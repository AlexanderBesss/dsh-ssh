/**
 * Verify the ripgrep shipping path: chunked upload, then run it remotely.
 *
 * This is the feature most likely to fail quietly, because it pushes a ~5 MB
 * binary through a JSON text channel in base64 pieces and then depends on the
 * remote executing it.
 *
 * Usage: node dist/scripts/rg-live.js <host>
 */

import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SshTransport } from '../src/transport.js'

const host = process.argv[2]
if (!host) {
	console.error('usage: node dist/scripts/rg-live.js <host>')
	process.exit(2)
}

const local = process.argv[3]
	?? 'C:\\Users\\alexa\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar.unpacked\\dsh\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe'
if (!existsSyncSafe(local)) {
	console.error(`local ripgrep not found: ${local}`)
	process.exit(1)
}

function existsSyncSafe(path: string) {
	try {
		statSync(path)
		return true
	} catch {
		return false
	}
}

const transport = new SshTransport({
	host,
	sshBin: 'ssh',
	sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
	remoteShell: 'powershell',
	connectTimeoutMs: 30000,
	requestTimeoutMs: 60000,
})

await transport.connect()
const home = transport.system!.home
const remote = `${home}\\.dsh\\bin\\rg.exe`
const buffer = readFileSync(local)
const localHash = createHash('sha256').update(buffer).digest('hex')
console.log(`local rg.exe: ${buffer.length} bytes, sha256 ${localHash.slice(0, 16)}...`)

const started = Date.now()
const CHUNK = Number(process.argv[4] ?? 64 * 1024)
const staged = `${remote}.part`
const parts = []
let index = 0
let incomplete = false
for (let offset = 0; offset < buffer.length; offset += CHUNK, index += 1) {
	const part = `${staged}.${String(index).padStart(4, '0')}`
	parts.push(part)
	const base64 = buffer.subarray(offset, offset + CHUNK).toString('base64')
	let written = false
	for (let tryNumber = 1; tryNumber <= 3 && !written; tryNumber += 1) {
		const attempt = Date.now()
		try {
			await transport.request('write', { path: part, base64, expected: null }, { timeoutMs: 30000 })
			written = true
			process.stdout.write(`  part ${index} ok in ${Date.now() - attempt}ms (${Math.min(offset + CHUNK, buffer.length)}/${buffer.length})\r`)
		} catch (error) {
			console.log(`\n  part ${index} attempt ${tryNumber} failed in ${Date.now() - attempt}ms: ${(error as Error).message.slice(0, 70)}`)
			if (tryNumber === 3) incomplete = true
		}
	}
	if (incomplete) break
}
console.log(`\nupload ${incomplete ? 'INCOMPLETE' : 'complete'} in ${Date.now() - started} ms (${parts.length} parts)`)
if (!incomplete) {
	await transport.request('concat', { target: staged, sources: parts }, { timeoutMs: 60000 })
	const digest = await transport.request('hash', { path: staged }, { timeoutMs: 60000 })
	console.log(`staged sha256 match: ${digest.sha256 === localHash}`)
	if (digest.sha256 === localHash) await transport.request('move', { source: staged, target: remote })
}

const info = await transport.request('stat', { path: remote })
console.log(`remote stat: exists=${info.exists} size=${info.size} (expected ${buffer.length})`)

const run = (line: string) => new Promise<any>((resolve) => {
	const child = transport.spawnCommand(line)
	let stdout = ''
	let stderr = ''
	child.stdout!.on('data', (c) => { stdout += c.toString('utf8') })
	child.stderr!.on('data', (c) => { stderr += c.toString('utf8') })
	child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
	child.stdin!.end()
})

const version = await run(`"${remote}" --version`)
console.log(`remote rg --version (exit ${version.code}): ${version.stdout.split('\n')[0] ?? version.stderr}`)

const search = await run(`"${remote}" --line-number --max-count 5 "class" "${home}\\.dsh\\bin"`)
console.log(`remote rg search (exit ${search.code}): ${search.stdout || search.stderr || '(no matches)'}`)

const hash = await run(`certutil -hashfile "${remote}" SHA256`)
const remoteHash = hash.stdout.split('\n').map((line: any) => line.trim()).find((line: any) => /^[0-9a-f]{64}$/i.test(line.replace(/\s/g, '')))?.replace(/\s/g, '')
console.log(`hash match: ${remoteHash === localHash ? 'IDENTICAL' : `MISMATCH (${remoteHash?.slice(0, 16)}...)`}`)
transport.close()
