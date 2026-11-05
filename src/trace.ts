import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const file = join(tmpdir(), 'dsh-ssh-boot-trace.log')

export function trace(message: string): void {
	if (process.env.DSH_SSH_TRACE === '0') return
	try {
		appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
	} catch {}
}
