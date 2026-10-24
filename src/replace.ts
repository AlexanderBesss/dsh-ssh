/**
 * Replace-mode entry point: `dsh-ssh/replace`.
 *
 * A session that is entirely on the remote PC, where the SSH providers take
 * the public `fs` and `subprocess` names outright. That shape cannot share an
 * entry with route mode: the route-mode gate waits for the app's `fs` and
 * `subprocess` to exist (so routing can borrow them), while replace mode
 * withdraws those rows in the profile patch and provides them itself — under
 * a shared gate the fiber would sit "pending" forever and the app would be
 * left with no filesystem at all. So the composition picks the entry:
 *
 * ```yaml
 * # profile cordis.patch.yml — remote-only session (see README before use)
 * - disabled: fs-sandbox        # local provider rows out of the way…
 * - disabled: subprocess
 * - id: ssh-replace
 *   name: dsh-ssh/replace       # …and this entry takes their names
 *   config:
 *     remoteRoot: 'C:\Users\Public\workplace'
 * ```
 *
 * The trade, restated because it is the whole point of the mode: with nothing
 * local mounted, a session cannot touch this machine's files, and if the SSH
 * providers fail to come up the app has no filesystem. Route mode
 * (`dsh-ssh`, the default) is the supported daily shape.
 *
 * @module dsh-ssh/replace
 */

import type { Context } from '@deepseek-ai/cordis'
import { applyModule, Config } from './index.js'
import type { SshConfig } from './index.js'

export const name = 'ssh'

/**
 * The only hard dependency: the tool registry, for the `ssh_status` tool.
 * This entry deliberately does NOT gate on `fs`/`subprocess` — it provides
 * them — nor on `webServer`, so the composition stays mountable headless;
 * the picker routes come up through `ctx.inject`/polling when a web server
 * is present.
 */
export const inject = ['tools']

export { Config }

export function apply(ctx: Context, config: SshConfig): void {
	applyModule(ctx, { ...config, mode: 'replace' }, true)
}
