import type { Context } from '@deepseek-ai/cordis'
import { contains, isAbsolute, normalize, resolvePath } from './remote-path.js'

export type RoutingSide = 'remote' | 'local'

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

export function sideForTarget(remoteRoots: () => readonly string[], target: unknown): RoutingSide {
	const display = (target as { displayPath?: unknown } | null | undefined)?.displayPath
	if (typeof display !== 'string' || display.trim().length === 0) return 'local'
	return sideFor(remoteRoots, display, undefined)
}

export type RoutingOverrides = Record<string, (args: any[]) => string>

export type RoutingFallback = (name: string, args: any[]) => RoutingSide

function createRouter(local: object, remote: object, overrides: RoutingOverrides, fallback?: RoutingFallback): any {
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

	return new Proxy(Object.create(local), {
		get(target, property, receiver) {
			const key = String(property)
			if (routed.has(key)) return routed.get(key)
			const value = Reflect.get(local, property, local)
			// methods stay bound to `local`: the app's provider may use private fields, unreachable from any other receiver
			if (typeof value !== 'function') return value
			if (typeof property !== 'string' || fallback === undefined) return value.bind(local)
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

const FS_TARGET_METHODS = [
	'stat', 'readText', 'readBytes', 'readByteRange', 'streamText', 'listDir', 'writeText', 'editText', 'watch',
]

export function createFsRouter({ local, remote, remoteRoots }: { local: object; remote: object; remoteRoots: () => readonly string[] }): any {
	const overrides: RoutingOverrides = {}
	for (const name of FS_TARGET_METHODS) {
		overrides[name] = (args) => sideForTarget(remoteRoots, args[0])
	}
	overrides.contains = (args) => sideForTarget(remoteRoots, args[0])
	overrides.processPath = (args) => sideForTarget(remoteRoots, args[0])
	overrides.fileUrl = (args) => sideForTarget(remoteRoots, args[0])
	overrides.resolve = (args) => sideFor(remoteRoots, args[0], args[1]?.cwd)
	overrides.lstat = (args) => sideFor(remoteRoots, args[0], args[1]?.cwd)
	overrides.processPathFromHostPath = (args) => sideFor(remoteRoots, args[0], undefined)
	return createRouter(local, remote, overrides, (_name, args) => {
		const first = args[0]
		if (first !== null && typeof first === 'object' && typeof (first as any).displayPath === 'string') {
			return sideForTarget(remoteRoots, first)
		}
		return 'local'
	})
}

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

// the fiber guard is required: the hook fires for the plugin's own reads too, and ctx.fs inside the plugin must keep returning the local provider
export function installRouting(ctx: Context, routers: Record<string, any>) {
	const publish = (name: string) => routers[name]
	return ctx.on('internal/get', (receiver, name, error, next) => {
		if (receiver?.fiber === ctx.fiber) return next()
		const value = publish(name)
		return value === undefined ? next() : value
	})
}
