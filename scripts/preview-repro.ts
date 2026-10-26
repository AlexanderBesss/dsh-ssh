import { Context, Service } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync, watch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as sshPlugin from '../src/index.js'
import { FsError, FileSystem, SubprocessRuntime } from '../src/seams.js'

const host = process.argv[2] ?? '192.168.0.68'
const projectRoot = process.argv[3] ?? 'C:\\project\\security_ai_benchmark'
const probeRel = process.argv[4] ?? 'out/qwen3.8-flash-next-iq3_s/full-2026-10-26/report.md'

class ToolsStub extends Service {
	constructor(ctx: Context) {
		super(ctx, 'tools')
	}
	register() {}
}

class WebServerStub extends Service {
	constructor(ctx: Context) {
		super(ctx, 'webServer')
	}
	add() {
		return () => {}
	}
}

class LocalFs extends FileSystem {
	constructor(ctx: Context) {
		super(ctx, 'fs')
	}
	async resolve(p: unknown, opts?: any): Promise<any> {
		const raw = String(p)
		const joined = path.isAbsolute(raw) ? raw : path.resolve(opts?.cwd ?? '.', raw)
		return { targetKey: joined.toLowerCase(), displayPath: joined }
	}
	processPath(target: any): string {
		return target.displayPath
	}
	fileUrl(target: any): string {
		return pathToFileURL(target.displayPath).href
	}
	contains(parent: any, child: any): boolean {
		const a = parent.displayPath.replace(/[\\/]+$/, '')
		return child.displayPath === a || child.displayPath.startsWith(a + path.sep)
	}
	async lstat(p: unknown, opts?: any): Promise<any> {
		const joined = path.isAbsolute(String(p)) ? String(p) : path.resolve(opts?.cwd ?? '.', String(p))
		try {
			const info = lstatSync(joined)
			return { version: `local:${info.mtimeMs}:${info.size}`, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
		} catch {
			return undefined
		}
	}
	async stat(target: any): Promise<any> {
		try {
			const info = statSync(target.displayPath)
			return { version: `local:${info.mtimeMs}:${info.size}`, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
		} catch {
			return undefined
		}
	}
	async readText(target: any): Promise<string> {
		if (!existsSync(target.displayPath)) throw new FsError(`local mirror has no ${target.displayPath}`, 'FS_NOT_FOUND')
		return readFileSync(target.displayPath, 'utf8')
	}
	async streamText(target: any): Promise<any> {
		return this.readText(target)
	}
	async listDir(target: any): Promise<any[]> {
		return readdirSync(target.displayPath, { withFileTypes: true }).map((entry) => ({
			name: entry.name,
			type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
			target: { targetKey: path.join(target.displayPath, entry.name).toLowerCase(), displayPath: path.join(target.displayPath, entry.name) },
		}))
	}
	override async watch(target: any): Promise<any> {
		const watcher = watch(path.dirname(target.displayPath))
		return { dispose: () => watcher.close() }
	}
}

class LocalSub extends SubprocessRuntime {
	constructor(ctx: Context) {
		super(ctx, 'subprocess')
	}
	async resolveExecutable(command: string): Promise<string> {
		return command
	}
	spawn(spec: any): any {
		const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true, shell: false })
		let stdout = ''
		let stderr = ''
		child.stdout?.on('data', (chunk) => {
			stdout += String(chunk)
		})
		child.stderr?.on('data', (chunk) => {
			stderr += String(chunk)
		})
		const done = new Promise((resolve) => child.once('close', (code) => resolve({ exitCode: code, signal: null })))
		return {
			control: {},
			collected: {
				stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
				stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
			},
			done,
			terminate() {
				child.kill()
			},
			waitForExit: () => done,
		}
	}
}

let consumerCtx: any
const results: string[] = []
function record(label: string, detail: string) {
	results.push(`${label} — ${detail}`)
	console.log(`${label} — ${detail}`)
}

async function statVia(scope: any, tag: string) {
	const root = await scope.fs.resolve(projectRoot, {})
	const entry = await scope.fs.lstat(probeRel, { cwd: projectRoot })
	const target = await scope.fs.resolve(probeRel, { cwd: projectRoot })
	const info = await scope.fs.stat(target)
	const inside = scope.fs.contains(root, target)
	record(`${tag}.stat`, `lstat=${entry ? entry.type : 'undefined'} stat=${info ? `${info.type} ${info.size}b v=${String(info.version).slice(0, 24)}` : 'undefined'} contains=${inside}`)
	return target
}

async function readVia(scope: any, tag: string, target: any) {
	try {
		const text = await scope.fs.streamText(target)
		record(`${tag}.read`, `streamText ${String(text).length} chars; first=${String(text).slice(0, 60).replace(/\n/g, ' ')}`)
	} catch (error: any) {
		record(`${tag}.read`, `FAILED code=${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 140)}`)
	}
}

async function watchVia(scope: any, tag: string, target: any) {
	try {
		const w = await scope.fs.watch(target, () => {})
		w?.dispose?.()
		record(`${tag}.watch`, 'succeeded (local provider watching)')
	} catch (error: any) {
		record(`${tag}.watch`, `refused: ${String(error?.message ?? error).slice(0, 100)}`)
	}
}

async function listVia(scope: any, tag: string) {
	const root = await scope.fs.resolve(projectRoot, {})
	const entries = await scope.fs.listDir(root)
	record(`${tag}.listDir`, `${entries.length} entries: ${entries.slice(0, 6).map((e: any) => e.name).join(', ')}`)
}

async function urlVia(scope: any, tag: string, target: any) {
	record(`${tag}.urls`, `processPath=${scope.fs.processPath(target)} fileUrl=${scope.fs.fileUrl(target)} processPathFromHostPath=${String(scope.fs.processPathFromHostPath(target.displayPath))}`)
}

async function gitVia(scope: any, tag: string) {
	const handle = scope.subprocess.spawn({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd: projectRoot, stdio: { stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 }, stdin: 'ignore' }, graceMs: 3000 })
	const outcome: any = await handle.done
	record(`${tag}.git`, `exit=${outcome.exitCode} out=${String(handle.collected?.stdout?.readFrom(0)?.text ?? '').trim().slice(0, 70)} err=${String(handle.collected?.stderr?.readFrom(0)?.text ?? '').trim().slice(0, 90)}`)
}

function spawnCollect(scope: any, spec: any): Promise<{ exit: number | null; stdout: string; stderr: string }> {
	const handle = scope.subprocess.spawn({ stdio: { stdout: { maxBytes: 262144 }, stderr: { maxBytes: 65536 }, stdin: 'ignore' }, graceMs: 15000, ...spec })
	return handle.done.then((outcome: any) => ({
		exit: outcome.exitCode ?? -1,
		stdout: String(handle.collected?.stdout?.readFrom(0)?.text ?? ''),
		stderr: String(handle.collected?.stderr?.readFrom(0)?.text ?? ''),
	}))
}

async function gitTurnVia(scope: any, tag: string) {
	const scratch = path.join(os.tmpdir(), 'dsh-changes-probe-fixed')
	const gitDir = path.join(projectRoot, '.git')
	const envBase = {
		GIT_CONFIG_COUNT: '0',
		GIT_TERMINAL_PROMPT: '0',
		GIT_OPTIONAL_LOCKS: '0',
		LC_ALL: 'C',
		GIT_INDEX_FILE: path.join(scratch, 'index-probe'),
		GIT_OBJECT_DIRECTORY: path.join(scratch, 'objects'),
		GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, 'objects'),
	}
	let add: { exit: number | null; stdout: string; stderr: string } | undefined
	let attempts = 0
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		attempts = attempt
		add = await spawnCollect(scope, { argv: ['git', 'add', '--all', '--ignore-errors'], cwd: projectRoot, env: envBase })
		if (add.exit === 0) break
		await new Promise((r) => setTimeout(r, 2000))
	}
	record(`${tag}.git-add`, `exit=${add?.exit ?? 'none'} attempts=${attempts} err=${add?.stderr.trim().slice(0, 140) ?? ''}`)
	if (add?.exit !== 0) return
	const wt = await spawnCollect(scope, { argv: ['git', 'write-tree'], cwd: projectRoot, env: envBase })
	record(`${tag}.git-write-tree`, `exit=${wt.exit} tree=${wt.stdout.trim().slice(0, 42)} err=${wt.stderr.trim().slice(0, 120)}`)
	if (wt.exit === 0 && /^[0-9a-f]{40}$/.test(wt.stdout.trim())) {
		const lt = await spawnCollect(scope, {
			argv: ['git', 'ls-tree', '-z', '-l', wt.stdout.trim()],
			cwd: projectRoot,
			env: { ...envBase, GIT_LITERAL_PATHSPECS: '1' },
		})
		record(`${tag}.git-ls-tree`, `exit=${lt.exit} entries=${lt.stdout.split('\0').filter(Boolean).length}`)
	}
	rmSync(scratch, { recursive: true, force: true })
}

async function hostMapVia(scope: any, tag: string, target: any) {
	const mapped = scope.fs.processPathFromHostPath(target.displayPath)
	const roundTrip = typeof mapped === 'string' ? scope.fs.processPath(await scope.fs.resolve(mapped, {})) : undefined
	record(`${tag}.host-map`, `mapped=${String(mapped)} roundtrip-equal=${roundTrip === target.displayPath}`)
}

async function mirrorVia(scope: any, tag: string) {
	const rel = 'notes/dsh-ssh-fixcheck.md'
	const target = await scope.fs.resolve(rel, { cwd: projectRoot })
	const local = target.displayPath
	await scope.fs.writeText(target, 'fix-check v1\n')
	await new Promise((r) => setTimeout(r, 300))
	const afterWrite = existsSync(local) ? readFileSync(local, 'utf8') : '<missing>'
	const edited = await scope.fs.editText(target, { oldString: 'v1', newString: 'v2' })
	const afterEdit = existsSync(local) ? readFileSync(local, 'utf8') : '<missing>'
	record(`${tag}.mirror-write`, `local-after-write=${JSON.stringify(afterWrite)} local-after-edit=${JSON.stringify(afterEdit)} edit-after=${JSON.stringify(edited.after)}`)
	await scope.fs.writeText(await scope.fs.resolve('notes/dsh-ssh-readwarm.md', { cwd: projectRoot }), 'read-warm probe\n')
	const warmTarget = await scope.fs.resolve('notes/dsh-ssh-readwarm.md', { cwd: projectRoot })
	await scope.fs.readBytes(warmTarget)
	await new Promise((r) => setTimeout(r, 300))
	const warm = existsSync(warmTarget.displayPath) ? readFileSync(warmTarget.displayPath, 'utf8') : '<missing>'
	record(`${tag}.mirror-read`, `local-after-readBytes=${JSON.stringify(warm)}`)
	for (const cleanup of [target, warmTarget]) {
		await spawnCollect(scope, { argv: ['cmd', '/c', 'if', 'exist', cleanup.displayPath, 'del', cleanup.displayPath], cwd: projectRoot })
	}
	const gone = await scope.fs.stat(target)
	record(`${tag}.mirror-cleanup`, `remote-stat-after-cleanup=${gone ? gone.type : 'undefined'}`)
	if (existsSync(local)) rmSync(local)
	if (existsSync(warmTarget.displayPath)) rmSync(warmTarget.displayPath)
}

const ctx = new Context()
new ToolsStub(ctx)
new WebServerStub(ctx)
new LocalFs(ctx)
new LocalSub(ctx)

await ctx.plugin({ name: 'preview-consumer', inject: ['fs', 'subprocess'], apply: (scope: any) => { consumerCtx = scope } })

const targetBefore = await statVia(consumerCtx, 'before-ssh')
await readVia(consumerCtx, 'before-ssh', targetBefore)
await watchVia(consumerCtx, 'before-ssh', targetBefore)

await ctx.plugin(sshPlugin as any, {
	host,
	remoteRoot: 'C:\\Users\\Public\\workplace',
	mode: 'route',
	sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
})

const targetAfter = await statVia(consumerCtx, 'after-ssh')
await readVia(consumerCtx, 'after-ssh', targetAfter)
await watchVia(consumerCtx, 'after-ssh', targetAfter)
await listVia(consumerCtx, 'after-ssh')
await urlVia(consumerCtx, 'after-ssh', targetAfter)
await gitVia(consumerCtx, 'after-ssh')
await hostMapVia(consumerCtx, 'after-ssh', targetAfter)
await mirrorVia(consumerCtx, 'after-ssh')
await gitTurnVia(consumerCtx, 'after-ssh')

await (ctx as any).stop?.()
process.exit(0)
