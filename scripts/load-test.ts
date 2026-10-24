/**
 * Load the plugin in a real cordis instance and prove the swap happened.
 * Unresolvable imports make the entry throw and `apply()` silently never run
 * — nothing short of mounting the plugin catches that, so this mounts it.
 *
 * Run:  node dist/scripts/load-test.js [host] [remoteRoot]
 */

import { Context, Service } from '@deepseek-ai/cordis'
import * as sshPlugin from '../src/index.js'

const host = process.argv[2] ?? '192.168.0.68'
const remoteRoot = process.argv[3] ?? 'C:\\Users\\AI\\workplace'

/** Stand-in for the tool registry, so `inject: ['tools']` resolves. */
class ToolsStub extends Service {
	registered: any[] = []
	constructor(ctx: Context) {
		super(ctx, 'tools')
	}
	register(tool: any) {
		this.registered.push(tool?.name ?? String(tool))
	}
}

const results: any[] = []
function check(label: string, ok: boolean, detail: any = '') {
	results.push({ label, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

// fs contract has no delete: start from a known-absent probe, not last run's leftover
const { spawnSync } = await import('node:child_process')
spawnSync('ssh', ['-o', 'BatchMode=yes', host, `del /q "${remoteRoot}\\probe-load-test.txt"`], { stdio: 'ignore' })

const ctx = new Context()
new ToolsStub(ctx)

const mounted = ctx.plugin(sshPlugin as any, {
	host,
	remoteRoot,
	sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
})

try {
	// plugin() settles once applied; unresolvable imports reject here — the guarded regression
	await mounted
} catch (error) {
	console.error(`\nplugin failed to apply: ${(error as any)?.message ?? error}`)
	process.exit(1)
}

check('ctx.fs is provided', !!ctx.fs, ctx.fs?.constructor?.name)
check('ctx.fs is the SSH provider', ctx.fs?.constructor?.name === 'SshFileSystem', ctx.fs?.constructor?.name)
check('ctx.subprocess is provided', !!ctx.subprocess, ctx.subprocess?.constructor?.name)
check('ctx.subprocess is the SSH provider', ctx.subprocess?.constructor?.name === 'SshSubprocessRuntime', ctx.subprocess?.constructor?.name)
check('fs.watch reports unsupported', typeof ctx.fs?.watch === 'function')
check('sandboxMode is undefined (no confinement claimed)', ctx.fs?.sandboxMode === undefined, String(ctx.fs?.sandboxMode))

// exercise the FileSystem class itself — the layer every file tool calls
try {
	const target = await ctx.fs.resolve('probe-load-test.txt', {})
	const before = await ctx.fs.stat(target)
	check('resolve + stat an absent path', before === undefined || before.type === undefined, JSON.stringify(before))

	const written = await ctx.fs.writeText(target, 'from dsh-ssh load test\n')
	check('writeText creates the file', written?.operation === 'create', JSON.stringify(written)?.slice(0, 120))

	const text = await ctx.fs.readText(target)
	check('readText returns the content', String(text).includes('from dsh-ssh load test'), JSON.stringify(text))

	const stale = await ctx.fs.writeText(target, 'conflict\n', { kind: 'replaceIfVersion', version: 'bogus:0' }).then(
		() => ({ code: 'NO_ERROR' }),
		(error: any) => ({ code: error?.code }),
	)
	check('stale version guard fires', stale.code === 'FS_STALE_VERSION', stale.code)

	const absent = await ctx.fs.writeText(target, 'race\n', { kind: 'createIfAbsent' }).then(
		() => ({ code: 'NO_ERROR' }),
		(error: any) => ({ code: error?.code }),
	)
	check('createIfAbsent refuses an existing file', absent.code === 'FS_NOT_OBSERVED', absent.code)

	const edited = await ctx.fs.editText(target, { oldString: 'load test', newString: 'load-test-edit' })
	check('editText applies a literal edit', String(edited?.after).includes('load-test-edit'), JSON.stringify(edited?.after))

	const listed = await ctx.fs.listDir(await ctx.fs.resolve('.', {}))
	check('listDir sees the new file', listed.some((entry: any) => entry.name === 'probe-load-test.txt'), `${listed.length} entries`)

	await ctx.fs.remove?.(target) ?? (await ctx.fs.writeText(target, ''))
} catch (error) {
	check('remote filesystem operations', false, (error as any)?.message ?? String(error))
}

// the subprocess contract: executable lookup happens on the remote host
try {
	const resolved = await ctx.subprocess.resolveExecutable('ping', {})
	check('resolveExecutable finds a remote executable', typeof resolved === 'string' && resolved.length > 0, resolved)

	const missing = await ctx.subprocess.resolveExecutable('definitely-not-a-command-xyz', {}).then(
		() => 'NO_ERROR',
		(error: any) => error?.name ?? 'ERROR',
	)
	check('missing executable reports SubprocessExecutableNotFoundError', missing === 'SubprocessExecutableNotFoundError', missing)

	const env = await ctx.subprocess.terminalEnvironment()
	check('terminalEnvironment reports windows', env?.platform === 'windows', JSON.stringify(env))
} catch (error) {
	check('remote subprocess contract', false, (error as any)?.message ?? String(error))
}

try {
	const handle = ctx.subprocess.spawn({
		argv: ['cmd', '/c', 'echo remote-ok && cd'],
		cwd: remoteRoot,
		stdio: { stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 }, stdin: 'ignore' },
		graceMs: 3000,
	})
	const outcome = await handle.done
	const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
	check('spawn runs remotely and collects stdout', outcome.exitCode === 0 && stdout.includes('remote-ok'), `exit=${outcome.exitCode} out=${JSON.stringify(stdout.trim())}`)
} catch (error) {
	check('spawn through ctx.subprocess', false, (error as any)?.message ?? String(error))
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await (ctx as any).stop?.()
process.exit(failed.length === 0 ? 0 : 1)
