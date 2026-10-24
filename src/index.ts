/**
 * dsh-ssh — work a project that lives on a remote PC.
 *
 * Two seams decide where files and commands live, and this plugin reaches into
 * both of them:
 *
 * - `ctx.fs`          → {@link SshFileSystem}, one `ssh` call per file operation
 * - `ctx.subprocess`  → {@link SshSubprocessRuntime}, one `ssh` call per command
 *
 * The `read` / `write` / `edit` / `glob` / `grep` tools consume `ctx.fs`, and the
 * `pwsh` tool runs through `ctx.subprocess`, so relocating those two services
 * relocates the whole tool family.
 *
 * TWO MODES, BECAUSE REPLACING THEM APP-WIDE IS FRAGILE
 * -----------------------------------------------------
 * `mode: 'route'` (the default) leaves the app's local providers registered and
 * active, and publishes a router that classifies each call: a path under
 * `remoteRoot` is served over SSH, and every other path is served locally, in
 * the same session. See {@link ./routing.ts} for why this is the supported
 * shape — a second provider for `fs` is a hard cordis error, and a provider
 * cannot delegate to itself.
 *
 * `mode: 'replace'` takes over `fs` and `subprocess` outright, for a session
 * that is remote-only. It requires the profile patch to disable the local
 * providers first; with nothing left local, a session cannot touch this
 * machine's files, and if the SSH providers do not come up the app has no
 * filesystem at all. It is a separate composition entry — `dsh-ssh/replace`,
 * see {@link ./replace.ts} — and a `mode: replace` written on THIS row is
 * downgraded to route with a warning, because this entry's gate waits for the
 * very providers that mode withdraws.
 *
 * @module dsh-ssh
 */

import Schema from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SshTransport } from './transport.js'
import { SshFileSystem } from './fs-provider.js'
import { SshSubprocessRuntime } from './subprocess-provider.js'
import { createFsRouter, createSubprocessRouter, installRouting } from './routing.js'
import { registerWorkspaceRoutes } from './workspace-routes.js'
import { createWorkspaceRootStore } from './workspace-roots.js'
import { isAbsolute } from './remote-path.js'

export const name = 'ssh'

/**
 * This entry is the route-mode mount: the gate holds the fiber pending until
 * the app's own `fs`, `subprocess`, and `webServer` all exist, so `apply`
 * reads them synchronously and never has to register anything under the
 * public names. That mattered concretely: at a cold app start an ungated
 * mount ran before `fs` existed, the old fallback registered the SSH
 * providers under `fs`/`subprocess`, and the app's real providers arriving
 * later turned the name clash into a failed fiber.
 *
 * Replace mode is a different entry — `dsh-ssh/replace`, see
 * {@link ./replace.ts} — whose gate is only `['tools']`, because that mode
 * withdraws `fs`/`subprocess` in the patch and provides them itself. A single
 * module-level list cannot serve both shapes, which is why the composition
 * picks the entry, not a config flag.
 */
export const inject = ['tools', 'fs', 'subprocess', 'webServer']

export const Config = Schema.object({
	/**
	 * SSH destination, resolved by the ssh client: a Host alias or [user@]host.
	 * The shipped default is the development peer; the user-facing place to
	 * change it is the profile's own `cordis.patch.yml` (a `- id: ssh` entry),
	 * which is applied after this bundle's layer.
	 */
	host: Schema.string().default('192.168.0.68'),
	/** Absolute path on the remote machine that becomes the workspace root. */
	remoteRoot: Schema.string().required(),
	/**
	 * Suffix in parentheses that remote workspaces get in the sidebar, e.g.
	 * `my-project (remote)`. Set it to the host name when several remotes are
	 * in play.
	 */
	remoteLabel: Schema.string().default('remote'),
	/**
	 * `'route'` serves `remoteRoot` over SSH and every other path from this
	 * machine, in one session — the only value this row acts on. The app-wide
	 * takeover lives in the `dsh-ssh/replace` entry, which forces it; setting
	 * `'replace'` here logs a warning and stays in route.
	 */
	mode: Schema.string().default('route'),
	/**
	 * Which world a session's shell facts come from, for the one call that
	 * carries no working directory (`terminalEnvironment`). `'auto'` and
	 * `'local'` answer for this machine; `'remote'` answers with the remote
	 * platform and shell, for sessions opened entirely on the remote PC.
	 */
	defaultSide: Schema.string().default('auto'),
	/** ssh client binary. */
	sshBin: Schema.string().default('ssh'),
	/** Extra arguments for every ssh invocation. */
	sshArgs: Schema.array(Schema.string()).default([]),
	/** Shell hosting the file-operation agent remotely. */
	remoteShell: Schema.string().default('powershell'),
	/** Ship the packaged ripgrep to the remote host for glob/grep. */
	mapRipgrep: Schema.boolean().default(true),
	/** Budget for bringing the remote channel up (staging the op script). */
	connectTimeoutMs: Schema.number().default(20000),
	/** Budget for one file operation — each is its own ssh invocation. */
	requestTimeoutMs: Schema.number().default(30000),
})

/**
 * The resolved configuration {@link apply} receives: every field with its
 * schema default applied, so nothing below needs to re-check defaults.
 */
export interface SshConfig {
	host: string
	remoteRoot: string
	remoteLabel: string
	mode: string
	defaultSide: string
	sshBin: string
	sshArgs: string[]
	remoteShell: string
	mapRipgrep: boolean
	connectTimeoutMs: number
	requestTimeoutMs: number
}

/**
 * Locate the ripgrep binary the harness ships for this platform.
 *
 * The search tools resolve it themselves at call time; this plugin only needs
 * it to pre-ship a matching copy to the remote host.
 *
 * @returns the local rg.exe path, or undefined when none is found.
 */
function findPackagedRipgrep(): string | undefined {
	// `resourcesPath` exists only when running inside the packaged Electron app;
	// plain `node` runs (the harnesses) leave it undefined.
	const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
	if (!resources) return undefined
	const scope = join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@vscode')
	if (!existsSync(scope)) return undefined
	for (const entry of readdirSync(scope)) {
		if (!entry.startsWith('ripgrep')) continue
		const candidate = join(scope, entry, 'bin', 'rg.exe')
		if (existsSync(candidate)) return candidate
	}
	return undefined
}

/**
 * Register the diagnostic tool, if the tool-definition helper resolves.
 *
 * `@deepseek-ai/dsh-tools` is not on a plugin's module resolution path in every
 * deployment — the same reason {@link ./seams.ts} exists. A status readout is
 * worth having for a remote backend and is not worth failing the plugin over,
 * so this is attempted rather than required, and the file and shell tools work
 * either way.
 *
 * @param ctx - the cordis context.
 * @param config - resolved plugin configuration.
 * @param transport - the SSH transport to report on.
 * @param filesystem - the remote filesystem to probe for the root.
 * @returns resolves once registration has happened, or immediately when the
 *   helper is unavailable.
 */
async function registerStatusTool(ctx: Context, config: SshConfig, transport: SshTransport, filesystem: SshFileSystem): Promise<void> {
	let defineTool: any
	try {
		;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
	} catch {
		ctx.logger.info('dsh-ssh: tool helper unavailable, skipping the ssh_status tool')
		return
	}
	if (typeof defineTool !== 'function') return

	ctx.tools.register(defineTool({
		name: 'ssh_status',
		description: 'Report the dsh-ssh connection: remote host, OS, user, workspace root, and whether the remote file-operation agent and ripgrep mapping are live. Use it to verify the remote setup before relying on the file and shell tools.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: true,
				properties: {
					host: { type: 'string' },
					remoteRoot: { type: 'string' },
					rootExists: { type: 'boolean' },
				},
			},
			render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		},
		async execute() {
			const root = await filesystem.stat(await filesystem.resolve('.', {})).catch(() => undefined)
			return {
				host: config.host,
				remoteRoot: config.remoteRoot,
				rootExists: root?.type === 'directory',
				rootType: root?.type ?? 'missing',
				system: transport.system ?? null,
			}
		},
	}))
}

/**
 * Transient boot diagnostics: the loader mount order at app start decides
 * whether `fs`/`subprocess`/`webServer` are already registered when `apply`
 * runs, and the `ctx.logger` stream is not readable from outside the packaged
 * host. Append one line per decision point to a file in the OS temp directory
 * so a restart leaves readable evidence — never beside the package, which
 * under a real install would be a read-only program directory. Wrapped
 * entirely; a failure to write must not change behavior.
 */
function bootTrace(message: string): void {
	try {
		appendFileSync(join(tmpdir(), 'dsh-ssh-boot-trace.log'), `[${new Date().toISOString()}] ${message}\n`)
	} catch {}
}

/**
 * The shared body of both entries. `config.mode` decides the shape: route
 * mode (this module's entry) borrows the app's providers and routes by path;
 * replace mode ( {@link ./replace.ts} ) arrives with `mode` already forced.
 * `allowReplace` marks the replace entry: the route-mode entry must never
 * take the public names, because its own gate is waiting for exactly the
 * providers replace mode withdraws — the fiber would hang pending and the
 * app would lose its filesystem. A `mode: replace` config that arrives
 * through the wrong entry downgrades to route with a warning instead.
 */
export function applyModule(ctx: Context, config: SshConfig, allowReplace = false): void {
	bootTrace(`apply start (mode=${config.mode}) fs=${!!ctx.get?.('fs', false)} subprocess=${!!ctx.get?.('subprocess', false)} webServer=${!!ctx.get?.('webServer', false)}`)
	if (!isAbsolute(config.remoteRoot)) {
		ctx.logger.error(`dsh-ssh: remoteRoot must be an absolute remote path, got "${config.remoteRoot}"`)
		return
	}

	let mode = config.mode
	if (mode === 'replace' && !allowReplace) {
		ctx.logger.warn('dsh-ssh: mode "replace" requested through the route-mode entry, whose inject gate waits for the very providers replace mode withdraws — staying in route mode. Mount "dsh-ssh/replace" for the remote-only shape.')
		mode = 'route'
	}
	if (mode !== 'route' && mode !== 'replace') {
		ctx.logger.warn(`dsh-ssh: unknown mode "${mode}", using "route"`)
		mode = 'route'
	}

	const transport = new SshTransport({
		host: config.host,
		sshBin: config.sshBin,
		sshArgs: config.sshArgs,
		remoteShell: config.remoteShell,
		connectTimeoutMs: config.connectTimeoutMs,
		requestTimeoutMs: config.requestTimeoutMs,
	})

	// Unloading the plugin must not leave a remote PowerShell running.
	ctx.effect(() => () => {
		transport.close()
	}, 'dsh-ssh: remote agent lifecycle')

	// Paths the picker has prepared join the routing set as additional remote
	// roots, so a workspace opened anywhere on the remote PC is served over
	// SSH by the sessions that use it — and the set survives restarts.
	const workspaceRoots = createWorkspaceRootStore(config.host)
	const remoteRoots = () => [config.remoteRoot, ...workspaceRoots.roots()]

	// In route mode the SSH providers register under private names, invisible to
	// consumers, and a router publishes them as `fs` / `subprocess`. Under
	// 'replace' they occupy the names themselves, which is why that mode needs
	// the local providers disabled by the profile patch.
	const localFs = mode === 'replace' ? undefined : ctx.get?.('fs', false)
	const localSubprocess = mode === 'replace' ? undefined : ctx.get?.('subprocess', false)
	const route = mode !== 'replace' && !!localFs && !!localSubprocess
	bootTrace(`routing decision: route=${route}`)
	if (mode !== 'replace' && !route) {
		ctx.logger.error('dsh-ssh: route mode did not find the app\'s fs and subprocess providers; refusing to register anything under the public names (that fallback clashed with the real providers at a cold start and failed the fiber). Through the route-mode entry the inject gate should make this state unreachable; if you are seeing it, this row was mounted through dsh-ssh/replace or with a patched inject list while the local providers were left in place.')
	}

	// Only 'replace' mode (where the patch has withdrawn the local providers)
	// may take the public names; everything else stays under private names so
	// a name clash can never fail the fiber or hijack the app.
	const filesystem = new SshFileSystem(ctx, { cwd: config.remoteRoot }, transport, mode === 'replace' ? 'fs' : 'ssh-fs')
	const subprocess = new SshSubprocessRuntime(ctx, { mapRipgrep: config.mapRipgrep }, transport, mode === 'replace' ? 'subprocess' : 'ssh-subprocess')

	if (route) {
		// The raw instance behind each service proxy: cordis binds method receivers
		// to a proxy, and the router must call the implementation itself.
		const raw = (service: any) => service?.[symbols.original] ?? service
		const fsRouter = createFsRouter({
			local: raw(localFs),
			remote: filesystem,
			remoteRoots,
		})
		const subprocessRouter = createSubprocessRouter({
			local: raw(localSubprocess),
			remote: subprocess,
			remoteRoots,
			defaultSide: config.defaultSide,
		})
		installRouting(ctx, { fs: fsRouter, subprocess: subprocessRouter })
		ctx.logger.info(`dsh-ssh: routing ${config.remoteRoot} to ${config.host}; all other paths stay on this machine`)
	}

	// Bring the channel up and pre-ship ripgrep off the critical path, so the
	// first tool call does not pay for agent startup plus a 5 MB upload.
	void (async () => {
		await transport.connect()
		const facts = transport.system
		ctx.logger.info(`dsh-ssh: connected to ${config.host} (${facts?.machine ?? 'unknown host'}, ${facts?.os ?? 'unknown OS'})`)
		if (config.mapRipgrep) await subprocess.warm(findPackagedRipgrep())
	})().catch((error) => {
		ctx.logger.error(`dsh-ssh: could not reach ${config.host}: ${error?.message ?? error}`)
	})

	void registerStatusTool(ctx, config, transport, filesystem).catch((error) => {
		ctx.logger.warn?.(`dsh-ssh: ssh_status tool not registered: ${error?.message ?? error}`)
	})

	// The remote-workspace picker's host half (browser half: src/client,
	// served through the './client' export). Through the route-mode entry the
	// `webServer` gate guarantees it is present when `apply` runs, so the
	// inject callback fires at once; through the replace entry
	// (`dsh-ssh/replace`, gate `['tools']`) this same block waits for a web
	// server or leaves the picker routes down in a headless composition.
	//
	// The retry timer below is not decoration. Observed against the shipped
	// 0.2 composition, a cold start could leave the inject callback unfired
	// even with the service already registered — while a mid-session re-mount
	// of the same row worked from the identical code. `ctx.get` deliberately
	// bypasses the inject gate — exactly how route mode reads `fs` — so a few
	// seconds of polling covers the boot window without holding the fiber
	// hostage when no web server exists.
	let routesUp = false
	const bringUpRoutes = (webServer: any, via: string): void => {
		if (routesUp || !webServer) return
		try {
			const dispose = registerWorkspaceRoutes(config, transport, webServer, workspaceRoots)
			routesUp = true
			ctx.effect(() => dispose, 'dsh-ssh: workspace picker routes')
			bootTrace(`workspace picker routes registered (${via})`)
		} catch (error: any) {
			bootTrace(`route registration failed (${via}): ${error?.message ?? error}`)
		}
	}

	ctx.inject(['webServer'], (scope: any) => {
		bootTrace('webServer inject callback fired')
		bringUpRoutes(scope.webServer, 'inject')
	})

	const pollDeadline = Date.now() + 300_000
	let pollCount = 0
	const timer = setInterval(() => {
		if (routesUp) {
			clearInterval(timer)
			return
		}
		if (Date.now() > pollDeadline) {
			clearInterval(timer)
			bootTrace('webServer never appeared; picker routes stay down')
			return
		}
		const webServer = (ctx as any).get?.('webServer', false)
		if (webServer) {
			if (pollCount < 3) bootTrace(`webServer visible to ctx.get; inject callback had not fired`)
			bringUpRoutes(webServer, 'poll')
			clearInterval(timer)
		}
		pollCount += 1
	}, 3000)
	timer.unref?.()
	ctx.effect(() => () => clearInterval(timer), 'dsh-ssh: picker route bring-up timer')
}

/**
 * The route-mode entry point: what the loader mounts for `name: dsh-ssh`.
 * Replace mode mounts {@link ./replace.ts} instead — the inject gate is
 * per-entry, and the two modes need different ones.
 */
export function apply(ctx: Context, config: SshConfig): void {
	applyModule(ctx, config)
}
