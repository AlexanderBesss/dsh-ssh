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

export interface SshFileSystemConfig {
	cwd: string
	diffBasisMaxBytes?: number
}

type LineEndings = 'CRLF' | 'LF'

const BINARY_SAMPLE_BYTES = 8192
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
const TEXT_CHUNK_BYTES = 64 * 1024

/** Failures are mapped into the `FS_*` taxonomy here; callers branch on `code`, never on message text. */
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

function detectLineEndings(raw: string): LineEndings {
	const sample = raw.slice(0, 4096)
	const crlfCount = sample.split('\r\n').length - 1
	return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF'
}

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

	/** `'fs'` takes the public name; a private name stays invisible to consumers (route mode). */
	constructor(ctx: Context, config: SshFileSystemConfig, transport: SshTransport, slot = 'fs') {
		super(ctx, slot)
		this._config = config
		this._transport = transport
	}

	get root() {
		return this._config.cwd
	}

	/** Mutations serialize per target — the contract's critical section. */
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

	/** The remote world has no path that identifies a host file; `undefined` is the contract's answer. */
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

	_assertNotBinary(buffer: Buffer, displayPath: string, verb: string): void {
		if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
			throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
		}
	}

	async _readRaw(displayPath: string, verb: string): Promise<Buffer> {
		let response: AgentResult
		try {
			response = await this._transport.request('read', { path: displayPath })
		} catch (error) {
			throw toFsError(error, displayPath, verb)
		}
		return Buffer.from(response.base64, 'base64')
	}

	async _statRaw(displayPath: string, verb: string): Promise<AgentResult> {
		try {
			return await this._transport.request('stat', { path: displayPath })
		} catch (error) {
			throw toFsError(error, displayPath, verb)
		}
	}

	_decodeText(buffer: Buffer, displayPath: string, verb: string): string {
		this._assertNotBinary(buffer, displayPath, verb)
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
		} catch {
			throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
		}
	}

	async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
		this._aborted(signal, 'read')
		const displayPath = this._pathOf(target)
		const buffer = await this._readRaw(displayPath, 'read')
		this._aborted(signal, 'read')
		return this._decodeText(buffer, displayPath, 'read')
	}

	async *streamText(target: FsTarget, signal?: AbortSignal): AsyncGenerator<string> {
		const displayPath = this._pathOf(target)
		const buffer = await this._readRaw(displayPath, 'read')
		this._assertNotBinary(buffer, displayPath, 'read')
		const decoder = new TextDecoder('utf-8', { fatal: true })
		for (let offset = 0; offset < buffer.length; offset += TEXT_CHUNK_BYTES) {
			this._aborted(signal, 'read')
			yield decoder.decode(buffer.subarray(offset, offset + TEXT_CHUNK_BYTES), { stream: offset + TEXT_CHUNK_BYTES < buffer.length })
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
			const existing = await this._statRaw(displayPath, 'write')
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

	async editText(target: FsTarget, edit: FsEdit, expected?: FsExpected | null, signal?: AbortSignal): Promise<FsEditResult> {
		this._aborted(signal, 'edit')
		const displayPath = this._pathOf(target)
		return this._withLock<FsEditResult>(target.targetKey, async () => {
			const existing = await this._statRaw(displayPath, 'edit')
			if (!existing.exists) {
				throw new FsError(`cannot edit "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
			}
			if (existing.type !== 'file') {
				throw new FsError(`cannot edit "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
			}
			if (expected && existing.version !== expected.version) {
				throw new FsError(`cannot edit "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
			}
			const raw = await this._readRaw(displayPath, 'edit')
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
