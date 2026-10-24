/**
 * The extra remote workspace roots the picker has opened.
 *
 * Route mode classifies every `fs` / `subprocess` call by containment, and the
 * configured `remoteRoot` alone would strand any workspace the picker opens
 * elsewhere on the remote PC: the workspace registry stats the path locally,
 * finds the empty mirror, and the session reads that empty mirror instead of
 * the remote project. Every path `/api/prepare` vouches for therefore joins
 * the routing set, and the set is persisted so the sessions those workspaces
 * open keep working after a restart.
 *
 * The store lives under `~/.dsh` next to the app's own state, keyed by host —
 * a host config change must not resurrect another machine's roots.
 *
 * @module dsh-ssh/workspace-roots
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The live set of picker-opened remote roots. */
export interface WorkspaceRootStore {
	/** Roots as plain absolute remote paths, insertion order. Does not include the configured root. */
	roots(): string[]
	/** Remember one prepared workspace path; persisted best-effort. */
	add(path: string): void
}

/** Default state file: one shared file, an entry per host. */
function defaultFile(): string {
	return join(homedir(), '.dsh', 'dsh-ssh-workspaces.json')
}

/**
 * Load (or start) the root set for one host; reads never fail — a corrupt file
 * starts a fresh set. `file` is a state-file override, for tests.
 */
export function createWorkspaceRootStore(host: string, file = defaultFile()): WorkspaceRootStore {
	// Case-folded keys, first spelling kept: NTFS lookups are case-insensitive,
	// so `C:\Work` and `c:\work` are one root, and re-preparing a workspace
	// must not append a second entry that the router will treat as distinct.
	const set = new Map<string, string>()
	try {
		if (existsSync(file)) {
			const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
			const mine = Array.isArray(all?.[host]) ? (all[host] as unknown[]) : []
			for (const entry of mine) {
				if (typeof entry === 'string' && entry.trim() !== '') set.set(entry.toLowerCase(), entry)
			}
		}
	} catch {
		// A corrupt or half-written file is treated as empty; the first `add`
		// rewrites it whole.
	}

	const persist = (): void => {
		try {
			let all: Record<string, unknown> = {}
			if (existsSync(file)) all = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) ?? {}
			all[host] = [...set.values()]
			mkdirSync(join(homedir(), '.dsh'), { recursive: true })
			writeFileSync(file, JSON.stringify(all, null, 2))
		} catch {
			// Best effort: the in-memory set still routes this session's calls.
		}
	}

	return {
		roots: () => [...set.values()],
		add: (path: string) => {
			const key = path.toLowerCase()
			if (set.has(key)) return
			set.set(key, path)
			persist()
		},
	}
}
