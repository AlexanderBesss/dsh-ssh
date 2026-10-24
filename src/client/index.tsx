/**
 * dsh-ssh browser half: the remote PC's folder picker, seated in the app's
 * own workspace directory-flow holes.
 *
 * Both workspace entry points — the sidebar "+" beside "Workspaces" and the
 * New Session hero's workspace picker — declare a `*.directoryFlow` hole: the
 * owner (WorkspaceBrowser / WorkspacePicker) opens a picking interaction and
 * shares `open / busy / onPicked / onCancel / onError`. The shipped default
 * occupant runs the OS-native chooser; this plugin registers the same seats at
 * a LOWER priority (the lowest registered occupant renders), so the same "+"
 * button now browses the remote PC, while a "browse this PC…" action still
 * hands off to that very native chooser for local folders.
 *
 * Picking a remote folder runs `/api/prepare` first (remote stat + local
 * mirror + join the routing set), then adopts the path through the app's own
 * verbs — `workspaces.create`, `workspaces.rename` (the sidebar shows
 * `folder (remote)`, the label coming from the plugin's `remoteLabel`
 * config), `uiWorkspace.openWorkspace`. A LOCAL pick goes through the owner's
 * `onPicked`, untouched — the native flow names it and opens it.
 *
 * Remote facts come from this plugin's `/ssh-workspace/api/*` routes (see
 * src/workspace-routes.ts); the component never sees SSH.
 *
 * The browser half also carries the plugin's configuration page: the Plugins
 * surface gives every installed bundle's row a `plugins.row.config` hole, and
 * a row that fills it grows a "Configure" control opening the row's page.
 * This one renders host / remoteRoot / remoteLabel over the settings form the
 * Plugins page hands down — the same revision-fenced write path the app's own
 * plugin pages use, landing in the profile settings document.
 *
 * Written with createElement (no JSX) to keep the bundle toolchain identical
 * to the host half: tsc never needs to understand JSX.
 *
 * @module dsh-ssh/client
 */

import { createElement, Fragment, useCallback, useEffect, useRef, useState } from 'react'

/** The slot-registration shape both client UI cohorts accept. */
interface SlotRegistration {
	name: string
	priority?: number
	key?: string
	inject?: () => Record<string, unknown>
	registrant?: string
}

/** One settings-document write, exactly as the app's own plugin pages send them. */
interface SettingsOp {
	op: 'set' | 'unset'
	path: string[]
	value?: unknown
}

interface ConfigFormSnapshot {
	status: 'loading' | 'ready' | 'unavailable'
	value?: Record<string, unknown>
	user?: Record<string, unknown>
	revision?: number
	writable: boolean
}

interface ClientScope {
	inject: (deps: string[], callback: (scope: any) => (() => void) | void) => () => void
	slots: {
		inject: (key: string, callback: () => (() => void) | void) => () => void
		register: <Props>(registration: SlotRegistration, render: (props: Props) => unknown) => () => void
	}
	uiWorkspace: {
		/** The Host-routed picker face; in the desktop shell the native global wins over it. */
		pickDirectory: () => Promise<string | null>
		/** The app's own "open this workspace" verb, as the owners use it. */
		openWorkspace: (workspaceId: string) => Promise<void>
	}
	workspaces: {
		// "the created or idempotently resolved Workspace" — re-picking a path
		// that is already a Workspace resolves to the existing one.
		create: (input: { path: string }) => Promise<{ workspaceId: string; path: string; title: string }>
		rename: (workspaceId: string, title: string) => Promise<unknown>
	}
}

/** Props the directory-flow owners share with their occupant. */
interface FlowProps {
	open: boolean
	busy: boolean
	onPicked: (path: string) => void
	onCancel: () => void
	onError: (message: string) => void
	/** Added by this registrant's `inject`: run the native local chooser. */
	pickLocal: () => Promise<string | null>
	/**
	 * Added by this registrant's `inject`: adopt a prepared remote path —
	 * create the workspace, mark its title with the remote label, and open
	 * it the way the app itself would. Remote picks cannot go through
	 * `onPicked` because that flow names the workspace after the folder,
	 * and a remote workspace should say so.
	 */
	adoptRemote: (path: string, label: string) => Promise<void>
}

const REGISTRANT = 'dsh-ssh'
// The shipped native occupant registers at the default 0; "register at a
// different priority to shadow it (lowest renders)".
const FLOW_PRIORITY = -10
const FLOW_SEATS = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'] as const

/* ------------------------------------------------------------------ *
 * Route client (same envelope as the sandbox / git route families).
 * ------------------------------------------------------------------ */

interface InfoView {
	host: string
	remoteRoot: string
	remoteLabel: string
	connected: boolean
	machine: string | null
}

interface DirEntry {
	name: string
	path: string
	hidden: boolean
}

interface BrowseView {
	path: string | null
	root: string
	parent: string | null
	entries: DirEntry[]
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	// Merge rather than spread-and-replace: a POST body carries its own
	// `content-type` header object, and a plain spread would silently drop
	// the `accept` header set here.
	const headers = new Headers(init?.headers)
	if (!headers.has('accept')) headers.set('accept', 'application/json')
	const response = await fetch(`/ssh-workspace/api/${path}`, { ...init, headers })
	let body: any
	try {
		body = await response.json()
	} catch {
		throw new Error(`${path} failed with HTTP ${response.status}`)
	}
	if (body?.ok !== true) throw new Error(body?.error?.message ?? `${path} failed with HTTP ${response.status}`)
	return body.data as T
}

/* ------------------------------------------------------------------ *
 * Styles: system colors so the panel follows the page's color scheme;
 * the shell's own controls are plain elements like docker-sandbox's.
 * ------------------------------------------------------------------ */

const panelStyle: Record<string, string> = {
	boxSizing: 'border-box',
	width: '640px',
	maxWidth: '92vw',
	maxHeight: '80vh',
	display: 'flex',
	flexDirection: 'column',
	gap: '10px',
	padding: '16px 18px',
	borderRadius: '10px',
	border: '1px solid color-mix(in srgb, CanvasText 25%, transparent)',
	background: 'Canvas',
	color: 'CanvasText',
	boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
}

const rowStyle: Record<string, string> = { display: 'flex', gap: '8px', alignItems: 'center' }

const inputStyle: Record<string, string> = {
	flex: '1',
	padding: '5px 8px',
	borderRadius: '6px',
	border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)',
	background: 'Canvas',
	color: 'CanvasText',
	font: 'inherit',
}

const buttonStyle: Record<string, string> = {
	padding: '5px 12px',
	borderRadius: '6px',
	border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)',
	background: 'transparent',
	color: 'inherit',
	font: 'inherit',
	cursor: 'pointer',
}

const primaryStyle: Record<string, string> = { ...buttonStyle, fontWeight: '600' }

const listStyle: Record<string, string> = {
	flex: '1',
	minHeight: '180px',
	overflowY: 'auto',
	border: '1px solid color-mix(in srgb, CanvasText 20%, transparent)',
	borderRadius: '6px',
}

const itemStyle: Record<string, string> = {
	display: 'block',
	width: '100%',
	boxSizing: 'border-box',
	textAlign: 'left',
	padding: '6px 10px',
	border: 'none',
	background: 'transparent',
	color: 'inherit',
	font: 'inherit',
	cursor: 'pointer',
}

const bigButtonStyle: Record<string, string> = {
	display: 'flex',
	flexDirection: 'column',
	gap: '6px',
	padding: '14px 16px',
	borderRadius: '8px',
	border: '1px solid color-mix(in srgb, CanvasText 25%, transparent)',
	background: 'transparent',
	color: 'inherit',
	font: 'inherit',
	cursor: 'pointer',
	textAlign: 'left',
}

/* ------------------------------------------------------------------ *
 * The flow occupant: a remote browser dialog, shown while `open` holds.
 * ------------------------------------------------------------------ */

function RemoteDirectoryFlow(props: FlowProps) {
	const { open, busy, onPicked, onCancel, onError, pickLocal, adoptRemote } = props
	const [info, setInfo] = useState<InfoView | undefined>()
	const [browse, setBrowse] = useState<BrowseView | undefined>()
	// Two-way opening choice the operator asked for: local folder dialog or
	// the remote browser, one seat for both.
	const [view, setView] = useState<'choose' | 'remote'>('choose')
	const [localBusy, setLocalBusy] = useState(false)
	const [filter, setFilter] = useState('')
	const [newName, setNewName] = useState('')
	const [busyHere, setBusyHere] = useState('')
	const [error, setError] = useState('')
	const armed = useRef(false)
	// Sequence guard for navigation: rapid folder clicks can land a stale
	// listing on top of a fresh one, so only the newest request may commit.
	const browseSeq = useRef(0)

	const go = useCallback(async (path: string | null) => {
		setError('')
		const seq = ++browseSeq.current
		try {
			const next = path === null
				? await api<BrowseView>('drives')
				: await api<BrowseView>(`browse?path=${encodeURIComponent(path)}`)
			if (browseSeq.current === seq) setBrowse(next)
		} catch (cause: any) {
			if (browseSeq.current === seq) setError(cause?.message ?? String(cause))
		}
	}, [])

	// Where the remote browser opens: the top of the remote's C: drive, so the
	// whole PC is one click from the root rather than buried in `remoteRoot`.
	// A remote whose C: is missing or unreachable still gets the drive list.
	const goHome = useCallback(async () => {
		setError('')
		const seq = ++browseSeq.current
		try {
			const next = await api<BrowseView>(`browse?path=${encodeURIComponent('C:\\')}`)
			if (browseSeq.current === seq) setBrowse(next)
		} catch {
			if (browseSeq.current === seq) await go(null)
		}
	}, [go])

	// Each rising `open` edge starts one fresh interaction, mirroring the
	// native occupant's arming: re-renders (and the owner's `busy` adoption
	// that keeps `open` true) never relaunch it.
	useEffect(() => {
		if (!open) {
			armed.current = false
			return
		}
		if (armed.current) return
		armed.current = true
		setView('choose')
		setFilter('')
		setNewName('')
		setError('')
		setBrowse(undefined)
		api<InfoView>('info')
			.then((fact) => {
				setInfo(fact)
				return goHome()
			})
			.catch((cause: any) => onError(cause?.message ?? String(cause)))
	}, [goHome, onError, open])

	const createFolder = useCallback(async () => {
		if (browse === undefined || browse.path === null || newName.trim() === '') return
		setBusyHere('creating…')
		setError('')
		try {
			await api('mkdir', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ parent: browse.path, name: newName }),
			})
			setNewName('')
			await go(browse.path)
		} catch (cause: any) {
			setError(cause?.message ?? String(cause))
		} finally {
			setBusyHere('')
		}
	}, [browse, go, newName])

	const pickHere = useCallback(async () => {
		if (browse === undefined || browse.path === null) return
		setBusyHere('opening…')
		setError('')
		try {
			// prepare: assert the remote directory exists, stand up the local
			// mirror the workspace registry validates against, and join the
			// path to the routing set so its session talks to the remote PC.
			await api('prepare', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: browse.path }),
			})
			// A remote pick is adopted here rather than through `onPicked`,
			// because the owner names the workspace after the folder — and a
			// remote workspace should say so: `folder (remote)`.
			await adoptRemote(browse.path, info?.remoteLabel ?? 'remote')
			onCancel()
		} catch (cause: any) {
			setError(cause?.message ?? String(cause))
		} finally {
			setBusyHere('')
		}
	}, [browse, info, onCancel, adoptRemote])

	const chooseLocal = useCallback(async () => {
		setError('')
		setLocalBusy(true)
		try {
			const path = await pickLocal()
			if (path !== null && path !== undefined && path !== '') onPicked(path)
			// A null cancel returns to the two-way choice — the operator may
			// still want the remote browser they came for.
			setView('choose')
		} catch (cause: any) {
			setError(cause?.message ?? String(cause))
		} finally {
			setLocalBusy(false)
		}
	}, [onPicked, pickLocal])

	const show = open
	const needle = filter.trim().toLowerCase()
	const entries = (browse?.entries ?? []).filter((entry) => needle === '' || entry.name.toLowerCase().includes(needle))
	const atDrives = browse !== undefined && browse.path === null
	const commitDisabled = browse === undefined || browse.path === null || busyHere !== '' || busy
	const remoteName = info === undefined ? 'remote PC' : info.machine ?? info.host

	if (!show) return null

	return createElement(
		'div',
		{
			style: {
				position: 'fixed',
				inset: 0,
				zIndex: 1000,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'rgba(0, 0, 0, 0.45)',
			},
			onMouseDown: (event: any) => {
				if (event.target === event.currentTarget) onCancel()
			},
		},
		createElement(
			'div',
			{ style: panelStyle },
			// Header.
			createElement(
				'div',
				{ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
				createElement('strong', { style: { fontSize: '14px' } }, 'New workspace — where is the folder?'),
				createElement('button', { style: buttonStyle, onClick: onCancel }, 'close'),
			),
			// The two buttons the operator asked for — local or remote — and
			// the remote browser behind the remote one.
			view === 'choose'
				? createElement(
						'div',
						{ style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '6px 0' } },
						createElement(
							'button',
							{ style: bigButtonStyle, disabled: localBusy, onClick: () => void chooseLocal() },
							createElement('span', { style: { fontWeight: '600' } }, '🗂 This computer'),
							createElement(
								'span',
								{ style: { fontSize: '12px', opacity: 0.75 } },
								localBusy ? 'folder chooser open — pick a folder in that dialog…' : 'the Windows folder dialog, exactly as before',
							),
						),
						createElement(
							'button',
							{ style: bigButtonStyle, onClick: () => setView('remote') },
							createElement('span', { style: { fontWeight: '600' } }, `⇄ ${remoteName} — remote PC`),
							createElement(
								'span',
								{ style: { fontSize: '12px', opacity: 0.75 } },
								info === undefined ? 'connecting…' : `browse ${info.host} and open any folder there as a workspace`,
							),
						),
					)
				: createElement(
						Fragment,
						null,
						// Navigation: back to the choice, This PC / parent / configured root.
						createElement(
							'div',
							{ style: rowStyle },
							createElement('button', { style: buttonStyle, onClick: () => setView('choose') }, '≡ local / remote'),
							createElement('button', { style: buttonStyle, disabled: atDrives, onClick: () => void go(null) }, '🖥 This PC'),
							createElement(
								'button',
								{ style: buttonStyle, disabled: browse === undefined || browse.parent === null, onClick: () => void go(browse?.parent ?? null) },
								'↑ parent',
							),
							createElement('button', { style: buttonStyle, disabled: atDrives, onClick: () => void go(browse?.root ?? null) }, '⌂ default folder'),
							createElement(
								'span',
								{ style: { flex: '1', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: browse?.path ?? 'This PC' },
								browse?.path ?? 'This PC',
							),
						),
						info === undefined || info.connected
							? null
							: createElement(
									'div',
									{ style: { fontSize: '12px', opacity: 0.8 } },
									`the channel to ${info.host} has not answered yet — the first browse may take a moment`,
								),
						// The level: filter + scrollable list (drives or folders).
						createElement('input', {
							style: inputStyle,
							placeholder: 'filter this level…',
							value: filter,
							onChange: (event: any) => setFilter(event.target.value),
						}),
						createElement(
							'div',
							{ style: listStyle },
							entries.length === 0
								? createElement('div', { style: { padding: '10px', opacity: 0.7, fontSize: '12px' } }, atDrives ? 'no drives found' : 'no folders here')
								: entries.map((entry) =>
										createElement(
											'button',
											{
												key: entry.path,
												style: { ...itemStyle, opacity: entry.hidden ? 0.6 : 1 },
												onClick: () => void go(entry.path),
											},
											`${atDrives ? '💽' : '📁'} ${entry.name}`,
										),
									),
						),
						// New folder (disabled while the whole PC is shown).
						createElement(
							'div',
							{ style: rowStyle },
							createElement('input', {
								style: inputStyle,
								placeholder: 'new folder name…',
								value: newName,
								disabled: atDrives,
								onChange: (event: any) => setNewName(event.target.value),
								onKeyDown: (event: any) => {
									if (event.key === 'Enter') void createFolder()
								},
							}),
							createElement('button', { style: buttonStyle, disabled: atDrives, onClick: () => void createFolder() }, 'new folder'),
						),
					),
			// The verbs: only for the remote browser; the choice row is its own verbs.
			view === 'remote'
				? createElement(
						'div',
						{ style: { ...rowStyle, justifyContent: 'flex-end' } },
						busyHere === '' && !busy
							? null
							: createElement('span', { style: { fontSize: '12px', opacity: 0.7 } }, busy ? 'adding workspace…' : busyHere),
						createElement(
							'button',
							{
								style: primaryStyle,
								disabled: commitDisabled,
								onClick: () => void pickHere(),
							},
							'open workspace here',
						),
					)
				: null,
			error === ''
				? null
				: createElement('div', { style: { fontSize: '12px', color: '#e5484d' } }, error),
		),
	)
}

/* ------------------------------------------------------------------ *
 * The Plugins page configuration card.
 * ------------------------------------------------------------------ */

// The Plugins page keys a row's configuration slot `<package name>#<row id>`;
// its page hands down `form: { state, mutate }` for that row's settings.
const ROW_CONFIG_KEY = 'dsh-ssh#ssh'

const SETTINGS_FIELDS = [
	{ key: 'host', label: 'Remote PC — address', hint: 'IP, or a Host name from your ssh config' },
	{ key: 'remoteRoot', label: 'Default remote folder', hint: 'absolute path on the remote PC' },
	{ key: 'remoteLabel', label: 'Remote marker', hint: 'titles become “my-project (remote)”' },
] as const

/**
 * Why a draft value for this field cannot be saved, in one line, or
 * `undefined` when it can. Refusing here is cheaper than persisting a
 * setting that makes the plugin's `apply` refuse to start at the next boot —
 * an empty host or a relative `remoteRoot` takes the whole plugin down
 * invisibly from this page's point of view.
 */
function fieldProblem(key: string, value: string): string | undefined {
	const trimmed = value.trim()
	switch (key) {
		case 'host':
			if (trimmed === '') return 'The remote address cannot be empty.'
			if (!/^[A-Za-z0-9._\-:@[\]]+$/.test(trimmed)) return 'Expected an IP address, a user@host form, or a Host name from your ssh config.'
			return undefined
		case 'remoteRoot':
			if (!/^(?:[a-zA-Z]:[\\/]|\\[\\/][^\\/])/.test(trimmed)) return 'Expected an absolute Windows path — e.g. C:\\workplace or \\\\server\\share.'
			return undefined
		default:
			return undefined
	}
}

interface RowPageProps {
	view?: 'summary' | 'page'
	form?: { state: ConfigFormSnapshot; mutate: (ops: SettingsOp[], revision?: number) => Promise<boolean> }
}

const settingsInputStyle = {
	width: '100%',
	boxSizing: 'border-box' as const,
	background: 'rgba(255,255,255,0.06)',
	color: 'inherit',
	border: '1px solid rgba(255,255,255,0.18)',
	borderRadius: 6,
	padding: '7px 9px',
	font: 'inherit',
}

const settingsButtonStyle = (primary: boolean) => ({
	background: primary ? 'rgba(255,255,255,0.9)' : 'transparent',
	color: primary ? '#111' : 'inherit',
	border: primary ? '1px solid transparent' : '1px solid rgba(255,255,255,0.22)',
	borderRadius: 6,
	padding: '7px 14px',
	font: 'inherit',
	cursor: 'pointer' as const,
})

function SshSettingsForm(props: RowPageProps) {
	const page = props.form
	const [draft, setDraft] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState(false)
	const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

	const current = (key: string): string => {
		const stored = page?.state.value?.[key]
		return typeof stored === 'string' ? stored : ''
	}
	const dirty = SETTINGS_FIELDS.filter((f) => draft[f.key] !== undefined && draft[f.key] !== current(f.key))
	const draftProblems: Record<string, string> = {}
	for (const field of SETTINGS_FIELDS) {
		const text = draft[field.key]
		if (text !== undefined) {
			const problem = fieldProblem(field.key, text)
			if (problem !== undefined) draftProblems[field.key] = problem
		}
	}

	const save = useCallback(async () => {
		if (page === undefined || dirty.length === 0 || busy) return
		for (const field of dirty) {
			const problem = fieldProblem(field.key, draft[field.key] ?? '')
			if (problem !== undefined) {
				setNote({ ok: false, text: problem })
				return
			}
		}
		setBusy(true)
		try {
			const ops: SettingsOp[] = dirty.map((f) => ({ op: 'set', path: [f.key], value: (draft[f.key] ?? '').trim() }))
			const ok = await page.mutate(ops, page.state.revision)
			setNote(ok
				? { ok: true, text: 'Saved. The new settings apply when you restart the app.' }
				: { ok: false, text: 'These settings changed elsewhere first — the page reloaded your values; save again.' })
			if (ok) setDraft({})
		} catch (cause: any) {
			setNote({ ok: false, text: cause?.message ?? String(cause) })
		} finally {
			setBusy(false)
		}
	}, [busy, current, dirty, draft, page])

	const restore = useCallback(async () => {
		if (page === undefined || busy) return
		setBusy(true)
		try {
			const ops: SettingsOp[] = SETTINGS_FIELDS.map((f) => ({ op: 'unset', path: [f.key] }))
			const ok = await page.mutate(ops, page.state.revision)
			setNote(ok
				? { ok: true, text: 'Reverted to the defaults shipped with the plugin; restart the app to apply.' }
				: { ok: false, text: 'These settings changed elsewhere first — the page reloaded your values; try again.' })
			if (ok) setDraft({})
		} catch (cause: any) {
			setNote({ ok: false, text: cause?.message ?? String(cause) })
		} finally {
			setBusy(false)
		}
	}, [busy, page])

	if (props.view !== 'page') return createElement('span', null, 'Remote SSH peer configuration')
	if (page === undefined) return createElement('p', { style: { fontSize: '12.5px', opacity: 0.7 } }, 'This profile does not expose the ssh settings right now.')
	if (page.state.status === 'loading') return createElement('p', { style: { fontSize: '12.5px', opacity: 0.7 } }, 'Loading settings…')
	if (page.state.status === 'unavailable') return createElement('p', { style: { fontSize: '12.5px', opacity: 0.7 } }, 'This profile is not writable, so the settings are read here only.')

	return createElement(
		'div',
		{ style: { display: 'grid', gap: 12, maxWidth: 520 } },
		createElement(
			'p',
			{ style: { fontSize: '12.5px', opacity: 0.65, margin: 0 } },
			'The remote PC this plugin serves. Saving writes to this profile’s settings; a new address applies when the app restarts.',
		),
		...SETTINGS_FIELDS.map((field) =>
			createElement(
				'label',
				{ key: field.key, style: { display: 'grid', gap: 4 } },
				createElement(
					'span',
					{ style: { fontSize: '12.5px', opacity: 0.8 } },
					field.label,
					createElement('span', { style: { opacity: 0.6 } }, ` — ${field.hint}`),
				),
				createElement('input', {
					style: settingsInputStyle,
					value: draft[field.key] !== undefined ? draft[field.key] : current(field.key),
					disabled: !page.state.writable || busy,
					onChange: (event: any) => {
						setNote(null)
						setDraft((d) => ({ ...d, [field.key]: event.target.value }))
					},
				}),
				draftProblems[field.key] === undefined
					? null
					: createElement('span', { style: { fontSize: '12px', color: '#e5484d' } }, draftProblems[field.key]),
			),
		),
		createElement(
			'div',
			{ style: { display: 'flex', gap: 8, alignItems: 'center' } },
			createElement(
				'button',
				{
					style: settingsButtonStyle(true),
					disabled: !page.state.writable || busy || dirty.length === 0 || Object.keys(draftProblems).length > 0,
					onClick: () => void save(),
				},
				'Save',
			),
			createElement(
				'button',
				{
					style: settingsButtonStyle(false),
					disabled: !page.state.writable || busy,
					onClick: () => void restore(),
				},
				'Restore defaults',
			),
			page.state.user === undefined || page.state.user === null
				? createElement('span', { style: { fontSize: '12px', opacity: 0.55 } }, 'using the values shipped with the plugin')
				: null,
		),
		note === null ? null : createElement('p', { style: { fontSize: '12.5px', margin: 0, color: note.ok ? '#3ecf8e' : '#e5484d' } }, note.text),
	)
}

/* ------------------------------------------------------------------ *
 * Entry.
 * ------------------------------------------------------------------ */

export const inject = ['slots']

export function apply(ctx: ClientScope): void {
	// uiWorkspace carries the Host-routed picker; the desktop shell also sets
	// the native global. Both faces of "choose a local folder" therefore work
	// from wherever this plugin lands — same choice the shipped native
	// occupant itself makes.
	ctx.inject(['uiWorkspace', 'workspaces'], (scope: ClientScope) => {
		const pickLocal = async (): Promise<string | null> => {
			const native = (globalThis as any).__DSH_DIRECTORY_PICKER__
			if (native !== undefined && typeof native.pick === 'function') return native.pick()
			return scope.uiWorkspace.pickDirectory()
		}
		const adoptRemote = async (path: string, label: string): Promise<void> => {
			// The same verbs the app's own flow uses, plus the rename that
			// marks the workspace as remote in the sidebar. `create` is
			// idempotent — re-picking an existing workspace path resolves it.
			const created = await scope.workspaces.create({ path })
			// The app titles a fresh workspace after the folder itself, and
			// that default title is what gets the marker. A title the user
			// renamed by hand is left alone, and one that already carries a
			// marker — possibly under an older `remoteLabel` — never grows a
			// second suffix, which an `endsWith` test alone would allow.
			const source = created.path ?? path
			const defaultTitle = source.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? source
			if (created.title === defaultTitle) {
				await scope.workspaces.rename(created.workspaceId, `${created.title} (${label})`)
			}
			await scope.uiWorkspace.openWorkspace(created.workspaceId)
		}
		const injected = () => ({ pickLocal, adoptRemote })
		const flow = (props: FlowProps) => createElement(RemoteDirectoryFlow, props)
		return scope.slots.inject(FLOW_SEATS[0], () =>
			scope.slots.inject(FLOW_SEATS[1], () => {
				const d1 = scope.slots.register({ name: FLOW_SEATS[0], priority: FLOW_PRIORITY, inject: injected, registrant: REGISTRANT }, flow)
				const d2 = scope.slots.register({ name: FLOW_SEATS[1], priority: FLOW_PRIORITY, inject: injected, registrant: REGISTRANT }, flow)
				return () => {
					d1()
					d2()
				}
			}),
		)
	})

	// The Plugins page: filling `plugins.row.config` with this bundle's row key
	// (`<package name>#<row id>`) is what grows the "Configure" control on the
	// row and opens the row's page, where the Host hands down its own
	// `form: { state, mutate }` for the row's settings. The row is the gate:
	// this client half ships bundled with the very row that declares `ssh`,
	// and the page dispatches the key only for that row. (The first version
	// rode a `configForms` service — there is no such Client Service, so the
	// injection could never fire; verified against the live Client catalog.)
	ctx.inject(['slots'], (scope: ClientScope) =>
		scope.slots.inject('plugins.row.config', () =>
			scope.slots.register({ name: 'plugins.row.config', key: ROW_CONFIG_KEY, registrant: REGISTRANT }, (rowProps: RowPageProps) =>
				createElement(SshSettingsForm, rowProps),
			),
		),
	)
}
