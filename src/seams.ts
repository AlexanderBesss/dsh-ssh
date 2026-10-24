/**
 * Local stand-ins for the app's `fs` / `subprocess` base classes: internal
 * `@deepseek-ai/dsh-*` packages do not resolve from an installed plugin, and
 * importing them would break the entry module before `apply()` runs.
 *
 * MUST KEEP: service classes must not use `#private` fields — cordis hands out
 * services through a proxy, and a private field is unreachable from the proxy
 * receiver. The providers below use `_`-prefixed fields for that reason.
 *
 * @module dsh-ssh/seams
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'

declare const fsTargetKeyBrand: unique symbol
declare const fsVersionBrand: unique symbol

export type FsTargetKey = string & { readonly [fsTargetKeyBrand]: 'FsTargetKey' }
export type FsVersion = string & { readonly [fsVersionBrand]: 'FsVersion' }

export function FsTargetKey(key: string): FsTargetKey {
	return key as FsTargetKey
}

/** Brand a string as an `FsVersion`. Identity function, matching upstream. */
export function FsVersion(version: string): FsVersion {
	return version as FsVersion
}

export type FsEntryType = 'file' | 'directory' | 'symlink' | 'other'

/** The `FS_*` codes this plugin's errors use; unknown remote codes map to `FS_IO_ERROR`. */
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

export interface FsTarget {
	targetKey: FsTargetKey
	displayPath: string
}

export interface FsInfo {
	version: FsVersion
	type: FsEntryType
	size: number
}

export interface FsDirEntry {
	name: string
	type: FsEntryType
	target: FsTarget
	version?: FsVersion
	size?: number
}

/** Conditional-write guard: `{ kind: 'replaceIfVersion', version }` or `{ kind: 'createIfAbsent' }`. */
export interface FsExpected {
	kind?: string
	version?: FsVersion
}

export interface FsEdit {
	oldString: string
	newString: string
	replaceAll?: boolean
}

export interface FsWriteResult {
	operation: 'create' | 'update'
	version: FsVersion
	before: string | null
	after: string
}

export interface FsEditResult {
	version: FsVersion
	before: string
	after: string
}

export interface FsByteRange {
	offset: number
	length: number
}

export interface FsWatcher {
	dispose(): void
	[Symbol.asyncDispose]?: () => void
}

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

/** Abstract filesystem provider, as `ctx.fs`. */
export class FileSystem extends Service {
	/** `'fs'` takes the public name; any other name stays invisible to consumers (route mode). */
	constructor(ctx: Context, slot = 'fs') {
		super(ctx, slot)
	}

	watch(target: FsTarget, changed: () => void, signal?: AbortSignal): Promise<FsWatcher> {
		signal?.throwIfAborted?.()
		return Promise.reject(new FsError('Filesystem watching is not supported by this provider.', 'FS_IO_ERROR'))
	}

	get sandboxMode(): undefined {
		return undefined
	}

	processPathFromHostPath(hostPath: string): string | undefined {
		return undefined
	}
}

/** The methods a subprocess backend must add: `resolveExecutable`, `terminalEnvironment`, `spawn`, `spawnTerminal`. */
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

export type StdioMode = 'pipe' | 'inherit' | { maxBytes?: number }

export interface SpawnStdio {
	stdin?: 'pipe' | 'ignore' | { data?: unknown }
	stdout?: StdioMode
	stderr?: StdioMode
}

export interface SpawnSpec {
	argv: string[]
	cwd?: string
	env?: Record<string, string | undefined>
	stdio?: SpawnStdio
	/** Grace between graceful termination and force before the request is abandoned. */
	graceMs: number
	signal?: AbortSignal
}

export interface OutputTailReader {
	readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

export interface SpawnOutcome {
	exitCode: number | null
	signal: NodeJS.Signals | null
}

export interface SpawnHandle {
	stdin?: Writable
	stdout?: Readable
	stderr?: Readable
	/** Always present as a key: consumers read it unconditionally. */
	control?: unknown
	collected: Record<string, OutputTailReader>
	done: Promise<SpawnOutcome>
	terminate(): void
	waitForExit(signal?: AbortSignal): Promise<boolean>
}

export interface TerminalEnvironment {
	platform: string
	defaultShell?: string
}
