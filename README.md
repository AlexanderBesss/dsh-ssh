# dsh-ssh

Work on a project that lives on a **remote Windows PC**, from this DSH session.

Not a mirror, not a mount, not a sync. The plugin reaches into the two
capability seams that decide where files and commands live, so the ordinary
`read`, `write`, `edit`, `glob`, `grep`, and `pwsh` tools operate on the remote
machine. By default it does that **path by path**: paths under the configured
remote root are served over SSH, and every other path stays on this machine, in
the same session.

## How it works

DSH's tools never touch the operating system directly. They go through two
services, and both are reachable:

| seam | served by | what that moves |
| --- | --- | --- |
| `ctx.fs` | a router over `SshFileSystem` + the app's own provider | `read` / `write` / `edit` / `glob` / `grep` path handling |
| `ctx.subprocess` | a router over `SshSubprocessRuntime` + the app's own provider | every command the `pwsh` tool runs |

`dsh-pwsh-local` declares `inject = ["subprocess"]` and spawns through
`ctx.subprocess.spawn(...)`. Reaching that service relocates the `pwsh` tool
without touching it — the executor keeps owning command construction, output
budgets, and the exit-marker format.

Routing is one decision per call. A file path that resolves under `remoteRoot`
is served remotely; a command whose working directory is under `remoteRoot` runs
remotely; everything else goes to the local implementation the app registered.
[src/routing.ts](F:\Projects\dsh-ssh\src\routing.ts) is the router, and
[scripts/coexistence-check.ts](F:\Projects\dsh-ssh\scripts\coexistence-check.ts)
proves both halves with counters that name the implementation that answered.

Two transports, chosen per job:

- **File operations** are **one `ssh` invocation each**, carrying a JSON request
  on stdin and a JSON response on stdout. (A persistent agent reading a stream
  does not survive Windows OpenSSH — see
  [The finding that reshaped the design](#the-finding-that-reshaped-the-design).)
- **Commands** are also **one `ssh` invocation each**, with real piped stdio,
  because the subprocess contract requires raw streams and a propagated exit code.

The API catalog already describes an unbuilt `ctx.ssh` seam — a verified remote
helper plus "one authenticated stream through an independent SSH channel". This
plugin is the shipped-today approximation of that shape.

## Two shapes, two entries

The plugin ships two composition entries, because one module-level inject gate
cannot serve both shapes:

| entry | what it does | what it costs |
| --- | --- | --- |
| `dsh-ssh` (`mode: route`, default) | local providers stay; a router answers `fs` / `subprocess` per path | nothing is withdrawn; a dead remote cannot touch local work |
| `dsh-ssh/replace` | takes `fs` and `subprocess` over app-wide | the two local provider rows must be disabled in the same patch; nothing local is reachable, and if the SSH providers fail there is **no filesystem at all** |

Writing `mode: replace` on the ordinary `dsh-ssh` row does nothing but log a
warning — that entry's inject gate waits for the very providers replace mode
withdraws, so it downgrades to route instead of hanging the app.

Route mode is the default shape because of three measurements against cordis
4.0.4 ([scripts/provider-wiring-check.ts](F:\Projects\dsh-ssh\scripts\provider-wiring-check.ts)
reproduces all three):

1. **A second provider for one name is a hard error**:
   `service "fs" has been registered at <fs-sandbox>` — in either mount order.
   So a takeover only works if the local provider is disabled first, by the
   patch layer, and the two halves fail in opposite directions: if the disable
   stops matching, this plugin's registration throws and there is no remote
   provider; if it matches and this plugin's providers fail to construct, the
   app has **no filesystem at all**.
2. **There is no wrapping API in this version.** `ctx.reflect.intercept` is
   `undefined`; `ctx.intercept(name, config)` layers *configuration* only.
3. **A provider cannot delegate to the implementation it replaced.** `provide()`
   overwrites the fiber's own view of the name, so inside an `fs` provider
   `this.ctx.fs` is the provider itself. "Remote, except for local paths" is not
   expressible from inside a provider — which is exactly why route mode publishes
   a router on the read path (the `internal/get` waterfall) instead.

**What enabling it used to feel like.** With the local providers withdrawn, the
app's file and shell tools ran entirely over SSH: ~0.5–2 s per operation, an
intermittent invocation that returns nothing and burns the full 20–30 s deadline,
and a one-time ripgrep upload that measured 408 s on a first run. Every tool
looked frozen, and no local file was reachable. Route mode removes the coupling:
the local tools are the app's own, and remote latency stays on remote paths.

## Prerequisites

- **Remote host runs Windows** with OpenSSH Server enabled, and PowerShell
  available as `powershell` (Windows PowerShell 5.1 is the tested target).
- **Key or config auth works non-interactively.** The plugin shells out to your
  system `ssh`, so `~/.ssh/config` Host aliases, `IdentityFile`, `ProxyJump`,
  and ssh-agent all just work. No credentials are handled here.
- Verify first: `ssh <host> "echo ok"` must print `ok` with no password prompt.

## Install

The supported route is the **Plugins page**: install from the local path
`F:\Projects\dsh-ssh`. That runs a real `pnpm add`, records the dependency, and
gives the plugin a row with an enable toggle.

To script the same operation instead:

```powershell
npm run build                                                      # compile src + scripts to dist/
node dist/scripts/install-profile.js add --profile desktop
node dist/scripts/install-profile.js status --profile desktop   # read-only
```

A file copy is **not** an install. An earlier version of this script placed the
package in `node_modules` and appended its name to `dsh.profile.bundles`, and
the plugin loaded fine — but the Plugins page had no row for it, because that
page lists bundles backed by a manifest dependency. A name in `bundles` with
nothing in `dependencies` behind it is not a bundle the manager recognises.

### What the toggles do

| toggle | effect |
| --- | --- |
| bundle row | moves `dsh-ssh` in and out of `dsh.profile.bundles` |
| plugin row (`id: ssh`) | writes `disabled: true/false` in `cordis.patch.yml` |

Disabling the **bundle** also withdraws its patch layer, which is what re-enables
the local `fs` and `subprocess` providers — so the toggle cleanly restores normal
behaviour. With HMR on, a change applies to the running composition; without it,
restart. Swapping the filesystem provider under a live session is the riskiest
case here, so restarting after a toggle is the safe habit.

### Requirements this package already meets

The page only offers a toggle for a package that declares a bundle, and the
install rejects an incompatible peer before `pnpm` runs:

- `dsh.bundle.patch` points at `./cordis.patch.yml`, and `exports` publishes it
- peers match the running app exactly: `cordis ^4.0.4` (app has 4.0.4),
  `schemastery ^3.18.4` (app has 3.18.4)
- `files` ships `src`, the patch, and the README — never `node_modules`

Then set the two required values in the profile's `cordis.patch.yml` (the
inserted `ssh` row) or via the plugin config UI:

```yaml
- id: ssh
  name: dsh-ssh
  config:
    host: 192.168.0.68                 # any ssh destination: alias or [user@]host
    remoteRoot: 'C:\Users\Public\workplace' # absolute path ON THE REMOTE MACHINE
    mode: route                        # route is the only mode this entry runs
    sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
```

Route mode withdraws nothing, so the app's local `fs` and `subprocess` providers
stay in control of everything outside `remoteRoot`. The remote-only takeover is
the separate `dsh-ssh/replace` entry, mounted alongside rows that disable
`fs-sandbox`, `subprocess`, and the `ssh` row itself; the bundle patch ships the
whole set commented out, with those conditions stated where they live. The
`host` value can also be changed from the app itself — Plugins → dsh-ssh →
Configure.

`BatchMode=yes` matters more than it looks: these `ssh` calls have no terminal,
so a missing key or a passphrase turns into a hang rather than a prompt.

### Two packaging rules this plugin had to learn the hard way

Both of these produced a plugin that installed cleanly, showed no error, and did
nothing — because the entry module never finished loading.

1. **Do not import internal `@deepseek-ai/*` packages.** A plugin under
   `profiles/<profile>/node_modules` resolves bare specifiers from there upward.
   `@deepseek-ai/dsh-fs`, `dsh-tools`, and `dsh-subprocess` live inside
   `app.asar`, which that walk never reaches, so the import throws before
   `apply()` runs. Only `cordis` and `schemastery` are reachable. The working
   plugin in this profile (`dsh-browser`) declares exactly one peer dependency,
   `@deepseek-ai/cordis` — that is the pattern. [src/seams.ts](F:\Projects\dsh-ssh\src\seams.ts)
   supplies the two base classes locally instead; both are thin `Service`
   subclasses, and registration is cordis' own mechanism.

   A trap while checking versions: `npm view @deepseek-ai/dsh-fs version`
   reports the `latest` **tag**, which points at `0.0.1-rc.1`. The registry does
   publish `0.2.0-rc.2`, matching the app. Check `versions`, not `version`.

2. **A cordis service class cannot use `#private` fields.** Services are handed
   out through a proxy, so a method reached over `ctx.fs` runs with the proxy as
   its receiver, and private fields are unreachable from a proxy:
   `TypeError: Receiver must be an instance of class SshFileSystem`. Both
   providers use `_`-prefixed fields. The shipped local backend has zero `this.#`
   uses for the same reason. Non-service classes (`SshTransport`, the output
   collector) keep real `#` fields.

## Verifying

Five harnesses, each answering one question. All of them mount the plugin in a
real cordis instance; run them after any change, from the machine that has SSH
access to the remote host.

```powershell
npm install          # cordis + schemastery + typescript, for the harnesses only
npm run build        # compile src + scripts into dist/
node dist/scripts/coexistence-check.js        # local + remote in one session
node dist/scripts/load-test.js 192.168.0.68 'C:\Users\AI\workplace'
node dist/scripts/remote-project-check.js 192.168.0.68 'C:\Users\AI\workplace' '<path-to>\rg.exe'
node dist/scripts/profile-load-check.js       # the INSTALLED copy, offline
node dist/scripts/provider-wiring-check.js    # cordis' own provider rules, offline
```

| harness | what it proves | last run |
| --- | --- | --- |
| [coexistence-check.ts](F:\Projects\dsh-ssh\scripts\coexistence-check.ts) | route mode: local paths served by the app's provider, remote paths over SSH, commands routed by cwd, and local work intact with the host unreachable | 11/11 |
| [load-test.ts](F:\Projects\dsh-ssh\scripts\load-test.ts) | the providers register and a full remote round trip works | 17/17 |
| [remote-project-check.ts](F:\Projects\dsh-ssh\scripts\remote-project-check.ts) | a real project on the remote PC, through the exact tool call paths, including the `rg.exe` argv rewrite | 10/11 (the miss was an intermittent `ssh` stall, see below) |
| [profile-load-check.ts](F:\Projects\dsh-ssh\scripts\profile-load-check.ts) | the installed copy imports, resolves its peers, and mounts; its one expected failure is `selected in dsh.profile.bundles`, i.e. the plugin is disabled on purpose | 11/12 |
| [provider-wiring-check.ts](F:\Projects\dsh-ssh\scripts\provider-wiring-check.ts) | the three cordis rules above, and that a published router reaches a consumer fiber **from a second copy of cordis** — the `link:` install condition | 7/7 |

The coexistence harness is the one that guards the design: its counters live
inside the local providers, so an assertion passes only if the implementation
that answered is the one that owns the path. A router that quietly sent
everything over SSH would fail it.

`load-test.ts` is the only check that catches a module-graph load failure at
all, so run it after any change to imports.

## Configuration

**The primary surface is the app's Plugins page**: Plugins → this plugin's
row → **Configure** opens a page with fields for the remote address
(`host`), the default remote folder (`remoteRoot`) and the sidebar marker
(`remoteLabel`). Saving writes this profile's settings document (a
revision-fenced overlay over the composed config); a new address takes
effect when the app restarts. The browser half registers this page into the
Plugins surface's `plugins.row.config` hole (key `dsh-ssh#ssh`), gated by
`configForms.whileServed(['ssh'])` — see `src/client/index.tsx`.

The file-level fallback stays available: the **profile's own**
`cordis.patch.yml` (`~/.dsh/profiles/desktop/cordis.patch.yml`) carries a
`- id: ssh` entry. A patch-layer `config` **replaces the row's config
wholesale — it never deep-merges** — so that entry restates every field the
row needs. Omit a required key and the row's fiber fails config validation
before `apply` ever runs — silently from the UI's side.

| key | default | meaning |
| --- | --- | --- |
| `host` | `192.168.0.68` | ssh destination, resolved by your ssh client (IP or `~/.ssh/config` Host alias) |
| `remoteRoot` | — | absolute remote path that becomes the workspace root |
| `remoteLabel` | `remote` | the marker remote workspaces get in the sidebar: `my-project (remote)` |
| `mode` | `route` | on the `dsh-ssh` row only `route` runs; the app-wide takeover is the `dsh-ssh/replace` entry, which forces it |
| `defaultSide` | `auto` | which world answers `terminalEnvironment()` (the call with no cwd); `auto`/`local` = this machine, correct for a Windows remote |
| `sshBin` | `ssh` | ssh client binary |
| `sshArgs` | `[]` | extra arguments for every ssh invocation |
| `remoteShell` | `powershell` | shell hosting the remote file agent |
| `mapRipgrep` | `true` | ship the packaged `rg.exe` to the remote once |
| `connectTimeoutMs` | `20000` | budget for bringing the agent up |
| `requestTimeoutMs` | `30000` | budget for one agent operation |

### Other checks

The plugin registers one tool, `ssh_status`, which reports the remote host, OS,
user, whether `remoteRoot` exists, and the live agent's system facts. Run it
before trusting anything else. It is registered only when the tool helper
resolves — see packaging rule 1 — so its absence is not a failure.

The agent itself is testable with no SSH at all:

```powershell
node dist/scripts/agent-smoke.js   # writes .tmp-agent/agent.ps1 + requests.jsonl
```

It exercises every file op against the local filesystem, which separates "the
agent logic is wrong" from "the SSH transport is wrong".

## Measured behaviour (192.168.0.68, Windows, LAN)

Numbers, not estimates — because the assumptions that looked obvious were wrong.

| thing | measured |
| --- | --- |
| connect + stage the remote file-operation script | ~1.0 s once |
| one filesystem operation (`stat`, `readText`, `listDir`) | ~520–700 ms |
| `writeText` (stat + read + write + stat) | ~1.6–2.0 s |
| `editText` (stat + read + write + stat) | ~2.1–3.1 s |
| one remote command, start to exit code | ~0.9–1.2 s |
| a ripgrep search in a real project | ~0.3 s |
| stdin payload relayed reliably | up to ~128 KB of base64 |
| stdin payload ≥ 256 KB base64 | stalls, produces **no output at all** |
| shipping `rg.exe` (5.4 MB) to a host that has it | ~2.8 s (stat + sha256, then reuse) |
| shipping `rg.exe` to a host that does not | 408 s measured on a first run, in 64 KB chunks |
| an invocation that returns nothing at all | burns the full 20–30 s deadline, intermittently |

The first line of the last pair is why `warm()` verifies a remote copy by
digest before uploading: re-shipping 5.4 MB over a channel that carries 64 KB
per round trip is not a startup cost worth paying twice.

### The finding that reshaped the design

A persistent remote agent reading JSON lines from stdin **does not work**
against Windows OpenSSH. The first request is answered; a request written at
t=3 s is never seen by the remote process. Verified with a minimal loop, so it
is not an artefact of the agent:

```
   9ms IN  first          426ms OUT "GOT:first"
 3012ms IN  second-at-3s              (never arrives)
```

Windows OpenSSH runs remote commands through `cmd.exe`, and `cmd.exe` does not
forward stdin to its child beyond the initial burst. `-tt` relays stdin
progressively but hands the session to an interactive `cmd.exe` instead of the
requested command, so it is not a workaround either.

So every operation is its own `ssh` invocation, with stdin closed after the
payload — the one shape this channel delivers reliably. There is no connection
reuse available: Windows OpenSSH has no `ControlMaster` equivalent. The
`ctx.fs` README already expects a remote backend to pay per round trip; this is
that cost, measured.

For **commands** (`ctx.subprocess.spawn` — the `pwsh` tool, `rg`, plain builds)
a second hazard applies: `cmd.exe` is the outer shell, and its quote toggling
lets an argument like `a"&calc` escape its own escaping and execute `calc`.
PowerShell 5.1 has its own argv-rewrite bug when it launches native commands.
So neither shell ever sees user-influenced text as text: the whole spawn is a
PowerShell script — .NET `ProcessStartInfo` with a hand-built MSVCRT-quoted
command line (the same scheme Node uses locally), process-scope environment,
working directory, exit-code propagation — handed over as a base64
`-EncodedCommand` payload. That is also why multi-line `pwsh` tool scripts
survive verbatim: the payload alphabet contains no quotes, no percent signs,
and no newlines.

The upgrade path, when latency becomes the complaint, is the shape the API
catalog already describes for `ctx.ssh`: the helper listens on the remote
loopback and each stream arrives over an independent SSH channel (`ssh -L`
forwarding), which sidesteps `cmd.exe` stdin entirely.

## Opening a remote workspace from the UI (built)

The button needs no new mechanism in DSH. Route mode already makes a **path**
remote, and the app's own "add workspace" flow already has an extension hole.
The plugin ships two halves that meet in the middle.

**The seat.** The sidebar "+" (beside "Workspaces") and the New Session hero's
workspace picker do not render a folder list themselves: they open a
*directory-flow* interaction through the single-slot holes
`sidebar.workspaces.directoryFlow` and
`conversation.hero.workspace.directoryFlow`, sharing `open / busy / onPicked /
onCancel / onError` with whoever occupies them. The shipped occupant (the
`directory-picker-native` package) runs the OS chooser. SlotCore renders the
**lowest-priority** occupant, so this plugin registers both seats at priority
`-10` with its own: pressing the app's own "+" now opens a two-button choice —
**🗂 This computer** (the same native OS chooser, untouched) or **⇄ the remote
PC** (a browser for the whole remote filesystem). Nothing about local
workspaces is lost.

**Host half — `src/workspace-routes.ts`.** Registered on the `webServer`
service as a `prefix` route under `/ssh-workspace`, loopback-fenced (peer
socket, `Host`, `Sec-Fetch-Site`, and `Origin` must all say loopback/same-
origin). Four JSON endpoints; browsing is the whole remote PC (paths must be
absolute, well-formed Windows paths):

| endpoint | purpose |
| --- | --- |
| `GET /api/info` | host, `remoteRoot`, connectivity, remote machine name |
| `GET /api/drives` | the remote PC's filesystem roots ("This PC" view) |
| `GET /api/browse?path=` | directories only, with a parent breadcrumb |
| `POST /api/mkdir` `{parent,name}` | create a remote folder (segment-validated) |
| `POST /api/prepare` `{path}` | remote stat + local mirror + join the routing set |

**Client half — `src/client/index.tsx`.** Built by `tsdown`
(`tsdown.config.ts`) into a `window.__ModuleLoader__.load({ id: "dsh-ssh", … })`
banner with `react` kept external — byte-compatible with the shape the app's
own bundles use. The occupant renders the two-button choice and, behind the
remote button, a modal: This-PC/drives level, folder browser, filter,
new-folder row, and "open workspace here". Picking a remote folder runs
`prepare` first, then adopts the path through the app's own verbs —
`workspaces.create` (idempotent), `workspaces.rename` (the sidebar shows
`my-project (remote)` — the word in parentheses is the `remoteLabel` config),
and `uiWorkspace.openWorkspace`. A local pick instead goes straight through
the owner's `onPicked`, so the native flow names and opens it as always. No
JSX syntax, so plain `tsc` typechecks it too.

**Any folder, not just `remoteRoot`.** A prepared path joins a persistent
routing set (`~/.dsh/dsh-ssh-workspaces.json`, keyed by host), and the route
mode router classifies containment against the configured root **plus** that
set. Without that step a folder elsewhere on the remote PC would resolve to
its empty local mirror — the set is what makes "open any folder on the remote
PC" mean the session really talks to the remote PC there. Removing a workspace
in the app does not remove its entry (harmless: the mirror is empty anyway);
prune the JSON file if it ever bothers you.

**The mirror caveat.** The app's workspace registry calls `realpath`/`stat` on
the *local* machine, so opening a remote workspace still needs a real local
directory at the identical absolute path — junctions and symlinks are rejected
because `realpath` resolves them away. `/api/prepare` creates that mirror with
`mkdir -p`. Where the path sits under a protected location (e.g.
`C:\Users\AI\...`), the first mirror mkdir can fail with `EPERM` for a
non-elevated user; `prepare` then answers 400 with a hint. The friction-free
choice is a remote root whose ancestors are already user-writable, such as
`C:\Users\Public\workplace` on both PCs.

**Deploy notes — two caches, both restart-shaped.**

- *Client half.* The row is composed into the boot table
  (`/plugins/<package>/client.js` combo URLs carry a `rev` query; plain-path
  probes 404 by design) when the `client-modules` plugin mounts — its package
  resolution cache has no invalidation path, so a bundle that gains a
  `dsh.client` declaration mid-session only appears after a **host restart**
  (desktop app restart; sessions persist).
- *Host half.* `set_plugin` enable/disable re-runs `apply()` against the
  **already-evaluated module instance** — a rebuild of `dist/` mid-session
  changes nothing until the app restarts, even through remove + install of a
  `link:` bundle. And at a cold start this plugin can mount before the web
  carrier registers `webServer`, where the pending `ctx.inject` callback then
  never fires; the picker routes would sit at 404 until the row is remounted
  mid-session. The bring-up timer (`src/index.ts`) covers that boot window by
  polling through `ctx.get`, which bypasses the inject gate — the same trick
  route mode uses for `fs`.
- *Boot trace.* While this `link:` development copy is active, `apply()`
  appends its decisions to `%TEMP%\dsh-ssh-boot-trace.log` (guarded by
  try/catch, inert elsewhere). It is a diagnostic aid — drop `bootTrace`
  before publishing.

## What is deliberately not claimed

- **`watch()`** — no remote primitive. It routes by target like every other fs
  call, so a watch on a remote path fails loudly instead of quietly watching a
  local mirror; consumers fall back to re-reading. Local paths keep their
  watcher.
- **Terminal sessions** (`spawnTerminal`) — a remote PTY needs a pseudoconsole
  relay. It throws rather than pretending.
- **Interactive stdin to remote commands** — the same `cmd.exe` limit above. A
  command may read input present at launch, but not input written later.
- **Process-range quiescence.** `waitForExit()` proves the direct command's exit
  (ssh propagates its status) but cannot prove remotely-spawned descendants are
  gone. There is no remote managed-range owner over this transport, and the code
  says so instead of returning a confident `true`.
- **Sandboxing** stays a local-OS concept. Under a remote provider the local
  sandbox has nothing to confine; the remote account's own permissions are the
  boundary.
- **Binary writes** — the fs contract is text-only (`FS_NOT_TEXT`). The agent's
  byte ops exist for the ripgrep upload, not for tool-facing writes.
- **Command-line length.** The spawn seam never lets `cmd.exe` parse arguments
  — the invocation is a base64 `-EncodedCommand` payload — but that payload sits
  inside `cmd.exe`'s 8191-character command line and base64 over UTF-16
  inflates it ~2.7×. A single command with very long inline arguments fails at
  a total length where a raw scheme might have squeaked through.
- **Intermittent stalls.** Some `ssh` invocations produce nothing at all and hit
  the deadline. Reads absorb this with one backed-off replay; a mutation never
  replays, because its remote effect may already have landed.

## Layout

```
src/index.ts                route-mode entry: gate, Config, providers, ssh_status
src/replace.ts              replace-mode entry: same body, public provider names
src/routing.ts              the local/remote router and the read-path hook
src/transport.ts            one ssh invocation per file op, one per command
src/agent-script.ts         the remote PowerShell op script (JSON in, JSON out)
src/fs-provider.ts          FileSystem over the op script
src/subprocess-provider.ts  SubprocessRuntime over ssh, incl. the rg.exe mapping
src/seams.ts                local stand-ins for the two base classes, and why
src/remote-path.ts          Windows path semantics and case-folding
src/client/index.tsx        the UI half: remote-workspace picker, Configure form
src/*.d.ts                  ambient shims: the dsh-tools stub, the Context seams
docs/subprocess-contract.md the exact SubprocessRuntime contract, cited
scripts/*.ts                the five harnesses listed under Verifying
dist/                       tsc output — entries and harnesses run from here
```
