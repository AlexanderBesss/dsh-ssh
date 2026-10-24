# `ctx.subprocess` — implementation contract for a third-party (SSH-backed) provider

Contract extracted from the shipped DSH build (`app.asar`), version line `0.2.0-rc.2`.
Every signature below is quoted from shipped code or from the shipped API catalog — no guesses.
Items that could not be found are listed explicitly in §13.

## 0. Sources (exact, as read)

| Artifact | Path in asar | Notes |
| --- | --- | --- |
| Service definition | `dsh/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js` (103 lines) | `SubprocessRuntime`, `scrubbedParentEnv`, `SubprocessExecutableNotFoundError` |
| Control-channel subpath | `dsh/node_modules/@deepseek-ai/dsh-subprocess/lib/control.js` (27 lines) | fd 7 protocol |
| Reference implementation | `dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js` (1485 lines) | `LocalSubprocessRuntime`, `LocalTerminalHandle` |
| Spawn/termination internals | `…/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js` (1529 lines) | `validateSubprocessSpec`, `bindManagedProcess`, owners |
| Output collection / spill | `…/dsh-subprocess-local/lib/output.js` (239 lines) | `OutputCollector`, spill dir policy |
| **Authoritative type text** | `dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` lines 2896–2930 (methods) and 7243–7305 (interfaces) | generated from the real `.d.ts` |
| Base class | `dsh/node_modules/@deepseek-ai/cordis/src/service.ts` lines 42–59 | registration mechanics |

Important: the packaged `dsh-subprocess` contains **no `.d.ts` files** (its `package.json` points at
`lib/types/*.d.ts`, but those are not in the asar). The `api-catalog.js` declarations are the
authoritative type text and are reproduced verbatim below.

## 1. Class shape and service registration

The seam is an abstract Cordis `Service`. The provider **must extend `SubprocessRuntime`**; the base
constructor performs the registration — a provider never calls `ctx.provide` itself.

```js
// dsh-subprocess/lib/index.js:86-90
var SubprocessRuntime = class extends Service {
	constructor(ctx) {
		super(ctx, "subprocess");
	}
};
```

Cordis registration (`cordis/src/service.ts:42-59`, verbatim):

```ts
constructor(protected ctx: Context, name: string) {
  name ??= this.constructor['provide'] as string

  let self = this
  const tracker: Tracker = {
    associate: name,
    property: 'ctx',
  }
  if (self[symbols.invoke]) {
    self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker)
  }
  self.ctx = ctx
  self.name = name
  defineProperty(self, symbols.tracker, tracker)

  self.ctx.reflect.provide(name, self, this[symbols.check])
  return self
}
```

Reference provider (`dsh-subprocess-local/lib/index.js:1269-1296`, `:1485`; it retains
`live`/`terminals`/`controlChannels` sets at `:1271-1275`):

```js
var LocalSubprocessRuntime = class extends SubprocessRuntime {
	constructor(ctx) {
		super(ctx);
		ctx.effect(() => {
			const onHostExit = () => {
				this.terminateForHostExit();
			};
			process.prependListener("exit", onHostExit);
			return async () => {
				await this.disposeManagedProcesses();
				process.off("exit", onHostExit);
			};
		}, "local subprocess teardown");
	}
	…
};
export { LocalSubprocessRuntime, LocalSubprocessRuntime as default };
```

Contract facts:

- **`static inject`: the provider declares none.** Grep over the whole compiled provider finds no
  `inject`. `inject` is a *consumer* concern — e.g. `dsh-bash-local/lib/index.js:68`
  `static inject = ["subprocess"]`.
- **`static Config`: none.** "It has no config: every disposition and limit arrives on the spec"
  (`dsh-subprocess-local/lib/index.js:1252-1259`).
- **Plugin entry**: the module's default export is the plugin. Cordis runs a class plugin as
  `new runtime.callback(this.ctx, this.config)` (`cordis/src/fiber.ts:253`), so
  `constructor(ctx, config?)` is the loading signature; the local provider uses `constructor(ctx)`.
- **One provider per context**: "loading a second throws, which is cordis' standard
  duplicate-service behavior" (`dsh-subprocess/lib/index.js:58-61`).
- **Teardown is an effect, not a method.** There is no `dispose()` on the seam. Register cleanup with
  `ctx.effect(() => { …; return async () => { … } }, label)`; cordis awaits the returned async
  cleanup. The local provider additionally force-stops everything on Node's synchronous `exit`.

### Public method surface (verbatim, `api-catalog.js:2901-2920`)

```
abstract resolveExecutable( command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, ): Promise<string>
abstract terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

`spawn` is **synchronous** and returns a live handle immediately ("`spawn` returns a live handle
synchronously", `dsh-subprocess/lib/index.js:66-67`). `spawnTerminal` is async. There are no other
public members on the seam.

## 2. Spawn request spec — every field (verbatim, `api-catalog.js:7271-7280`, `7260`, `7275`, `7243`)

```ts
export interface SubprocessSpawnSpec {
    argv: readonly string[];
    cwd: string;
    stdio: SubprocessStdio;
    graceMs: number;
    signal?: AbortSignal | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}

export interface SubprocessStdio {
    stdin: SubprocessStdinMode;
    stdout: SubprocessOutputMode;
    stderr: SubprocessOutputMode;
    control?: 'pipe';
}

export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string };
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect;

export interface SubprocessCollect {
    maxBytes: number;
    spill?: { maxBytes: number };
}
```

Disposition rules that a conforming provider must reproduce:

- `'ignore'` is a **stdin-only** disposition. For stdout/stderr the local classifier is
  `const isCollect = (mode) => mode !== "pipe" && mode !== "inherit";`
  (`runner-launch-B2zsQ1Dz.js:855`) — i.e. any non-`'pipe'`/`'inherit'` value (including a
  hypothetical `'ignore'`) is treated as a collect object. Do not advertise `'ignore'` for output
  streams.
- stdin `'pipe'` → the caller owns `handle.stdin` and closes it.
- stdin `{ data }` → the provider writes `data` and ends the stream itself; `handle.stdin` is
  `undefined` (`runner-launch-B2zsQ1Dz.js:956-959`).
- stdout/stderr `'pipe'` → raw `Readable` handed to the caller, never buffered by the provider.
- stdout/stderr `'inherit'` → child attached to the parent's own stream.
- `control: 'pipe'` → an extra raw `Duplex` (see §8).

### Validation performed before launch (`runner-launch-B2zsQ1Dz.js:764-775`, `1516-1527`)

```js
function validateSubprocessSpec(spec) {
	if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (spec.signal?.aborted) {
		let reason = "aborted";
		try {
			reason = String(spec.signal.reason ?? reason);
		} catch {}
		throw new Error(`aborted before spawn: ${reason}`);
	}
	const [program] = spec.argv;
	if (program === void 0 || program.length === 0) throw new Error("invalid argv: expected a non-empty program name at argv[0]");
}
```

- `MAX_TIMER_DELAY_MS = 2147483647` (`@deepseek-ai/dsh-timeout/lib/index.js:27`).
- `targetEnvironment()` (`:1516-1527`) rejects NUL bytes in every argv entry, in `cwd`, and in env
  keys/values with `TypeError { code: 'ERR_INVALID_ARG_VALUE' }`, then applies `controlEnvironment`.
- A caller-supplied `DSH_SUBPROCESS_CONTROL` env entry throws
  `"DSH_SUBPROCESS_CONTROL is reserved for subprocess control-channel setup"` (`:60-64`).
- All of the above throw **synchronously from `spawn()`**.

### Environment layering (`runner-launch-B2zsQ1Dz.js:694-707`)

```js
function childEnv(extra) {
	const env = scrubbedParentEnv();
	if (process.platform !== "win32") return { ...env, ...extra };
	let entries = Object.entries(env);
	for (const [key, value] of Object.entries(extra ?? {})) {
		const normalized = key.toUpperCase();
		entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized);
		entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}
```

An explicit string overrides/restores; an explicit `undefined` tombstone removes an ambient entry;
on Windows key matching is case-insensitive. The *base* (`scrubbedParentEnv()`) is the local
provider's policy — for a remote provider the base is the remote world's environment; the contract
only requires that the spec's `env` layers last and wins (§12).

## 3. The handle returned by `spawn()` (verbatim, `api-catalog.js:7251-7268`)

```ts
export interface SubprocessHandle {
    readonly stdin: Writable | undefined;
    readonly stdout: Readable | undefined;
    readonly stderr: Readable | undefined;
    readonly control: Duplex | undefined;
    readonly collected: SubprocessCollectedOutputs;
    readonly done: Promise<SubprocessOutcome>;
    terminate(): void;
    waitForExit(signal?: AbortSignal): Promise<boolean>;
}

export interface SubprocessOutcome {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

export interface SubprocessCollectedOutputs {
    readonly stdout?: SubprocessOutputReader;
    readonly stderr?: SubprocessOutputReader;
}

export interface SubprocessOutputReader {
    readFrom(fromByte: number): SubprocessOutputRead;
}

export interface SubprocessOutputRead {
    text: string;
    nextOffset: number;
    lossy: boolean;
    spillPath?: string;
}
```

The reference handle object (`runner-launch-B2zsQ1Dz.js:996-1012`):

```js
return {
	stdin: stdinMode === "pipe" ? stdin ?? void 0 : void 0,
	stdout: outMode === "pipe" ? stdout ?? void 0 : void 0,
	stderr: errMode === "pipe" ? stderr ?? void 0 : void 0,
	control: launch.control,
	collected: {
		...stdoutCollector !== void 0 ? { stdout: stdoutCollector } : {},
		...stderrCollector !== void 0 ? { stderr: stderrCollector } : {}
	},
	done,
	terminate,
	terminateForHostExit,
	waitForExit
};
```

Presence rules: `stdin` only for `'pipe'`; `stdout`/`stderr` only for `'pipe'`; `control` present
(`undefined` when not requested); `collected.stdout`/`.stderr` keys present **only** for collect
dispositions. `terminateForHostExit` is provider-internal (not in the interface).

### `done`

- Resolves with exactly `{ exitCode, signal }` for the **direct** command; rejects for spawn or
  provider failures (`dsh-subprocess/lib/index.js:66-68`). A rejection also triggers `terminate()`
  (`runner-launch-B2zsQ1Dz.js:969-975`).
- Settlement barrier (`:976-991`): after the direct outcome, if any non-`'inherit'` output stream
  exists, `done` waits for those streams to close (`end`/`close`/`error`) **or** a `graceMs` timeout,
  whichever first. Only then are collectors sealed and `done` resolved. `'inherit'` streams do not
  gate settlement.
- Consumers rely on this: `dsh-bash-local` reads `handle.collected.stdout?.readFrom(0)` after
  `await handle.done`.

### `terminate()`

- Returns `void`; idempotent; starts the provider's termination procedure against the managed range
  (`runner-launch-B2zsQ1Dz.js:936-948`):

```js
const terminateWithReason = (cancellationReason) => {
	if (rangeExitObserved || terminationStarted) return;
	terminationStarted = true;
	observeRangeExit().catch(() => {});
	kill("SIGTERM", cancellationReason);
	graceTimer = setTimeout(() => {
		graceTimer = void 0;
		kill("SIGKILL");
	}, spec.graceMs);
};
```

- The spec's `signal` abort runs the same path with `signal.reason` as the cancellation reason
  (`:952-955`). After the range exit is observed, no further signals are sent, the escalation timer
  is cleared, and the abort listener is removed (`:918-935`).

### `waitForExit(signal?)`

```js
const waitForExit = async (signal) => {
	if (rangeExitObserved) return true;
	return waitWithAbort(observeRangeExit(), signal);
};
```
(`runner-launch-B2zsQ1Dz.js:992-995`; `waitWithAbort` at `:21-40` returns `false` when the caller's
signal aborts first, `true` on completion, and propagates a rejection when the owner cannot prove
quiescence.) The observation is memoized: every caller shares one range wait.

### Collect-mode reader (`output.js:188-198`, verbatim)

```js
readFrom(fromByte) {
	const windowStart = this.total - this.bytes;
	const buffer = Buffer.concat(this.chunks);
	const lossy = fromByte < windowStart;
	return {
		text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString("utf8"),
		nextOffset: this.total,
		lossy,
		...this.spillFile !== void 0 ? { spillPath: this.spillFile } : {}
	};
}
```

Offsets are whole-stream byte coordinates owned by the caller; reads are non-consuming and
offset-based, so concurrent readers never steal bytes. `lossy: true` means the requested offset
slid out of the retained tail — the returned `text` is then the **whole retained tail**, and the
gap is only recoverable from the spill file. Internal extras used by remote adapters
(`output.js:203-236`): `snapshot() → { bytes: Buffer, totalBytes: number }`, `seal()`,
`finalize() → { text, truncated, spillPath? }`.

## 4. `resolveExecutable(command, env?, signal?)`

Reference implementation (`dsh-subprocess-local/lib/index.js:1332-1354`, verbatim):

```js
async resolveExecutable(command, env, signal) {
	if (command.length === 0) throw new Error("subprocess-local: executable must be non-empty");
	signal?.throwIfAborted();
	const environment = childEnv(env);
	const absolute = isAbsolute(command);
	if (!absolute && (command.includes("/") || process.platform === "win32" && command.includes("\\"))) throw new Error(`subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`);
	const candidates = absolute ? [command] : this.executableCandidates(command, environment);
	for (const candidate of candidates) {
		signal?.throwIfAborted();
		try {
			if (!(await stat(candidate)).isFile()) continue;
			await access(candidate, constants.X_OK);
			signal?.throwIfAborted();
			return candidate;
		} catch {}
	}
	signal?.throwIfAborted();
	throw new SubprocessExecutableNotFoundError(absolute ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file` : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`);
}
executableCandidates(command, env) {
	const path = environmentValue(env, "PATH") ?? "";
	const extensions = process.platform === "win32" && extname(command) === "" ? (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	return path.split(delimiter).flatMap((directory) => extensions.map((extension) => resolve(process.cwd(), directory, command + extension)));
}
```

- Search: `PATH` from the layered environment (`childEnv(env)`), split on `path.delimiter`; each
  candidate is `resolve(process.cwd(), directory, command + extension)` — relative PATH entries
  resolve from the host process cwd.
- Windows extensions: PATHEXT (default `.COM;.EXE;.BAT;.CMD`) is appended **only when
  `extname(command)` is empty**; a command that already carries an extension gets no extension
  variants. POSIX always uses `[""]`.
- `environmentValue(env, name)` (`index.js:1477-1483`) reads env case-insensitively on Windows.
- Accept test: `stat(candidate).isFile()` **and** `access(candidate, X_OK)`; the loop re-checks
  `signal?.throwIfAborted()` per candidate.
- Absolute paths are verified as-is (no extension probing); a relative path containing a separator
  throws a plain `Error` (not the not-found class).
- Miss → `SubprocessExecutableNotFoundError` (`dsh-subprocess/lib/index.js:92-101`):

```js
var SubprocessExecutableNotFoundError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "SubprocessExecutableNotFoundError";
	}
};
```

- Consumers distinguish a *completed miss* from a *transport failure*: only the miss may be this
  class ("A completed lookup miss throws `SubprocessExecutableNotFoundError`; transport failures
  remain distinct", `dsh-subprocess/README.md:132`). Verified consumers:
  `dsh-api-terminal-controller/lib/index.js:56` and `lib/types/shells.js:45`
  (`if (error instanceof SubprocessExecutableNotFoundError) return void 0; throw error;`), and
  `dsh-workspace-changes/lib/index.js:999` (catches anything and reports "git unavailable").

## 5. `spawnTerminal(spec)` — what to implement or reject

```ts
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>

export interface SubprocessTerminalSpawnSpec {
    argv: readonly string[];
    cwd: string;
    env?: Record<string, string> | undefined;   // note: NOT NodeJS.ProcessEnv (no tombstones)
    rows: number;
    cols: number;
    terminalType: string;
    shellActivity?: boolean | undefined;
    graceMs: number;
    signal?: AbortSignal | undefined;
}

export interface SubprocessTerminalHandle {
    readonly pid: number;
    readonly output: Readable;
    readonly done: Promise<SubprocessOutcome>;
    write(data: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    inspectForeground(): Promise<SubprocessTerminalForeground | undefined>;
    inspectActivity(): Promise<SubprocessTerminalActivity>;
    signalForeground(signal: SubprocessTerminalSignal): Promise<number>;
    terminate(): Promise<void>;
}

export interface SubprocessTerminalForeground { processGroupId: number; inputWaiting: boolean }
export interface SubprocessTerminalActivity { state: 'idle' | 'busy' | 'unknown'; revision: number }
export type SubprocessTerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP';
```

Reference behavior (`dsh-subprocess-local/lib/index.js:737-1100`, `:1415-1475`):

- `output` is a `PassThrough` emitting Buffers; it ends when the top-level process exits
  (`this.output.end()` at `index.js:808`, and again at `:1085`).
- `done` resolves `{ exitCode, signal }` from the shell's own exit event. When the provider killed
  the shell and no exit event was observed, it synthesizes `{ exitCode: null, signal: null }`
  (`settleExitIfGone`, `index.js:1078-1090`).
- `terminate()` returns a memoized `Promise<void>` that settles only after whole-session quiescence
  (`:893-909`, `closeOnce` at `:1029-1077`); it throws
  `Error("terminal cleanup failed; surviving pid: <pid>")` when a survivor remains (`:1076`).
- `signalForeground(signal)` returns the process-group id it signalled. It resolves the group via
  `inspector.foregroundPgid(this.pid)` and throws
  `Error("cannot resolve foreground process group for terminal <pid>")` when unresolvable
  (`index.js:878-882`). On Windows `SIGINT` is delivered as a Ctrl-C write to the terminal
  (`:884-887`) and `SIGTSTP`/`SIGHUP` throw
  (`"signal <SIG> is unsupported on Windows; only SIGINT, SIGTERM, and SIGKILL are available"`,
  `:888`); otherwise `inspector.signalGroup(pgid, signal)` (`:890`).
- `SIGKILL` targeting the shell's own group throws
  `"refusing to SIGKILL the terminal shell; terminate the terminal session instead"` (`:882`) —
  session teardown belongs to `terminate()`.
- `inspectForeground()` returns `{ processGroupId, inputWaiting }` where `inputWaiting` comes from
  `inspector.isStdinWaiting(pgid, pid)`, and `undefined` when the foreground group cannot be
  resolved (`:833-841`).
- `inspectActivity()` returns `{ state, revision }`; `revision` must change whenever the state
  observation changes (consumer: `dsh-api-terminal-controller` retention policy,
  `lib/types/retention.js:130-140`).
- `shellActivity: true` (local-only opt-in) makes the provider keep shell idle/busy instrumentation
  and *not* auto-terminate on `done` (`:1463-1474`).
- Rejecting `spawnTerminal` is a legitimate provider choice — the PTY consumer surfaces the error at
  spawn time (`dsh-terminal-bash/lib/index.js:1053-1062` calls
  `ctx.subprocess.spawnTerminal({ argv, cwd, env, rows, cols, terminalType, graceMs, signal })`).

## 6. `terminalEnvironment(signal?)`

```ts
async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>
export interface SubprocessTerminalEnvironment { platform: 'posix' | 'windows'; defaultShell?: string }
```

Reference (`dsh-subprocess-local/lib/index.js:1406-1414`, verbatim):

```js
async terminalEnvironment(signal) {
	signal?.throwIfAborted();
	const platform = process.platform === "win32" ? "windows" : "posix";
	const defaultShell = platform === "windows" ? process.env.ComSpec || void 0 : process.env.SHELL || userInfo().shell || void 0;
	return {
		platform,
		...defaultShell === void 0 ? {} : { defaultShell }
	};
}
```

An empty/undefined shell is **omitted** (never `defaultShell: undefined`), so the consumer applies
its own fallback (`dsh-api-terminal-controller/lib/types/shells.js:16` uses
`environment.defaultShell ?? (environment.platform === 'windows' ? 'cmd.exe' : '/bin/sh')`).
For a remote provider `platform` must describe the **remote** execution world.

## 7. Termination, managed ranges, and what `waitForExit()` must prove

The seam requires *provider-managed ranges*, not just the direct child
(`dsh-subprocess/lib/index.js:73-79`). The local provider selects one of three owners
(`dsh-subprocess-local/lib/index.js:1113-1160`):

1. **`linux-scope`** — a user-systemd transient scope. The invocation (`scopeArgs`,
   `index.js:383-396`, verbatim):

   ```js
   function scopeArgs(unitBase, invocation, argv) {
   	return [
   		"--user",
   		"--scope",
   		"--quiet",
   		"--collect",
   		"--expand-environment=no",
   		`--unit=${unitBase}`,
   		"--",
   		...invocation,
   		"--",
   		...argv
   	];
   }
   ```

   `unitBase = unitStem("dsh-subprocess")` = `dsh-subprocess-<pid>-<6 hex>` (`index.js:48-50`,
   `:486`); `invocation` is the private runner entry, which execs the real target. Signalling
   (`SystemdScopeOwner.signal`, `index.js:179-214`): `systemctl --user kill --kill-whom=all
   --signal=<SIGTERM|SIGKILL> <unit>`, with a direct-child fallback while the scope is still
   pending. Quiescence: `systemctl --user show <unit> --property=LoadState,ActiveState,TasksCurrent`
   (`:175-177`), `emptyRange(tasksCurrent)` (`:252`), `rangeActive()` (`:291`), plus
   "launch request consumed" evidence (`observeRequestConsumption`, `:234-236`).
2. **`windows-job`** (`selectContainmentMode`, `index.js:1393-1395` — ordinary spawns only) — a
   private Node runner process uniquely owning a Win32 Job; termination is an IPC message
   `this.runner.send?.({ type: "terminate" }, …)` (`index.js:559`) leading to `terminateJob` in
   `lib/runner.js`. Quiescence: `settleRange()` (`index.js:618`) — runner exit + the single direct
   result + IPC disconnect.
3. **`fallback`** — `detached: true` spawn; POSIX signals the **negative pid** (process group) and
   falls back to the direct child (`signalChildGroup`, `index.js:436-443`); Windows uses
   `taskkill /PID <pid> /T /F` (`taskkillProcessTree`, `runner-launch:724-735`; dispatch in
   `signalTree`, `:742-763`). Quiescence: `process.kill(-pid, 0)` group existence plus a `/proc` pgrp
   scan (`linuxProcessGroupHasLiveMembers`, `runner-launch:405-421`), or the child's exit status on
   Windows (`fallbackOwner`, `:797-844`).

Containment is chosen per spawn (`selectContainmentMode`, `index.js:1384-1398`), and the provider
logs a one-time warning when it degrades to `fallback`
(`warnFallback`, `:1399-1404`: "subprocess-local is using weaker process-tree containment because
…; descendants that escape the process group or direct-parent tree are not guaranteed to terminate
or delay `waitForExit()`").

Ordinary-process ladder: **SIGTERM → wait `graceMs` → SIGKILL**, then the range wait proves
emptiness. Terminal ladder (`closeOnce`, `index.js:1029-1077`; steps at `:1042-1045`): stop descendants
(TERM → wait grace → KILL → wait) → stop shell (TERM → wait grace → KILL → wait → throw on
survivor) → stop descendants again; with a managed owner the shell step is
`owner.signal("SIGTERM")` → wait `graceMs` → `owner.signal("SIGKILL")` → await the range observation.

`waitForExit()` must therefore prove **the managed range is empty** — every descendant the provider
can still observe — not merely that the direct child exited. It rejects when the provider can no
longer prove that: "`waitForExit()` rejects if the selected owner can no longer prove its range
empty, and cleanup still attempts termination" (`dsh-subprocess-local/README.md:72`). The fallback
owner logs a one-time warning about weaker containment (`index.js:1399-1404`).
`done` and `waitForExit()` are independent: "`done` settles the direct command after its stdio
barrier, while `waitForExit()` separately waits for the selected scope, Job, process group, or
observed session to become empty" (`README.md:108`).

Service disposal (`index.js:1284-1331`): terminate every live handle, then
`await Promise.all([handle.done.catch(() => {}), handle.waitForExit()])` per handle, `terminate()`
every terminal, destroy control channels, and finally **rethrow collected failures**.

## 8. Exported helpers a provider must reuse

From `@deepseek-ai/dsh-subprocess` (`lib/index.js:103`):

```js
export { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN, SubprocessExecutableNotFoundError,
         SubprocessRuntime, SubprocessRuntime as default, scrubbedParentEnv };
```

- `DSH_ENV_PREFIX = "DSH_"` (`:13`).
- `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i` (`:32`).
- `scrubbedParentEnv()` (`:50-56`) — the canonical child-env base:

```js
function scrubbedParentEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== void 0 && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith("DSH_")) env[key] = value;
	for (const [name, value] of Object.entries(proxyEnvironmentForChild()))
		if (value === void 0) Reflect.deleteProperty(env, name);
		else env[name] = value;
	return env;
}
```

  It is exported "so spawners that cannot route through the service (node-pty backends,
  SDK-managed transports) share the one scrub definition" (`:42-44`). A remote provider does not
  forward the local parent env, but must not leak harness credentials/`DSH_*` facts of its own.

From `@deepseek-ai/dsh-subprocess/control` (`package.json` `"./control"` export, `lib/control.js`):

```js
const SUBPROCESS_CONTROL_FD = 7;
const SUBPROCESS_CONTROL_ENV = "DSH_SUBPROCESS_CONTROL";
function openInheritedControlChannel() {
	const marker = process.env[SUBPROCESS_CONTROL_ENV];
	Reflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV);
	if (marker !== "pipe") throw new Error("subprocess control channel was not inherited");
	return new Socket({
		fd: 7,
		readable: true,
		writable: true,
		allowHalfOpen: true
	});
}
```
(`lib/control.js:5-25`; exports at `:27`.)

Provider side: allocate fd 7 as an extra pipe, set `DSH_SUBPROCESS_CONTROL=pipe` in the child env
(throwing if the caller supplied it — `controlEnvironment`, `runner-launch:60-64`), and expose
`child.stdio[7]` as `handle.control` (`controlPipe`, `:50-53`; the marker is stamped only when
`stdio.control === 'pipe'`, `:62`). Reference fd layout (`dsh-subprocess-local/README.md:108`,
`runnerStdio` at `runner-launch:1384`): the Windows runner isolates its own fd 0-2, reserves fd 3
for IPC, and carries the *target's* stdio on fd 4-6 plus fd 7 when control is requested.
Real consumer:
`dsh-ptc-runtime-node/lib/index.js:961-975` spawns with
`stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' }` and throws
`"subprocess provider did not supply the requested control and output pipes"` if any of
`control`/`stdout`/`stderr` is `undefined`; the child calls `openInheritedControlChannel()`.
For a remote provider there is no inherited fd — either relay the channel over your transport into
a real `Duplex`, or document that `control: 'pipe'` is unsupported (which breaks that consumer).

From `@deepseek-ai/dsh-subprocess-local/output` (optional but recommended for parity):
`OutputCollector`, `prepareManagedProcessBinding(internals)`, `logSpillFailure(logger, owner)`
(`output.js:239`). The README states the intent explicitly: "`snapshot()` returns the retained raw
bytes and total byte count, allowing remote adapters to preserve offsets without forwarding the
complete stream" (`dsh-subprocess-local/README.md:49-53`).

## 9. Output bounding and spill ownership

**The provider owns spill. There is no `ctx.spill` service.** (`ctx.spillStore` exists —
`abstract saveText(input: SaveTextSpill): Promise<SpillRef>`, `api-catalog.js:2693-2703` — but it is
a session-scoped, model-facing artifact store used by tool result policy, e.g.
`dsh-tool-fs-search/lib/index.js:292-309`; the subprocess provider never calls it.)

Reference semantics (`output.js`; `dsh-subprocess-local/README.md:45-53`):

- Wiring (`runner-launch-B2zsQ1Dz.js:852-872`): the spec's `spill: { maxBytes }` becomes the
  collector's third argument — `new OutputCollector(mode.maxBytes, label, mode.spill === void 0 ?
  void 0 : { maxBytes: mode.spill.maxBytes, dir: spillDir, onFailure: onSpillFailure })` — where
  `spillDir`/`onSpillFailure` come from `prepareManagedProcessBinding(internals)`
  (`output.js:63-68`: `spillDir: internals.spillDir ?? privateSpillDir()`,
  `onSpillFailure: internals.onSpillFailure ?? reportSpillFailureToStderr`).
- Collect keeps the **last** `maxBytes` in memory: `push()` appends, then drops head chunks (or the
  head of an over-cap chunk) until it fits, setting `dropped = true` (`output.js:115-134`).
- Spill starts **on first overflow** only when `spill` was configured; the file is created and every
  chunk — including already-retained ones — is appended (`output.js:119`, `:141-154`).
- Spill file: `` `dsh-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString("hex")}-${this.label}.log` ``
  inside `mkdtempSync(join(tmpdir(), "dsh-subprocess-"))` (`0700`, created once per process and
  never recreated), opened `openSync(file, "wx", 384)` i.e. mode `0600` (`output.js:20-23`, `:148-149`).
  At a JS-observable process exit the directory is `rmdirSync`-ed **only when empty**; completed
  spill files are retained until external cleanup (`output.js:25-30`).
- Exceeding `spill.maxBytes` stops spilling and removes the partial file
  (`if (this.total > spill.maxBytes) { this.discardSpill(); return; }` at `:142-145`;
  `discardSpill` at `:165-179`), and the read then reports no `spillPath`.
- Spilling is best-effort: an open/write failure discards the spill and calls
  `spill.onFailure(error, this.label)` once; collection continues with the in-memory tail alone
  (`:155-162`), so the read reports `lossy` with **no** `spillPath` (`logSpillFailure`, `:49-54`).
- `seal()` closes the spill fd once the stream ended, so post-exit reads never advertise an open
  file; a failed close also stops advertising the path (`output.js:209-236`).

A remote provider may legitimately omit spill entirely (no `spillPath`), as long as `lossy` and
`nextOffset` stay truthful — that is the documented "diagnostic-tail shape"
(`output.js:70-74`).

## 10. What real consumers will do to your provider

| Consumer | Calls it makes |
| --- | --- |
| `dsh-bash-local` (`lib/index.js:209`, `:150-166`) | `resolveExecutable`; `spawn({argv,cwd,env,stdio:{stdin:'ignore'\|{data}, stdout:{maxBytes,spill:{maxBytes}}, stderr:{maxBytes,spill:{maxBytes}}},graceMs,signal})`; `handle.stdin?.end()`; `await handle.done`; `collected.stdout?.readFrom(0)`; `terminate()` + `waitForExit()` ladder |
| `dsh-pwsh-local` (`lib/index.js:306`) | same shape |
| `dsh-ptc-runtime-node` (`lib/index.js:941-975`) | `resolveExecutable(nodeExecutable, undefined, signal)`; `spawn` with `stdout/stderr: 'pipe'`, `control: 'pipe'`; requires non-`undefined` `control`/`stdout`/`stderr`; `terminate()` + `waitForExit()` |
| `dsh-tool-fs-search` (`lib/index.js:171`) | `spawn` with collect dispositions for `rg` |
| `dsh-workspace-changes` (`lib/index.js:999`) | `resolveExecutable('git', undefined, signal)` |
| `dsh-api-terminal-controller` (`lib/index.js:56`, `lib/types/shells.js:16`) | `terminalEnvironment(signal)`, `resolveExecutable(path, undefined, signal)`, terminal `inspectActivity()`, `resize`, `signalForeground`, `terminate` |

## 11. Gap check against the current draft (`src/subprocess-provider.ts`)

Measured against the contract above (line refs into your file):

1. `done` resolves `{ exitCode, signal, error }` on child error (`:260-265`) — the contract requires
   `done` to **reject** for provider failures, and `SubprocessOutcome` has exactly
   `exitCode`/`signal`.
2. `terminate()` returns a boolean (`:274-278`) — contract returns `void`, and it must start the
   SIGTERM→`graceMs`→SIGKILL ladder against the **remote** range. Killing the local `ssh` client
   does not terminate the remote process tree.
3. `waitForExit()` returns `true` after the local `done` (`:279-282`) — it must prove remote-range
   quiescence (or reject when unprovable); `false` is reserved for caller-abort.
4. `control` is absent from the returned handle (`:268-283`) — the property must exist
   (`undefined` when not requested); `control: 'pipe'` support decides whether
   `dsh-ptc-runtime-node`-style consumers work.
5. stdin `{ data }` is not handled (`:248-251`) — must write `data` and end, with `handle.stdin`
   left `undefined`.
6. No spec validation: `graceMs` bounds (`> 0`, finite, `≤ 2147483647`), pre-aborted signal
   (`Error("aborted before spawn: <reason>")`), argv[0] non-empty, NUL-byte rejection.
7. `stdio.stdout/stderr: 'inherit'` is silently treated as discard (`:241-243`) — document as a
   provider limitation (the seam allows weaker fallbacks but requires them to be documented).
8. `dispose()` (`:287-291`) is not part of the seam — teardown must be registered via `ctx.effect`
   so cordis awaits it, and must terminate remote ranges + await `waitForExit()`.
9. `terminalEnvironment` sets `defaultShell: undefined` (`:98-105`) — omit the key; `platform` must
   describe the **remote** world.
10. `resolveExecutable` ignores the `env` layer (`:88-95`) — PATH layering should at least honor
    `spec.env` overrides.
11. `spawnTerminal` throwing (`:112-114`) is acceptable; keep the message honest.
12. `OutputTail.readFrom` (`:58-67`) matches the reader contract (no `spillPath` is allowed);
    `nextOffset: this.#total` and `lossy` semantics are correct.

## 12. Semantics every implementation must honor (verbatim, `dsh-subprocess/lib/index.js:63-85`)

- "Executable paths belong to one execution world shared with the mounted filesystem provider."
- "`spawn` returns a live handle synchronously. Target identity remains provider-private; `done`
  resolves with the spawned command's exit facts and may reject for spawn or provider failures."
- "Collect-mode readers are offset-based and non-consuming … Piped streams are handed to the caller
  raw and never buffered here."
- "`SubprocessHandle.terminate` (and the spec's abort signal) starts the provider's documented
  procedure against its managed range. `SubprocessHandle.waitForExit` observes that same range …
  each provider documents its signalling and observability limits."
- "Disposal of the service terminates all still-running managed processes and awaits their exit."
- "`spawnTerminal` owns terminal allocation, text transport, foreground groups, signalling, and
  whole-session quiescence behind one awaited termination method … Its output stream ends after
  queued terminal output when the top-level process exits."

## 13. Not found / open questions

- No `.d.ts` ships for `dsh-subprocess` in this asar; the `api-catalog.js` text above is the only
  complete type source. Field optionality for `SubprocessSpawnSpec.env` is `NodeJS.ProcessEnv`
  (so `undefined` tombstones are legal), while `SubprocessTerminalSpawnSpec.env` is
  `Record<string, string>`.
- `docs/subsystems/subprocess.md` — linked from both READMEs (`dsh-subprocess/README.md:125`,
  `dsh-subprocess-local/README.md:123`) — is **not** shipped in the asar, so the READMEs plus the
  code above are the only available prose.
- Only one `SubprocessRuntime` subclass exists in the shipped build
  (`dsh-subprocess-local`); there is no shipped remote/SSH subprocess provider to mirror.
- The catalog also defines a separate `ctx.ssh` seam ("One non-reconnecting SSH session …
  `dispose(): Tear down the helper's remote managed ranges before releasing the SSH master`",
  `api-catalog.js:2706-2732`), but no `@deepseek-ai` package in this asar registers it — not traced.
- `SubprocessHandle.terminateForHostExit()` and the terminal handle's `running` getter /
  `terminateForHostExit()` are provider-internal in the reference implementation and are not part of
  the published interfaces.
