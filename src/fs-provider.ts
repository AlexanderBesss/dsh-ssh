/**
 * SSH-backed `ctx.fs` provider.
 *
 * Implements the `dsh-fs` provider contract against a remote Windows host, so
 * the model-facing `read` / `write` / `edit` tools operate there with no change
 * of their own. The contract is what makes this possible: it names what a
 * storage layer can do and never how it stores bytes, and its own documentation
 * treats a remote backend as an expected shape rather than an experiment.
 *
 * Identity and I/O paths are deliberately separated. `targetKey` is case-folded
 * so the same file reached as `D:\Src\A.ts` and `D:\src\a.ts` shares one stale
 * version guard, mirroring what `fs.realpath` gives the local backend on NTFS.
 * `displayPath` keeps the caller's spelling and is the path actually used for
 * I/O, so a new file is created with the case the model asked for rather than a
 * folded one.
 *
 * @module dsh-ssh/fs-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion, FileSystem } from './seams.js'
import type {
	FsByteRange,
	FsDirEntry,
	FsEdit,
	FsEditResult,
	FsExpected,
	FsInfo,
	FsResolveOptions,
	FsTarget,
	FsWriteResult,
} from './seams.js'
import { RemoteAgentError } from './transport.js'
import type { AgentResult, SshTransport } from './transport.js'
import { contains, normalize, resolvePath, targetKey } from './remote-path.js'

/** Configuration this provider is constructed with: the remote workspace root. */
export interface SshFileSystemConfig {
	/** The remote directory relative paths resolve against. */
	cwd: string
	/** Cap on the content snapshot returned alongside a write, for diffs. */
	diffBasisMaxBytes?: number
}

/** Which line-ending style a file used. */
type LineEndings = 'CRLF' | 'LF'

/** Leading bytes scanned for a NUL before a file is treated as text. */
const BINARY_SAMPLE_BYTES = 8192
/** Default cap on the content snapshot returned alongside a write, for diffs. */
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/**
 * Translate a transport or agent failure into the `dsh-fs` error taxonomy.
 * Callers branch on `code`, never on message text, so the mapping stays here.
 */
function toFsError(error: unknown, displayPath: string, verb: string): FsError {
	if (error instanceof FsError) return error
	if (error instanceof RemoteAgentError) {
		if (error.code === 'FS_NOT_FOUND' || error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED') {
			return new FsError(error.message, error.code as FsError['code'])
		}
		return new FsError(`cannot ${verb} "${displayPath}": ${error.message}`, (error.code as FsError['code']) ?? 'FS_IO_ERROR')
	}
	return new FsError(`cannot ${verb} "${displayPath}": ${(error as any)?.message ?? String(error)}`, 'FS_IO_ERROR')
}

/** LF-normalize, matching the local backend's model-facing text form. */
function normalizeLineEndings(content: string): string {
	return content.replaceAll('\r\n', '\n')
}

/** Which style a file used, decided from its leading 4 KiB. */
function detectLineEndings(raw: string): LineEndings {
	const sample = raw.slice(0, 4096)
	const crlfCount = sample.split('\r\n').length - 1
	return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF'
}

/** Convert LF-normalized content back to the style the file had. */
function restoreLineEndings(content: string, lineEndings: LineEndings): string {
	return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
	let count = 0
	let index = 0
	while (true) {
		const found = content.indexOf(needle, index)
		if (found === -1) return count
		count += 1
		index = found + needle.length
	}
}

/** Literal match-and-replace with the contract's not-found / ambiguous codes. */
function applyLiteralEdit(content: string, oldString: string, newString: string, replaceAll: boolean | undefined, displayPath: string): { content: string; replacements: number } {
	const oldNorm = normalizeLineEndings(oldString)
	if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
	const newNorm = normalizeLineEndings(newString)
	const replacements = countOccurrences(content, oldNorm)
	if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
	if (!replaceAll && replacements > 1) {
		throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
	}
	return { content: content.split(oldNorm).join(newNorm), replacements }
}

export class SshFileSystem extends FileSystem {
	_transport: SshTransport
	_config: SshFileSystemConfig
	_locks = new Map<string, Promise<unknown>>()

	/**
	 * @param ctx - the cordis context.
	 * @param config - `{ cwd }`, the remote workspace root.
	 * @param transport - the {@link SshTransport} carrying agent calls.
	 * @param slot - the service name to occupy: `'fs'` to replace the app's
	 * filesystem outright, or a private name to stay unregistered from the
	 * consumer's point of view (route mode, where a router answers `fs`).
	 */
	constructor(ctx: Context, config: SshFileSystemConfig, transport: SshTransport, slot = 'fs') {
		super(ctx, slot)
		this._config = config
		this._transport = transport
	}

	/** The remote directory relative paths resolve against. */
	get root() {
		return this._config.cwd
	}

	/** Serialize mutations per target, as the contract's critical section requires. */
	async _withLock<T>(key: string, op: () => T | Promise<T>): Promise<T> {
		const run = (this._locks.get(key) ?? Promise.resolve()).then(op, op)
		const tail = run.then(() => void 0, () => void 0)
		this._locks.set(key, tail)
		try {
			return await run
		} finally {
			if (this._locks.get(key) === tail) this._locks.delete(key)
		}
	}

	/** The case-preserved path used for actual I/O. */
	_pathOf(target: Pick<FsTarget, 'displayPath'>): string {
		return String(target.displayPath)
	}

	_aborted(signal: AbortSignal | undefined, verb: string): void {
		if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
	}

	async resolve(path: unknown, opts?: FsResolveOptions): Promise<FsTarget> {
		this._aborted(opts?.signal, 'resolve')
		const cwd = opts?.cwd ?? this._config.cwd
		let resolved: string
		let key: string
		try {
			resolved = resolvePath(cwd, path)
			key = targetKey(resolved)
		} catch (error) {
			throw new FsError(`cannot resolve "${path}": ${(error as Error).message}`, 'FS_INVALID_PATH')
		}
		return { targetKey: FsTargetKey(key), displayPath: resolved }
	}

	processPath(target: FsTarget): string {
		return String(target.displayPath)
	}

	/**
	 * No host path identifies a file in this execution world: the harness host
	 * and the remote machine are different machines. Returning `undefined` is
	 * the contract's answer for "this world cannot read that host file", and it
	 * is what keeps a local file reference from being silently treated as a
	 * remote one.
	 */
	override processPathFromHostPath(): string | undefined {
		return undefined
	}

	fileUrl(target: FsTarget): string {
		const path = String(target.displayPath).replace(/\\/g, '/')
		return `sftp://${this._transport.host}${path}`
	}

	contains(parent: FsTarget, child: FsTarget): boolean {
		return contains(this.processPath(parent), this.processPath(child))
	}

	async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
		this._aborted(signal, 'stat')
		try {
			const info = await this._transport.request('stat', { path: this._pathOf(target) })
			if (!info.exists) return undefined
			return { version: FsVersion(info.version), type: info.type, size: Number(info.size) }
		} catch (error) {
			throw toFsError(error, this._pathOf(target), 'stat')
		}
	}

	async lstat(path: unknown, opts?: FsResolveOptions, signal?: AbortSignal): Promise<FsInfo | undefined> {
		this._aborted(signal, 'lstat')
		if (String(path ?? '').trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
		const cwd = opts?.cwd ?? this._config.cwd
		const resolved = resolvePath(cwd, path)
		try {
			const info = await this._transport.request('stat', { path: resolved })
			if (!info.exists) return undefined
			return { version: FsVersion(info.version), type: info.type, size: Number(info.size) }
		} catch (error) {
			throw toFsError(error, resolved, 'lstat')
		}
	}

	/** Decode remote bytes as UTF-8, rejecting binaries the way the local backend does. */
	_decodeText(buffer: Buffer, displayPath: string, verb: string): string {
		if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
			throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
		}
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
		} catch {
			throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
		}
	}

	async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
		this._aborted(signal, 'read')
		const displayPath = this._pathOf(target)
		let response: AgentResult
		try {
			response = await this._transport.request('read', { path: displayPath })
		} catch (error) {
			throw toFsError(error, displayPath, 'read')
		}
		this._aborted(signal, 'read')
		return this._decodeText(Buffer.from(response.base64, 'base64'), displayPath, 'read')
	}

	async *streamText(target: FsTarget, signal?: AbortSignal): AsyncGenerator<string> {
		const displayPath = this._pathOf(target)
		let response: AgentResult
		try {
			response = await this._transport.request('read', { path: displayPath })
		} catch (error) {
			throw toFsError(error, displayPath, 'read')
		}
		const buffer = Buffer.from(response.base64, 'base64')
		if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
			throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
		}
		const decoder = new TextDecoder('utf-8', { fatal: true })
		for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
			this._aborted(signal, 'read')
			yield decoder.decode(buffer.subarray(offset, offset + 64 * 1024), { stream: offset + 64 * 1024 < buffer.length })
		}
	}

	async readBytes(target: FsTarget, signal?: AbortSignal, maxBytes?: number): Promise<Uint8Array> {
		this._aborted(signal, 'read')
		const displayPath = this._pathOf(target)
		try {
			const info = await this._transport.request('stat', { path: displayPath })
			if (!info.exists) throw new FsError(`cannot read "${displayPath}": no such file`, 'FS_NOT_FOUND')
			if (info.type !== 'file') throw new FsError(`cannot read "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
			if (Number(info.size) > (maxBytes ?? Number.POSITIVE_INFINITY)) {
				throw new FsError(`cannot read "${displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
			}
			const response = await this._transport.request('read', { path: displayPath })
			return new Uint8Array(Buffer.from(response.base64, 'base64'))
		} catch (error) {
			throw toFsError(error, displayPath, 'read')
		}
	}

	async readByteRange(target: FsTarget, range: FsByteRange, signal?: AbortSignal): Promise<Uint8Array> {
		this._aborted(signal, 'read')
		const displayPath = this._pathOf(target)
		if (range.length === 0) return new Uint8Array(0)
		try {
			const response = await this._transport.request('range', {
				path: displayPath,
				offset: range.offset,
				length: range.length,
			})
			return new Uint8Array(Buffer.from(response.base64, 'base64'))
		} catch (error) {
			throw toFsError(error, displayPath, 'read')
		}
	}

	async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
		this._aborted(signal, 'list')
		const displayPath = this._pathOf(target)
		let response: AgentResult
		try {
			response = await this._transport.request('list', { path: displayPath })
		} catch (error) {
			throw toFsError(error, displayPath, 'list')
		}
		if (!response.exists) throw new FsError(`cannot list "${displayPath}": no such directory`, 'FS_NOT_FOUND')
		return (response.items ?? []).map((entry: any): FsDirEntry => {
			const child = normalize(`${displayPath.replace(/\\+$/, '')}\\${entry.name}`)
			return {
				name: entry.name,
				type: entry.type,
				target: {
					targetKey: FsTargetKey(targetKey(child)),
					displayPath: child,
				},
				...(entry.version !== undefined ? { version: FsVersion(entry.version) } : {}),
				...(entry.size !== undefined ? { size: Number(entry.size) } : {}),
			}
		})
	}

	async writeText(target: FsTarget, content: string, expected?: FsExpected | null, signal?: AbortSignal): Promise<FsWriteResult> {
		this._aborted(signal, 'write')
		const displayPath = this._pathOf(target)
		return this._withLock<FsWriteResult>(target.targetKey, async () => {
			let existing: AgentResult
			try {
				existing = await this._transport.request('stat', { path: displayPath })
			} catch (error) {
				throw toFsError(error, displayPath, 'write')
			}
			if (existing.exists && existing.type !== 'file') {
				throw new FsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
			}
			if (expected?.kind === 'replaceIfVersion') {
				if (!existing.exists) throw new FsError(`cannot write "${displayPath}": file no longer exists`, 'FS_STALE_VERSION')
				if (existing.version !== expected.version) {
					throw new FsError(`cannot write "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
				}
			} else if (expected?.kind === 'createIfAbsent' && existing.exists) {
				throw new FsError(`cannot overwrite existing "${displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
			}

			// The pre-write snapshot is what the UI renders a diff against.
			let before: string | null = null
			if (existing.exists && Buffer.byteLength(content, 'utf8') < (this._config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES)) {
				try {
					const previous = await this._transport.request('read', { path: displayPath })
					before = normalizeLineEndings(Buffer.from(previous.base64, 'base64').toString('utf8'))
				} catch {
					before = null
				}
			}

			try {
				await this._transport.request('write', {
					path: displayPath,
					base64: Buffer.from(content, 'utf8').toString('base64'),
					expected: expected ?? null,
				})
			} catch (error) {
				throw toFsError(error, displayPath, 'write')
			}
			const after = await this._transport.request('stat', { path: displayPath })
			return {
				operation: existing.exists ? 'update' : 'create',
				version: FsVersion(after.version),
				before,
				after: normalizeLineEndings(content),
			}
		})
	}

	/**
	 * Literal edit, kept on this seam so the version check, the literal match
	 * and the rewrite share one critical section. The read-modify-write happens
	 * in-process against remote bytes; the contract allows a remote backend to
	 * do this natively, and this is the honest non-native form.
	 */
	async editText(target: FsTarget, edit: FsEdit, expected?: FsExpected | null, signal?: AbortSignal): Promise<FsEditResult> {
		this._aborted(signal, 'edit')
		const displayPath = this._pathOf(target)
		return this._withLock<FsEditResult>(target.targetKey, async () => {
			let existing: AgentResult
			try {
				existing = await this._transport.request('stat', { path: displayPath })
			} catch (error) {
				throw toFsError(error, displayPath, 'edit')
			}
			if (!existing.exists) {
				throw new FsError(`cannot edit "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
			}
			if (existing.type !== 'file') {
				throw new FsError(`cannot edit "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
			}
			if (expected && existing.version !== expected.version) {
				throw new FsError(`cannot edit "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
			}
			let response: AgentResult
			try {
				response = await this._transport.request('read', { path: displayPath })
			} catch (error) {
				throw toFsError(error, displayPath, 'edit')
			}
			const raw = Buffer.from(response.base64, 'base64')
			const content = this._decodeText(raw, displayPath, 'edit')
			const lineEndings = detectLineEndings(content)
			const edited = applyLiteralEdit(normalizeLineEndings(content), edit.oldString, edit.newString, edit.replaceAll, displayPath)
			try {
				await this._transport.request('write', {
					path: displayPath,
					base64: Buffer.from(restoreLineEndings(edited.content, lineEndings), 'utf8').toString('base64'),
					expected: expected ?? null,
				})
			} catch (error) {
				throw toFsError(error, displayPath, 'edit')
			}
			const after = await this._transport.request('stat', { path: displayPath })
			return {
				version: FsVersion(after.version),
				before: normalizeLineEndings(content),
				after: edited.content,
			}
		})
	}
}
