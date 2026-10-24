/**
 * Repair identifiers damaged by a rename whose replacement string was eaten by
 * shell interpolation: `#transport` became `_ransport` instead of `_transport`.
 *
 * The damage was consistent, so the code still ran â€” declarations and call sites
 * lost the same letter â€” which is exactly why `node --check` and the load test
 * both passed over it.
 *
 * Run:  node dist/scripts/repair-identifiers.js
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** Mangled -> intended, per file. Keys are the damaged spellings only. */
const REPAIRS = {
	'src/fs-provider.ts': {
		_borted: '_aborted',
		_onfig: '_config',
		_ecodeText: '_decodeText',
		_ocks: '_locks',
		_athOf: '_pathOf',
		_ransport: '_transport',
		_ithLock: '_withLock',
	},
	'src/subprocess-provider.ts': {
		_ytes: '_bytes',
		_hunks: '_chunks',
		_onfig: '_config',
		_nsureRemoteRipgrep: '_ensureRemoteRipgrep',
		_sPackagedRipgrep: '_isPackagedRipgrep',
		_ive: '_live',
		_axBytes: '_maxBytes',
		_emoteCommand: '_remoteCommand',
		_esolveProgram: '_resolveProgram',
		_ipgrepPath: '_ripgrepPath',
		_ipgrepPromise: '_ripgrepPromise',
		_otal: '_total',
		_ransport: '_transport',
		_alidate: '_validate',
	},
}

for (const [file, map] of Object.entries(REPAIRS)) {
	let source = readFileSync(file, 'utf8')
	const report = []
	for (const [from, to] of Object.entries(map)) {
		// Word-boundary anchored so `_ive` cannot rewrite `_archive` or similar.
		const pattern = new RegExp(`(?<![\\w$])${from}(?![\\w$])`, 'g')
		const hits = (source.match(pattern) ?? []).length
		if (hits === 0) {
			report.push(`  MISS  ${from}`)
			continue
		}
		source = source.replace(pattern, to)
		report.push(`  ok    ${from} -> ${to}  (${hits})`)
	}
	writeFileSync(file, source)
	console.log(`${file}\n${report.join('\n')}`)
}

// Anything still shaped like a damaged identifier is a mapping we missed.
for (const file of Object.keys(REPAIRS)) {
	const leftovers = readFileSync(file, 'utf8').match(/(?<![.#\w$])_[a-z]{1}[a-z]*\b/g) ?? []
	const suspicious = [...new Set(leftovers)].filter((name) => !/_[a-z]/.test(name.slice(2)))
	if (suspicious.length) console.log(`\n${file}: review these short _ names: ${suspicious.join(', ')}`)
}
