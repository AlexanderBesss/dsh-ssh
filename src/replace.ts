/**
 * Replace-mode entry `dsh-ssh/replace`: the SSH providers take the public
 * `fs`/`subprocess` names outright, and the profile patch must have disabled
 * the local provider rows first. If the SSH providers fail, the app has NO
 * filesystem — route mode (`dsh-ssh`, default) is the daily shape.
 *
 * @module dsh-ssh/replace
 */

import type { Context } from '@deepseek-ai/cordis'
import { applyModule, Config } from './index.js'
import type { SshConfig } from './index.js'

export const name = 'ssh'

/** Gate on `tools` only: this entry provides `fs`/`subprocess` itself, and stays mountable headless. */
export const inject = ['tools']

export { Config }

export function apply(ctx: Context, config: SshConfig): void {
	applyModule(ctx, { ...config, mode: 'replace' }, true)
}
