import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, stat as statLocal } from 'node:fs/promises'
import { isAbsolute as isLocalAbsolute, win32 } from 'node:path'
import type { SshTransport } from './transport.js'
import { isAbsolute, joinDir, normalize } from './remote-path.js'
import type { WorkspaceRootStore } from './workspace-roots.js'

export interface WorkspaceRouteConfig {
	host: string
	remoteRoot: string
	remoteLabel: string
}

export interface WebServerLike {
	register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

export interface RemoteDirEntry {
	name: string
	path: string
	hidden: boolean
}

export interface RemoteBrowse {
	path: string
	root: string
	parent: string | null
	entries: RemoteDirEntry[]
}

function isIPv4Loopback(v4: string): boolean {
	const parts = v4.split('.')
	return parts.length === 4
		&& parts[0] === '127'
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(address: string | undefined): boolean {
	if (address === undefined) return false
	const normalized = address.toLowerCase()
	if (normalized === '::1') return true
	if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
	return isIPv4Loopback(normalized)
}

function isLoopbackRequest(request: IncomingMessage): boolean {
	if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
	const host = request.headers.host
	if (typeof host !== 'string') return false
	let hostUrl: URL
	try {
		hostUrl = new URL(`http://${host}`)
	} catch {
		return false
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false
	if (request.headers['sec-fetch-site'] === 'cross-site') return false
	const origin = request.headers.origin
	if (origin === undefined) return true
	try {
		return new URL(origin).host === hostUrl.host
	} catch {
		return false
	}
}

function isLoopbackHostname(hostname: string): boolean {
	if (hostname === 'localhost' || hostname === '[::1]') return true
	return isIPv4Loopback(hostname)
}

const JSON_BODY_MAX_BYTES = 32 * 1024

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
	res.end(JSON.stringify(body))
}

const ok = (data: unknown) => ({ ok: true, data })
const fail = (message: string) => ({ ok: false, error: { message } })

// malformed/oversized bodies are answered here (400/413) and reported as null: the caller must not touch the response again
async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
	const chunks: Buffer[] = []
	let size = 0
	let tooLarge = false
	for await (const chunk of req) {
		const buffer = chunk as Buffer
		size += buffer.length
		if (size > JSON_BODY_MAX_BYTES) {
			tooLarge = true
			break
		}
		chunks.push(buffer)
	}
	if (tooLarge) {
		writeJson(res, 413, fail(`request body exceeds ${JSON_BODY_MAX_BYTES} bytes`))
		req.destroy()
		return null
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
	} catch {
	}
	writeJson(res, 400, fail('expected a JSON object body'))
	return null
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

class PolicyError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PolicyError'
	}
}

function freePath(path: string): string {
	const trimmed = path.trim()
	if (trimmed === '') throw new PolicyError('a path is required')
	if (!isAbsolute(trimmed)) {
		throw new PolicyError(`"${path}" is not an absolute path on the remote PC (use e.g. "C:\\\\Users\\\\...")`)
	}
	if (/[*?"<>|]/.test(trimmed)) {
		throw new PolicyError(`"${path}" contains characters that are illegal in Windows paths`)
	}
	const segments = trimmed.split(/[\\/]+/)
	const driveSegments = /^[a-zA-Z]:(?:[\\/]|$)/.test(trimmed) ? 1 : 0
	for (let index = driveSegments; index < segments.length; index += 1) {
		if (segments[index].includes(':')) {
			throw new PolicyError(`"${path}" has a colon outside the drive specifier`)
		}
	}
	return normalize(trimmed)
}

function parentOf(target: string): string | null {
	const trimmed = target.replace(/\\+$/, '')
	if (/^[a-zA-Z]:$/.test(trimmed)) return null
	if (/^\\\\[^\\]+$/.test(trimmed)) return null
	const segments = trimmed.split('\\')
	if (segments.length <= 1) return null
	const parent = segments.slice(0, -1).join('\\')
	return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent
}

function validSegment(name: string): boolean {
	const trimmed = name.trim()
	if (trimmed === '' || trimmed === '.' || trimmed === '..') return false
	if (/[\\/:*?"<>|]/.test(trimmed)) return false
	if (/[. ]$/.test(trimmed)) return false
	if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(trimmed)) return false
	return true
}

export function registerWorkspaceRoutes(
	config: WorkspaceRouteConfig,
	transport: SshTransport,
	webServer: WebServerLike,
	roots: WorkspaceRootStore,
): () => void {
	// the agent knows files, not volumes: one-shot PowerShell probe, cached, own kill timer
	// (requestTimeoutMs guards agent ops, not spawnCommand); concurrent opens coalesce
	let driveCache: { at: number; list: string[] } | undefined
	let drivePending: Promise<string[]> | undefined
	const probeDrives = (): Promise<string[]> => new Promise<string[]>((resolve, reject) => {
		const child = transport.spawnCommand('powershell -NoProfile -NonInteractive -Command "Get-PSDrive -PSProvider FileSystem | ForEach-Object Root"', { stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		let err = ''
		let settled = false
		const settle = (fn: () => void): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			fn()
		}
		const timer = setTimeout(() => {
			settle(() => {
				try {
					child.kill('SIGKILL')
				} catch {}
				reject(new Error('drive probe timed out after 8000ms'))
			})
		}, 8000)
		timer.unref?.()
		child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
		child.stderr?.on('data', (chunk) => { err += chunk.toString('utf8') })
		child.on('error', (error) => settle(() => reject(error)))
		child.on('close', (code) => settle(() => {
			if (code !== 0) {
				reject(new Error(`drive probe failed (exit ${code})${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''}`))
				return
			}
			const drives = out
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => /^[a-zA-Z]:\\?$/.test(line))
				.map((line) => (line.endsWith('\\') ? line : `${line}\\`))
			if (drives.length === 0) reject(new Error(`drive probe returned nothing${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''}`))
			else resolve(drives)
		}))
	})
	const driveRoots = async (): Promise<string[]> => {
		if (driveCache && Date.now() - driveCache.at < 60_000) return driveCache.list
		if (drivePending === undefined) {
			const run = probeDrives().then((list) => {
				driveCache = { at: Date.now(), list }
				return list
			})
			drivePending = run
			void run.then(() => {}, () => {}).finally(() => {
				if (drivePending === run) drivePending = undefined
			})
		}
		return drivePending
	}

	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, fail('dsh-ssh workspace routes only answer loopback, same-origin requests'))
			return
		}
		const url = new URL(req.url ?? '/', 'http://localhost')
		const route = url.pathname.slice('/ssh-workspace'.length)
		try {
			if (req.method === 'GET' && route === '/api/info') {
				writeJson(res, 200, ok({
					host: config.host,
					remoteRoot: normalize(config.remoteRoot),
					remoteLabel: config.remoteLabel,
					connected: transport.system !== undefined,
					machine: transport.system?.machine ?? null,
				}))
				return
			}
			if (req.method === 'GET' && route === '/api/drives') {
				writeJson(res, 200, ok({ path: null, root: normalize(config.remoteRoot), parent: null, entries: (await driveRoots()).map((drive) => ({ name: drive, path: drive, hidden: false })) }))
				return
			}
			if (req.method === 'GET' && route === '/api/browse') {
				const requested = url.searchParams.get('path') ?? config.remoteRoot
				const target = freePath(requested)
				const listed = await transport.request('list', { path: target })
				const entries: RemoteDirEntry[] = (Array.isArray(listed.items) ? listed.items : [])
					.filter((item: any) => item?.type === 'directory')
					.map((item: any) => ({ name: String(item.name), path: joinDir(target, String(item.name)), hidden: String(item.name).startsWith('.') }))
				const browse: RemoteBrowse = { path: target, root: normalize(config.remoteRoot), parent: parentOf(target), entries }
				writeJson(res, 200, ok(browse))
				return
			}
			if (req.method === 'POST' && route === '/api/mkdir') {
				const body = await readJsonObject(req, res)
				if (body === null) return
				const parent = typeof body?.parent === 'string' ? body.parent : ''
				const name = typeof body?.name === 'string' ? body.name : ''
				if (!validSegment(name)) {
					writeJson(res, 400, fail(`"${name}" is not a usable single directory name`))
					return
				}
				const target = joinDir(freePath(parent), name.trim())
				await transport.request('mkdir', { path: target })
				writeJson(res, 200, ok({ path: target }))
				return
			}
			if (req.method === 'POST' && route === '/api/prepare') {
				const body = await readJsonObject(req, res)
				if (body === null) return
				const target = freePath(typeof body?.path === 'string' ? body.path : '')
				const remote = await transport.request('stat', { path: target })
				if (!remote.exists || remote.type !== 'directory') {
					throw new PolicyError(`the remote path is not a directory: ${target}`)
				}
				// the workspace registry stats paths on this machine, so opening a remote folder needs an
				// empty local dir at the same path; the router serves the traffic remotely
				if (!win32.isAbsolute(target) || !isLocalAbsolute(target) || target.startsWith('\\\\')) {
					// a UNC mirror would resolve the same on both sides: mkdir would write into the share itself
					throw new PolicyError(`cannot mirror "${target}" locally — pick a drive-rooted folder (e.g. "C:\\...") for now`)
				}
				try {
					await mkdir(target, { recursive: true })
				} catch (cause: any) {
					if (cause?.code === 'EPERM' || cause?.code === 'EACCES') {
						throw new PolicyError(
							`this machine refuses to create the mirror folder for "${target}" (Windows protects other users' profile folders). Either seed the path once from an elevated terminal (mkdir "${target}", then grant this account modify on "${win32.dirname(target)}"), or keep remote work under a plain folder such as "C:\\workplace" that mirrors cleanly.`,
						)
					}
					throw cause
				}
				const local = await statLocal(target).catch(() => undefined)
				if (!local?.isDirectory()) {
					throw new PolicyError(`"${target}" exists locally but is not a directory; move it out of the way or choose another folder`)
				}
				roots.add(target)
				writeJson(res, 200, ok({ path: target, host: config.host }))
				return
			}
			writeJson(res, 404, fail(`unknown ssh-workspace route: ${req.method} ${url.pathname}`))
		} catch (error) {
			if (error instanceof PolicyError) {
				writeJson(res, 400, fail(error.message))
				return
			}
			writeJson(res, 500, fail(messageOf(error)))
		}
	}

	return webServer.register({ kind: 'prefix', path: '/ssh-workspace', handler })
}
