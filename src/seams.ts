// cordis services must not use #private fields: they are handed out through a proxy, and a private field is
// unreachable from the proxy receiver — the providers below use `_`-prefixed fields for that reason

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

export function FsVersion(version: string): FsVersion {
	return version as FsVersion
}

export type FsEntryType = 'file' | 'directory' | 'symlink' | 'other'

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

export class FsError extends Error {
	code: FsErrorCode

	constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
		super(message, options)
		this.name = 'FsError'
		this.code = code
	}
}

export class FileSystem extends Service {
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

export class SubprocessRuntime extends Service {
	constructor(ctx: Context, slot = 'subprocess') {
		super(ctx, slot)
	}
}

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
	// always present as a key: consumers read it unconditionally
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
