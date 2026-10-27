import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface WorkspaceRootStore {
	roots(): string[]
	add(path: string): void
}

function defaultFile(): string {
	return join(homedir(), '.dsh', 'dsh-ssh-workspaces.json')
}

export function createWorkspaceRootStore(host: string, file = defaultFile()): WorkspaceRootStore {
	// case-folded keys, first spelling kept: `C:\Work` and `c:\work` are one root
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
		// corrupt or half-written file reads as empty
	}

	const persist = (): void => {
		try {
			let all: Record<string, unknown> = {}
			if (existsSync(file)) all = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) ?? {}
			all[host] = [...set.values()]
			mkdirSync(join(homedir(), '.dsh'), { recursive: true })
			writeFileSync(file, JSON.stringify(all, null, 2))
		} catch {
			// best effort: the in-memory set still routes this session
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
