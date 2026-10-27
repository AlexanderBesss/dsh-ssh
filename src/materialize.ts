import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { contains, isAbsolute } from './remote-path.js'

export const MIRROR_MAX_BYTES = 32 * 1024 * 1024

export function createMirror(remoteRoots: () => readonly string[], maxBytes = MIRROR_MAX_BYTES): (path: string, bytes: Buffer) => Promise<void> {
	return async (path, bytes) => {
		try {
			if (!isAbsolute(path) || bytes.length > maxBytes) return
			if (!remoteRoots().some((root) => contains(root, path))) return
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, bytes)
		} catch {}
	}
}
