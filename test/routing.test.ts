/**
 * Characterization tests for the route-mode classifiers and routers in
 * src/routing.ts, plus the argv shape of src/transport.ts.
 *
 * The fakes stand in for the local and remote providers; every assertion pins
 * which implementation served a call, the same trick coexistence-check uses
 * against the real app. Run with `npm test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SshTransport } from '../src/transport.js'
import { createFsRouter, createSubprocessRouter, installRouting, sideFor, sideForTarget } from '../src/routing.js'

const roots = () => ['C:\\Work']

test('sideFor classifies paths against the remote roots', () => {
	assert.equal(sideFor(roots, 'C:\\Work', undefined), 'remote')
	assert.equal(sideFor(roots, 'C:\\Work\\a\\b.ts', undefined), 'remote')
	assert.equal(sideFor(roots, 'D:\\x', undefined), 'local')
	assert.equal(sideFor(roots, 'sub', undefined), 'local')
	assert.equal(sideFor(roots, 'sub', 'C:\\Work\\proj'), 'remote')
	assert.equal(sideFor(roots, 'D:\\x', 'C:\\Work\\proj'), 'local')
	assert.equal(sideFor(roots, '', undefined), 'local')
	assert.equal(sideFor(roots, '', 'C:\\Work\\p'), 'remote')
	assert.equal(sideFor(roots, 'C:work', undefined), 'local')
})

test('sideFor falls back to local on any classification error', () => {
	assert.equal(sideFor(() => { throw new Error('boom') }, 'C:\\Work', undefined), 'local')
})

test('sideForTarget reads the displayed path', () => {
	assert.equal(sideForTarget(roots, { displayPath: 'C:\\Work\\a' }), 'remote')
	assert.equal(sideForTarget(roots, { displayPath: 'D:\\a' }), 'local')
	assert.equal(sideForTarget(roots, {}), 'local')
	assert.equal(sideForTarget(roots, null), 'local')
})

class LocalFs {
	someProp = 7
	stat() { return 'local-stat' }
	readText() { return 'local-read' }
	resolve(p: unknown, o?: unknown) { return { via: 'local', p, o } }
	contains() { return 'local-contains' }
	processPath(t: any) { return String(t?.displayPath) }
	fileUrl() { return 'local-url' }
	watch() { return 'local-watch' }
	processPathFromHostPath() { return 'local-host-map' }
	notListed(t: any) { return `local-extra:${t?.displayPath ?? 'plain'}` }
	whoAmI() { return this.someProp }
}

class RemoteFs {
	stat() { return 'remote-stat' }
	readText() { return 'remote-read' }
	resolve(p: unknown, o?: unknown) { return { via: 'remote', p, o } }
	contains() { return 'remote-contains' }
	processPath(t: any) { return `remote:${t?.displayPath}` }
	fileUrl() { return 'remote-url' }
	watch() { return 'remote-watch' }
	processPathFromHostPath() { return 'remote-host-map' }
	notListed(t: any) { return `remote-extra:${t?.displayPath ?? 'plain'}` }
}

test('fs router forwards by target, keeps the prototype, and guards unlisted methods', () => {
	const local = new LocalFs()
	const router = createFsRouter({ local, remote: new RemoteFs(), remoteRoots: roots })

	assert.equal(router.stat({ displayPath: 'C:\\Work\\a' }), 'remote-stat')
	assert.equal(router.stat({ displayPath: 'D:\\a' }), 'local-stat')
	assert.equal(router.readText({ displayPath: 'C:\\Work' }), 'remote-read')

	assert.deepEqual(router.resolve('sub', { cwd: 'C:\\Work\\p' }), { via: 'remote', p: 'sub', o: { cwd: 'C:\\Work\\p' } })
	assert.equal((router.resolve('D:\\x') as any).via, 'local')

	assert.equal(router.contains({ displayPath: 'C:\\Work' }, { displayPath: 'C:\\Work\\a' }), 'remote-contains')
	assert.equal(router.processPath({ displayPath: 'C:\\Work\\a' }), 'remote:C:\\Work\\a')
	assert.equal(router.processPath({ displayPath: 'D:\\a' }), 'D:\\a')
	assert.equal(router.processPathFromHostPath('C:\\anything'), 'local-host-map')
	assert.equal(router.processPathFromHostPath('C:\\Work\\out\\report.md'), 'remote-host-map')

	assert.equal(router.someProp, 7)
	assert.equal(router.whoAmI(), 7, 'method binds to the local implementation')

	// An unlisted method with a remote-shaped target must fail loudly, not serve the local mirror.
	assert.throws(() => router.notListed({ displayPath: 'C:\\Work\\a' }), TypeError)
	assert.equal(router.notListed({ displayPath: 'D:\\x' }), 'local-extra:D:\\x')
	assert.equal(router.notListed('a plain string'), 'local-extra:plain')

	assert.equal(Object.getPrototypeOf(router), LocalFs.prototype)
	assert.ok(router instanceof LocalFs)
	assert.equal('someProp' in router, true)
	assert.ok(Reflect.ownKeys(router).includes('someProp'))

	router.someProp = 9
	assert.equal(local.someProp, 9, 'writes land on the local implementation')
})

class LocalSub {
	spawn(spec: any) { return `local-spawn:${spec?.cwd ?? ''}` }
	spawnTerminal(spec: any) { return `local-term:${spec?.cwd ?? ''}` }
	terminalEnvironment() { return { platform: 'local' } }
	resolveExecutable(name: unknown) {
		if (name === 'localcmd') return 'C:\\local\\localcmd.exe'
		throw new Error('not on local PATH')
	}
	other() { return 'local-other' }
}

class RemoteSub {
	spawn(spec: any) { return `remote-spawn:${spec?.cwd ?? ''}` }
	spawnTerminal(spec: any) { return `remote-term:${spec?.cwd ?? ''}` }
	terminalEnvironment() { return { platform: 'remote' } }
	resolveExecutable(name: unknown) { return `remote:${name}` }
}

test('subprocess router routes by cwd and answers terminalEnvironment by defaultSide', async () => {
	const auto = createSubprocessRouter({ local: new LocalSub(), remote: new RemoteSub(), remoteRoots: roots, defaultSide: 'auto' })
	assert.equal(auto.spawn({ cwd: 'C:\\Work\\proj' }), 'remote-spawn:C:\\Work\\proj')
	assert.equal(auto.spawn({ cwd: 'D:\\x' }), 'local-spawn:D:\\x')
	assert.equal(auto.spawn({}), 'local-spawn:')
	assert.equal(auto.terminalEnvironment().platform, 'local')
	assert.equal(auto.other(), 'local-other')

	const remoteSide = createSubprocessRouter({ local: new LocalSub(), remote: new RemoteSub(), remoteRoots: roots, defaultSide: 'remote' })
	assert.equal(remoteSide.terminalEnvironment().platform, 'remote')
	assert.equal(await remoteSide.resolveExecutable('localcmd'), 'remote:localcmd')
})

test('resolveExecutable falls back to the remote PATH when local lookup fails', async () => {
	const router = createSubprocessRouter({ local: new LocalSub(), remote: new RemoteSub(), remoteRoots: roots })
	assert.equal(await router.resolveExecutable('localcmd'), 'C:\\local\\localcmd.exe')
	assert.equal(await router.resolveExecutable('remoteonly'), 'remote:remoteonly')
})

test('installRouting answers other fibers with the router and leaves this fiber alone', () => {
	let listener: any
	const ctx: any = {
		fiber: 'own-fiber',
		on: (_event: string, fn: any) => { listener = fn; return () => {} },
	}
	const routers = { fs: { marker: 'fs-router' }, subprocess: { marker: 'sub-router' } }
	installRouting(ctx, routers)

	assert.equal(listener({ fiber: 'own-fiber' }, 'fs', undefined, () => 'next'), 'next')
	assert.deepEqual(listener({ fiber: 'other' }, 'fs', undefined, () => 'next'), routers.fs)
	assert.deepEqual(listener({ fiber: 'other' }, 'subprocess', undefined, () => 'next'), routers.subprocess)
	assert.equal(listener({ fiber: 'other' }, 'unrouted', undefined, () => 'next'), 'next')
})

test('transport builds the ssh argv', () => {
	const withArgs = new SshTransport({ host: 'h', sshBin: 'ssh', sshArgs: ['-o', 'BatchMode=yes'], remoteShell: 'powershell', connectTimeoutMs: 1, requestTimeoutMs: 1 })
	assert.deepEqual(withArgs.sshArgv('dir'), ['-o', 'BatchMode=yes', 'h', 'dir'])
	const bare = new SshTransport({ host: 'h', sshBin: 'ssh', remoteShell: 'powershell', connectTimeoutMs: 1, requestTimeoutMs: 1 })
	assert.deepEqual(bare.sshArgv('dir'), ['h', 'dir'])
})
