/**
 * SSH-backed `ctx.subprocess` provider.
 *
 * This is the seam that relocates the model-facing `pwsh` tool without touching
 * it: `dsh-pwsh-local` declares `inject = ["subprocess"]` and spawns through
 * `ctx.subprocess.spawn(...)`, so replacing this service moves every PowerShell
 * command to the remote machine while the executor keeps owning command
 * construction, output budgets, and the exit-marker format.
 *
 * Each command is one `ssh` invocation with real piped stdio, which is the only
 * shape the contract's raw-stream and exit-code requirements fit here. The
 * API catalog's unbuilt `ctx.ssh` seam describes the same shape DSH intends — a
 * verified remote helper plus "one authenticated stream through an independent
 * SSH channel" — and this provider is the shipped-today approximation of it.
 *
 * @module dsh-ssh/subprocess-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from './seams.js'
import type { SpawnHandle, SpawnOutcome, SpawnSpec, StdioMode, TerminalEnvironment } from './seams.js'
import type { SshTransport } from './transport.js'

/** Configuration this provider is constructed with. */
export interface SshSubprocessConfig {
	/** Remote working directory default, when a spawn omits `cwd`. */
	cwd?: string
	/** Shell hosting remote commands; informational on this transport. */
	remoteShell?: string
	/** Whether the packaged ripgrep is mapped onto a remote copy. */
	mapRipgrep?: boolean
}

/** Upper bound on a terminate-escalation grace, matching the shared timer bound. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/**
 * Binary payload per upload chunk.
 *
 * Measured against a real Windows host: a request body carried as stdin text is
 * relayed reliably up to about 128 KB of base64, and stalls with no output at
 * all beyond about 256 KB, because the remote default shell does not forward a
 * large stdin write to its child. 64 KB of binary is 88 KB of base64, which
 * sits inside the reliable range with margin.
 */
const UPLOAD_CHUNK_BYTES = 64 * 1024
/** Windows executable suffixes tried when a command carries no extension. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** A live command as tracked for teardown: both members must exist. */
interface LiveEntry {
	terminate(): void
	waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** Reject any string containing a NUL, which no spawn API can carry. */
function assertNoNul(value: unknown, label: string): void {
	if (typeof value === 'string' && value.includes('\0')) {
		const error = new TypeError(`invalid ${label}: NUL bytes are not permitted`) as NodeJS.ErrnoException
		error.code = 'ERR_INVALID_ARG_VALUE'
		throw error
	}
}

/**
 * A bounded in-memory tail with offset-based, non-consuming reads, matching the
 * collector shape the local provider exposes. No spill file is written, so
 * `spillPath` is simply absent; the contract treats that as a valid provider
 * choice as long as `lossy` and `nextOffset` stay truthful.
 */
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

	/**
	 * @param slot - the service name to occupy: `'subprocess'` to replace the
	 * app's runtime outright, or a private name for route mode.
	 */
	constructor(ctx: Context, config: SshSubprocessConfig, transport: SshTransport, slot = 'subprocess') {
		super(ctx, slot)
		this._config = config
		this._transport = transport
		// Teardown belongs to the composition, not to a method nobody calls:
		// unloading the plugin must stop every remote command still running.
		ctx.effect(() => async () => {
			for (const entry of this._live) entry.terminate()
			await Promise.all([...this._live].map((entry) => entry.waitForExit().catch(() => true)))
			this._live.clear()
		}, 'dsh-ssh subprocess teardown')
	}

	/**
	 * Look an executable up in the remote execution world, honouring the
	 * caller's PATH layering and Windows PATHEXT, as the contract requires for
	 * paths that must belong to the same world as the mounted filesystem.
	 */
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

	/** The remote world's shell facts, so consumers pick Windows conventions. */
	async terminalEnvironment(signal?: AbortSignal): Promise<TerminalEnvironment> {
		signal?.throwIfAborted?.()
		const comspec = this._transport.system?.comspec
		return {
			platform: 'windows',
			// The key is omitted rather than set to undefined: consumers fall
			// back to `cmd.exe` only when the key is absent.
			...(comspec ? { defaultShell: comspec } : {}),
		}
	}

	/**
	 * Interactive terminal sessions are not offered over this transport. A PTY
	 * would need a remote pseudoconsole relay; refusing is the honest answer,
	 * and the terminal UI stays unavailable instead of silently misbehaving.
	 */
	async spawnTerminal(): Promise<never> {
		throw new Error('dsh-ssh: remote terminal sessions are not supported; use the pwsh tool for remote commands')
	}

	/**
	 * Recognize the ripgrep binary the harness packages locally.
	 *
	 * `dsh-tool-fs-search` resolves its own bundled ripgrep and hands that
	 * absolute local path to `ctx.subprocess` as argv[0]. It does not exist on
	 * the remote host, so the provider maps it onto a remote copy it ships
	 * itself: the search tools stay untouched and no remote install is needed.
	 */
	_isPackagedRipgrep(program: string): boolean {
		if (this._config.mapRipgrep === false) return false
		return /[\\/]@vscode[\\/]ripgrep/i.test(program) || /^(?:rg|rg\.exe)$/i.test(basename(program))
	}

	/**
	 * Upload the locally packaged rg.exe once, then reuse the remote copy.
	 *
	 * Each chunk is written to its own numbered part file rather than appended
	 * to one growing file. That makes a chunk idempotent, so a stalled request
	 * can be retried without duplicating bytes — the failure mode an append
	 * based upload cannot recover from. The parts are then concatenated
	 * remotely and the result is verified by SHA-256 before it moves into
	 * place. A 5 MB binary over an intermittently stalling channel is exactly
	 * the thing that half-completes, and a truncated `rg.exe` would look like a
	 * search bug rather than a transport one.
	 */
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

			// Reuse a copy an earlier session already shipped. The check costs two
			// round trips (~1 s); the upload costs 5 MB over a channel that
			// intermittently stalls — measured at 408 s for one session start.
			// Identity is the SHA-256, so a remote build of a different ripgrep
			// version is not mistaken for a match.
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

	/**
	 * Resolve argv[0] without awaiting.
	 *
	 * `spawn` must hand back a live handle synchronously, so the upload cannot
	 * happen on this path. Before it lands the search tools run against a remote
	 * `rg` on PATH; {@link warm} pre-ships the binary at startup so that
	 * fallback is rarely what actually runs.
	 */
	_resolveProgram(program: string): string {
		if (!this._isPackagedRipgrep(program)) return program
		if (this._ripgrepPath) return this._ripgrepPath
		void this._ensureRemoteRipgrep(program).catch(() => {})
		return 'rg'
	}

	/**
	 * Ship the packaged ripgrep to the remote host, called at startup so the
	 * first `glob` / `grep` already runs against the mapped binary.
	 */
	async warm(localProgram?: string): Promise<void> {
		if (this._config.mapRipgrep === false || !localProgram) return
		await this._ensureRemoteRipgrep(localProgram)
	}

	/** Synchronous spec validation, mirroring the local provider's rejections. */
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

	/**
	 * Build the remote command line.
	 *
	 * Two parsers stand between this plugin and the remote program, and both
	 * mangle conventional quoting: `cmd.exe` (the remote default shell) toggles
	 * quotes naively, so an element like `a"&calc` escapes its escaping and the
	 * `&calc` executes; and PowerShell 5.1's own argv rewrite for native
	 * commands corrupts embedded quotes even when `cmd.exe` never sees them.
	 * So neither shell ever parses user-influenced text. The invocation is one
	 * PowerShell script that starts the process through .NET directly —
	 * `ProcessStartInfo` with `FileName`, a hand-built MSVCRT-quoted
	 * `Arguments` line (the same scheme libuv uses locally; .NET's
	 * `ArgumentList` is absent on older framework installs), `WorkingDirectory`
	 * and per-process `EnvironmentVariables`, output handles inherited from the
	 * ssh channel — and that script crosses the wire as a base64
	 * `-EncodedCommand` payload whose alphabet contains no shell metacharacter
	 * at all.
	 *
	 * Costs, stated honestly: the payload inflates the script about 2.7×
	 * inside the (8191-char) remote command line, so very long single commands
	 * can hit the limit sooner than a raw scheme; and the .NET-framework
	 * semantics apply (Windows 10 ships it everywhere).
	 *
	 * Only the request's explicit `env` layers on top of the remote's own
	 * environment: the local parent environment belongs to a different machine
	 * and is deliberately not forwarded.
	 */
	_remoteCommand(spec: SpawnSpec): string {
		const argv = [...spec.argv]
		argv[0] = this._resolveProgram(String(argv[0]))
		// A PowerShell single-quoted literal: no interpolation, and the only
		// escape is doubling the quote itself. Values carrying newlines are
		// re-materialized at runtime from base64 instead — a raw newline inside
		// a `; `-joined statement list would end the statement, and a
		// here-string's `'@` terminator can be forged by the value's own
		// content; the base64 alphabet contains neither quotes nor newlines.
		const q = (value: string): string =>
			value.includes('\n') || value.includes('\r')
				? `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')))`
				: `'${value.replace(/'/g, "''")}'`
		// The MSVCRT command-line quoting, i.e. the exact scheme Node's own
		// spawner (libuv) uses locally and .NET's ArgumentList builds when the
		// property exists — it is absent on older .NET Framework installs, so
		// the line is composed here and handed over whole.
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
			// Progress records arrive as CLIXML on stderr otherwise, which the
			// contract would hand back as the command's own stderr.
			"$ProgressPreference = 'SilentlyContinue'",
			'$si = New-Object Diagnostics.ProcessStartInfo',
			// Must precede EnvironmentVariables access: setting that map while
			// shell-execute is on throws.
			'$si.UseShellExecute = $false',
			`$si.FileName = ${q(String(argv[0]))}`,
			`$si.Arguments = ${q(argv.slice(1).map((entry) => msvcQuote(String(entry))).join(' '))}`,
		]
		if (spec.cwd) statements.push(`$si.WorkingDirectory = ${q(String(spec.cwd))}`)
		for (const [key, value] of Object.entries(spec.env ?? {})) {
			if (value === undefined) continue
			statements.push(`$si.EnvironmentVariables[${q(key)}] = ${q(String(value))}`)
		}
		statements.push('$proc = [Diagnostics.Process]::Start($si)')
		statements.push('$proc.WaitForExit()')
		statements.push('exit $proc.ExitCode')
		const encoded = Buffer.from(statements.join('; '), 'utf16le').toString('base64')
		return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`
	}

	/** Spawn one remote command and bind it to the contract's handle shape. */
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
				// The harness host has no interactive console to inherit, so the
				// nearest honest equivalent is this process's own stream.
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
				// Closing the SSH channel is the graceful tier; the local client
				// is then forced off if the remote side has not settled.
				child.kill()
				const timer = setTimeout(() => {
					try {
						child.kill('SIGKILL')
					} catch {
						// Already gone.
					}
				}, spec.graceMs)
				timer.unref?.()
			},
			waitForExit: (signal) => waitForExit(signal),
		}
		this._live.add(entry)

		// Detach the caller's abort listener once the command settles, so a
		// long-lived signal does not accumulate listeners across spawns.
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
				// ssh propagates the remote exit status, so a numeric code is a
				// real remote outcome; a null code with no signal is a transport
				// failure and the contract wants that rejected, not resolved.
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

		/**
		 * Resolve true once the remote command's own exit is observed.
		 *
		 * ssh carries the direct command's exit status, so that part is
		 * proven. Descendants the command spawned remotely are NOT proven
		 * quiescent — there is no remote process-range owner over this
		 * transport — so this is weaker than the local provider's managed
		 * range and is documented as such rather than passed off as equal.
		 */
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
			// Always present: the contract exposes the key even when no control
			// channel was requested, and consumers read it unconditionally.
			control: undefined,
			collected: collectors,
			done,
			terminate: () => entry.terminate(),
			waitForExit,
		}
	}
}
