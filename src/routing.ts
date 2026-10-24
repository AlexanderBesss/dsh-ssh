/**
 * Serving local and remote files from one session, without replacing anything.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The obvious design — register the SSH providers in place of the app's — has
 * two properties that make it fragile, both measured against cordis 4.0.4:
 *
 * 1. Registering a second provider for a name is a hard error
 *    (`service "fs" has been registered at <fs-sandbox>`), so replacing works
 *    only if the local provider is disabled first, by a patch layer. The two
 *    halves of that arrangement fail in opposite directions: if the disable
 *    does not match, this plugin's registration throws and no remote provider
 *    exists; if it does match and this plugin's provider fails to construct,
 *    the app has NO filesystem at all. Every file tool in the UI stops working,
 *    and the local machine's files go with it.
 *
 * 2. Inside a provider of `fs`, `this.ctx.fs` resolves to the provider itself —
 *    `provide()` overwrites the fiber's own view of the name. So a provider
 *    cannot delegate to the implementation it replaced, and "remote except for
 *    a few local paths" is not expressible from inside a provider.
 *
 * Route mode takes the supported path instead: the local providers stay
 * registered and active, and this module publishes a **router** for the names
 * `fs` and `subprocess` through cordis' own read hook, the `internal/get`
 * waterfall (a listener that returns a value vetoes the store lookup). Every
 * consumer in a plugin fiber receives the router; the router classifies one
 * call at a time and forwards it to the SSH provider or to the local provider
 * the app registered.
 *
 * WHAT THE ROUTER GUARANTEES
 * --------------------------
 * It is a Proxy over an object whose prototype is the local implementation, so
 * the service contract is intact: `instanceof` holds, unlisted members exist,
 * symbols pass through. Every function — routed or not — is applied to the
 * implementation that owns it, never to the router. That matters because
 * cordis hands services through proxies, which is exactly why service classes
 * may not use private fields; binding the receiver here keeps the app's own
 * provider free to use them.
 *
 * @module dsh-ssh/routing
 */

import type { Context } from '@deepseek-ai/cordis'
import { contains, isAbsolute, normalize, resolvePath } from './remote-path.js'

/** Which side of the seam serves a call. */
export type RoutingSide = 'remote' | 'local'

/**
 * Which side owns a path: the remote workspace, or this machine.
 *
 * `contains` implements Windows semantics case-insensitively, matching the
 * remote root check the fs provider itself uses. Anything this function cannot
 * classify as a Windows path inside one of the remote roots belongs to the
 * local side, which is the safe default: a misrouted local path fails
 * visibly, a misrouted remote path reads a file nobody asked for.
 *
 * The roots are read through a getter because the picker adds entries while
 * the app runs — a workspace opened on the remote PC joins the set the moment
 * it is prepared, and its sessions route from the first call.
 */
export function sideFor(remoteRoots: () => readonly string[], path: unknown, cwd?: unknown): RoutingSide {
	const value = String(path ?? '')
	if (value.trim().length === 0) {
		return cwd ? sideFor(remoteRoots, cwd, undefined) : 'local'
	}
	try {
		const base = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
		if (base) return remoteRoots().some((root) => contains(root, resolvePath(base, value))) ? 'remote' : 'local'
		if (!isAbsolute(value)) return 'local'
		const normalized = normalize(value)
		return remoteRoots().some((root) => contains(root, normalized)) ? 'remote' : 'local'
	} catch {
		return 'local'
	}
}

/** The side that owns a resolved target, by the path the provider displayed it. */
export function sideForTarget(remoteRoots: () => readonly string[], target: unknown): RoutingSide {
	const display = (target as { displayPath?: unknown } | null | undefined)?.displayPath
	if (typeof display !== 'string' || display.trim().length === 0) return 'local'
	return sideFor(remoteRoots, display, undefined)
}

/** Method-name → side-decision table for {@link createRouter}. */
export type RoutingOverrides = Record<string, (args: any[]) => string>

/**
 * Decide the side for a method the override table does not list, so the router
 * can refuse rather than silently serve a remote-shaped call from the local
 * provider. Returning anything but `'remote'` lets the call through.
 */
export type RoutingFallback = (name: string, args: any[]) => RoutingSide

/**
 * Build a service object that answers `name` by forwarding to whichever
 * implementation owns the call.
 *
 * @param local - the app's own provider instance (raw, unproxied).
 * @param remote - this plugin's provider instance, registered under a private
 * name so consumers never see it.
 * @param overrides - method name → `(...args) => side`, where `'remote'` sends
 * the call to `remote` and anything else to `local`.
 * @param fallback - classification for methods the table does not list; a
 * method it calls `'remote'` is rejected loudly instead of running local,
 * because an unlisted target-taking method would otherwise read the empty
 * local mirror of a remote file and return it as if it were the file.
 */
function createRouter(local: object, remote: object, overrides: RoutingOverrides, fallback?: RoutingFallback): any {
	/** routed implementations, bound to their owner. */
	const routed = new Map<string, Function>()
	for (const name of Object.keys(overrides)) {
		const localFn = Reflect.get(local, name)
		const remoteFn = Reflect.get(remote, name)
		if (typeof localFn !== 'function' && typeof remoteFn !== 'function') continue
		routed.set(name, function (...args: any[]) {
			const useRemote = overrides[name](args) === 'remote'
			const impl = useRemote ? remote : local
			const fn = useRemote ? remoteFn : localFn
			if (typeof fn !== 'function') {
				throw new TypeError(`dsh-ssh: the ${useRemote ? 'remote' : 'local'} provider does not implement "${name}"`)
			}
			return fn.apply(impl, args)
		})
	}

	// A plain object would expose only what we enumerate; a Proxy resolves
	// members against the real provider on demand, including symbols and getters.
	return new Proxy(Object.create(local), {
		get(target, property, receiver) {
			const key = String(property)
			if (routed.has(key)) return routed.get(key)
			const value = Reflect.get(local, property, local)
			// Bind methods so the owner is the receiver: private fields stay legal.
			if (typeof value !== 'function') return value
			if (typeof property !== 'string' || fallback === undefined) return value.bind(local)
			// A method the table does not list still runs local — unless its
			// arguments name a remote target, which no local implementation can
			// honor. Failing visibly beats serving an empty local mirror.
			return function guarded(...args: any[]) {
				if (fallback(property, args) === 'remote') {
					throw new TypeError(`dsh-ssh: "${property}" was not routed to the remote provider although its arguments point at a remote target; add it to the routing table`)
				}
				return value.apply(local, args)
			}
		},
		set(target, property, value) {
			return Reflect.set(local, property, value, local)
		},
		has(target, property) {
			return Reflect.has(local, property)
		},
		deleteProperty(target, property) {
			return Reflect.deleteProperty(local, property)
		},
		getPrototypeOf() {
			return Object.getPrototypeOf(local)
		},
		ownKeys() {
			return Reflect.ownKeys(local)
		},
		getOwnPropertyDescriptor(target, property) {
			return Reflect.getOwnPropertyDescriptor(local, property)
		},
	})
}

/**
 * fs methods whose first argument is a resolved target. Every target-taking
 * method of the real `fs` contract belongs in this list — an omission used to
 * fall through to the local provider silently, and the remote side's empty
 * local mirrors made that read as a real (empty) file. `streamText` is what
 * taught the lesson; the router's fallback classification now catches the
 * class of mistakes loudly instead.
 */
const FS_TARGET_METHODS = [
	'stat', 'readText', 'readBytes', 'readByteRange', 'streamText', 'listDir', 'writeText', 'editText', 'watch',
]

/**
 * The `fs` router. Targets carry the path their provider displayed, so a target
 * produced by the remote side keeps going remote; paths are classified against
 * `remoteRoot` together with the caller's working directory.
 */
export function createFsRouter({ local, remote, remoteRoots }: { local: object; remote: object; remoteRoots: () => readonly string[] }): any {
	const overrides: RoutingOverrides = {}
	for (const name of FS_TARGET_METHODS) {
		overrides[name] = (args) => sideForTarget(remoteRoots, args[0])
	}
	// contains() compares two targets; the parent decides the world.
	overrides.contains = (args) => sideForTarget(remoteRoots, args[0])
	// processPath reads a target's display path only.
	overrides.processPath = (args) => sideForTarget(remoteRoots, args[0])
	overrides.fileUrl = (args) => sideForTarget(remoteRoots, args[0])
	// resolve() and lstat() take a raw path plus an optional working directory.
	overrides.resolve = (args) => sideFor(remoteRoots, args[0], args[1]?.cwd)
	overrides.lstat = (args) => sideFor(remoteRoots, args[0], args[1]?.cwd)
	// processPathFromHostPath maps harness-host paths: a remote world has no
	// mapping to offer, and the local backend is the one that understands them.
	overrides.processPathFromHostPath = () => 'local'
	// A method this table does not list still runs local, but only when its
	// first argument does not name a remote target — a target carries the
	// display path its provider gave it, which is exactly the evidence.
	return createRouter(local, remote, overrides, (_name, args) => {
		const first = args[0]
		if (first !== null && typeof first === 'object' && typeof (first as any).displayPath === 'string') {
			return sideForTarget(remoteRoots, first)
		}
		return 'local'
	})
}

/**
 * The `subprocess` router. A command belongs to the world its working directory
 * lives in, which is the same rule the fs side uses, so `pwsh` in a remote
 * project runs on the remote PC and `pwsh` in a local one runs here.
 *
 * `terminalEnvironment()` carries no working directory — the app asks once for
 * the session's shell facts — so it follows `defaultSide`, and
 * `resolveExecutable` resolves locally first, falling back to the remote PATH
 * when nothing local provides the command.
 */
export function createSubprocessRouter({ local, remote, remoteRoots, defaultSide = 'auto' }: {
	local: object
	remote: object
	remoteRoots: () => readonly string[]
	defaultSide?: string
}): any {
	const byCwd = (args: any[]) => sideFor(remoteRoots, args[0]?.cwd ?? '', undefined)
	const overrides: RoutingOverrides = {
		spawn: byCwd,
		spawnTerminal: byCwd,
		terminalEnvironment: () => (defaultSide === 'remote' ? 'remote' : 'local'),
	}
	// A method the table does not list runs local, unless its options name a
	// working directory inside a remote root — the same rule `spawn` routes by.
	return new Proxy(createRouter(local, remote, overrides, (_name, args) => {
		const cwd = args[0]?.cwd
		return typeof cwd === 'string' && cwd.trim().length > 0 ? sideFor(remoteRoots, cwd, undefined) : 'local'
	}), {
		get(target, property, receiver) {
			if (String(property) !== 'resolveExecutable') return Reflect.get(target, property, receiver)
			return async function resolveExecutable(command: unknown, env: unknown, signal: unknown) {
				const localFn = Reflect.get(local, 'resolveExecutable')
				if (defaultSide === 'remote') {
					const remoteFn = Reflect.get(remote, 'resolveExecutable')
					if (typeof remoteFn === 'function') return remoteFn.apply(remote, [command, env, signal])
				}
				if (typeof localFn === 'function') {
					try {
						return await localFn.apply(local, [command, env, signal])
					} catch (localError) {
						const remoteFn = Reflect.get(remote, 'resolveExecutable')
						if (typeof remoteFn !== 'function') throw localError
						return remoteFn.apply(remote, [command, env, signal])
					}
				}
				const remoteFn = Reflect.get(remote, 'resolveExecutable')
				return remoteFn.apply(remote, [command, env, signal])
			}
		},
	})
}

/**
 * Publish the routers for `fs` and `subprocess` to every consumer fiber;
 * returns a disposer that stops routing.
 *
 * The listener is registered on the context, so it is disposed with the plugin's
 * fiber; the `fiber` guard is required because the hook fires for this plugin's
 * own reads too, and `ctx.fs` inside the plugin must keep returning the local
 * provider — that is where the router borrows its local half from.
 */
export function installRouting(ctx: Context, routers: Record<string, any>) {
	const publish = (name: string) => routers[name]
	return ctx.on('internal/get', (receiver, name, error, next) => {
		if (receiver?.fiber === ctx.fiber) return next()
		const value = publish(name)
		return value === undefined ? next() : value
	})
}
