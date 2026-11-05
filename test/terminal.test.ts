import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { SshTransport } from '../src/transport.js'
import type { RemoteSystem } from '../src/transport.js'
import type { TerminalSpawnSpec } from '../src/seams.js'
import {
	LineTerminalSession,
	PtyTerminalSession,
	decodeCommand,
	parseTrail,
	posixTerminalShell,
	resolveTerminalMode,
	sessionMarker,
} from '../src/terminal-session.js'

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	readonly pid = 4242
	readonly kills: Array<string | undefined> = []
	kill(signal?: string): boolean {
		this.kills.push(signal)
		return true
	}
}

class FakeTransport {
	host = 'gaming-pc'
	system: RemoteSystem | undefined = undefined
	readonly commands: string[] = []
	readonly ptyCommands: string[] = []
	readonly children: FakeChild[] = []

	spawnCommand(remoteCommand: string): ChildProcess {
		this.commands.push(remoteCommand)
		return this.#track()
	}

	spawnPty(remoteCommand: string): ChildProcess {
		this.ptyCommands.push(remoteCommand)
		return this.#track()
	}

	#track(): ChildProcess {
		const child = new FakeChild()
		this.children.push(child)
		return child as unknown as ChildProcess
	}
}

class Sink {
	text = ''

	constructor(stream: Readable) {
		stream.on('data', (chunk: Buffer) => {
			this.text += chunk.toString('utf8')
		})
	}
}

function spec(overrides: Partial<TerminalSpawnSpec> = {}): TerminalSpawnSpec {
	return { argv: ['powershell.exe'], cwd: 'C:\\Work\\p', rows: 30, cols: 100, terminalType: 'xterm-256color', graceMs: 50, ...overrides }
}

function open(overrides: Partial<TerminalSpawnSpec> = {}) {
	const transport = new FakeTransport()
	const opening = LineTerminalSession.create(transport as unknown as Parameters<typeof LineTerminalSession.create>[0], { shell: 'powershell', graceMs: 50 }, spec(overrides))
	return { transport, opening }
}

function script(command: string): string {
	return decodeCommand(command)
}

function marker(command: string): string {
	return sessionMarker(script(command))
}

function trailer(command: string, cwd: string, env: Record<string, string>, lastExit = ''): string {
	const blob = [cwd, lastExit, ...Object.entries(env).map(([key, value]) => `${key}=${value}`)].join('\0')
	return `${marker(command)} ${Buffer.from(blob, 'utf8').toString('base64')}\n`
}

async function openSession(overrides: Partial<TerminalSpawnSpec> = {}, env: Record<string, string> = { PATH: 'A', COMPUTERNAME: 'WORK-PC' }) {
	const world = open(overrides)
	const probe = world.transport.children[0]
	probe.stderr.write(trailer(world.transport.commands[0], 'C:\\Work\\p', env))
	probe.emit('close', 0, null)
	const session = await world.opening
	return { ...world, session, sink: new Sink(session.output) }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('the session probes the remote world quietly, then shows a banner and a prompt', async () => {
	const world = open()
	world.transport.system = undefined
	const probe = world.transport.children[0]
	assert.equal(world.transport.commands.length, 1)
	assert.match(script(world.transport.commands[0]), /if \(Test-Path -LiteralPath 'C:\\Work\\p'\) \{ Set-Location -LiteralPath 'C:\\Work\\p' \}/)
	assert.doesNotMatch(script(world.transport.commands[0]), /; ;/)

	probe.stderr.write(trailer(world.transport.commands[0], 'C:\\Work\\p', { PATH: 'A' }))
	probe.emit('close', 0, null)
	const session = await world.opening
	const sink = new Sink(session.output)
	await tick()
	assert.match(sink.text, /dsh-ssh remote shell on gaming-pc/)
	assert.match(sink.text, /PS C:\\Work\\p> /)
	assert.equal(session.pid, 4242)
	assert.equal((await session.inspectActivity()).state, 'idle')
	assert.equal((await session.inspectForeground())?.inputWaiting, true)
})

test('typed text echoes locally and Enter runs exactly one remote command', async () => {
	const { transport, session, sink } = await openSession()
	await session.write('git status')
	await tick()
	assert.ok(sink.text.endsWith('git status'))
	assert.equal(transport.commands.length, 1, 'nothing runs before Enter')

	await session.write('\r')
	await tick()
	assert.equal(transport.commands.length, 2)
	assert.match(script(transport.commands[1]), /& \{ git status \} 2>&1/)
	assert.equal(sink.text.includes('git status\r\n'), true)

	transport.children[1].stderr.write(trailer(transport.commands[1], 'C:\\Work\\p\\repo', { PATH: 'A', COMPUTERNAME: 'WORK-PC', DSH: '1' }, '4'))
	transport.children[1].emit('close', 0, null)
	await tick()
	assert.match(sink.text, /PS C:\\Work\\p\\repo> /)

	await session.write('dir\r')
	await tick()
	const next = script(transport.commands[2])
	assert.match(next, /Set-Location -LiteralPath 'C:\\Work\\p\\repo'/)
	assert.match(next, /\$global:LASTEXITCODE = 4/)
	assert.match(next, /SetEnvironmentVariable\('DSH', '1', 'Process'\)/)
	assert.doesNotMatch(next, /SetEnvironmentVariable\('PATH'/)

	transport.children[2].stderr.write(trailer(transport.commands[2], 'C:\\Work\\p\\repo', { PATH: 'A', COMPUTERNAME: 'WORK-PC' }))
	transport.children[2].emit('close', 0, null)
	await session.write('ver\r')
	await tick()
	const restored = script(transport.commands[3])
	assert.doesNotMatch(restored, /SetEnvironmentVariable\('DSH'/, 'a variable back at its login value needs no statement')
	assert.doesNotMatch(restored, /SetEnvironmentVariable\('COMPUTERNAME'/)

	transport.children[3].stderr.write(trailer(transport.commands[3], 'C:\\Work\\p\\repo', { PATH: 'A' }))
	transport.children[3].emit('close', 0, null)
	await session.write('whoami\r')
	await tick()
	assert.match(script(transport.commands[4]), /SetEnvironmentVariable\('COMPUTERNAME', \$null, 'Process'\)/)
})

test('the caller-provided environment is injected on every command, not folded into the baseline', async () => {
	const { transport, session } = await openSession({ env: { DSH_SESSION_ID: 's1' } }, { PATH: 'A', DSH_SESSION_ID: 's1' })
	await session.write('dir\r')
	await tick()
	assert.match(script(transport.commands[0]), /SetEnvironmentVariable\('DSH_SESSION_ID', 's1', 'Process'\)/)
	assert.match(script(transport.commands[1]), /SetEnvironmentVariable\('DSH_SESSION_ID', 's1', 'Process'\)/)
})

test('line editing echoes without touching the remote command', async () => {
	const { transport, session } = await openSession()
	await session.write('git commitx')
	await session.write('\b')
	await session.write('\x15')
	await session.write('git blame src\r')
	await tick()
	assert.match(script(transport.commands[1]), /& \{ git blame src \} 2>&1/)
})

test('escape sequences never reach the remote command', async () => {
	const { transport, session } = await openSession()
	await session.write('ab\x1b[Ccd\x1b[?25l\r')
	await tick()
	assert.match(script(transport.commands[1]), /& \{ abcd \} 2>&1/)
})

test('a line typed while the remote command runs is queued, not dropped', async () => {
	const { transport, session } = await openSession()
	await session.write('one\r')
	await tick()
	await session.write('two\r')
	await tick()
	assert.equal(transport.commands.length, 2, 'the queued line waits for its turn')
	assert.equal((await session.inspectActivity()).state, 'busy')

	transport.children[1].emit('close', 0, null)
	await tick()
	assert.equal(transport.commands.length, 3)
	assert.match(script(transport.commands[2]), /& \{ two \} 2>&1/)
})

test('Ctrl+C kills the running command and leaves the session ready', async () => {
	const { transport, session, sink } = await openSession()
	await session.write('ping -t\r')
	await tick()
	const run = transport.children[1]
	await session.write('\x03')
	assert.deepEqual(run.kills, [undefined])
	run.emit('close', null, 'SIGTERM')
	await tick()
	assert.match(sink.text, /\^C\r\n/)
	assert.match(sink.text, /PS C:\\Work\\p> $/)
	assert.equal((await session.inspectActivity()).state, 'idle')

	const before = transport.commands.length
	await session.signalForeground('SIGINT')
	assert.equal(transport.commands.length, before, 'Ctrl+C on an idle prompt runs nothing')
})

test('a command whose remote call fails reports it and stays usable', async () => {
	const { transport, session, sink } = await openSession()
	await session.write('dir\r')
	await tick()
	transport.children[1].emit('error', new Error('ssh exited'))
	await tick()
	assert.match(sink.text, /\[dsh-ssh: the remote command did not run\]/)
	assert.match(sink.text, /PS C:\\Work\\p> $/)
})

test('exit ends the session with the shell exit code', async () => {
	const { transport, session, sink } = await openSession()
	await session.write('exit 3\r')
	assert.deepEqual(await session.done, { exitCode: 3, signal: null })
	assert.equal(transport.commands.length, 1, 'exit never reaches the remote')
	await session.write('still here')
	assert.ok(!sink.text.includes('still here'))
})

test('terminate ends the stream and settles the session', async () => {
	const { session } = await openSession()
	await session.write('sleep 100\r')
	await tick()
	await session.terminate()
	assert.deepEqual(await session.done, { exitCode: null, signal: 'SIGTERM' })
})

test('a cancelled allocation tears the session down', async () => {
	const controller = new AbortController()
	const world = open({ signal: controller.signal })
	controller.abort()
	const probe = world.transport.children[0]
	probe.stderr.write(trailer(world.transport.commands[0], 'C:\\Work\\p', { PATH: 'A' }))
	probe.emit('close', 0, null)
	await assert.rejects(world.opening, /cancelled/)
})

test('pty mode asks for a remote tty and relays bytes unframed', async () => {
	const transport = new FakeTransport()
	const session = new PtyTerminalSession(
		transport as unknown as ConstructorParameters<typeof PtyTerminalSession>[0],
		{ shell: 'bash', graceMs: 20 },
		spec({ cwd: '/home/alex/project' }),
	)
	assert.equal(transport.ptyCommands.length, 1)
	assert.equal(
		transport.ptyCommands[0],
		"stty rows 30 cols 100 2>/dev/null; cd '/home/alex/project' 2>/dev/null; exec 'bash'",
	)

	let fed = ''
	transport.children[0].stdin.on('data', (chunk: Buffer) => {
		fed += chunk.toString('utf8')
	})
	transport.children[0].stdout.write(Buffer.from('hello\r\n'))
	const sink = new Sink(session.output)
	await session.write('ls\r')
	assert.equal(fed, 'ls\r')
	assert.equal(sink.text, 'hello\r\n')
	assert.equal(await session.inspectForeground(), undefined)

	await session.signalForeground('SIGINT')
	assert.equal(fed, 'ls\r\x03')
	transport.children[0].emit('close', 0, null)
	assert.deepEqual(await session.done, { exitCode: 0, signal: null })
})

test('pty terminate kills the channel and settles', async () => {
	const transport = new FakeTransport()
	const session = new PtyTerminalSession(
		transport as unknown as ConstructorParameters<typeof PtyTerminalSession>[0],
		{ shell: 'bash', graceMs: 20 },
		spec({ cwd: '/home/alex' }),
	)
	await session.terminate()
	assert.deepEqual(await session.done, { exitCode: null, signal: 'SIGTERM' })
	assert.ok(transport.children[0].kills.includes(undefined))
})

test('parseTrail decodes the carried cwd, exit code and environment', () => {
	const encoded = Buffer.from(['C:\\Work', '7', 'A=1', 'B=x=y'].join('\0'), 'utf8').toString('base64')
	assert.deepEqual(parseTrail('M', `M ${encoded}`), { cwd: 'C:\\Work', lastExit: '7', env: { A: '1', B: 'x=y' } })
	assert.equal(parseTrail('M', 'unrelated line'), undefined)
	assert.equal(parseTrail('M', 'M '), undefined)
})

test('the remote script merges every stream into stdout and carries the exit code back', async () => {
	const { transport, session } = await openSession()
	await session.write('git status\r')
	await tick()
	const script = decodeCommand(transport.commands[1])
	assert.match(script, /2>&1 3>&1 4>&1 5>&1 6>&1/)
	assert.match(script, /\[Console\]::Out\.WriteLine\(\[string\]\$_\.Exception\.Message\)/)
	assert.match(script, /\$__dshExit = \[string\]\$LASTEXITCODE/)
	assert.match(script, /try \{ \[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8 \} catch \{ \}/)
})

test('terminal mode and the posix shell follow configuration and the reported os', () => {
	assert.equal(resolveTerminalMode(undefined, 'Microsoft Windows 10 Pro'), 'line')
	assert.equal(resolveTerminalMode('auto', 'Microsoft Windows 11 Pro'), 'line')
	assert.equal(resolveTerminalMode('auto', 'Linux'), 'pty')
	assert.equal(resolveTerminalMode('auto', undefined), 'line')
	assert.equal(resolveTerminalMode('pty', 'Microsoft Windows 11 Pro'), 'pty')
	assert.equal(resolveTerminalMode('line', 'Linux'), 'line')
	assert.equal(posixTerminalShell('powershell'), 'bash')
	assert.equal(posixTerminalShell('pwsh'), 'bash')
	assert.equal(posixTerminalShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'bash')
	assert.equal(posixTerminalShell('/bin/zsh'), '/bin/zsh')
})

test('pty argv forces tty allocation ahead of the destination', () => {
	const transport = new SshTransport({ host: 'h', sshBin: 'ssh', sshArgs: ['-p', '2222'], remoteShell: 'powershell', connectTimeoutMs: 1, requestTimeoutMs: 1 })
	assert.deepEqual(transport.ptyArgv('ls'), ['-p', '2222', '-tt', 'h', 'ls'])
})
