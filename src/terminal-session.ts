import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'
import type { RemoteSystem } from './transport.js'
import type {
	SpawnOutcome,
	TerminalActivity,
	TerminalForeground,
	TerminalHandle,
	TerminalSignal,
	TerminalSpawnSpec,
} from './seams.js'

export interface TerminalTransport {
	readonly host: string
	readonly system: RemoteSystem | undefined
	spawnCommand(remoteCommand: string): ChildProcess
	spawnPty(remoteCommand: string): ChildProcess
}

export interface TerminalOptions {
	shell: string
	graceMs: number
}

// the remote command travels as one ssh argv element the remote shell hands to cmd.exe, which refuses over 8191 characters
const REMOTE_COMMAND_LIMIT = 7000
const ENV_CARRY_LIMIT = 4000

function psLiteral(value: string): string {
	if (value.includes('\n') || value.includes('\r')) {
		return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')))`
	}
	return `'${value.replace(/'/g, "''")}'`
}

function posixLiteral(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

export function encodePowerShell(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64')
}

export function decodeCommand(remoteCommand: string): string {
	const match = /-EncodedCommand (\S+)/.exec(remoteCommand)
	if (match === null) throw new Error('dsh-ssh: the remote command carries no encoded script')
	return Buffer.from(match[1], 'base64').toString('utf16le')
}

export function sessionMarker(script: string): string {
	const match = /'(DSHSSH-TRAIL-[0-9a-f]+) '/.exec(script)
	if (match === null) throw new Error('dsh-ssh: the script carries no trailer marker')
	return match[1]
}

const STREAM_HANDLER =
	"if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Out.WriteLine([string]$_.Exception.Message) } elseif ($_ -is [System.Management.Automation.WarningRecord]) { [Console]::Out.WriteLine('WARNING: ' + [string]$_.Message) } elseif ($_.PSObject.Properties['Message']) { [Console]::Out.WriteLine([string]$_.Message) } else { $_ }"

export interface TerminalLine {
	cwd: string
	env: Record<string, string>
	lastExit: string
}

// every remote stream has to reach stdout: PowerShell serialises anything left on stderr as CLIXML
function runStatement(line: string): string {
	return `try { & { ${line} } 2>&1 3>&1 4>&1 5>&1 6>&1 | ForEach-Object { ${STREAM_HANDLER} } } catch { [Console]::Out.WriteLine([string]$_.Exception.Message) }`
}

export function lineScript(options: {
	cwd: string
	env: readonly (readonly [string, string | null])[]
	lastExit: string
	line: string
	marker: string
}): string {
	return [
		"$ErrorActionPreference = 'Continue'",
		"$ProgressPreference = 'SilentlyContinue'",
		'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }',
		`if (Test-Path -LiteralPath ${psLiteral(options.cwd)}) { Set-Location -LiteralPath ${psLiteral(options.cwd)} }`,
		...options.env.map(([key, value]) => value === null
			? `[Environment]::SetEnvironmentVariable(${psLiteral(key)}, $null, 'Process')`
			: `[Environment]::SetEnvironmentVariable(${psLiteral(key)}, ${psLiteral(value)}, 'Process')`),
		/^-?\d+$/.test(options.lastExit) ? `$global:LASTEXITCODE = ${options.lastExit}` : '',
		options.line.length === 0 ? '' : runStatement(options.line),
		'$__dshCwd = (Get-Location).ProviderPath',
		'$__dshExit = [string]$LASTEXITCODE',
		"$__dshPairs = (Get-ChildItem env: | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value })",
		"$__dshBlob = $__dshCwd + [char]0 + $__dshExit + [char]0 + ($__dshPairs -join [char]0)",
		`[Console]::Error.WriteLine('${options.marker} ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__dshBlob)))`,
	].filter((statement) => statement.length > 0).join('; ')
}

// the trailer rides stderr because a command's own stdout must reach the terminal untouched
export function parseTrail(marker: string, line: string): TerminalLine | undefined {
	const prefix = `${marker} `
	if (!line.startsWith(prefix)) return undefined
	const encoded = line.slice(prefix.length).trim()
	if (encoded.length === 0) return undefined
	const parts = Buffer.from(encoded, 'base64').toString('utf8').split('\0')
	const cwd = parts.shift() ?? ''
	const lastExit = parts.shift() ?? ''
	const env: Record<string, string> = {}
	for (const part of parts) {
		const at = part.indexOf('=')
		if (at > 0) env[part.slice(0, at)] = part.slice(at + 1)
	}
	return { cwd, lastExit, env }
}

function envDiff(login: Record<string, string>, current: Record<string, string>): (readonly [string, string | null])[] {
	const entries: [string, string | null][] = []
	for (const [key, value] of Object.entries(current)) if (login[key] !== value) entries.push([key, value])
	for (const key of Object.keys(login)) if (!(key in current)) entries.push([key, null])
	return entries
}

export function resolveTerminalMode(configured: string | undefined, os: string | undefined): 'line' | 'pty' {
	const mode = (configured ?? 'auto').trim().toLowerCase()
	if (mode === 'pty') return 'pty'
	if (mode === 'line') return 'line'
	return os !== undefined && os.length > 0 && !/windows/i.test(os) ? 'pty' : 'line'
}

const WINDOWS_SHELL = /^(?:powershell|pwsh|psh|cmd|conhost)(?:\.exe)?$/i

export function posixTerminalShell(configured: string | undefined): string {
	const value = (configured ?? '').trim()
	if (value.length === 0 || value.includes('\\') || WINDOWS_SHELL.test(value)) return 'bash'
	return value
}

export class LineTerminalSession implements TerminalHandle {
	#transport: TerminalTransport
	#shell: string
	#graceMs: number
	#marker = `DSHSSH-TRAIL-${randomBytes(4).toString('hex')}`
	#out = new PassThrough()
	#pid = 0
	#cwd = ''
	#loginEnv: Record<string, string> = {}
	#env: Record<string, string> = {}
	#specEnvKeys: string[] = []
	#line = ''
	#escape = 0
	#child: ChildProcess | undefined
	#queue: string[] = []
	#stderr = ''
	#lastExit = ''
	#trail: TerminalLine | undefined
	#run: { resolve: () => void; reject: (error: Error) => void; silent: boolean } | undefined
	#busy = false
	#revision = 0
	#closed = false
	#warnedEnv = false
	#settle!: (outcome: SpawnOutcome) => void
	readonly done = new Promise<SpawnOutcome>((resolve) => {
		this.#settle = resolve
	})

	constructor(transport: TerminalTransport, options: TerminalOptions) {
		this.#transport = transport
		this.#shell = options.shell
		this.#graceMs = options.graceMs
	}

	static async create(transport: TerminalTransport, options: TerminalOptions, spec: TerminalSpawnSpec): Promise<LineTerminalSession> {
		const session = new LineTerminalSession(transport, options)
		session.#cwd = spec.cwd
		session.#env = Object.fromEntries(Object.entries(spec.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined))
		session.#specEnvKeys = Object.keys(session.#env)
		spec.signal?.addEventListener('abort', () => void session.terminate().catch(() => {}), { once: true })
		const system = transport.system
		const facts = [system?.machine, system?.user].filter((fact) => Boolean(fact)).join('\\')
		session.#out.write(`dsh-ssh remote shell on ${transport.host}${facts ? ` (${facts})` : ''}\r\n`)
		try {
			await session.#execute('', true)
		} catch (error) {
			await session.terminate()
			throw error
		}
		if (session.#closed) throw new Error('dsh-ssh: the remote terminal session was cancelled before it opened')
		session.#out.write(session.#prompt())
		return session
	}

	get pid(): number {
		return this.#pid
	}

	get output(): Readable {
		return this.#out
	}

	async write(data: string): Promise<void> {
		if (this.#closed) return
		for (const char of data) this.#feed(char)
	}

	async resize(): Promise<void> {}

	async inspectForeground(): Promise<TerminalForeground | undefined> {
		return { processGroupId: this.#pid, inputWaiting: !this.#busy }
	}

	async inspectActivity(): Promise<TerminalActivity> {
		return { state: this.#busy ? 'busy' : 'idle', revision: this.#revision }
	}

	async signalForeground(signal: TerminalSignal): Promise<number> {
		if (signal === 'SIGINT') this.#interrupt()
		else if (signal !== 'SIGTSTP') await this.terminate()
		return this.#pid
	}

	async terminate(): Promise<void> {
		await this.#finishSession({ exitCode: null, signal: 'SIGTERM' })
	}

	#prompt(): string {
		return `PS ${this.#cwd}> `
	}

	#feed(char: string): void {
		const code = char.codePointAt(0) as number
		if (this.#escape === 1) {
			if (code === 0x5b || code === 0x50 || code === 0x58 || code === 0x28) this.#escape = code === 0x28 ? 1 : 2
			else this.#escape = 0
			return
		}
		if (this.#escape === 2) {
			if (!(code >= 0x20 && code <= 0x3f)) this.#escape = 0
			return
		}
		if (code === 0x1b) this.#escape = 1
		else if (code === 0x03) this.#interrupt()
		else if (code === 0x04) {
			if (this.#line.length === 0 && !this.#busy) void this.#finishSession({ exitCode: 0, signal: null })
		} else if (code === 0x09) {
			// completion belongs to a terminal the remote does not have
		} else if (code === 0x0c) this.#out.write('\x1b[2J\x1b[H' + this.#prompt())
		else if (code === 0x15) {
			if (this.#line.length > 0) {
				this.#out.write('\b \b'.repeat(this.#line.length))
				this.#line = ''
			}
		} else if (code === 0x0d || code === 0x0a) {
			this.#out.write('\r\n')
			const line = this.#line
			this.#line = ''
			this.#submit(line)
		} else if (code === 0x7f || code === 0x08) {
			if (this.#line.length > 0) {
				this.#line = this.#line.slice(0, -1)
				this.#out.write('\b \b')
			}
		} else if (code >= 0x20) {
			this.#line += char
			this.#out.write(char)
		}
	}

	#submit(line: string): void {
		const exit = /^exit\b(?:\s+(-?\d+))?$/.exec(line.trim())
		if (exit) {
			void this.#finishSession({ exitCode: Number(exit[1] ?? '0'), signal: null })
			return
		}
		if (line.length === 0) {
			if (!this.#busy) this.#out.write(this.#prompt())
			return
		}
		if (this.#busy) this.#queue.push(line)
		else void this.#execute(line, false).catch(() => {})
	}

	#interrupt(): void {
		if (this.#closed) return
		if (this.#child) {
			this.#killChild(this.#child)
			this.#out.write('^C\r\n')
			return
		}
		this.#line = ''
		this.#out.write('^C\r\n' + this.#prompt())
	}

	#killChild(child: ChildProcess): void {
		try {
			child.kill()
		} catch {}
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL')
			} catch {}
		}, this.#graceMs)
		timer.unref?.()
	}

	#envCarry(): (readonly [string, string | null])[] | undefined {
		const entries = envDiff(this.#loginEnv, this.#env)
		let size = 0
		for (const [key, value] of entries) size += key.length + (value?.length ?? 0)
		if (size > ENV_CARRY_LIMIT) return undefined
		return entries
	}

	#remote(envEntries: readonly (readonly [string, string | null])[], line: string): string {
		const script = lineScript({ cwd: this.#cwd, env: envEntries, lastExit: this.#lastExit, line, marker: this.#marker })
		return `${this.#shell} -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`
	}

	#execute(line: string, silent: boolean): Promise<void> {
		let settleResolve!: () => void
		let settleReject!: (error: Error) => void
		const settled = new Promise<void>((resolve, reject) => {
			settleResolve = resolve
			settleReject = reject
		})
		this.#run = { resolve: settleResolve, reject: settleReject, silent }

		const carried = this.#envCarry()
		let remoteCommand = this.#remote(carried ?? [], line)
		const tooWide = carried === undefined || remoteCommand.length > REMOTE_COMMAND_LIMIT
		if (tooWide) remoteCommand = this.#remote([], line)
		if (tooWide && !this.#warnedEnv && !silent && !this.#closed) {
			this.#warnedEnv = true
			this.#out.write('\r\n[dsh-ssh: this command is too large to carry the saved environment along]\r\n')
		}

		const child = this.#transport.spawnCommand(remoteCommand)
		if (this.#pid === 0) this.#pid = child.pid ?? 0
		this.#child = child
		this.#busy = true
		this.#revision += 1
		this.#trail = undefined
		child.stdin?.end()
		child.stdout?.on('data', (chunk: Buffer) => {
			if (!silent && !this.#closed) this.#out.write(chunk)
		})
		child.stderr?.on('data', (chunk: Buffer) => this.#onStderr(chunk, silent))
		child.on('close', () => this.#finish(child, undefined))
		child.on('error', (error: Error) => this.#finish(child, error))
		return settled
	}

	#finish(child: ChildProcess, error: Error | undefined): void {
		if (this.#child !== child) return
		this.#child = undefined
		this.#flushStderr(this.#run?.silent ?? false)
		const trail = this.#trail
		if (trail !== undefined) {
			if (trail.cwd.length > 0) this.#cwd = trail.cwd
			this.#lastExit = trail.lastExit
			this.#env = trail.env
			if (this.#run?.silent) {
				this.#loginEnv = { ...trail.env }
				for (const key of this.#specEnvKeys) if (this.#loginEnv[key] === trail.env[key]) delete this.#loginEnv[key]
			}
		}
		this.#busy = false
		this.#revision += 1
		const run = this.#run
		this.#run = undefined
		if (error) run?.reject(error)
		else run?.resolve()
		if (this.#closed || run?.silent) return
		if (error) this.#out.write('\r\n[dsh-ssh: the remote command did not run]\r\n')
		if (this.#queue.length > 0) {
			void this.#execute(this.#queue.shift() as string, false).catch(() => {})
			return
		}
		this.#out.write(this.#prompt())
	}

	#onStderr(chunk: Buffer, silent: boolean): void {
		this.#stderr += chunk.toString('utf8')
		for (;;) {
			const index = this.#stderr.indexOf('\n')
			if (index < 0) return
			const raw = this.#stderr.slice(0, index).replace(/\r$/, '')
			this.#stderr = this.#stderr.slice(index + 1)
			this.#stderrLine(raw, silent)
		}
	}

	#flushStderr(silent: boolean): void {
		if (this.#stderr.length === 0) return
		const raw = this.#stderr.replace(/\r$/, '')
		this.#stderr = ''
		this.#stderrLine(raw, silent)
	}

	#stderrLine(raw: string, silent: boolean): void {
		const trail = parseTrail(this.#marker, raw)
		if (trail !== undefined) {
			this.#trail = trail
			return
		}
		if (!silent && !this.#closed && raw.length > 0) this.#out.write(`${raw}\r\n`)
	}

	async #finishSession(outcome: SpawnOutcome): Promise<void> {
		if (this.#closed) {
			await this.done
			return
		}
		if (this.#child) this.#killChild(this.#child)
		this.#closed = true
		this.#out.write('\r\n')
		this.#out.end()
		this.#settle(outcome)
	}
}

export class PtyTerminalSession implements TerminalHandle {
	#child: ChildProcess
	#out = new PassThrough()
	#graceMs: number
	#closed = false
	#forwarding = true
	#revision = 1
	#settle!: (outcome: SpawnOutcome) => void
	readonly done = new Promise<SpawnOutcome>((resolve) => {
		this.#settle = resolve
	})
	readonly pid: number

	constructor(transport: TerminalTransport, options: TerminalOptions, spec: TerminalSpawnSpec) {
		this.#graceMs = options.graceMs
		const rows = Number.isFinite(spec.rows) && spec.rows > 0 ? Math.trunc(spec.rows) : 24
		const cols = Number.isFinite(spec.cols) && spec.cols > 0 ? Math.trunc(spec.cols) : 80
		const command = `stty rows ${rows} cols ${cols} 2>/dev/null; cd ${posixLiteral(spec.cwd)} 2>/dev/null; exec ${posixLiteral(options.shell)}`
		const child = transport.spawnPty(command)
		this.#child = child
		this.pid = child.pid ?? 0
		spec.signal?.addEventListener('abort', () => void this.terminate().catch(() => {}), { once: true })
		child.stdin?.on('error', () => {})
		child.stdout?.on('data', (chunk: Buffer) => {
			if (this.#forwarding) this.#out.write(chunk)
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			if (this.#forwarding) this.#out.write(chunk)
		})
		child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
			this.#stopForwarding()
			this.#closed = true
			this.#settle({ exitCode: code, signal })
		})
		child.on('error', () => {
			this.#stopForwarding()
			if (this.#closed) return
			this.#closed = true
			this.#settle({ exitCode: null, signal: null })
		})
	}

	get output(): Readable {
		return this.#out
	}

	async write(data: string): Promise<void> {
		if (this.#closed || this.#child.stdin === null || this.#child.stdin === undefined || !this.#child.stdin.writable) return
		await new Promise<void>((resolve) => {
			this.#child.stdin?.write(data, () => resolve())
		})
	}

	async resize(): Promise<void> {}

	async inspectForeground(): Promise<TerminalForeground | undefined> {
		return undefined
	}

	async inspectActivity(): Promise<TerminalActivity> {
		return { state: 'unknown', revision: this.#revision }
	}

	async signalForeground(signal: TerminalSignal): Promise<number> {
		if (signal === 'SIGINT') await this.write('\x03')
		else if (signal === 'SIGTSTP') await this.write('\x1a')
		else await this.terminate()
		return this.pid
	}

	async terminate(): Promise<void> {
		if (this.#closed) {
			await this.done
			return
		}
		this.#closed = true
		this.#stopForwarding()
		try {
			this.#child.kill()
		} catch {}
		const timer = setTimeout(() => {
			try {
				this.#child.kill('SIGKILL')
			} catch {}
		}, this.#graceMs)
		timer.unref?.()
		this.#settle({ exitCode: null, signal: 'SIGTERM' })
	}

	#stopForwarding(): void {
		if (!this.#forwarding) return
		this.#forwarding = false
		this.#out.end()
	}
}
