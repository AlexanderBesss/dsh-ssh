import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from './seams.js'
import type { SpawnHandle, SpawnOutcome, SpawnSpec, StdioMode, TerminalEnvironment } from './seams.js'
import type { SshTransport } from './transport.js'
import { plumbingRootOf, prunePlumbingScript, rewriteGitPlumbing } from './git-plumbing.js'

export interface SshSubprocessConfig {
	cwd?: string
	remoteShell?: string
	mapRipgrep?: boolean
	remoteRoots?: () => readonly string[]
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
// 64 KB binary is 88 KB base64 — the largest stdin payload the remote shell relays reliably
const UPLOAD_CHUNK_BYTES = 64 * 1024
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

interface LiveEntry {
	terminate(): void
	waitForExit(signal?: AbortSignal): Promise<boolean>
}

function assertNoNul(value: unknown, label: string): void {
	if (typeof value === 'string' && value.includes('\0')) {
		const error = new TypeError(`invalid ${label}: NUL bytes are not permitted`) as NodeJS.ErrnoException
		error.code = 'ERR_INVALID_ARG_VALUE'
		throw error
	}
}

class OutputTail {
	_chunks: Buffer[] = []
	_bytes = 0
	_total = 0
	_maxBytes: number

	constructor(maxBytes?: number) {
		this._maxBytes = Number.isFinite(maxBytes) && (maxBytes as number) > 0 ? (maxBytes as number) : 256 * 1024
	}

	push(chunk: Buffer): void {
		this._chunks.push(chunk)
		this._bytes += chunk.length
		this._total += chunk.length
		while (this._bytes > this._maxBytes && this._chunks.length > 1) {
			this._bytes -= this._chunks.shift()!.length
		}
		if (this._bytes > this._maxBytes) {
			const tail = this._chunks[0].subarray(this._bytes - this._maxBytes)
			this._chunks = [tail]
			this._bytes = tail.length
		}
	}

	readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
		const windowStart = this._total - this._bytes
		const buffer = Buffer.concat(this._chunks)
		const lossy = fromByte < windowStart
		return {
			text: (lossy ? buffer : buffer.subarray(Math.max(0, fromByte - windowStart))).toString('utf8'),
			nextOffset: this._total,
			lossy,
		}
	}
}

export class SshSubprocessRuntime extends SubprocessRuntime {
	_config: SshSubprocessConfig
	_transport: SshTransport
	_live = new Set<LiveEntry>()
	_ripgrepPath?: string
	_ripgrepPromise?: Promise<string>

	constructor(ctx: Context, config: SshSubprocessConfig, transport: SshTransport, slot = 'subprocess') {
		super(ctx, slot)
		this._config = config
		this._transport = transport
		void this._transport.ensureSystem().catch(() => void 0)
		ctx.effect(() => async () => {
			for (const entry of this._live) entry.terminate()
			await Promise.all([...this._live].map((entry) => entry.waitForExit().catch(() => true)))
			this._live.clear()
		}, 'dsh-ssh subprocess teardown')
	}

	async resolveExecutable(command: unknown, env?: Record<string, string | undefined>, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted?.()
		assertNoNul(command, 'executable')
		const name = String(command ?? '')
		if (name.length === 0) throw new Error('dsh-ssh: executable must be non-empty')
		if (isAbsolute(name)) {
			const info = await this._transport.request('stat', { path: name })
			if (info.exists && info.type === 'file') return name
			throw new SubprocessExecutableNotFoundError(`command ${JSON.stringify(name)} is not an executable file`)
		}
		const pathValue = env?.PATH ?? env?.Path ?? env?.path
		const pathExt = env?.PATHEXT ?? env?.PathExt ?? DEFAULT_PATHEXT
		const found = await this._transport.request('where', {
			name,
			...(pathValue ? { path: pathValue } : {}),
			...(pathExt ? { pathExt } : {}),
		})
		if (!found.path) {
			throw new SubprocessExecutableNotFoundError(`command ${JSON.stringify(name)} was not found on PATH`)
		}
		return found.path
	}

	async terminalEnvironment(signal?: AbortSignal): Promise<TerminalEnvironment> {
		signal?.throwIfAborted?.()
		const comspec = this._transport.system?.comspec
		return {
			platform: 'windows',
			// consumers fall back to cmd.exe only when the key is absent
			...(comspec ? { defaultShell: comspec } : {}),
		}
	}

	async spawnTerminal(): Promise<never> {
		throw new Error('dsh-ssh: remote terminal sessions are not supported; use the pwsh tool for remote commands')
	}

	_isPackagedRipgrep(program: string): boolean {
		if (this._config.mapRipgrep === false) return false
		return /[\\/]@vscode[\\/]ripgrep/i.test(program) || /^(?:rg|rg\.exe)$/i.test(basename(program))
	}

	async _ensureRemoteRipgrep(localProgram: string): Promise<string> {
		if (this._ripgrepPath) return this._ripgrepPath
		this._ripgrepPromise ??= (async () => {
			const system = this._transport.system ?? (await this._transport.request('system', {}))
			const home = system?.home ?? '.'
			const remote = `${String(home).replace(/\\+$/, '')}\\.dsh\\bin\\rg.exe`
			if (!existsSync(localProgram)) {
				const found = await this._transport.request('where', { name: 'rg' })
				return found.path ?? 'rg'
			}
			const buffer = readFileSync(localProgram)
			const expected = createHash('sha256').update(buffer).digest('hex')

			// reuse a copy an earlier session shipped: SHA-256 proves it is the same build
			const present = await this._transport.request('stat', { path: remote })
			if (present.exists && present.type === 'file') {
				const digest = await this._transport.request('hash', { path: remote }, { timeoutMs: 60000 })
				if (digest.sha256 === expected) {
					this.ctx.logger?.info?.(`dsh-ssh: reusing remote ripgrep (${present.size} bytes) at ${this._transport.host}:${remote}`)
					return remote
				}
				this.ctx.logger?.info?.(`dsh-ssh: remote ripgrep at ${remote} is a different build (${String(digest.sha256).slice(0, 12)}...), re-shipping`)
			}

			for (let attempt = 1; attempt <= 2; attempt += 1) {
				const staged = `${remote}.part`
				const parts: string[] = []
				let incomplete = false
				let index = 0
				for (let offset = 0; offset < buffer.length; offset += UPLOAD_CHUNK_BYTES, index += 1) {
					const part = `${staged}.${String(index).padStart(4, '0')}`
					parts.push(part)
					const base64 = buffer.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString('base64')
					let written = false
					for (let tryNumber = 1; tryNumber <= 3 && !written; tryNumber += 1) {
						try {
							await this._transport.request('write', { path: part, base64, expected: null }, { timeoutMs: 30000 })
							written = true
						} catch (error) {
							if (tryNumber === 3) {
								this.ctx.logger?.warn?.(`dsh-ssh: ripgrep chunk ${index} failed on ${this._transport.host}: ${(error as any)?.message ?? error}`)
								incomplete = true
							}
						}
					}
					if (incomplete) break
				}
				if (!incomplete) {
					await this._transport.request('concat', { target: staged, sources: parts }, { timeoutMs: 60000 })
					const digest = await this._transport.request('hash', { path: staged }, { timeoutMs: 60000 })
					if (digest.sha256 === expected) {
						await this._transport.request('move', { source: staged, target: remote })
						this.ctx.logger?.info?.(`dsh-ssh: shipped ripgrep (${buffer.length} bytes) to ${this._transport.host}:${remote}`)
						return remote
					}
					this.ctx.logger?.warn?.(`dsh-ssh: ripgrep upload to ${this._transport.host} came back corrupt (attempt ${attempt})`)
				}
				for (const part of parts) {
					await this._transport.request('remove', { path: part }).catch(() => {})
				}
				await this._transport.request('remove', { path: staged }).catch(() => {})
			}
			const found = await this._transport.request('where', { name: 'rg' })
			return found.path ?? 'rg'
		})().then((path) => {
			this._ripgrepPath = path
			return path
		}).finally(() => {
			this._ripgrepPromise = undefined
		})
		return this._ripgrepPromise
	}

	// spawn is synchronous: until the upload lands, fall back to a remote rg on PATH
	_resolveProgram(program: string): string {
		if (!this._isPackagedRipgrep(program)) return program
		if (this._ripgrepPath) return this._ripgrepPath
		void this._ensureRemoteRipgrep(program).catch(() => {})
		return 'rg'
	}

	async warm(localProgram?: string): Promise<void> {
		if (this._config.mapRipgrep === false || !localProgram) return
		await this._ensureRemoteRipgrep(localProgram)
	}

	_validate(spec: SpawnSpec): void {
		if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
			throw new Error(`dsh-ssh: graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
		}
		if (spec.signal?.aborted) {
			throw new Error(`aborted before spawn: ${spec.signal.reason ?? 'aborted'}`)
		}
		if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv[0]) {
			throw new Error('dsh-ssh: invalid argv: expected a non-empty program name at argv[0]')
		}
		for (const [index, entry] of spec.argv.entries()) assertNoNul(entry, `argv[${index}]`)
		if (spec.cwd !== undefined) assertNoNul(spec.cwd, 'cwd')
		for (const [key, value] of Object.entries(spec.env ?? {})) {
			assertNoNul(key, 'env key')
			if (value !== undefined) assertNoNul(value, `env value for ${key}`)
		}
		if (spec.env?.DSH_SUBPROCESS_CONTROL !== undefined) {
			throw new Error('DSH_SUBPROCESS_CONTROL is reserved for subprocess control-channel setup')
		}
	}

	// user-influenced text must never be parsed by cmd.exe or PowerShell 5.1 (both mangle quotes — `a"&calc` would execute):
	// one PowerShell script via -EncodedCommand, the process started through .NET ProcessStartInfo; only the
	// request's explicit env layers on, the local parent environment belongs to another machine
	_remoteCommand(spec: SpawnSpec): string {
		const argv = [...spec.argv]
		argv[0] = this._resolveProgram(String(argv[0]))
		// single-quoted PS literal, quotes doubled; newline-carrying values ride base64 so a here-string terminator cannot be forged by the value
		const q = (value: string): string =>
			value.includes('\n') || value.includes('\r')
				? `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')))`
				: `'${value.replace(/'/g, "''")}'`
		// MSVCRT quoting — libuv's scheme; .NET's ArgumentList is absent on older Frameworks
		const msvcQuote = (value: string): string => {
			if (value === '') return '""'
			let out = '"'
			let backslashes = 0
			for (const ch of value) {
				if (ch === '\\') {
					backslashes += 1
					continue
				}
				if (ch === '"') {
					out += `${'\\'.repeat(backslashes * 2 + 1)}"`
				} else {
					out += '\\'.repeat(backslashes) + ch
				}
				backslashes = 0
			}
			return `${out}${'\\'.repeat(backslashes * 2)}"`
		}
		const statements: string[] = [
			"$ErrorActionPreference = 'Stop'",
			// progress records would otherwise arrive as CLIXML on stderr and look like the command's own output
			"$ProgressPreference = 'SilentlyContinue'",
			'$si = New-Object Diagnostics.ProcessStartInfo',
			// must precede EnvironmentVariables access: setting that map while shell-execute is on throws
			'$si.UseShellExecute = $false',
			`$si.FileName = ${q(String(argv[0]))}`,
			`$si.Arguments = ${q(argv.slice(1).map((entry) => msvcQuote(String(entry))).join(' '))}`,
		]
		if (spec.cwd) statements.push(`$si.WorkingDirectory = ${q(String(spec.cwd))}`)
		let envEntries = Object.entries(spec.env ?? {}).flatMap(
			([key, value]) => value === undefined ? [] : [[key, String(value)]] as [string, string][],
		)
		const plumbingRoot = plumbingRootOf(this._transport.system?.home)
		if (envEntries.length > 0 && plumbingRoot !== undefined && this._config.remoteRoots !== undefined) {
			const rewrite = rewriteGitPlumbing(Object.fromEntries(envEntries), this._config.remoteRoots(), plumbingRoot)
			if (rewrite.remapped) {
				envEntries = Object.entries(rewrite.env)
				statements.unshift(`New-Item -ItemType Directory -Force -Path ${q(plumbingRoot)} | Out-Null`)
				for (const dir of rewrite.createdDirs) {
					if (dir !== plumbingRoot) statements.push(`New-Item -ItemType Directory -Force -Path ${q(dir)} | Out-Null`)
				}
				statements.push(prunePlumbingScript(plumbingRoot))
			}
		}
		for (const [key, value] of envEntries) {
			statements.push(`$si.EnvironmentVariables[${q(key)}] = ${q(value)}`)
		}
		statements.push('$proc = [Diagnostics.Process]::Start($si)')
		statements.push('$proc.WaitForExit()')
		statements.push('exit $proc.ExitCode')
		const encoded = Buffer.from(statements.join('; '), 'utf16le').toString('base64')
		return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`
	}

	spawn(spec: SpawnSpec): SpawnHandle {
		this._validate(spec)
		const stdio = spec.stdio ?? {}
		const collectors: Record<string, OutputTail> = {}
		const streams: { stdin?: Writable; stdout?: Readable; stderr?: Readable } = {}
		let settled = false
		let terminated = false

		const child = this._transport.spawnCommand(this._remoteCommand(spec))

		const attach = (name: 'stdout' | 'stderr', mode: StdioMode | undefined, stream: Readable | null | undefined): void => {
			if (!stream) return
			if (mode === 'pipe') {
				streams[name] = stream
				return
			}
			if (mode === 'inherit') {
				stream.pipe(name === 'stdout' ? process.stdout : process.stderr)
				return
			}
			const tail = new OutputTail(typeof mode === 'object' && mode !== null ? mode.maxBytes : undefined)
			collectors[name] = tail
			stream.on('data', (chunk: Buffer) => tail.push(chunk))
		}
		attach('stdout', stdio.stdout, child.stdout)
		attach('stderr', stdio.stderr, child.stderr)

		if (stdio.stdin && typeof stdio.stdin === 'object' && stdio.stdin.data !== undefined) {
			child.stdin!.end(String(stdio.stdin.data))
		} else if (stdio.stdin !== 'pipe') {
			child.stdin!.end()
		} else {
			streams.stdin = child.stdin!
		}

		const entry: LiveEntry = {
			terminate() {
				if (terminated) return
				terminated = true
				// closing the ssh channel is the graceful tier; SIGKILL is the forced one
				child.kill()
				const timer = setTimeout(() => {
					try {
						child.kill('SIGKILL')
					} catch {
						// already gone
					}
				}, spec.graceMs)
				timer.unref?.()
			},
			waitForExit: (signal) => waitForExit(signal),
		}
		this._live.add(entry)

		// detach after settle: a long-lived signal must not accumulate listeners across spawns
		let detachSignalAbort = (): void => {}
		if (spec.signal) {
			const onAbort = (): void => entry.terminate()
			spec.signal.addEventListener('abort', onAbort, { once: true })
			detachSignalAbort = () => spec.signal?.removeEventListener?.('abort', onAbort)
		}

		const done = new Promise<SpawnOutcome>((resolve, reject) => {
			child.on('close', (code, signal) => {
				this._live.delete(entry)
				detachSignalAbort()
				if (settled) return
				settled = true
				// numeric code = a real remote exit; null code + null signal = transport failure, reject
				if (code === null && signal === null) {
					reject(new Error(`dsh-ssh: remote command did not run to completion on ${this._transport.host}`))
					return
				}
				resolve({ exitCode: code, signal })
			})
			child.on('error', (error) => {
				this._live.delete(entry)
				detachSignalAbort()
				if (settled) return
				settled = true
				reject(error)
			})
		})

		// remote descendants are not proven quiescent on exit — weaker than the local provider's managed range
		function waitForExit(signal?: AbortSignal): Promise<boolean> {
			if (signal?.aborted) return Promise.resolve(false)
			return new Promise((resolve) => {
				const abort = () => resolve(false)
				signal?.addEventListener?.('abort', abort, { once: true })
				done.then(
					() => {
						signal?.removeEventListener?.('abort', abort)
						resolve(true)
					},
					() => {
						signal?.removeEventListener?.('abort', abort)
						resolve(true)
					},
				)
			})
		}

		return {
			stdin: streams.stdin,
			stdout: streams.stdout,
			stderr: streams.stderr,
			// key always present; consumers read it unconditionally
			control: undefined,
			collected: collectors,
			done,
			terminate: () => entry.terminate(),
			waitForExit,
		}
	}
}
