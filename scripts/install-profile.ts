import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const argv = process.argv.slice(2)
const action = argv[0]
const flagValue = (name: string) => {
	const index = argv.indexOf(name)
	return index === -1 ? undefined : argv[index + 1]
}
const profile = flagValue('--profile') ?? 'desktop'

if (!['add', 'remove', 'status'].includes(action!)) {
	console.error('usage: node dist/scripts/install-profile.js <add|remove|status> [--profile desktop] [--pnpm <cmd>]')
	process.exit(2)
}

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const profileDir = join(home, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
	console.error(`no profile manifest at ${manifestPath}`)
	process.exit(1)
}

const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'))
const writeManifest = (manifest: any) => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// the desktop app's own pnpm (via the app binary, --expose-internals) is what the plugin manager invokes; others may hit a different registry/Node
function findPnpm() {
	const explicit = flagValue('--pnpm')
	if (explicit) return { command: explicit, args: [] }
	const appDir = process.env.DSH_APP_DIR
		?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
	const launcher = join(appDir, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
	const host = join(appDir, 'DeepSeek Harness.exe')
	if (existsSync(launcher) && existsSync(host)) {
		return { command: host, args: ['--expose-internals', launcher] }
	}
	return { command: 'pnpm', args: [] }
}

function runPnpm(args: string[]) {
	const { command, args: prefix } = findPnpm()
	console.log(`> ${command} ${[...prefix, ...args].join(' ')}`)
	const result = spawnSync(command, [...prefix, ...args], {
		cwd: profileDir,
		stdio: 'inherit',
		shell: false,
		windowsHide: true,
	})
	if (result.error) {
		console.error(`pnpm run failed to start: ${result.error.message}`)
		process.exit(1)
	}
	return result.status ?? 1
}

function setBundle(name: string, selected: boolean) {
	const manifest = readManifest()
	manifest.dsh ??= {}
	manifest.dsh.profile ??= {}
	manifest.dsh.profile.bundles ??= []
	const bundles = manifest.dsh.profile.bundles
	if (selected && !bundles.includes(name)) bundles.push(name)
	if (!selected) manifest.dsh.profile.bundles = bundles.filter((entry: any) => entry !== name)
	writeManifest(manifest)
}

if (action === 'status') {
	const manifest = readManifest()
	const bundles = manifest.dsh?.profile?.bundles ?? []
	const dependencies = manifest.dependencies ?? {}
	console.log(`profile: ${profileDir}`)
	console.log(`  in dsh.profile.bundles: ${bundles.includes('dsh-ssh')}`)
	console.log(`  in dependencies:      ${Object.keys(dependencies).includes('dsh-ssh') ? dependencies['dsh-ssh'] : false}`)
	process.exit(0)
}

if (action === 'add') {
	// pnpm first: a bundle row only exists once the manifest names the package
	const status = runPnpm(['add', pkgRoot])
	if (status !== 0) {
		console.error('pnpm add failed; the bundle was not selected')
		process.exit(status)
	}
	setBundle('dsh-ssh', true)
	console.log('installed and selected dsh-ssh')
	console.log('  set host and remoteRoot in the ssh row of cordis.patch.yml')
	console.log('  the Plugins page now lists it with an enable toggle')
	process.exit(0)
}

// deselect before pnpm remove: a mid-way failure never leaves a selected bundle pointing at a removed package
setBundle('dsh-ssh', false)
const status = runPnpm(['remove', 'dsh-ssh'])
if (status !== 0) console.error(`pnpm remove reported a failure (exit ${status}); the bundle is already deselected`)
console.log('removed dsh-ssh; restart DSH to finish unloading it')
