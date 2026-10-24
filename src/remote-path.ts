/**
 * Windows path semantics for the remote world: `\` separators, case-insensitive
 * identity, `D:\x` and `\\server\share` absolute.
 *
 * @module dsh-ssh/remote-path
 */

/** Matches `C:\`, `C:/`, and UNC `\\server\share`; drive-relative (`C:work`) is not absolute. */
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\[\\/][^\\/])/

export function isAbsolute(path: string): boolean {
	return ABSOLUTE.test(path)
}

/** Fold separators, collapse `.` / `..`; throws when not absolute. */
export function normalize(path: string): string {
	if (!isAbsolute(path)) throw new Error(`dsh-ssh: not an absolute remote path: ${path}`)
	const unc = path.startsWith('\\')
	const prefix = unc ? '\\\\' : ''
	const body = unc ? path.slice(2).replace(/\\/g, '/') : path.replace(/\\/g, '/')
	const segments = body.split('/')
	// The UNC share root (server + share) is `..`-protected the way a drive root is.
	const protectedSegments = unc ? 2 : 0
	const out: string[] = []
	for (const segment of segments) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			if (out.length > protectedSegments && out[out.length - 1] !== '..') out.pop()
			continue
		}
		out.push(segment)
	}
	if (unc) return `${prefix}${out.join('\\')}`
	const joined = out.join('\\')
	// `C:` alone is drive-relative, not a path — the root keeps its separator.
	return joined.length === 2 && joined[1] === ':' ? `${joined}\\` : joined
}

export function resolvePath(cwd: string, path: unknown): string {
	const value = String(path ?? '')
	if (value.trim().length === 0) return normalize(cwd)
	if (isAbsolute(value)) return normalize(value)
	const base = normalize(cwd).replace(/\\+$/, '')
	return normalize(`${base}\\${value}`)
}

/** Case-folded identity key: `D:\Src\a.ts` and `D:\src\A.TS` are one target on NTFS. */
export function targetKey(path: string): string {
	return normalize(path).toLowerCase()
}

/** Whether `child` is `parent` itself or beneath it, case-insensitively. */
export function contains(parent: string, child: string): boolean {
	const p = normalize(parent).toLowerCase().replace(/\\+$/, '')
	const c = normalize(child).toLowerCase().replace(/\\+$/, '')
	return c === p || c.startsWith(`${p}\\`)
}

export function joinDir(dir: string, name: string): string {
	return normalize(`${normalize(dir).replace(/\\+$/, '')}\\${name}`)
}
