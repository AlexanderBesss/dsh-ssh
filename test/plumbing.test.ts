/**
 * Characterization tests for the git-plumbing env rewrite (src/git-plumbing.ts),
 * the write-through mirror (src/materialize.ts), and the fs-provider hooks
 * they feed. Run with `npm test`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { plumbingRootOf, prunePlumbingScript, rewriteGitPlumbing } from '../src/git-plumbing.js'
import { createMirror } from '../src/materialize.js'
import { SshFileSystem } from '../src/fs-provider.js'

const stubCtx = () => ({ reflect: { provide: () => {} } }) as any

test('plumbingRootOf derives a remote scratch root from the remote home', () => {
	assert.equal(plumbingRootOf('C:\\Users\\r'), 'C:\\Users\\r\\.dsh\\dsh-ssh-git')
	assert.equal(plumbingRootOf('C:\\Users\\r\\'), 'C:\\Users\\r\\.dsh\\dsh-ssh-git')
	assert.equal(plumbingRootOf(undefined), undefined)
	assert.equal(plumbingRootOf(''), undefined)
})

test('rewriteGitPlumbing maps local scratch paths and keeps repository paths', () => {
	const rewrite = rewriteGitPlumbing({
		GIT_INDEX_FILE: 'C:\\Users\\me\\AppData\\Local\\Temp\\dsh-changes\\index-7Qx\\index',
		GIT_OBJECT_DIRECTORY: 'C:\\Users\\me\\AppData\\Local\\Temp\\dsh-changes\\objects',
		GIT_ALTERNATE_OBJECT_DIRECTORIES: 'C:\\Work\\repo\\.git\\objects',
		GIT_CONFIG_COUNT: '0',
		LC_ALL: 'C',
	}, ['C:\\Work'], 'R:\\plumb')
	assert.equal(rewrite.remapped, true)
	assert.ok(rewrite.env.GIT_INDEX_FILE.startsWith('R:\\plumb\\index-'))
	assert.equal(rewrite.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, 'C:\\Work\\repo\\.git\\objects')
	assert.ok(rewrite.env.GIT_OBJECT_DIRECTORY.startsWith('R:\\plumb\\objects-'))
	assert.equal(rewrite.env.GIT_CONFIG_COUNT, '0')
	assert.equal(rewrite.env.LC_ALL, 'C')
	assert.deepEqual(rewrite.createdDirs, ['R:\\plumb', rewrite.env.GIT_OBJECT_DIRECTORY])
	const again = rewriteGitPlumbing({ GIT_INDEX_FILE: 'C:\\Users\\me\\AppData\\Local\\Temp\\dsh-changes\\index-7Qx\\INDEX' }, ['C:\\Work'], 'R:\\plumb')
	assert.equal(again.env.GIT_INDEX_FILE, rewrite.env.GIT_INDEX_FILE)
})

test('rewriteGitPlumbing passes through env without plumbing keys', () => {
	const rewrite = rewriteGitPlumbing({ PATH: 'C:\\bin', FOO: 'bar' }, ['C:\\Work'], 'R:\\plumb')
	assert.equal(rewrite.remapped, false)
	assert.deepEqual(rewrite.env, { PATH: 'C:\\bin', FOO: 'bar' })
	assert.deepEqual(rewrite.createdDirs, [])
})

test('rewriteGitPlumbing folds slash-separated values and keeps unmappable parts', () => {
	const rewrite = rewriteGitPlumbing({
		GIT_ALTERNATE_OBJECT_DIRECTORIES: 'C:\\Work\\a\\.git\\objects;D:\\elsewhere\\objects',
		GIT_INDEX_FILE: 'relative-index',
	}, ['C:\\Work'], 'R:\\plumb')
	assert.ok(rewrite.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.startsWith('C:\\Work\\a\\.git\\objects;R:\\plumb\\objects-'))
	assert.equal(rewrite.env.GIT_INDEX_FILE, 'relative-index')
	assert.equal(rewrite.remapped, true)
})

test('prunePlumbingScript quotes the root and bounds age', () => {
	const script = prunePlumbingScript('R:\\plumb\'s')
	assert.ok(script.includes("'R:\\plumb''s'"))
	assert.ok(script.includes('AddDays(-2)'))
})

test('createMirror writes only inside mirror roots and under the size cap', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-mirror-'))
	try {
		const mirror = createMirror(() => [join(dir, 'root')], 1024)
		await mirror(join(dir, 'root', 'a', 'b.txt'), Buffer.from('hello'))
		assert.equal(await readFile(join(dir, 'root', 'a', 'b.txt'), 'utf8'), 'hello')
		await mirror(join(dir, 'outside.txt'), Buffer.from('nope'))
		assert.equal(await readFile(join(dir, 'outside.txt'), 'utf8').catch(() => undefined), undefined)
		await mirror(join(dir, 'root', 'big.txt'), Buffer.alloc(1025))
		assert.equal(await readFile(join(dir, 'root', 'big.txt'), 'utf8').catch(() => undefined), undefined)
		await mirror(join(dir, 'root', 'b.txt', 'nested'), Buffer.from('x'))
		await mirror('relative\\path', Buffer.from('x'))
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('SshFileSystem maps host paths onto the mirrored remote world', () => {
	const filesystem = new SshFileSystem(stubCtx(), { cwd: 'C:\\Work' }, { host: 'h' } as any, 'ssh-fs')
	assert.equal(filesystem.processPathFromHostPath('C:\\Work\\out\\report.md'), 'C:\\Work\\out\\report.md')
	assert.equal(filesystem.processPathFromHostPath('C:/Work/a.md'), 'C:\\Work\\a.md')
	assert.equal(filesystem.processPathFromHostPath('relative'), undefined)
	assert.equal(filesystem.processPathFromHostPath(''), undefined)
	assert.equal(filesystem.fileUrl({ targetKey: 'k' as any, displayPath: 'C:\\Work\\a.md' }), 'sftp://h/C:/Work/a.md')
})

test('fs reads and writes push bytes through the mirror sink', async () => {
	const seen: string[] = []
	let written = false
	const transport = {
		host: 'h',
		async request(op: string) {
			if (op === 'stat') return { exists: written, type: 'file', size: 7, version: 'v1' }
			if (op === 'write') {
				written = true
				return { version: 'v2' }
			}
			if (op === 'read') return { base64: Buffer.from('content', 'utf8').toString('base64') }
			throw new Error(`unexpected op ${op}`)
		},
	} as any
	const filesystem = new SshFileSystem(stubCtx(), {
		cwd: 'C:\\Work',
		mirror: async (path, bytes) => void seen.push(`${path}:${bytes.length}:${bytes.toString('utf8')}`),
	}, transport, 'ssh-fs')
	const target = await filesystem.resolve('C:\\Work\\a.md', {})
	await filesystem.writeText(target, 'content')
	assert.deepEqual(seen, ['C:\\Work\\a.md:7:content'])
	await filesystem.readText(target)
	await filesystem.readBytes(target)
	await filesystem.editText(target, { oldString: 'content', newString: 'edited' })
	assert.deepEqual(seen, [
		'C:\\Work\\a.md:7:content',
		'C:\\Work\\a.md:7:content',
		'C:\\Work\\a.md:7:content',
		'C:\\Work\\a.md:6:edited',
	])
})

test('a failing mirror sink never fails a remote write', async () => {
	const filesystem = new SshFileSystem(stubCtx(), {
		cwd: 'C:\\Work',
		mirror: async () => {
			throw new Error('mirror disk gone')
		},
	}, {
		host: 'h',
		async request(op: string) {
			if (op === 'stat') return { exists: false, type: 'file', size: 0, version: 'v1' }
			if (op === 'write') return { version: 'v2' }
			throw new Error(`unexpected op ${op}`)
		},
	} as any, 'ssh-fs')
	const target = await filesystem.resolve('C:\\Work\\a.md', {})
	const result = await filesystem.writeText(target, 'content')
	assert.equal(result.operation, 'create')
})
