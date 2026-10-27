import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contains, isAbsolute, joinDir, normalize, resolvePath, targetKey } from '../src/remote-path.js'

test('isAbsolute', () => {
	assert.equal(isAbsolute('C:\\x'), true)
	assert.equal(isAbsolute('C:/x'), true)
	assert.equal(isAbsolute('\\\\server\\share'), true)
	assert.equal(isAbsolute('x\\y'), false)
	assert.equal(isAbsolute('C:x'), false)
	assert.equal(isAbsolute(''), false)
})

test('normalize folds separators, dots and parent segments', () => {
	assert.equal(normalize('C:\\a\\..\\b'), 'C:\\b')
	assert.equal(normalize('C:\\a\\.\\b'), 'C:\\a\\b')
	assert.equal(normalize('C:/a/b'), 'C:\\a\\b')
	assert.equal(normalize('C:\\a\\b\\'), 'C:\\a\\b')
	assert.equal(normalize('C:\\'), 'C:\\')
	// quirk pinned as-is: .. pops the drive segment itself, leaving ''
	assert.equal(normalize('C:\\..\\..'), '')
})

test('normalize protects the UNC share root from ..', () => {
	assert.equal(normalize('\\\\server\\share\\a\\..\\..'), '\\\\server\\share')
	assert.equal(normalize('\\\\server\\share\\..'), '\\\\server\\share')
	assert.equal(normalize('\\\\server\\share\\a\\b'), '\\\\server\\share\\a\\b')
})

test('normalize rejects relative and drive-relative paths', () => {
	assert.throws(() => normalize('relative\\x'), /not an absolute remote path/)
	assert.throws(() => normalize('C:work'), /not an absolute remote path/)
})

test('normalize keeps case', () => {
	assert.equal(normalize('C:\\SRC\\A.TS'), 'C:\\SRC\\A.TS')
})

test('resolvePath', () => {
	assert.equal(resolvePath('C:\\root', ''), 'C:\\root')
	assert.equal(resolvePath('C:\\root\\', 'sub'), 'C:\\root\\sub')
	assert.equal(resolvePath('C:\\root', 'D:\\x'), 'D:\\x')
	assert.equal(resolvePath('C:\\root', 'a\\..\\b'), 'C:\\root\\b')
})

test('targetKey case-folds', () => {
	assert.equal(targetKey('C:\\SRC\\A.TS'), 'c:\\src\\a.ts')
	assert.equal(targetKey('C:\\src\\a.ts'), targetKey('C:\\SRC\\A.TS'))
})

test('contains compares case-insensitively and blocks partial names', () => {
	assert.equal(contains('C:\\Work', 'C:\\Work'), true)
	assert.equal(contains('C:\\Work', 'C:\\Work\\sub'), true)
	assert.equal(contains('C:\\Work', 'C:\\work\\SUB'), true)
	assert.equal(contains('C:\\Work', 'C:\\Workplace'), false)
	assert.equal(contains('C:\\Work', 'D:\\Work'), false)
	assert.equal(contains('C:\\', 'C:\\x'), true)
	assert.equal(contains('C:\\Work\\', 'c:\\work'), true)
})

test('joinDir', () => {
	assert.equal(joinDir('C:\\a\\', 'b'), 'C:\\a\\b')
	assert.equal(joinDir('C:\\a', 'b\\c'), 'C:\\a\\b\\c')
})
