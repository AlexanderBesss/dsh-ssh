// local git scratch paths exist only on this machine: commands that run remotely need them remapped onto remote paths
import { createHash } from 'node:crypto'
import { contains, normalize } from './remote-path.js'

const SCRATCH_KEYS = new Set(['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'])

export interface PlumbingRewrite {
	env: Record<string, string>
	createdDirs: string[]
	remapped: boolean
}

export function plumbingRootOf(home: string | undefined): string | undefined {
	if (typeof home !== 'string' || home.trim().length === 0) return undefined
	try {
		return `${normalize(home).replace(/\\+$/, '')}\\.dsh\\dsh-ssh-git`
	} catch {
		return undefined
	}
}

export function rewriteGitPlumbing(
	env: Record<string, string | undefined>,
	remoteRoots: readonly string[],
	plumbingRoot: string,
): PlumbingRewrite {
	const out: Record<string, string> = {}
	const createdDirs: string[] = []
	let remapped = false
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue
		if (!SCRATCH_KEYS.has(key)) {
			out[key] = value
			continue
		}
		const mapped: string[] = []
		for (const part of value.split(';')) {
			const raw = part.trim()
			if (raw.length === 0) continue
			let absolute: string
			try {
				absolute = normalize(raw)
			} catch {
				mapped.push(raw)
				continue
			}
			if (remoteRoots.some((root) => contains(root, absolute))) {
				mapped.push(absolute)
				continue
			}
			const hash = createHash('sha1').update(absolute.toLowerCase(), 'utf8').digest('hex').slice(0, 16)
			if (key === 'GIT_INDEX_FILE') {
				mapped.push(`${plumbingRoot}\\index-${hash}`)
				createdDirs.push(plumbingRoot)
			} else {
				const dir = `${plumbingRoot}\\objects-${hash}`
				mapped.push(dir)
				createdDirs.push(dir)
			}
			remapped = true
		}
		if (mapped.length > 0) out[key] = mapped.join(';')
	}
	return { env: out, createdDirs: [...new Set(createdDirs)], remapped }
}

export function prunePlumbingScript(plumbingRoot: string): string {
	return `Get-ChildItem -LiteralPath '${plumbingRoot.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | ForEach-Object { if ($_.PSIsContainer) { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } else { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } }`
}
