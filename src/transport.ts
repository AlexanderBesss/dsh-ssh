import { spawn } from 'node:child_process'
import type { ChildProcess, ChildProcessByStdio, SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { AGENT_SCRIPT } from './agent-script.js'

export interface RemoteSystem {
	os?: string
	machine?: string
	user?: string
	home?: string
	pwsh?: string | null
	architecture?: string
	comspec?: string
}

export class RemoteAgentError extends Error {
	code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'RemoteAgentError'
		this.code = code
	}
}

export class SshTransportError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message)
		this.name = 'SshTransportError'
		if (cause !== undefined) this.cause = cause
	}
}

// replayable after a transport failure; a lost mutation may already have landed, never replay those
const REPLAYABLE_OPS = new Set(['ping', 'system', 'stat', 'list', 'read', 'range', 'where', 'mkdir', 'hash'])

const RETRY_BACKOFF_MS = 1500

export interface SshTransportConfig {
	host: string
	sshBin: string
	sshArgs?: string[]
	remoteShell: string
	connectTimeoutMs: number
	requestTimeoutMs: number
}

export interface SshCallResult {
	stdout: string
	stderr: string
	code: number | null
}

export interface SshRequestOptions {
	timeoutMs?: number
	retried?: boolean
}

export type AgentResult = Record<string, any>

export class SshTransport {
	#config: SshTransportConfig
	#staged: Promise<string> | undefined
	#system: RemoteSystem | undefined
	#sequence = 0
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

	// the agent script is too big for a command line: it rides stdin; the hash-named file makes staging idempotent
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
				this.#staged = undefined
				throw error
			})
		return this.#staged
	}

	// windows openssh never delivers stdin past the initial burst: one invocation per op, and closing stdin after the payload is what makes delivery reliable
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

	async #replay(op: string, payload: Record<string, unknown>, options: SshRequestOptions): Promise<AgentResult | undefined> {
		if (!REPLAYABLE_OPS.has(op) || options.retried) return undefined
		await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS))
		return this.request(op, payload, { ...options, retried: true })
	}

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

		// the agent prints one JSON line per request; other stdout text is a remote banner
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

	async connect(): Promise<void> {
		await this.#stageAgent()
		await this.ensureSystem()
	}

	async ensureSystem(): Promise<RemoteSystem | undefined> {
		if (this.#system) return this.#system
		await this.#stageAgent()
		this.#system = await this.request('system', {})
		return this.#system
	}

	spawnCommand(remoteCommand: string, options: SpawnOptions = {}): ChildProcess {
		return spawn(this.#config.sshBin, this.sshArgv(remoteCommand), {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			...options,
		})
	}

	close(): void {
		this.#staged = undefined
		this.#system = undefined
		for (const child of this.#children) {
			try {
				child.kill('SIGKILL')
			} catch {
				// already gone
			}
		}
		this.#children.clear()
	}
}
