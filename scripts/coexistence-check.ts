/**
 * Prove the local world and the remote world coexist in one session.
 *
 * Route mode exists because cordis forbids a second `fs` provider and a
 * provider cannot delegate to the implementation it replaced (`this.ctx.fs` is
 * itself); the plugin instead publishes a router on the `internal/get` read
 * path and leaves the local providers registered.
 *
 * This harness registers REAL local providers and counts every call reaching
 * them: each check asserts the answer AND which implementation produced it —
 * a router quietly serving everything over SSH would pass content-only checks,
 * since the remote PC holds the same file names. Also covers a dead remote
 * channel (TEST-NET-1 black hole) and the legacy `mode: 'replace'` takeover.
 *
 * The remote checks need the live remote PC.
 *
 * Usage: node dist/scripts/coexistence-check.js [host] [remoteRoot] [localRoot]
 *
 * @module dsh-ssh/scripts/coexistence-check
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, watch as nodeWatch, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FsError, FsTargetKey, FsVersion, FileSystem, SubprocessExecutableNotFoundError, SubprocessRuntime } from '../src/seams.js'
import * as sshPlugin from '../src/index.js'

const host = process.argv[2] ?? '192.168.0.68'
const remoteRoot = process.argv[3] ?? 'C:\\Users\\AI\\workplace'
const localRoot = normalize(process.argv[4] ?? join(import.meta.dirname, '..', '..'))

/** Arguments for every ssh invocation: never prompt, and fail fast. */
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
/** A host that routes nowhere: the black-hole context's whole point. */
const blackHoleHost = '192.0.2.1'

const results: any[] = []
const clock = { total: 0 }
/** Every context this harness mounted, for teardown. */
const contexts: { label: string; ctx: Context }[] = []

// counters answer one question: which impl served the call; the spawn counter counts spawns only
const stats = { localFsCalls: 0, localSpawnCalls: 0, localSubprocessCalls: 0 }
const blackHoleStats = { localFsCalls: 0, localSpawnCalls: 0, localSubprocessCalls: 0 }

async function step(label: string, fn: () => any) {
	const started = Date.now()
	try {
		const detail = await fn()
		const ms = Date.now() - started
		clock.total += ms
		results.push({ label, ok: true, ms, detail })
		console.log(`PASS  ${label}  (${ms} ms)${detail ? `  — ${detail}` : ''}`)
	} catch (error) {
		const ms = Date.now() - started
		clock.total += ms
		results.push({ label, ok: false, ms, detail: String((error as any)?.message ?? error) })
		console.log(`FAIL  ${label}  (${ms} ms)  — ${(error as any)?.message ?? error}`)
	}
}

const implOf = (ctx: any) => `fs=${ctx.fs?.constructor?.name ?? 'none'} subprocess=${ctx.subprocess?.constructor?.name ?? 'none'}`

const firstLine = (text: any) => String(text).split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? ''

const normalizeText = (content: any) => String(content).replaceAll('\r\n', '\n')

function countOccurrences(content: string, needle: string) {
	let count = 0
	let index = 0
	while (true) {
		const found = content.indexOf(needle, index)
		if (found === -1) return count
		count += 1
		index = found + needle.length
	}
}

function applyLiteralEdit(content: string, oldString: any, newString: any, replaceAll: any, displayPath: string) {
	const oldNorm = normalizeText(oldString)
	if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
	const newNorm = normalizeText(newString)
	const replacements = countOccurrences(content, oldNorm)
	if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
	if (!replaceAll && replacements > 1) {
		throw new FsError(`old_string matched ${replacements} times in "${displayPath}"`, 'FS_AMBIGUOUS_EDIT')
	}
	return { content: content.split(oldNorm).join(newNorm), replacements }
}

// a real cordis service occupying `fs`, so the plugin collides with it exactly as with the app's provider. `_` fields, never `#` (see src/seams.js)
class LocalFileSystem extends FileSystem {
	_root: string
	_counters: any

	constructor(ctx: Context, root: string, counters: any) {
		super(ctx)
		this._root = root
		this._counters = counters
	}

	// one increment per call: this is what proves the local impl answered
	_count() {
		this._counters.localFsCalls += 1
	}

	_pathOf(target: any) {
		return resolve(this._root, String(target?.displayPath ?? target))
	}

	_versionAt(path: string) {
		const info = statSync(path)
		return FsVersion(`${Math.trunc(info.mtimeMs)}:${info.size}:${Math.trunc(info.birthtimeMs)}`)
	}

	_stat(path: string) {
		let info
		try {
			info = statSync(path)
		} catch {
			return undefined
		}
		const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
		return { version: this._versionAt(path), type, size: info.size }
	}

	_decode(buffer: Buffer, displayPath: string, verb: string) {
		if (buffer.subarray(0, 8192).includes(0)) {
			throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
		}
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
		} catch {
			throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
		}
	}

	async resolve(path: any, opts: any) {
		this._count()
		opts?.signal?.throwIfAborted?.()
		const base = opts?.cwd ? resolve(this._root, String(opts.cwd)) : this._root
		const resolved = resolve(base, String(path ?? ''))
		return { targetKey: FsTargetKey(resolved.toLowerCase()), displayPath: resolved }
	}

	async stat(target: any, signal?: AbortSignal) {
		this._count()
		signal?.throwIfAborted?.()
		return this._stat(this._pathOf(target))
	}

	async lstat(path: any, opts: any, signal?: AbortSignal) {
		this._count()
		signal?.throwIfAborted?.()
		const base = opts?.cwd ? resolve(this._root, String(opts.cwd)) : this._root
		const resolved = resolve(base, String(path ?? ''))
		let info
		try {
			info = statSync(resolved)
		} catch {
			return undefined
		}
		const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
		return { version: FsVersion(`${Math.trunc(info.mtimeMs)}:${info.size}:${Math.trunc(info.birthtimeMs)}`), type, size: info.size }
	}

	async readText(target: any, signal?: AbortSignal) {
		this._count()
		signal?.throwIfAborted?.()
		const path = this._pathOf(target)
		let buffer
		try {
			buffer = readFileSync(path)
		} catch (error) {
			throw new FsError(`cannot read "${path}": ${(error as any)?.code ?? (error as any)?.message ?? error}`, 'FS_NOT_FOUND')
		}
		return this._decode(buffer, path, 'read')
	}

	async writeText(target: any, content: string, expected: any, signal?: AbortSignal) {
		this._count()
		signal?.throwIfAborted?.()
		const path = this._pathOf(target)
		const existing = this._stat(path)
		if (existing && existing.type !== 'file') {
			throw new FsError(`cannot write "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
		}
		if (expected?.kind === 'replaceIfVersion') {
			if (!existing) throw new FsError(`cannot write "${path}": file no longer exists`, 'FS_STALE_VERSION')
			if (existing.version !== expected.version) {
				throw new FsError(`cannot write "${path}": file changed since it was read`, 'FS_STALE_VERSION')
			}
		} else if (expected?.kind === 'createIfAbsent' && existing) {
			throw new FsError(`cannot overwrite existing "${path}" without reading it first`, 'FS_NOT_OBSERVED')
		}
		// The pre-write snapshot is what the UI renders a diff against.
		const before = existing ? normalizeText(readFileSync(path, 'utf8')) : null
		writeFileSync(path, content, 'utf8')
		return {
			operation: existing ? 'update' : 'create',
			version: this._versionAt(path),
			before,
			after: normalizeText(content),
		}
	}

	async editText(target: any, edit: any, expected: any, signal?: AbortSignal) {
		this._count()
		signal?.throwIfAborted?.()
		const path = this._pathOf(target)
		const existing = this._stat(path)
		if (!existing) throw new FsError(`cannot edit "${path}": file changed since it was read`, 'FS_STALE_VERSION')
		if (existing.type !== 'file') throw new FsError(`cannot edit "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
		if (expected && existing.version !== expected.version) {
			throw new FsError(`cannot edit "${path}": file changed since it was read`, 'FS_STALE_VERSION')
		}
		const content = this._decode(readFileSync(path), path, 'edit')
		const edited = applyLiteralEdit(normalizeText(content), edit?.oldString, edit?.newString, edit?.replaceAll, path)
		writeFileSync(path, edited.content, 'utf8')
		return { version: this._versionAt(path), before: normalizeText(content), after: edited.content }
	}

	async listDir(target: any, signal?: AbortSignal) {
		this._count()
		signal?.throwIfAborted?.()
		const path = this._pathOf(target)
		let entries
		try {
			entries = readdirSync(path, { withFileTypes: true })
		} catch (error) {
			throw new FsError(`cannot list "${path}": ${(error as any)?.code ?? (error as any)?.message ?? error}`, 'FS_NOT_FOUND')
		}
		return entries.map((entry) => {
			const child = join(path, entry.name)
			const info = this._stat(child)
			return {
				name: entry.name,
				type: info?.type ?? 'other',
				target: { targetKey: FsTargetKey(child.toLowerCase()), displayPath: child },
				...(info ? { version: info.version, size: info.size } : {}),
			}
		})
	}

	/** Case-insensitive containment, as NTFS identity demands. */
	contains(parent: any, child: any) {
		this._count()
		const fold = (value: any) => resolve(this._root, String(value?.displayPath ?? value)).replace(/[\\/]+$/, '').toLowerCase()
		const p = fold(parent)
		const c = fold(child)
		return c === p || c.startsWith(`${p}${sep}`)
	}

	processPath(target: any) {
		this._count()
		return this._pathOf(target)
	}

	// host path maps straight through — the half a remote provider cannot do
	override processPathFromHostPath(hostPath: any) {
		this._count()
		if (hostPath === undefined || hostPath === null) return undefined
		const value = String(hostPath)
		return isAbsolute(value) ? normalize(value) : resolve(this._root, value)
	}

	fileUrl(target: any) {
		this._count()
		return pathToFileURL(this._pathOf(target)).href
	}

	/** No confinement claimed, matching the shipped local backend. */
	override get sandboxMode(): undefined {
		return undefined
	}

	// watches the PARENT dir: fs.watch on a file dies when the file is replaced
	override watch(target: any, changed: () => void, signal?: AbortSignal) {
		this._count()
		signal?.throwIfAborted?.()
		const path = this._pathOf(target)
		const name = basename(path).toLowerCase()
		const watcher = nodeWatch(dirname(path), { persistent: false }, (_event, filename) => {
			if (filename === null || String(filename).toLowerCase() === name) changed()
		})
		watcher.unref?.()
		const dispose = () => watcher.close()
		signal?.addEventListener?.('abort', dispose, { once: true })
		return Promise.resolve({ dispose, [Symbol.asyncDispose]: dispose })
	}
}

// not a cordis service, so plain fields are fine; only services must avoid `#private`
class OutputTail {
	chunks: Buffer[] = []
	bytes = 0
	total = 0
	maxBytes

	constructor(maxBytes: number) {
		this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 256 * 1024
	}

	push(chunk: Buffer) {
		this.chunks.push(chunk)
		this.bytes += chunk.length
		this.total += chunk.length
		while (this.bytes > this.maxBytes && this.chunks.length > 1) {
			this.bytes -= this.chunks.shift()!.length
		}
		if (this.bytes > this.maxBytes) {
			const tail = this.chunks[0].subarray(this.bytes - this.maxBytes)
			this.chunks = [tail]
			this.bytes = tail.length
		}
	}

	readFrom(fromByte: number) {
		const windowStart = this.total - this.bytes
		const buffer = Buffer.concat(this.chunks)
		const lossy = fromByte < windowStart
		return {
			text: (lossy ? buffer : buffer.subarray(Math.max(0, fromByte - windowStart))).toString('utf8'),
			nextOffset: this.total,
			lossy,
		}
	}
}

// the handle shape mirrors the SSH provider's exactly: shape drift would be a coexistence bug
class LocalSubprocess extends SubprocessRuntime {
	_counters: any

	constructor(ctx: Context, counters: any) {
		super(ctx)
		this._counters = counters
	}

	async resolveExecutable(command: any, env: any, signal?: AbortSignal) {
		signal?.throwIfAborted?.()
		this._counters.localSubprocessCalls += 1
		const name = String(command ?? '')
		if (name.length === 0) throw new Error('local stand-in: executable must be non-empty')
		if (name.includes('\0')) {
			const error: any = new TypeError('invalid executable: NUL bytes are not permitted')
			error.code = 'ERR_INVALID_ARG_VALUE'
			throw error
		}
		if (isAbsolute(name)) {
			if (existsSync(name) && statSync(name).isFile()) return name
			throw new SubprocessExecutableNotFoundError(`command ${JSON.stringify(name)} is not an executable file`)
		}
		const pathValue = env?.PATH ?? env?.Path ?? env?.path
		const pathExt = env?.PATHEXT ?? env?.PathExt ?? '.COM;.EXE;.BAT;.CMD'
		const probe = spawnSync('where', [name], {
			encoding: 'utf8',
			windowsHide: true,
			...(pathValue ? { env: { ...process.env, PATH: pathValue } } : {}),
		})
		const lines = String(probe.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
		const suffixes = pathExt.split(';').map((entry: any) => entry.toLowerCase()).filter(Boolean)
		const found = lines.find((line) => suffixes.includes(extname(line).toLowerCase())) ?? lines[0]
		if (found) return found
		throw new SubprocessExecutableNotFoundError(`command ${JSON.stringify(name)} was not found on PATH`)
	}

	async terminalEnvironment(signal?: AbortSignal) {
		signal?.throwIfAborted?.()
		this._counters.localSubprocessCalls += 1
		return { platform: process.platform, defaultShell: process.env.ComSpec ?? undefined }
	}

	async spawnTerminal(spec: any) {
		throw new Error('local stand-in: interactive terminal sessions are not implemented by this harness')
	}

	async warm(localProgram: any) {}

	spawn(spec: any) {
		this._counters.localSpawnCalls += 1
		const argv = spec.argv ?? []
		if (!Array.isArray(argv) || argv.length === 0 || !argv[0]) {
			throw new Error('local stand-in: invalid argv: expected a non-empty program name at argv[0]')
		}
		for (const entry of argv) {
			if (typeof entry === 'string' && entry.includes('\0')) {
				const error: any = new TypeError('invalid argv: NUL bytes are not permitted')
				error.code = 'ERR_INVALID_ARG_VALUE'
				throw error
			}
		}
		const stdio = spec.stdio ?? {}
		const child = nodeSpawn(String(argv[0]), argv.slice(1).map(String), {
			cwd: spec.cwd,
			stdio: 'pipe',
			windowsHide: true,
			...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
		})

		const collectors: Record<string, OutputTail> = {}
		const streams: Record<string, any> = {}
		const attach = (name: string, mode: any, stream: any) => {
			if (!stream) return
			if (mode === 'pipe') {
				streams[name] = stream
				return
			}
			if (mode === 'inherit') {
				stream.pipe(name === 'stdout' ? process.stdout : process.stderr)
				return
			}
			const tail = new OutputTail(mode?.maxBytes)
			collectors[name] = tail
			stream.on('data', (chunk: any) => tail.push(chunk))
		}
		attach('stdout', stdio.stdout, child.stdout)
		attach('stderr', stdio.stderr, child.stderr)

		if (stdio.stdin && typeof stdio.stdin === 'object' && stdio.stdin.data !== undefined) {
			child.stdin!.end(String(stdio.stdin.data))
		} else if (stdio.stdin !== 'pipe') {
			child.stdin!.end()
		} else {
			streams.stdin = child.stdin
		}

		let terminated = false
		const terminate = () => {
			if (terminated || child.exitCode !== null) return
			terminated = true
			child.kill()
			const timer = setTimeout(() => {
				try {
					child.kill('SIGKILL')
				} catch {
					// Already gone.
				}
			}, Number.isFinite(spec.graceMs) && spec.graceMs > 0 ? spec.graceMs : 3000)
			timer.unref?.()
		}
		if (spec.signal) spec.signal.addEventListener('abort', terminate, { once: true })

		const settled = new Promise((resolveDone, rejectDone) => {
			child.on('close', (code, exitSignal) => resolveDone({ exitCode: code, signal: exitSignal }))
			child.on('error', (error) => rejectDone(error))
		})

		return {
			stdin: streams.stdin,
			stdout: streams.stdout,
			stderr: streams.stderr,
			// Present as a key, as the SSH provider exposes it: consumers read it.
			control: undefined,
			collected: collectors,
			done: settled,
			terminate,
			waitForExit: async (signal?: AbortSignal) => {
				if (signal?.aborted) return false
				return settled.then(() => true, () => true)
			},
		}
	}
}

/** Stand-in for the tool registry, so the plugin's `inject: ['tools']` resolves. */
class ToolsStub extends Service {
	registered: any[] = []
	constructor(ctx: Context) {
		super(ctx, 'tools')
	}
	register(tool: any) {
		this.registered.push(tool?.name ?? String(tool))
	}
}

async function run(ctx: any, argv: string[], cwd: string) {
	const handle = ctx.subprocess.spawn({
		argv,
		cwd,
		stdio: { stdout: { maxBytes: 262144 }, stderr: { maxBytes: 65536 }, stdin: 'ignore' },
		graceMs: 3000,
	})
	const outcome = await handle.done
	return {
		outcome,
		stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
		stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
	}
}

// a plugin fiber is the only place cordis runs the read waterfall — the routed view
async function consumerFiber(ctx: any) {
	let scope: any
	await ctx.plugin({
		name: 'coexistence-consumer',
		inject: ['fs', 'subprocess'],
		apply(target: any) {
			scope = target
		},
	})
	return scope
}

async function finish() {
	for (const entry of contexts) {
		try {
			await (entry.ctx as any).stop?.()
		} catch (error) {
			console.log(`  note: teardown of ${entry.label} reported ${(error as any)?.message ?? error}`)
		}
	}
	for (const probe of localProbes) rmSync(probe, { force: true })
	const failed = results.filter((entry) => !entry.ok)
	console.log(`\n${results.length - failed.length}/${results.length} checks passed  |  total ${clock.total} ms`)
	process.exit(failed.length === 0 ? 0 : 1)
}

if (!existsSync(localRoot) || !statSync(localRoot).isDirectory()) {
	console.error(`localRoot is not a directory: ${localRoot}`)
	process.exit(2)
}

// probe names carry pid+time: a crashed run leaves no file a later run reads as its own
const stamp = `${process.pid}-${Date.now()}`
const localProbes = [
	join(localRoot, `dsh-ssh-coexistence-read-${stamp}.txt`),
	join(localRoot, `dsh-ssh-coexistence-write-${stamp}.txt`),
	join(localRoot, `dsh-ssh-coexistence-edit-${stamp}.txt`),
]
const remoteClean = remoteRoot.replace(/[\\/]+$/, '')
const remoteProbe = `${remoteClean}\\dsh-ssh-coexistence-${stamp}.txt`

// probes written with node:fs directly: a passing local read is proof of a local answer
writeFileSync(localProbes[0], 'local world: read served here\n', 'utf8')
writeFileSync(localProbes[2], 'edit me: marker\n', 'utf8')

console.log(`host=${host}  remoteRoot=${remoteRoot}  localRoot=${localRoot}`)
console.log(`node ${process.version} on ${process.platform}\n`)

const ctx = new Context()
contexts.push({ label: 'route', ctx })
new ToolsStub(ctx)
new LocalFileSystem(ctx, localRoot, stats)
new LocalSubprocess(ctx, stats)

const mounted = ctx.plugin(sshPlugin as any, {
	host,
	remoteRoot,
	mode: 'route',
	sshArgs,
})

let mountError: any
await step('route mode mounts with the local providers registered (no duplicate-provider throw)', async () => {
	try {
		await mounted
	} catch (error) {
		mountError = error
		throw error
	}
	return implOf(ctx)
})
if (mountError) {
	// a duplicate `fs` registration is the exact failure route mode exists to avoid
	console.error(`plugin failed to apply: ${mountError?.message ?? mountError}`)
	await finish()
}

// cordis runs the `internal/get` waterfall for plugin fibers only — routing lives there
let scope: any
const consumer = {
	name: 'coexistence-consumer',
	inject: ['fs', 'subprocess'],
	apply(target: any) {
		scope = target
	},
}

await step('a consumer fiber is handed the router, not the local provider', async () => {
	await ctx.plugin(consumer)
	const routed = scope.fs
	// ctx.get reads the store directly — no waterfall, the root context's view
	const direct = ctx.get('fs', false)
	if (routed === direct) {
		throw new Error(`the consumer fiber received the app's own provider (${routed?.constructor?.name}), so nothing was published on the read path (${implOf(scope)})`)
	}
	return `consumer sees ${routed?.constructor?.name}, the store holds ${direct?.constructor?.name}`
})

await step('local read is served by the local implementation', async () => {
	const before = stats.localFsCalls
	const target = await scope.fs.resolve(localProbes[0], {})
	const text = await scope.fs.readText(target)
	const grew = stats.localFsCalls - before
	if (!String(text).includes('local world: read served here')) {
		throw new Error(`readText of ${localProbes[0]} returned ${JSON.stringify(String(text).slice(0, 120))}, not the bytes node:fs wrote there (${implOf(scope)})`)
	}
	if (grew === 0) {
		throw new Error(`readText answered without touching the local provider: localFsCalls stayed at ${before}, so the answer came over ssh (${implOf(scope)})`)
	}
	return `localFsCalls ${before} → ${stats.localFsCalls}, content ${JSON.stringify(firstLine(text))}`
})

await step('remote stat is served by the ssh implementation', async () => {
	const before = stats.localFsCalls
	const target = await scope.fs.resolve(remoteRoot, {})
	const info = await scope.fs.stat(target)
	const after = stats.localFsCalls
	if (info?.type !== 'directory') {
		throw new Error(`stat of ${remoteRoot} = ${JSON.stringify(info)}, expected type=directory (${implOf(scope)})`)
	}
	if (after !== before) {
		throw new Error(`stat of ${remoteRoot} reached the local provider: localFsCalls ${before} → ${after}, so the local disk answered a remote path (${implOf(scope)})`)
	}
	return `${info.type} size=${info.size}, localFsCalls frozen at ${after}`
})

await step('local write lands on the local disk', async () => {
	const before = stats.localFsCalls
	const target = await scope.fs.resolve(localProbes[1], {})
	const written = await scope.fs.writeText(target, 'written locally through the router\n', { kind: 'createIfAbsent' })
	const grew = stats.localFsCalls - before
	if (written?.operation !== 'create') {
		throw new Error(`writeText reported operation=${JSON.stringify(written?.operation)}, expected create (${implOf(scope)})`)
	}
	const onDisk = readFileSync(localProbes[1], 'utf8')
	if (!onDisk.includes('written locally through the router')) {
		throw new Error(`node:fs sees ${JSON.stringify(onDisk.slice(0, 120))} at ${localProbes[1]}: the write went to the remote host, not the local disk (localFsCalls ${before} → ${stats.localFsCalls}, ${implOf(ctx)})`)
	}
	if (grew === 0) {
		throw new Error(`writeText of a local path never reached the local provider: localFsCalls stayed at ${before} (${implOf(scope)})`)
	}
	rmSync(localProbes[1], { force: true })
	return `operation=create, version=${written.version}, verified with node:fs then rmSync; localFsCalls ${before} → ${stats.localFsCalls}`
})

await step('remote write lands on the remote host', async () => {
	const before = stats.localFsCalls
	const target = await scope.fs.resolve(remoteProbe, {})
	const written = await scope.fs.writeText(target, 'written remotely through the router\n', { kind: 'createIfAbsent' })
	const text = await scope.fs.readText(target)
	if (written?.operation !== 'create' || !String(text).includes('written remotely through the router')) {
		throw new Error(`remote probe round trip failed: operation=${JSON.stringify(written?.operation)} read=${JSON.stringify(String(text).slice(0, 120))} (${implOf(scope)})`)
	}
	if (stats.localFsCalls !== before) {
		throw new Error(`the remote probe reached the local provider: localFsCalls ${before} → ${stats.localFsCalls} (${implOf(scope)})`)
	}
	// the fs contract has no delete: removal runs over the subprocess seam, like the pwsh tool
	const removed = await run(scope, ['cmd', '/c', 'del', '/q', remoteProbe], remoteRoot)
	const after = await scope.fs.stat(target)
	if (after?.type === 'file') {
		throw new Error(`probe ${remoteProbe} still present after del (exit=${removed.outcome.exitCode}, out=${JSON.stringify(String(removed.stdout).slice(0, 120))})`)
	}
	return `operation=create, readText confirmed, del exit=${removed.outcome.exitCode}, stat=${after ? after.type : 'gone'}; localFsCalls frozen at ${stats.localFsCalls}`
})

await step('local edit changes the file on the local disk', async () => {
	const before = stats.localFsCalls
	const target = await scope.fs.resolve(localProbes[2], {})
	const edited = await scope.fs.editText(target, { oldString: 'edit me: marker', newString: 'edit me: marker edited locally' })
	const onDisk = readFileSync(localProbes[2], 'utf8')
	if (!String(edited?.after).includes('edited locally') || !onDisk.includes('edited locally')) {
		throw new Error(`editText after=${JSON.stringify(String(edited?.after).slice(0, 120))} node:fs=${JSON.stringify(onDisk.slice(0, 120))}: the local file did not change (${implOf(scope)})`)
	}
	if (stats.localFsCalls - before === 0) {
		throw new Error(`editText of a local path never reached the local provider: localFsCalls stayed at ${before} (${implOf(scope)})`)
	}
	return `before=${JSON.stringify(firstLine(edited.before))} after=${JSON.stringify(firstLine(edited.after))}, confirmed with node:fs; localFsCalls ${before} → ${stats.localFsCalls}`
})

await step('subprocess with a local cwd runs locally', async () => {
	const before = stats.localSpawnCalls
	const probe = await run(scope, ['cmd', '/c', 'cd'], localRoot)
	const after = stats.localSpawnCalls
	const out = String(probe.stdout)
	if (!out.toLowerCase().includes(localRoot.toLowerCase())) {
		throw new Error(`cwd=${localRoot} printed ${JSON.stringify(out.trim().slice(0, 160))}, which is not under the local root (exit=${probe.outcome.exitCode} err=${JSON.stringify(String(probe.stderr).slice(0, 120))}, ${implOf(ctx)})`)
	}
	if (after - before === 0) {
		throw new Error(`a local-cwd spawn answered without touching the local provider: localSpawnCalls stayed at ${before}, so cmd ran over ssh (${implOf(scope)})`)
	}
	return `cd printed ${JSON.stringify(firstLine(out))}; localSpawnCalls ${before} → ${after}`
})

await step('subprocess with a remote cwd runs remotely', async () => {
	const before = stats.localSpawnCalls
	const probe = await run(scope, ['cmd', '/c', 'cd'], remoteRoot)
	const after = stats.localSpawnCalls
	const out = String(probe.stdout)
	// The remote PC's own path can only be printed by a command that ran there.
	if (!out.toLowerCase().includes(remoteClean.toLowerCase())) {
		throw new Error(`cwd=${remoteRoot} printed ${JSON.stringify(out.trim().slice(0, 160))}, which is not the remote root (exit=${probe.outcome.exitCode} err=${JSON.stringify(String(probe.stderr).slice(0, 120))}, ${implOf(ctx)})`)
	}
	if (after !== before) {
		throw new Error(`a remote-cwd spawn reached the local provider: localSpawnCalls ${before} → ${after}, so the local cmd.exe answered a remote cwd (${implOf(scope)})`)
	}
	return `cd printed ${JSON.stringify(firstLine(out))}; localSpawnCalls frozen at ${after}`
})

await step('an unreachable ssh host cannot break local work', async () => {
	const blackHole = new Context()
	contexts.push({ label: `black hole (${blackHoleHost})`, ctx: blackHole })
	new ToolsStub(blackHole)
	new LocalFileSystem(blackHole, localRoot, blackHoleStats)
	new LocalSubprocess(blackHole, blackHoleStats)
	await blackHole.plugin(sshPlugin as any, {
		host: blackHoleHost,
		remoteRoot,
		mode: 'route',
		sshArgs,
	})

	const bh = await consumerFiber(blackHole)
	const beforeFs = blackHoleStats.localFsCalls
	const target = await bh.fs.resolve(localProbes[0], {})
	const text = await bh.fs.readText(target)
	if (!String(text).includes('local world: read served here')) {
		throw new Error(`readText with ${blackHoleHost} unreachable returned ${JSON.stringify(String(text).slice(0, 120))} (${implOf(bh)})`)
	}
	if (blackHoleStats.localFsCalls - beforeFs === 0) {
		throw new Error(`readText of a local file never reached the local provider: localFsCalls stayed at ${beforeFs} (${implOf(bh)})`)
	}

	const beforeSpawn = blackHoleStats.localSpawnCalls
	const probe = await run(bh, ['cmd', '/c', 'echo local-ok'], localRoot)
	const afterSpawn = blackHoleStats.localSpawnCalls
	if (!String(probe.stdout).includes('local-ok')) {
		throw new Error(`echo local-ok with ${blackHoleHost} unreachable returned exit=${probe.outcome.exitCode} out=${JSON.stringify(String(probe.stdout).slice(0, 120))} err=${JSON.stringify(String(probe.stderr).slice(0, 120))} (${implOf(bh)})`)
	}
	if (afterSpawn - beforeSpawn === 0) {
		throw new Error(`the echo did not run locally: localSpawnCalls stayed at ${beforeSpawn} (${implOf(bh)})`)
	}
	return `readText ok, localFsCalls ${beforeFs} → ${blackHoleStats.localFsCalls}; echo ${JSON.stringify(firstLine(probe.stdout))}, localSpawnCalls ${beforeSpawn} → ${afterSpawn}`
})

await step('legacy replace mode still replaces both providers app-wide', async () => {
	const legacy = new Context()
	contexts.push({ label: 'replace', ctx: legacy })
	// no local providers: the pre-coexistence deployment, patch-disabled
	new ToolsStub(legacy)
	await legacy.plugin(sshPlugin as any, {
		host,
		remoteRoot,
		mode: 'replace',
		sshArgs,
	})
	const fsName = legacy.fs?.constructor?.name
	const subprocessName = legacy.subprocess?.constructor?.name
	if (fsName !== 'SshFileSystem') {
		throw new Error(`mode=replace gave ctx.fs=${fsName ?? 'none'}, expected SshFileSystem: the takeover regressed for existing deployments`)
	}
	if (subprocessName !== 'SshSubprocessRuntime') {
		throw new Error(`mode=replace gave ctx.subprocess=${subprocessName ?? 'none'}, expected SshSubprocessRuntime: the takeover regressed for existing deployments`)
	}
	return `ctx.fs=${fsName} ctx.subprocess=${subprocessName}`
})

await finish()
