/**
 * SSH transport: staged remote agent, driven one request per SSH invocation.
 *
 * The plugin shells out to the system `ssh` client rather than embedding an SSH
 * stack. That is a deliberate choice for the `~/.ssh/config` authentication
 * model: Host aliases, `IdentityFile`, `ProxyJump`, `Match` blocks and a running
 * ssh-agent all keep working, and no private key material is ever read into
 * this process. A pure-Node client would have to reimplement config resolution
 * and jump hosting to reach the same place.
 *
 * WHY NOT A PERSISTENT AGENT
 * ---------------------------
 * The obvious design — one long-lived remote PowerShell reading line-delimited
 * JSON from stdin — was built, worked in isolation, and then failed against a
 * real Windows host. Windows OpenSSH runs remote commands through `cmd.exe`,
 * and stdin written to that channel after the initial burst never reaches the
 * grandchild process. Verified directly: a request sent at t=0 is answered, a
 * request sent at t=3s is never seen. `-tt` relays stdin progressively but
 * hands the session to an interactive `cmd.exe` instead of the requested
 * command, so it is not a fix either.
 *
 * So each operation is its own `ssh` invocation: the request rides stdin and
 * stdin is then closed, which is the one shape this channel delivers reliably.
 * It costs a connection per operation (roughly half a second on a LAN) and
 * there is no connection reuse available — Windows OpenSSH has no ControlMaster
 * equivalent. The `ctx.fs` README already expects a remote backend to pay per
 * round trip; this is that cost, measured rather than assumed.
 *
 * The upgrade path, when latency becomes the complaint, is the shape the API
 * catalog describes for `ctx.ssh`: the helper listens on the remote loopback and
 * each stream arrives over an independent SSH channel (`ssh -L` forwarding),
 * which sidesteps `cmd.exe` stdin entirely.
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

	/**
	 * @param code - the agent-supplied error code, from the `FS_*` vocabulary.
	 * @param message - the agent-supplied failure message.
	 */
	constructor(code: string, message: string) {
		super(message)
		this.name = 'RemoteAgentError'
		this.code = code
	}
}

/** The remote call failed at the transport level, not the operation level. */
export class SshTransportError extends Error {
	/**
	 * @param message - transport-level failure description.
	 * @param cause - the underlying error, when there is one.
	 */
	constructor(message: string, cause?: unknown) {
		super(message)
		this.name = 'SshTransportError'
		if (cause !== undefined) this.cause = cause
	}
}

/**
 * Operations that are safe to replay after a transport failure.
 *
 * A mutation whose response was lost is ambiguous: the remote side may already
 * have applied it, and replaying would double-apply a write or re-append bytes.
 * Only reads are retried; a lost mutation surfaces as an error and the caller
 * decides.
 */
const REPLAYABLE_OPS = new Set(['ping', 'system', 'stat', 'list', 'read', 'range', 'where', 'mkdir', 'hash'])

/**
 * Wait before replaying a read, so a channel that is briefly saturated gets a
 * chance to recover instead of failing on the second identical attempt.
 */
const RETRY_BACKOFF_MS = 1500

/** Resolved plugin configuration subset the transport drives on. */
export interface SshTransportConfig {
	/** SSH destination, resolved by the ssh client itself. */
	host: string
	/** ssh client binary. */
	sshBin: string
	/** Extra arguments for every invocation. */
	sshArgs?: string[]
	/** Shell hosting the agent on the remote. */
	remoteShell: string
	/** Budget for staging and the first probe. */
	connectTimeoutMs: number
	/** Budget for one operation. */
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
	/** Budget for this call, defaulting to config. */
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

	/**
	 * @param config - resolved plugin configuration.
	 */
	constructor(config: SshTransportConfig) {
		this.#config = config
	}

	get host() {
		return this.#config.host
	}

	/** Cached `system` facts (remote machine, user, home, shell paths). */
	get system() {
		return this.#system
	}

	/** Assemble the argv for one `ssh` invocation against this host. */
	sshArgv(remoteCommand: string): string[] {
		return [...(this.#config.sshArgs ?? []), this.#config.host, remoteCommand]
	}

	/**
	 * Stage the agent script on the remote host and return its path.
	 *
	 * The script is too large to inline: an `-EncodedCommand` blob for it runs to
	 * about 21 KB, and the remote default shell is `cmd.exe`, whose command line
	 * caps at 8191 characters. So the script rides stdin and a short bootstrap
	 * writes it out. The file name carries a content hash, which makes staging
	 * idempotent and keeps two plugin versions from overwriting each other.
	 *
	 * @returns the remote path of the staged agent script.
	 */
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

	/**
	 * One `ssh` invocation: optional stdin payload, then EOF, then collect.
	 *
	 * Closing stdin is not an optimization here — it is what makes delivery
	 * reliable against the remote default shell.
	 *
	 * @param remoteCommand - the fully formed remote command line.
	 * @param stdin - payload to write before EOF, when the command needs one.
	 * @param timeoutMs - budget before the invocation is killed.
	 * @returns resolved stdout, stderr, and exit code.
	 */
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

	/**
	 * Run one agent operation.
	 *
	 * The channel is intermittently slow against Windows hosts — a connection
	 * that answers in 530 ms most of the time occasionally stalls past any sane
	 * deadline. Reads absorb that with one backed-off replay; a mutation never
	 * replays, because its remote effect may already have landed.
	 *
	 * @param op - the agent operation name.
	 * @param payload - operation arguments, JSON-safe.
	 * @param options - per-call overrides.
	 * @returns the operation result.
	 */
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
			if (REPLAYABLE_OPS.has(op) && !options.retried) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS))
				return this.request(op, payload, { ...options, retried: true })
			}
			throw error
		}

		// The agent prints one JSON line per request; anything else on stdout is
		// a remote banner and belongs with the diagnostics.
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
			if (REPLAYABLE_OPS.has(op) && !options.retried) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS))
				return this.request(op, payload, { ...options, retried: true })
			}
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

	/**
	 * Spawn a remote command with piped stdio, as one `ssh` invocation.
	 *
	 * Killing the local client is the only termination primitive available here;
	 * Windows OpenSSH tears the direct remote process down when its channel
	 * closes, though descendants it spawned may survive.
	 *
	 * Note: stdin written to this channel after the initial burst is not
	 * delivered reliably, so interactive input to a remote command is not
	 * supported.
	 *
	 * @param remoteCommand - the fully quoted remote command line.
	 * @param options - spawn options handed to `child_process.spawn`.
	 * @returns the local child process bound to the remote command.
	 */
	spawnCommand(remoteCommand: string, options: SpawnOptions = {}): ChildProcess {
		return spawn(this.#config.sshBin, this.sshArgv(remoteCommand), {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			...options,
		})
	}

	/**
	 * Tear the channel down: nothing is held open between operations, but an
	 * agent request still in flight must not outlive the plugin — unloading
	 * used to leave those `ssh` processes running until their own deadline.
	 */
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
