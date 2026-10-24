/**
 * Live transport check against a real SSH host.
 *
 * Runs the same code path the plugin uses — persistent agent, JSON ops, and a
 * per-command ssh spawn — without needing DSH installed.
 *
 * Usage: node dist/scripts/transport-live.js <host> [remoteRoot]
 */

import { SshTransport, RemoteAgentError } from '../src/transport.js'

const host = process.argv[2]
if (!host) {
	console.error('usage: node dist/scripts/transport-live.js <host> [remoteRoot]')
	process.exit(2)
}
const root = process.argv[3] ?? 'C:\\Users\\AI'
const scratch = `${root}\\dsh-ssh-probe`

const transport = new SshTransport({
	host,
	sshBin: 'ssh',
	sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
	remoteShell: 'powershell',
	connectTimeoutMs: 30000,
	requestTimeoutMs: 30000,
})

const step = async (label: string, fn: () => Promise<any>) => {
	try {
		const value = await fn()
		console.log(`ok   ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
		return value
	} catch (error) {
		console.log(`FAIL ${label}: ${(error as any)?.name ?? 'Error'} ${(error as any)?.code ?? ''} ${(error as any)?.message ?? error}`)
		return undefined
	}
}

console.log(`connecting to ${host} ...`)
await transport.connect()
console.log(`connected; system = ${JSON.stringify(transport.system)}`)

await step('mkdir scratch', () => transport.request('mkdir', { path: scratch }))
await step('stat scratch', () => transport.request('stat', { path: scratch }))
await step('write', () => transport.request('write', {
	path: `${scratch}\\note.txt`,
	base64: Buffer.from('first line\nsecond line\n', 'utf8').toString('base64'),
	expected: null,
}))
const info = await step('stat note', () => transport.request('stat', { path: `${scratch}\\note.txt` }))
await step('read note', () => transport.request('read', { path: `${scratch}\\note.txt` }))
await step('range note 12..18', () => transport.request('range', { path: `${scratch}\\note.txt`, offset: 12, length: 6 }))
await step('stale guard (expect FS_STALE_VERSION)', () => transport.request('write', {
	path: `${scratch}\\note.txt`,
	base64: Buffer.from('nope', 'utf8').toString('base64'),
	expected: { kind: 'replaceIfVersion', version: 'bogus' },
}).then(() => 'UNEXPECTED SUCCESS').catch((error) => error instanceof RemoteAgentError ? `caught ${error.code}` : `wrong error: ${error}`))
await step('list scratch', () => transport.request('list', { path: scratch }))
await step('where ping', () => transport.request('where', { name: 'ping' }))
await step('where node via PATH', () => transport.request('where', { name: 'node', path: process.env.PATH, pathExt: '.COM;.EXE;.BAT;.CMD' }))

// Per-command ssh: the subprocess provider's path.
const runCommand = (line: string) => new Promise<any>((resolve) => {
	const child = transport.spawnCommand(line)
	let stdout = ''
	let stderr = ''
	child.stdout!.on('data', (chunk) => { stdout += chunk.toString('utf8') })
	child.stderr!.on('data', (chunk) => { stderr += chunk.toString('utf8') })
	child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() }))
	child.on('error', (error) => resolve({ code: null, signal: null, stdout: '', stderr: String(error) }))
	child.stdin!.end()
})

console.log('--- per-command ssh ---')
console.log(`echo:            ${JSON.stringify(await runCommand('echo hello-from-remote'))}`)
console.log(`cwd+exit code:   ${JSON.stringify(await runCommand(`cd /d ${root} && cd && exit /b 3`))}`)
console.log(`stderr channel:  ${JSON.stringify(await runCommand('echo to-stderr 1>&2'))}`)
console.log(`long-ish output: ${JSON.stringify((await runCommand('wmic logicaldisk get size,caption')).stdout.split('\n').length)} lines`)

await step('remove note', () => transport.request('remove', { path: `${scratch}\\note.txt` }))
await step('remove scratch dir marker (no-op)', () => transport.request('remove', { path: `${scratch}\\missing.txt` }))
transport.close()
console.log('done')
