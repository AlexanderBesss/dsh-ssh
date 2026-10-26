/**
 * Write-through mirror: content served from the remote PC is also written at
 * the same path on this machine, so local consumers (the changes recorder's
 * file captures and native “open in app” handlers) see real bytes instead of
 * the empty mirror folders the workspace picker leaves behind.
 *
 * @module dsh-ssh/materialize
 */

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
