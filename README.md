# dsh-ssh

Work on a project that lives on a **remote Windows PC**, from this DSH session.
The ordinary `read`, `write`, `edit`, `glob`, `grep`, and `pwsh` tools operate
on the remote machine — by default **path by path**: anything under the
configured `remoteRoot` is served over SSH, and every other path stays on this
machine, in the same session.

## Requirements

- The remote host runs **Windows** with **OpenSSH Server** enabled, and
  PowerShell available as `powershell` (Windows PowerShell 5.1 is the tested
  target; set `remoteShell: pwsh` for PowerShell 7).
- **Non-interactive SSH auth works** — key auth, `~/.ssh/config` Host aliases,
  `IdentityFile`, `ProxyJump`, and ssh-agent all just work, because the plugin
  shells out to your system `ssh` and handles no credentials itself.
- Check it first: `ssh <host> "echo ok"` must print `ok` with no password
  prompt.

## Install

The supported route is the **Plugins page**: install the package from its local
path (or package name). That records it as a manifest dependency, gives it a
row with an enable toggle, and runs its `prepare` build. To script the same
operation instead:

```powershell
npm run build
node dist/scripts/install-profile.js add --profile desktop
node dist/scripts/install-profile.js status --profile desktop   # read-only
```

A plain file copy into `node_modules` is **not** an install — the Plugins page
only lists bundles backed by a manifest dependency.

Toggling off restores normal behaviour cleanly: disabling the bundle row also
withdraws the plugin's patch layer, so the app's own local providers stay in
charge. Restart the app after any toggle — swapping a filesystem provider under
a live session is the riskiest case, so restart is the safe habit.

## Configure

**Primary surface: Plugins → dsh-ssh → Configure** — fields for the remote
address, the default remote folder, and the sidebar marker. Saving writes the
profile's settings document; changes take effect when the app restarts.

**File-level fallback:** the profile's own `cordis.patch.yml` (for example
`~/.dsh/profiles/desktop/cordis.patch.yml`) with a `- id: ssh` entry. A
patch-layer `config` **replaces the row's config wholesale — it never
deep-merges** — so restate every field you need, not just the changed ones. The
bundle ships a fully commented example patch (`cordis.patch.yml` in this
package) that mounts the `ssh` row with these values:

```yaml
- id: ssh
  name: dsh-ssh
  config:
    host: 192.168.0.68                      # anything the ssh CLI resolves: IP or Host alias
    remoteRoot: 'C:\Users\Public\workplace' # absolute path ON THE REMOTE machine
    sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
```

| key | default | meaning |
| --- | --- | --- |
| `host` | `192.168.0.68` | ssh destination, resolved by your ssh client (IP or `~/.ssh/config` Host alias) |
| `remoteRoot` | — | absolute remote path that becomes the workspace root |
| `remoteLabel` | `remote` | marker remote workspaces get in the sidebar: `my-project (remote)` |
| `mode` | `route` | the only mode this entry runs; the remote-only takeover is the separate `dsh-ssh/replace` entry (its full recipe sits commented at the bottom of the shipped patch file) |
| `defaultSide` | `auto` | which world answers the one call with no working directory; `auto`/`local` is correct for a Windows-to-Windows remote, set `remote` when the remote is not Windows |
| `sshBin` | `ssh` | ssh client binary |
| `sshArgs` | `[]` | extra arguments for every ssh invocation |
| `remoteShell` | `powershell` | shell hosting the remote file agent (`pwsh` for PowerShell 7) |
| `mapRipgrep` | `true` | upload the packaged `rg.exe` to the remote once, so `glob`/`grep` need nothing installed remotely |
| `connectTimeoutMs` | `20000` | budget for bringing the remote channel up |
| `requestTimeoutMs` | `30000` | budget for one file operation |

`BatchMode=yes` matters more than it looks: these `ssh` calls have no terminal,
so a missing key or an unlockable passphrase would otherwise hang instead of
failing fast.

## Use

Once the plugin is enabled and the app restarted, nothing special is needed:

- A tool call whose path resolves under `remoteRoot` — `read`, `write`, `edit`,
  `glob`, `grep` — is served over SSH; a `pwsh` command whose working
  directory is under `remoteRoot` runs on the remote PC. Everything else stays
  local, in the same session.
- Run the **`ssh_status`** tool first: it reports the remote host, OS, user,
  whether `remoteRoot` exists, and whether the remote agent and ripgrep
  mapping are live.
- **Open any folder on the remote PC as a workspace:** press the sidebar "+"
  (or the New Session hero's picker) and choose **⇄ the remote PC** — a browser
  for the whole remote filesystem, with filter and new-folder. Picking a
  folder adds it to the routing set, so its sessions talk to the remote PC
  there; the sidebar titles it `folder (remote)`. **This computer** keeps the
  usual native folder dialog. For this to work friction-free, choose a remote
  root whose ancestors are user-writable on **both** machines —
  `C:\Users\Public\...` is the safe choice; opening paths under another user's
  profile may need a one-time elevated `mkdir` on this machine.

Good to know:

- Each operation is its own `ssh` invocation — expect roughly 0.5–2 s per file
  operation on a LAN. The first run uploads the search binary; a re-detected
  remote copy is reused instead.
- Edits are text-only (binary writes are refused, as locally).
- `watch` on a remote path fails loudly instead of quietly watching a local
  mirror; remote terminal sessions are not supported; a remote command can
  read input present at launch, but not input written later.
- Occasionally an `ssh` invocation returns nothing at all; reads absorb that
  with one automatic retry, mutations never auto-retry (their effect may
  already have landed).

Design rationale, measurements, and the exact transport constraints live in the
headers of `cordis.patch.yml` and the `src/` modules, not here.
