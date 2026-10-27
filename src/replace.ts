import type { Context } from '@deepseek-ai/cordis'
import { applyModule, Config } from './index.js'
import type { SshConfig } from './index.js'

export const name = 'ssh'

// gate on tools only: this entry provides fs/subprocess itself, and stays mountable headless
export const inject = ['tools']

export { Config }

export function apply(ctx: Context, config: SshConfig): void {
	applyModule(ctx, { ...config, mode: 'replace' }, true)
}
