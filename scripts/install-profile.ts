/**
 * Install or remove dsh-ssh from a DSH profile the way the plugin manager does.
 *
 * WHY THIS REPLACED A FILE COPY
 * -----------------------------
 * The first version of this script copied the package into the profile's
 * `node_modules` and appended its name to `dsh.profile.bundles`. That made the
 * plugin load, but it never appeared on the Plugins page. The page lists
 * bundles backed by a manifest dependency; a name in `bundles` with nothing in
 * `dependencies` behind it is not a bundle the manager recognises, so there was
 * no row to toggle. Copying files is not installing a package.
 *
 * This version runs the same `pnpm add` the manager runs, which records the
 * dependency, resolves it, and lets the page show the bundle with its enable
 * toggle. Toggling then writes `disabled` into `cordis.patch.yml` for the
 * matching entry id, or moves the name in and out of `dsh.profile.bundles`.
 *
 * Prefer the Plugins page itself when it is available Ã¢â‚¬â€ it does all of this and
 * shows the result. This script exists for the case where you want the
 * operation scripted.
 *
 * Usage:
 *   node dist/scripts/install-profile.js add    [--profile desktop] [--pnpm <cmd>]
 *   node dist/scripts/install-profile.js remove [--profile desktop] [--pnpm <cmd>]
 *   node dist/scripts/install-profile.js status [--profile desktop]
 */

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

/**
 * Locate a pnpm that works against this profile.
 *
 * The desktop app ships its own, launched through the app binary with
 * `--expose-internals`; that is what the plugin manager invokes, and a pnpm
 * from elsewhere may resolve against a different registry or Node.
 */
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

/** Select or deselect a bundle, preserving list order for everything else. */
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
	// pnpm first: a bundle row only exists once the manifest names the package.
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

// Removal follows the manager's order: deselect and unload before pnpm runs,
// so a failure partway never leaves a selected bundle pointing at a removed
// package.
setBundle('dsh-ssh', false)
const status = runPnpm(['remove', 'dsh-ssh'])
if (status !== 0) console.error(`pnpm remove reported a failure (exit ${status}); the bundle is already deselected`)
console.log('removed dsh-ssh; restart DSH to finish unloading it')
