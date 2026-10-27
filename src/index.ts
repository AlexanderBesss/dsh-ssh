/**
 * dsh-ssh route-mode entry. The app-wide takeover is the separate
 * `dsh-ssh/replace` entry (see ./replace.ts); a `mode: replace` written on
 * this row downgrades to route with a warning.
 *
 * @module dsh-ssh
 */

import Schema from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { SshTransport } from './transport.js'
import { SshFileSystem } from './fs-provider.js'
import { SshSubprocessRuntime } from './subprocess-provider.js'
import { createFsRouter, createSubprocessRouter, installRouting } from './routing.js'
import { registerWorkspaceRoutes } from './workspace-routes.js'
import { createWorkspaceRootStore } from './workspace-roots.js'
import { createMirror } from './materialize.js'
import { isAbsolute } from './remote-path.js'

export const name = 'ssh'

/** Route-mode gate: hold the fiber until the app's fs/subprocess/webServer exist, so `apply` reads them synchronously and never registers under the public names. */
export const inject = ['tools', 'fs', 'subprocess', 'webServer']

// the Plugins page form edits exactly the volatile fields; dropping .volatile() hides the form
export const Config = Schema.object({
	host: Schema.string().default('192.168.0.100').volatile(),
	remoteRoot: Schema.string().required().volatile(),
	remoteLabel: Schema.string().default('remote').volatile(),
	mode: Schema.string().default('route'),
	defaultSide: Schema.string().default('auto'),
	sshBin: Schema.string().default('ssh'),
	sshArgs: Schema.array(Schema.string()).default([]),
	remoteShell: Schema.string().default('powershell'),
	mapRipgrep: Schema.boolean().default(true),
	connectTimeoutMs: Schema.number().default(20000),
	requestTimeoutMs: Schema.number().default(30000),
})

export interface SshConfig {
	host: Volatile<string>
	remoteRoot: Volatile<string>
	remoteLabel: Volatile<string>
	mode: string
	defaultSide: string
	sshBin: string
	sshArgs: string[]
	remoteShell: string
	mapRipgrep: boolean
	connectTimeoutMs: number
	requestTimeoutMs: number
}

export interface SshRuntime extends Omit<SshConfig, 'host' | 'remoteRoot' | 'remoteLabel'> {
	host: string
	remoteRoot: string
	remoteLabel: string
}

function findPackagedRipgrep(): string | undefined {
	// resourcesPath exists only in the packaged Electron app
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

/** `dsh-tools` may not resolve here (same reason as seams); a status tool must never fail the plugin. */
async function registerStatusTool(ctx: Context, config: SshRuntime, transport: SshTransport, filesystem: SshFileSystem): Promise<void> {
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

/** Boot diagnostics: appends decision points to a %TEMP% log (never beside a read-only install). Failures are fully swallowed. */
function bootTrace(message: string): void {
	try {
		appendFileSync(join(tmpdir(), 'dsh-ssh-boot-trace.log'), `[${new Date().toISOString()}] ${message}\n`)
	} catch {}
}

/** The mode this mount will run: a misrequested `replace` downgrades to route. */
function resolveMode(ctx: Context, config: SshRuntime, allowReplace: boolean): string {
	let mode = config.mode
	if (mode === 'replace' && !allowReplace) {
		ctx.logger.warn('dsh-ssh: mode "replace" requested through the route-mode entry, whose inject gate waits for the very providers replace mode withdraws — staying in route mode. Mount "dsh-ssh/replace" for the remote-only shape.')
		mode = 'route'
	}
	if (mode !== 'route' && mode !== 'replace') {
		ctx.logger.warn(`dsh-ssh: unknown mode "${mode}", using "route"`)
		mode = 'route'
	}
	return mode
}

/** The router forwards to the raw instances behind the service proxies — cordis binds method receivers to the proxy. */
function publishRouters(
	ctx: Context,
	config: SshRuntime,
	localFs: any,
	localSubprocess: any,
	filesystem: SshFileSystem,
	subprocess: SshSubprocessRuntime,
	remoteRoots: () => string[],
): void {
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

/** Bring the channel up and pre-ship ripgrep off the critical path. */
function connectAndWarm(ctx: Context, config: SshRuntime, transport: SshTransport, subprocess: SshSubprocessRuntime): void {
	void (async () => {
		await transport.connect()
		const facts = transport.system
		ctx.logger.info(`dsh-ssh: connected to ${config.host} (${facts?.machine ?? 'unknown host'}, ${facts?.os ?? 'unknown OS'})`)
		if (config.mapRipgrep) await subprocess.warm(findPackagedRipgrep())
	})().catch((error) => {
		ctx.logger.error(`dsh-ssh: could not reach ${config.host}: ${error?.message ?? error}`)
	})
}

/**
 * The remote-workspace picker's host half (browser half: src/client, via the
 * './client' export). The poll timer is not decoration: on a cold start the
 * inject callback could stay unfired even with the service registered, and
 * `ctx.get` deliberately bypasses the inject gate — exactly how route mode
 * reads `fs`.
 */
function bringUpWorkspacePicker(ctx: Context, config: SshRuntime, transport: SshTransport, workspaceRoots: ReturnType<typeof createWorkspaceRootStore>): void {
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

/** Shared body of both entries. `allowReplace` marks the replace entry; the route-mode entry must never take the public names — its gate waits for exactly the providers replace mode withdraws. */
export function applyModule(ctx: Context, config: SshConfig, allowReplace = false): void {
	const runtime: SshRuntime = {
		...config,
		host: config.host.get(),
		remoteRoot: config.remoteRoot.get(),
		remoteLabel: config.remoteLabel.get(),
	}
	bootTrace(`apply start (mode=${config.mode}) fs=${!!ctx.get?.('fs', false)} subprocess=${!!ctx.get?.('subprocess', false)} webServer=${!!ctx.get?.('webServer', false)}`)
	if (!isAbsolute(runtime.remoteRoot)) {
		ctx.logger.error(`dsh-ssh: remoteRoot must be an absolute remote path, got "${runtime.remoteRoot}"`)
		return
	}

	const mode = resolveMode(ctx, runtime, allowReplace)

	const transport = new SshTransport({
		host: runtime.host,
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

	// picker-prepared roots join the routing set and survive restarts
	const workspaceRoots = createWorkspaceRootStore(runtime.host)
	const remoteRoots = () => [runtime.remoteRoot, ...workspaceRoots.roots()]

	const localFs = mode === 'replace' ? undefined : ctx.get?.('fs', false)
	const localSubprocess = mode === 'replace' ? undefined : ctx.get?.('subprocess', false)
	const route = mode !== 'replace' && !!localFs && !!localSubprocess
	bootTrace(`routing decision: route=${route}`)
	if (mode !== 'replace' && !route) {
		ctx.logger.error('dsh-ssh: route mode did not find the app\'s fs and subprocess providers; refusing to register anything under the public names (that fallback clashed with the real providers at a cold start and failed the fiber). Through the route-mode entry the inject gate should make this state unreachable; if you are seeing it, this row was mounted through dsh-ssh/replace or with a patched inject list while the local providers were left in place.')
	}

	// only 'replace' may take the public names; private names make a clash impossible
	const filesystem = new SshFileSystem(
		ctx,
		{ cwd: runtime.remoteRoot, mirror: mode === 'replace' ? undefined : createMirror(remoteRoots) },
		transport,
		mode === 'replace' ? 'fs' : 'ssh-fs',
	)
	const subprocess = new SshSubprocessRuntime(
		ctx,
		{ mapRipgrep: config.mapRipgrep, remoteRoots },
		transport,
		mode === 'replace' ? 'subprocess' : 'ssh-subprocess',
	)

	if (route) publishRouters(ctx, runtime, localFs, localSubprocess, filesystem, subprocess, remoteRoots)

	connectAndWarm(ctx, runtime, transport, subprocess)

	void registerStatusTool(ctx, runtime, transport, filesystem).catch((error) => {
		ctx.logger.warn?.(`dsh-ssh: ssh_status tool not registered: ${error?.message ?? error}`)
	})

	bringUpWorkspacePicker(ctx, runtime, transport, workspaceRoots)

	ctx.inject(['settings'], (scope: any) => {
		const dispose = scope.settings.configure({ auto: false }, ctx.fiber)
		return () => dispose()
	})
}

export function apply(ctx: Context, config: SshConfig): void {
	applyModule(ctx, config)
}
