// checks the INSTALLED copy of dsh-ssh in a profile: a missing peer makes the entry throw and the plugin register nothing, unreported
// run with the app's own Node so the module graph matches what the app sees

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.argv[2] ?? 'desktop'
const host = process.argv[3] ?? '192.168.0.68'
const remoteRoot = process.argv[4] ?? 'C:\\Users\\AI\\workplace'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const profileDir = join(home, 'profiles', profile)
const packageDir = join(profileDir, 'node_modules', 'dsh-ssh')
let pkg: any = {}
try {
	pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
} catch {
	// not installed: the check below reports it
}
const exp = pkg.exports?.['.']
const entry = join(packageDir, (typeof exp === 'string' ? exp : exp?.default) ?? pkg.main ?? 'dist/src/index.js')

const results: { label: string; ok: boolean }[] = []
function check(label: string, ok: boolean, detail = '') {
	results.push({ label, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
	return ok
}

check(`installed at ${packageDir}`, existsSync(packageDir))
check('entry module present', existsSync(entry), entry)
if (!existsSync(entry)) process.exit(1)

// without bundle selection the Plugins page has no row and the composition never mounts it
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
check('declared as a profile dependency', Object.keys(manifest.dependencies ?? {}).includes('dsh-ssh'), manifest.dependencies?.['dsh-ssh'])
check('selected in dsh.profile.bundles', bundles.includes('dsh-ssh'))

const requireFromEntry = createRequire(join(packageDir, 'noop.js'))
for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
	let resolved: string | undefined
	let error: any
	try {
		resolved = requireFromEntry.resolve(`${peer}/package.json`)
	} catch (cause) {
		error = (cause as any)?.code ?? (cause as any)?.message
	}
	check(`peer resolves from the install: ${peer}`, !!resolved, resolved ? `${resolved.split('\\').slice(-2).join('\\')}` : String(error))
}

let plugin: any
try {
	plugin = await import(pathToFileURL(entry).href)
	check('installed entry imports', true, `name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`)
} catch (error) {
	check('installed entry imports', false, String((error as any)?.message ?? error))
	process.exit(1)
}

const { Context, Service } = await import(pathToFileURL(requireFromEntry.resolve('@deepseek-ai/cordis')).href)
const ServiceCtor = Service as abstract new (ctx: any, name: string) => any
class ToolsStub extends ServiceCtor {
	constructor(ctx: any) {
		super(ctx, 'tools')
	}
	register() {}
}
const ctx = new Context()
new ToolsStub(ctx)
const mounted = ctx.plugin(plugin, {
	host,
	remoteRoot,
	sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
})
try {
	await mounted
	check('plugin applies from the installed copy', true)
} catch (error) {
	check('plugin applies from the installed copy', false, String((error as any)?.message ?? error))
	process.exit(1)
}
check('ctx.fs is the SSH provider', ctx.fs?.constructor?.name === 'SshFileSystem', ctx.fs?.constructor?.name)
check('ctx.subprocess is the SSH provider', ctx.subprocess?.constructor?.name === 'SshSubprocessRuntime', ctx.subprocess?.constructor?.name)

try {
	const root = await ctx.fs.resolve('.', {})
	const info = await ctx.fs.stat(root)
	check('remote workspace root is live', info?.type === 'directory', `${root.displayPath} (${info?.type})`)
	const entries = await ctx.fs.listDir(root)
	check('remote project listing', entries.length > 0, `${entries.length} entries: ${entries.slice(0, 6).map((entry: any) => entry.name).join(', ')}`)
} catch (error) {
	check('remote round trip', false, String((error as any)?.message ?? error))
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await ctx.stop?.()
process.exit(failed.length === 0 ? 0 : 1)
