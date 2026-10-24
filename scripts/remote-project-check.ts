/**
 * Prove the plugin can work a real project that lives on the remote PC.
 *
 * Where load-test.ts asserts the provider contract, this drives the same
 * sequence the model-facing tools perform against a live project directory:
 * list, read, write, edit, delete, search with the mapped ripgrep, and build
 * commands through `ctx.subprocess`. Every step is timed, because per-operation
 * latency is the property that decides whether remote work is usable.
 *
 * Usage: node dist/scripts/remote-project-check.js <host> <projectRoot> [localRgExe]
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import * as sshPlugin from '../src/index.js'

const host = process.argv[2] ?? '192.168.0.68'
const projectRoot = process.argv[3] ?? 'C:\\Users\\AI\\workplace\\kirocrew-workspace'
const localRg = process.argv[4]

const results: any[] = []
const clock = { total: 0 }

/** Time one labelled phase and record pass/fail with its latency. */
async function step(label: string, fn: () => any) {
	const started = Date.now()
	try {
		const detail = await fn()
		const ms = Date.now() - started
		clock.total += ms
		results.push({ label, ok: true, ms, detail })
		console.log(`PASS  ${label}  (${ms} ms)${detail ? `  Ã¢â‚¬â€ ${detail}` : ''}`)
	} catch (error) {
		const ms = Date.now() - started
		clock.total += ms
		results.push({ label, ok: false, ms, detail: String((error as any)?.message ?? error) })
		console.log(`FAIL  ${label}  (${ms} ms)  Ã¢â‚¬â€ ${(error as any)?.message ?? error}`)
	}
}

/** Run one remote command through the subprocess seam and collect its output. */
function run(ctx: any, argv: string[], cwd: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const handle = ctx.subprocess.spawn({
			argv,
			cwd,
			stdio: { stdout: { maxBytes: 262144 }, stderr: { maxBytes: 65536 }, stdin: 'ignore' },
			graceMs: 3000,
		})
		handle.done.then((outcome: any) => resolve({
			outcome,
			stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
			stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
		}), reject)
	})
}

const firstLine = (text: any) => String(text).split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? ''

// The plugin declares `inject: ['tools']`, so a stand-in has to *provide* that
// name: without the super(ctx, 'tools') call the plugin silently never starts,
// and every service it registers comes back undefined.
class ToolsStub extends Service {
	constructor(ctx: Context) {
		super(ctx, 'tools')
	}
	register() {}
}

const ctx = new Context()
new ToolsStub(ctx)
const mounted = ctx.plugin(sshPlugin as any, {
	host,
	remoteRoot: projectRoot,
	sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
})
try {
	await mounted
} catch (error) {
	console.error(`plugin failed to apply: ${(error as any)?.message ?? error}`)
	process.exit(1)
}
if (!ctx.fs || !ctx.subprocess) {
	console.error(`the swap did not happen: ctx.fs=${ctx.fs?.constructor?.name} ctx.subprocess=${ctx.subprocess?.constructor?.name}`)
	process.exit(1)
}
console.log(`mounted: ctx.fs=${ctx.fs.constructor.name} ctx.subprocess=${ctx.subprocess.constructor.name}\n`)

// The harness ships ripgrep inside app.asar, which a plain node run cannot see,
// so hand the provider the same path the search tools would have handed it.
// `warm()` is what plugin startup calls, and this step times it: re-uploading
// 5 MB over this channel costs minutes, a verified reuse costs seconds, and that
// difference is the startup cost of every remote session.
await step('warm the remote ripgrep (mapRipgrep)', async () => {
	const usable = localRg && (() => { try { statSync(localRg); return true } catch { return false } })() ? localRg : undefined
	if (!usable) throw new Error('no local rg.exe given; pass one as argv[3]')
	await ctx.subprocess.warm(usable)
	const probe = await run(ctx, ['rg', '--version'], projectRoot)
	return `mapped to ${ctx.subprocess._ripgrepPath}, answered: ${firstLine(probe.stdout || probe.stderr)}`
})

const root = await ctx.fs.resolve('.', {})

await step('list the remote project root', async () => {
	const entries = await ctx.fs.listDir(root)
	return `${entries.length} entries: ${entries.map((entry: any) => `${entry.name}/`).join(' ')}`
})

let sampleFile: any
await step('find a source file in the project (recursive list)', async () => {
	const stack = [root]
	const files: any[] = []
	let listed = 0
	// Six levels, because the project root is the configured remoteRoot and a
	// real project keeps interesting files deeper than the top two directories.
	for (let depth = 0; depth < 6 && stack.length && files.length < 5; depth += 1) {
		const level = stack.splice(0, stack.length)
		for (const dir of level) {
			const entries = await ctx.fs.listDir(dir)
			listed += 1
			for (const entry of entries) {
				if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh') continue
				if (entry.type === 'directory') stack.push(entry.target)
				else if (/\.(json|js|ts|md|txt|py|cs|go)$/i.test(entry.name)) files.push(entry)
			}
		}
	}
	if (!files.length) throw new Error(`no source files found: listed ${listed} directories, ${stack.length} still queued`)
	sampleFile = files[0]
	return `${files.length} found, first: ${sampleFile.target.displayPath}`
})

await step('read that file (read tool path)', async () => {
	const text = await ctx.fs.readText(sampleFile.target)
	return `${text.length} chars, first line: ${JSON.stringify(firstLine(text))}`
})

const probePath = `${projectRoot.replace(/\\+$/, '')}\\dsh-ssh-project-probe.txt`
const probeTarget = await ctx.fs.resolve(probePath, {})

await step('create a file in the project (write tool path)', async () => {
	const written = await ctx.fs.writeText(probeTarget, 'task list\n- verify remote work\n', { kind: 'createIfAbsent' })
	return `operation=${written.operation}`
})

await step('edit that file (edit tool path)', async () => {
	const edited = await ctx.fs.editText(probeTarget, { oldString: '- verify remote work', newString: '- verify remote work\n- ship the plugin' })
	return JSON.stringify(firstLine(edited.after))
})

await step('re-read to confirm the edit landed remotely', async () => {
	const text = await ctx.fs.readText(probeTarget)
	if (!text.includes('ship the plugin')) throw new Error('edit not visible on the remote host')
	return text.replace(/\r?\n/g, ' | ')
})

await step('search the project with ripgrep (grep tool path)', async () => {
	const found = await run(ctx, ['rg', '--files-with-matches', '--line-number', 'task', projectRoot], projectRoot)
	const hits = String(found.stdout).trim().split('\n').filter(Boolean)
	if (!hits.length) throw new Error(`rg found nothing (exit ${found.outcome.exitCode}) ${String(found.stderr).slice(0, 120)}`)
	return `${hits.length} match lines, first: ${firstLine(found.stdout)}`
})

// The search tools hand argv[0] as the *local* packaged rg path, which does not
// exist remotely. The provider must rewrite it onto its own remote copy.
await step('rewrite the local rg argv[0] onto the remote copy', async () => {
	if (!localRg) throw new Error('no local rg path given; pass it as argv[3]')
	const found = await run(ctx, [localRg, '--files', projectRoot], projectRoot)
	const files = String(found.stdout).trim().split('\n').filter(Boolean)
	if (found.outcome.exitCode !== 0 || !files.length) {
		throw new Error(`exit=${found.outcome.exitCode} out=${JSON.stringify(String(found.stdout).slice(0, 120))} err=${JSON.stringify(String(found.stderr).slice(0, 160))}`)
	}
	return `${files.length} files listed by ${files[0].includes(':\\') ? 'the remote rg' : 'rg'} (argv[0] was ${localRg})`
})

await step('run project commands remotely (pwsh tool path)', async () => {
	const node = await run(ctx, ['node', '--version'], projectRoot)
	const dotnet = await run(ctx, ['dotnet', '--version'], projectRoot)
	const git = await run(ctx, ['git', 'status', '--porcelain'], projectRoot)
	return [
		`node ${firstLine(node.stdout) || node.outcome.exitCode}`,
		`dotnet ${firstLine(dotnet.stdout) || dotnet.outcome.exitCode}`,
		`git exit=${git.outcome.exitCode}`,
	].join(', ')
})

await step('delete the probe file over the subprocess seam', async () => {
	const removed = await run(ctx, ['cmd', '/c', 'del', '/q', probePath], projectRoot)
	const after = await ctx.fs.stat(probeTarget)
	if (after?.type === 'file') throw new Error('probe file still present')
	return `del exit=${removed.outcome.exitCode}, stat=${after ? after.type : 'gone'}`
})

const failed = results.filter((entry) => !entry.ok)
const avg = Math.round(results.reduce((sum, entry) => sum + entry.ms, 0) / results.length)
console.log(`\n${results.length - failed.length}/${results.length} checks passed  |  total ${clock.total} ms  |  avg ${avg} ms per check`)
await (ctx as any).stop?.()
process.exit(failed.length === 0 ? 0 : 1)
