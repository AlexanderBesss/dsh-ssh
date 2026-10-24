/**
 * Local smoke test for the remote agent script.
 *
 * The agent is plain PowerShell with no SSH dependency in its request handling,
 * so it can be exercised against the local filesystem before any remote host is
 * involved. That separates "the agent logic is wrong" from "the SSH transport is
 * wrong" — the two failure modes that otherwise get confused at first contact.
 *
 * Usage: node dist/scripts/agent-smoke.js
 */

import { AGENT_SCRIPT } from '../src/agent-script.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '.tmp-agent')
const out = process.argv[2] ?? join(root, 'agent.ps1')
mkdirSync(root, { recursive: true })
writeFileSync(out, AGENT_SCRIPT, 'utf8')

const scratch = join(import.meta.dirname, '..', '..', '.tmp-agent', 'probe.txt')
const text = Buffer.from('hello remote world', 'utf8').toString('base64')
const more = Buffer.from('!!', 'utf8').toString('base64')

const requests = [
	{ id: 1, op: 'ping' },
	{ id: 2, op: 'system' },
	{ id: 3, op: 'stat', payload: { path: scratch } },
	{ id: 4, op: 'write', payload: { path: scratch, base64: text, expected: null } },
	{ id: 5, op: 'stat', payload: { path: scratch } },
	{ id: 6, op: 'read', payload: { path: scratch } },
	{ id: 7, op: 'range', payload: { path: scratch, offset: 6, length: 5 } },
	{ id: 8, op: 'append', payload: { path: scratch, base64: more } },
	{ id: 9, op: 'read', payload: { path: scratch } },
	{ id: 10, op: 'write', payload: { path: scratch, base64: text, expected: { kind: 'replaceIfVersion', version: 'bogus' } } },
	{ id: 11, op: 'list', payload: { path: join(import.meta.dirname, '..', '..', 'src') } },
	{ id: 12, op: 'where', payload: { name: 'ping' } },
	{ id: 13, op: 'where', payload: { name: 'node', path: process.env.PATH, pathExt: '.COM;.EXE;.BAT;.CMD' } },
	{ id: 14, op: 'remove', payload: { path: scratch } },
	{ id: 15, op: 'stat', payload: { path: scratch } },
]

writeFileSync(join(import.meta.dirname, '..', '..', '.tmp-agent', 'requests.jsonl'), `${requests.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
console.log(`wrote ${out}`)
console.log(`wrote requests: ${join(import.meta.dirname, '..', '..', '.tmp-agent', 'requests.jsonl')}`)
