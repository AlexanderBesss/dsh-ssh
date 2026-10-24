/**
 * SSH transport: one `ssh` invocation per operation, payload on stdin then
 * close — Windows OpenSSH never delivers stdin past the initial burst to a
 * long-lived reader, so a persistent agent does not work here.
 *
 * @module dsh-ssh/transport
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, ChildProcessByStdio, SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { AGENT_SCRIPT } from './agent-script.js'

/** Facts the remote `system` op reports about the machine behind the channel. */
export interface RemoteSystem {
	os?: string
	machine?: string
	user?: string
	home?: string
	pwsh?: string | null
	architecture?: string
	comspec?: string
}

/** A remote agent replied with a structured `{ code, message }` failure. */
export class RemoteAgentError extends Error {
	code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'RemoteAgentError'
		this.code = code
	}
}

/** The remote call failed at the transport level, not the operation level. */
export class SshTransportError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message)
		this.name = 'SshTransportError'
		if (cause !== undefined) this.cause = cause
	}
}

/** Safe to replay after a transport failure; a lost mutation may already have landed, never replay it. */
const REPLAYABLE_OPS = new Set(['ping', 'system', 'stat', 'list', 'read', 'range', 'where', 'mkdir', 'hash'])

/** Backoff before the single replay, to let a saturated channel recover. */
const RETRY_BACKOFF_MS = 1500

/** Resolved plugin configuration subset the transport drives on. */
export interface SshTransportConfig {
	host: string
	sshBin: string
	sshArgs?: string[]
	remoteShell: string
	connectTimeoutMs: number
	requestTimeoutMs: number
}

/** Raw outcome of one `ssh` invocation. */
export interface SshCallResult {
	stdout: string
	stderr: string
	code: number | null
}

/** Per-call overrides for {@link SshTransport.request}. */
export interface SshRequestOptions {
	timeoutMs?: number
	/** Internal; marks the single allowed replay. */
	retried?: boolean
}

/** One decoded agent response body; callers read known keys, the rest is data. */
export type AgentResult = Record<string, any>

export class SshTransport {
	#config: SshTransportConfig
	#staged: Promise<string> | undefined
	#system: RemoteSystem | undefined
	#sequence = 0
	/** Live `ssh` children of agent requests, so {@link close} can end them. */
	#children = new Set<ChildProcess>()

	constructor(config: SshTransportConfig) {
		this.#config = config
	}

	get host() {
		return this.#config.host
	}

	get system() {
		return this.#system
	}

	sshArgv(remoteCommand: string): string[] {
		return [...(this.#config.sshArgs ?? []), this.#config.host, remoteCommand]
	}

	/** Too big for cmd.exe's command line: the script rides stdin; the hash-named file makes staging idempotent. */
	#stageAgent(): Promise<string> {
		if (this.#staged) return this.#staged
		const hash = createHash('sha256').update(AGENT_SCRIPT, 'utf8').digest('hex').slice(0, 12)
		const bootstrap = 'powershell -NoProfile -NonInteractive -Command '
			+ `"$p=Join-Path $env:TEMP 'dsh-ssh-agent-${hash}.ps1'; `
			+ '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); '
			+ '[System.IO.File]::WriteAllBytes($p,$b); Write-Output $p"'
		this.#staged = this.#run(bootstrap, Buffer.from(AGENT_SCRIPT, 'utf8').toString('base64'), this.#config.connectTimeoutMs)
			.then(({ stdout, code, stderr }) => {
				const path = stdout.trim().split('\n').pop()?.trim()
				if (code !== 0 || !path) {
					throw new SshTransportError(
						`failed to stage the remote agent (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
					)
				}
				return path
			})
			.catch((error) => {
				// Let a later call try again rather than caching the failure.
				this.#staged = undefined
				throw error
			})
		return this.#staged
	}

	/** Closing stdin after the payload is what makes delivery reliable on this channel. */
	#run(remoteCommand: string, stdin: string | undefined, timeoutMs: number): Promise<SshCallResult> {
		return new Promise((resolve, reject) => {
			let child: ChildProcessByStdio<Writable, Readable, Readable>
			try {
				child = spawn(this.#config.sshBin, this.sshArgv(remoteCommand), {
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true,
				})
			} catch (error) {
				reject(new SshTransportError(`failed to start ${this.#config.sshBin}: ${(error as Error).message}`, error))
				return
			}
			let stdout = ''
			let stderr = ''
			let settled = false
			this.#children.add(child)
			const forget = (): void => {
				this.#children.delete(child)
			}
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				child.kill('SIGKILL')
				const note = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ')
				reject(new SshTransportError(
					`remote call timed out after ${timeoutMs}ms${note ? `: ${note.slice(0, 500)}` : ' (no output from the remote call)'}`,
				))
			}, timeoutMs)
			child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
			child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
			child.on('error', (error) => {
				forget()
				if (settled) return
				settled = true
				clearTimeout(timer)
				reject(new SshTransportError(`failed to run the remote call: ${error.message}`, error))
			})
			child.on('close', (code) => {
				forget()
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolve({ stdout, stderr, code })
			})
			if (stdin === undefined) child.stdin.end()
			else child.stdin.end(stdin)
		})
	}

	/** Whether a failed call gets the single backed-off replay; performs it when so. */
	async #replay(op: string, payload: Record<string, unknown>, options: SshRequestOptions): Promise<AgentResult | undefined> {
		if (!REPLAYABLE_OPS.has(op) || options.retried) return undefined
		await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS))
		return this.request(op, payload, { ...options, retried: true })
	}

	/** Run one agent operation; the channel stalling is absorbed by the single read-only replay. */
	async request(op: string, payload: Record<string, unknown> = {}, options: SshRequestOptions = {}): Promise<AgentResult> {
		const scriptPath = await this.#stageAgent()
		const id = `r${++this.#sequence}`
		const frame = `${JSON.stringify({ id, op, payload })}\n`
		const command = `${this.#config.remoteShell} -NoProfile -NonInteractive -File "${scriptPath}"`
		const timeoutMs = options.timeoutMs ?? this.#config.requestTimeoutMs
		let stdout: string
		let stderr: string
		let code: number | null
		try {
			({ stdout, stderr, code } = await this.#run(command, frame, timeoutMs))
		} catch (error) {
			const replayed = await this.#replay(op, payload, options)
			if (replayed !== undefined) return replayed
			throw error
		}

		// The agent prints one JSON line per request; other stdout text is a remote banner.
		const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
		const answer = lines.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return undefined
			}
		}).find((message) => message?.id === id)

		if (!answer) {
			const note = [stderr.trim(), ...lines].filter(Boolean).join(' | ')
			const replayed = await this.#replay(op, payload, options)
			if (replayed !== undefined) return replayed
			throw new SshTransportError(
				`remote ${op} returned no response (exit ${code})${note ? `: ${note.slice(0, 500)}` : ''}`,
			)
		}
		if (answer.ok) return answer.result ?? {}
		throw new RemoteAgentError(answer.error?.code ?? 'FS_IO_ERROR', answer.error?.message ?? 'remote agent failure')
	}

	/** Establish the channel and cache the remote system facts. */
	async connect(): Promise<void> {
		await this.#stageAgent()
		this.#system = await this.request('system', {})
	}

	/** One `ssh` invocation with piped stdio. Killing the local client is the only termination primitive. */
	spawnCommand(remoteCommand: string, options: SpawnOptions = {}): ChildProcess {
		return spawn(this.#config.sshBin, this.sshArgv(remoteCommand), {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			...options,
		})
	}

	/** An agent request still in flight must not outlive the plugin. */
	close(): void {
		this.#staged = undefined
		this.#system = undefined
		for (const child of this.#children) {
			try {
				child.kill('SIGKILL')
			} catch {
				// Already gone.
			}
		}
		this.#children.clear()
	}
}
