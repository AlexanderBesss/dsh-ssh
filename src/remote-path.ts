/**
 * Windows path semantics for the remote execution world.
 *
 * The remote host is a Windows PC, so the provider cannot borrow POSIX rules:
 * `\` is the separator, `D:\x` and `\\server\share` are absolute, and the
 * filesystem is case-insensitive. Target identity therefore keys on a
 * case-folded normalized path while `displayPath` keeps the caller's spelling.
 *
 * @module dsh-ssh/remote-path
 */

/** Matches `C:\`, `C:/`, and UNC `\\server\share`. */
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\[\\/][^\\/])/

/**
 * Whether a path is absolute in the remote (Windows) execution world.
 * Drive-relative forms (`C:work`) are not absolute and normalize rejects them
 * through this guard, matching the workspace registry's own stance on that form.
 */
export function isAbsolute(path: string): boolean {
	return ABSOLUTE.test(path)
}

/**
 * Fold separators and collapse `.` / `..` segments without touching case.
 * Throws when the path is not absolute.
 */
export function normalize(path: string): string {
	if (!isAbsolute(path)) throw new Error(`dsh-ssh: not an absolute remote path: ${path}`)
	const unc = path.startsWith('\\')
	// Preserve the UNC prefix (`\\server\share`) and normalize the remainder.
	const prefix = unc ? '\\\\' : ''
	const body = unc ? path.slice(2).replace(/\\/g, '/') : path.replace(/\\/g, '/')
	const segments = body.split('/')
	// The UNC share root — server plus share, the two segments below the
	// prefix — is protected from `..` the way a drive root is: `\\srv\share\..\..`
	// stays at the share instead of popping into a malformed single-backslash
	// path that Windows would re-read as drive-relative.
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
	// A bare drive root keeps its separator: `C:` alone is not a usable path.
	return joined.length === 2 && joined[1] === ':' ? `${joined}\\` : joined
}

/** Resolve a possibly relative path against the remote workspace root. */
export function resolvePath(cwd: string, path: unknown): string {
	const value = String(path ?? '')
	if (value.trim().length === 0) return normalize(cwd)
	if (isAbsolute(value)) return normalize(value)
	const base = normalize(cwd).replace(/\\+$/, '')
	return normalize(`${base}\\${value}`)
}

/**
 * The stable identity key for a remote path: case-folded, because NTFS lookups
 * are case-insensitive and the same file reached as `D:\Src\a.ts` or
 * `D:\src\A.TS` must share one stale-version guard.
 */
export function targetKey(path: string): string {
	return normalize(path).toLowerCase()
}

/** Whether `child` is `parent` itself or lives beneath it, case-insensitively. */
export function contains(parent: string, child: string): boolean {
	const p = normalize(parent).toLowerCase().replace(/\\+$/, '')
	const c = normalize(child).toLowerCase().replace(/\\+$/, '')
	return c === p || c.startsWith(`${p}\\`)
}

/** Join a directory with one child name; the result is normalized. */
export function joinDir(dir: string, name: string): string {
	return normalize(`${normalize(dir).replace(/\\+$/, '')}\\${name}`)
}
