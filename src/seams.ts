/**
 * Local stand-ins for the two Service Definition base classes this plugin
 * implements, plus the error vocabulary and contract types they expose.
 *
 * WHY THESE ARE HERE RATHER THAN IMPORTED
 * --------------------------------------
 * `@deepseek-ai/dsh-fs` and `@deepseek-ai/dsh-subprocess` are not on a plugin's
 * module resolution path. A plugin installed under
 * `<DSH_HOME>/profiles/<profile>/node_modules` resolves bare specifiers from
 * that directory upward; those two packages live inside `app.asar`, which that
 * walk never reaches. Importing them makes the entry module throw before
 * `apply()` runs, so the plugin silently registers nothing — a total failure
 * that looks like "the feature doesn't work" rather than a missing dependency.
 *
 * The working plugin in this profile (`dsh-browser`) declares exactly one peer
 * dependency, `@deepseek-ai/cordis`, and imports nothing else internal. That is
 * the pattern this file follows.
 *
 * The substitution is safe because both bases are thin. In the app's own
 * sources they are:
 *
 *   var FileSystem = class extends Service { constructor(ctx) { super(ctx, 'fs') } … }
 *   var SubprocessRuntime = class extends Service { constructor(ctx) { super(ctx, 'subprocess') } }
 *
 * — cordis `Service` subclasses whose only members are defaults this plugin
 * overrides anyway. Registration is cordis' own mechanism (`Service` calls
 * `ctx.reflect.provide(name, self)`), and cordis IS resolvable, so the swap
 * works identically.
 *
 * ONE DOCUMENTED LOSS
 * -------------------
 * The real `FsError` extends `HarnessError` from `@deepseek-ai/dsh-llm`, and the
 * tool layer classifies failures with `error instanceof HarnessError` to attach
 * a structured `{ name, code }` to a tool result. A locally defined `FsError`
 * is a different class identity, so that annotation is dropped and the failure
 * surfaces as its message text. Nothing else changes: the tool layer never
 * branches on fs error codes, and every message here already states the reason
 * and the path. Carrying the real base would require importing a package that
 * does not resolve, which is the failure this file exists to prevent.
 *
 * A SECOND RULE THIS FILE ENCODES
 * --------------------------------
 * **A service class must not use `#private` fields.** Cordis hands out services
 * through a proxy, so a method reached over `ctx.fs` runs with the proxy as its
 * receiver, and a private field is not reachable from a proxy:
 *
 *   TypeError: Receiver must be an instance of class SshFileSystem
 *
 * The shipped local backend has zero `this.#` uses, which is why it never hits
 * this. Both providers here use `_`-prefixed fields for that reason. Classes that
 * are *not* cordis services — `SshTransport`, the output collector — keep real
 * `#` fields, since nothing proxies them.
 *
 * @module dsh-ssh/seams
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'

declare const fsTargetKeyBrand: unique symbol
declare const fsVersionBrand: unique symbol

/**
 * Branded string identities, mirroring the upstream helpers: a backend
 * manufactures keys and versions, a consumer only ever receives one.
 */
export type FsTargetKey = string & { readonly [fsTargetKeyBrand]: 'FsTargetKey' }
export type FsVersion = string & { readonly [fsVersionBrand]: 'FsVersion' }

/** Brand a string as an `FsTargetKey`. Identity function, matching the upstream helper. */
export function FsTargetKey(key: string): FsTargetKey {
	return key as FsTargetKey
}

/** Brand a string as an `FsVersion`. Identity function, matching upstream. */
export function FsVersion(version: string): FsVersion {
	return version as FsVersion
}

/** Entry kinds a backend reports for a path. */
export type FsEntryType = 'file' | 'directory' | 'symlink' | 'other'

/**
 * The `FS_*` codes this plugin's error vocabulary defines. `RemoteAgentError`
 * carries an agent-supplied code through this taxonomy; unknown codes fall back
 * to `FS_IO_ERROR` at the mapping sites.
 */
export type FsErrorCode =
	| 'FS_IO_ERROR'
	| 'FS_NOT_FOUND'
	| 'FS_STALE_VERSION'
	| 'FS_NOT_OBSERVED'
	| 'FS_INVALID_PATH'
	| 'FS_NOT_TEXT'
	| 'FS_NOT_REGULAR_FILE'
	| 'FS_TOO_LARGE'
	| 'FS_ABORTED'
	| 'FS_EDIT_NOT_FOUND'
	| 'FS_AMBIGUOUS_EDIT'

/** One resolved file or directory in this execution world. */
export interface FsTarget {
	targetKey: FsTargetKey
	displayPath: string
}

/** What a stat says about a target. */
export interface FsInfo {
	version: FsVersion
	type: FsEntryType
	size: number
}

/** One child entry of a directory listing. */
export interface FsDirEntry {
	name: string
	type: FsEntryType
	target: FsTarget
	version?: FsVersion
	size?: number
}

/**
 * The conditional-write guard both `writeText` and `editText` accept:
 * `{ kind: 'replaceIfVersion', version }` or `{ kind: 'createIfAbsent' }`.
 */
export interface FsExpected {
	kind?: string
	version?: FsVersion
}

/** A literal match-and-replace edit. */
export interface FsEdit {
	oldString: string
	newString: string
	replaceAll?: boolean
}

/** The result of a conditional write, with the pre-write snapshot for diffs. */
export interface FsWriteResult {
	operation: 'create' | 'update'
	version: FsVersion
	before: string | null
	after: string
}

/** The result of a literal edit. */
export interface FsEditResult {
	version: FsVersion
	before: string
	after: string
}

/** A byte window within a file. */
export interface FsByteRange {
	offset: number
	length: number
}

/** What `watch` hands back: a disposer, disposable in the JS sense too. */
export interface FsWatcher {
	dispose(): void
	[Symbol.asyncDispose]?: () => void
}

/** Options accepted by `resolve` / `lstat` for path resolution. */
export interface FsResolveOptions {
	cwd?: string
	signal?: AbortSignal
}

/** Typed filesystem failure carrying a stable `FS_*` code. */
export class FsError extends Error {
	code: FsErrorCode

	constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
		super(message, options)
		this.name = 'FsError'
		this.code = code
	}
}

/**
 * Abstract filesystem provider, as `ctx.fs`.
 *
 * Mirrors the upstream base: the members below are the defaults, and a backend
 * that overrides all of them behaves identically whether the class came from
 * the package or from here.
 */
export class FileSystem extends Service {
	/**
	 * @param ctx - the cordis context to register into.
	 * @param slot - the service name to occupy. `'fs'` takes over the app's
	 * filesystem; any other name keeps the implementation as a plain service that
	 * no consumer reads, which is what route mode needs (a second `fs` provider
	 * is a hard error in cordis, and a provider cannot delegate to itself).
	 */
	constructor(ctx: Context, slot = 'fs') {
		super(ctx, slot)
	}

	/**
	 * Observe one target for changes. The base has no watching primitive, so it
	 * rejects — which is also the honest answer for a remote backend.
	 */
	watch(target: FsTarget, changed: () => void, signal?: AbortSignal): Promise<FsWatcher> {
		signal?.throwIfAborted?.()
		return Promise.reject(new FsError('Filesystem watching is not supported by this provider.', 'FS_IO_ERROR'))
	}

	/**
	 * The sandbox mode this backend enforces by default. `undefined` means it
	 * does not confine at all, which is what the bare local backend reports too.
	 */
	get sandboxMode(): undefined {
		return undefined
	}

	/**
	 * Map a harness-host path into this filesystem's execution world. A remote
	 * backend cannot read host files, so it exposes no mapping.
	 */
	processPathFromHostPath(hostPath: string): string | undefined {
		return undefined
	}
}

/**
 * Abstract subprocess provider, as `ctx.subprocess`. The upstream base declares
 * no members at all; the contract is documentation, and the four methods a
 * backend must implement are `resolveExecutable`, `terminalEnvironment`,
 * `spawn`, and `spawnTerminal`.
 */
export class SubprocessRuntime extends Service {
	constructor(ctx: Context, slot = 'subprocess') {
		super(ctx, slot)
	}
}

/** Executable lookup completed without finding an executable file. */
export class SubprocessExecutableNotFoundError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'SubprocessExecutableNotFoundError'
	}
}

/* ---------------------------------------------------------------------------
 * The subprocess contract shape, as the documentation in
 * `docs/subprocess-contract.md` describes it and the local provider exposes it.
 * ------------------------------------------------------------------------- */

/** Disposition of one output stream: live pipe, inherited, or collected with a cap. */
export type StdioMode = 'pipe' | 'inherit' | { maxBytes?: number }

/** Disposition of stdin: held open, closed at once, or fed one payload. */
export interface SpawnStdio {
	stdin?: 'pipe' | 'ignore' | { data?: unknown }
	stdout?: StdioMode
	stderr?: StdioMode
}

/** One command request as the executor presents it. */
export interface SpawnSpec {
	argv: string[]
	cwd?: string
	env?: Record<string, string | undefined>
	stdio?: SpawnStdio
	/** Grace between graceful termination and force before the request is abandoned. */
	graceMs: number
	signal?: AbortSignal
}

/** Offset-based, non-consuming read of collected output. */
export interface OutputTailReader {
	readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

/** How a command finished: a remote exit status, or a signal, or neither. */
export interface SpawnOutcome {
	exitCode: number | null
	signal: NodeJS.Signals | null
}

/** The live handle `spawn` returns, as both providers shape it. */
export interface SpawnHandle {
	stdin?: Writable
	stdout?: Readable
	stderr?: Readable
	/** Always present as a key: the contract exposes it even when unused. */
	control?: unknown
	collected: Record<string, OutputTailReader>
	done: Promise<SpawnOutcome>
	terminate(): void
	waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** The shell facts a consumer needs to pick this world's conventions. */
export interface TerminalEnvironment {
	/** The world's platform name as the contract spells it, e.g. `'windows'`. */
	platform: string
	defaultShell?: string
}
