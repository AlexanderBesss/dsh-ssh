import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp-wiring')
const repoNodeModules = join(root, '..', 'node_modules', '@deepseek-ai')

const results: any[] = []
function check(label: string, ok: boolean, detail: any = '') {
	results.push({ label, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

function buildTree(name: string) {
	const tree = join(root, name)
	rmSync(tree, { recursive: true, force: true })
	for (const pkg of ['cordis', 'schemastery']) {
		mkdirSync(join(tree, 'node_modules', '@deepseek-ai'), { recursive: true })
		cpSync(join(repoNodeModules, pkg), join(tree, 'node_modules', '@deepseek-ai', pkg), { recursive: true })
	}
	writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: `wiring-${name}`, private: true, type: 'module' }, null, 2), 'utf8')
	return tree
}

for (const pkg of ['cordis', 'schemastery']) {
	if (!existsSync(join(repoNodeModules, pkg))) {
		console.error(`run npm install first: ${join(repoNodeModules, pkg)} is missing`)
		process.exit(2)
	}
}

const appTree = buildTree('app')
const pluginTree = buildTree('plugin')

// the plugin side, against ITS OWN copy of the libraries, as a linked install resolves
writeFileSync(join(pluginTree, 'plugin.mjs'), `
import Schema from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'

export const name = 'wiring-probe'
export const inject = []

export const Config = Schema.object({
  marker: Schema.string().default('plugin'),
  // Route mode registers no provider at all: the local one stays, and a router
  // is published on the read path. Phase 6 needs that shape.
  register: Schema.boolean().default(true),
})

// Observed at apply() time. A cordis context rejects ad-hoc properties, so an
// export is the portable way for the probe to read what apply() saw.
export const seen = {}

export class PluginFileSystem extends Service {
  constructor(ctx, marker) {
    super(ctx, 'fs')
    this.marker = marker
  }

  async readText() {
    return this.marker
  }

  // Self-reference: what a delegating provider would do to reach the other fs.
  async delegateSelf() {
    return this.ctx.fs.readText()
  }
}

export function apply(ctx, config) {
  seen.config = config
  // Reading a property the plugin did not declare in \`inject\` throws in cordis,
  // so every probe of the reflection surface is wrapped.
  const probe = (fn) => { try { return fn() } catch (error) { return 'threw: ' + error.message } }
  seen.interceptType = probe(() => typeof ctx.reflect?.intercept)
  seen.provideType = probe(() => typeof ctx.reflect?.provide)
  seen.bypassType = probe(() => typeof ctx.bypass)
  seen.onType = probe(() => typeof ctx.on)
  if (config.register !== false) new PluginFileSystem(ctx, config.marker)
}

// The route-mode mechanism, exercised from the plugin's own copy of cordis:
// publish an object for \`fs\` on the read path, for consumer fibers only.
export function installRouter(ctx, marker) {
  const router = { marker, readText: async () => marker + ' routed' }
  return ctx.on('internal/get', (receiver, name, error, next) => {
    if (name !== 'fs') return next()
    if (receiver?.fiber === ctx.fiber) return next()
    return router
  })
}
`, 'utf8')

// the app side: its own copies, five phases, each on a fresh Context
writeFileSync(join(appTree, 'probe.mjs'), `
import { Context, Service } from '@deepseek-ai/cordis'

const plugin = await import(${JSON.stringify(pathToFileURL(join(pluginTree, 'plugin.mjs')).href)})
const out = {}

class LocalFileSystem extends Service {
  constructor(ctx) {
    super(ctx, 'fs')
    this.marker = 'local'
  }
  async readText() {
    return 'local'
  }
}

const fresh = () => new Context()
const who = (ctx) => Promise.resolve(ctx.fs?.readText?.()).catch((error) => 'threw: ' + (error?.message ?? error))

// A phase that throws is a result, not a crash: the app's composition behaves
// this way too, and the message is the finding.
async function phase(label, fn) {
  try {
    await fn()
  } catch (error) {
    out[label] = 'threw: ' + (error?.message ?? error)
  }
}

// Phase 1: the local provider alone — the app as it runs today.
await phase('phase1_localOnly', async () => {
  const ctx = fresh()
  new LocalFileSystem(ctx)
  out.phase1_localOnly = await who(ctx)
  await ctx.stop?.()
})

// Phase 2: plugin mounts first, local provider registers after.
await phase('phase2_pluginFirst', async () => {
  const ctx = fresh()
  await ctx.plugin(plugin, { marker: 'plugin-first' })
  new LocalFileSystem(ctx)
  out.phase2_pluginFirst = await who(ctx)
  await ctx.stop?.()
})

// Phase 3: local provider registers first (app bundles mount before plugins),
// plugin mounts after. This is the real app order.
await phase('phase3_pluginSecond', async () => {
  const ctx = fresh()
  new LocalFileSystem(ctx)
  await ctx.plugin(plugin, { marker: 'plugin-second' })
  out.phase3_pluginSecond = await who(ctx)
  out.phase3_seen = plugin.seen
  await ctx.stop?.()
})
out.phase3_seen = plugin.seen

// Phase 4: self-reference from inside the plugin's own provider.
await phase('phase4_selfReference', async () => {
  const ctx = fresh()
  new LocalFileSystem(ctx)
  try {
    await ctx.plugin(plugin, { marker: 'delegate' })
  } catch (error) {
    out.phase4_mount = 'threw: ' + (error?.message ?? error)
  }
  out.phase4_selfReference = await Promise.resolve(ctx.fs?.delegateSelf?.())
    .catch((error) => 'threw: ' + (error?.message ?? error))
  await ctx.stop?.()
})

// Phase 5: interception, if this cordis exposes it.
await phase('phase5', async () => {
  const ctx = fresh()
  new LocalFileSystem(ctx)
  const probe = (fn) => { try { return fn() } catch (error) { return 'threw: ' + error.message } }
  out.phase5_reflectApi = {
    intercept: probe(() => typeof ctx.reflect?.intercept),
    provide: probe(() => typeof ctx.reflect?.provide),
    bypass: probe(() => typeof ctx.bypass),
  }
  if (out.phase5_reflectApi.intercept === 'function') {
    out.phase5_interceptResult = probe(() => {
      ctx.reflect.intercept('fs', (self) => ({ probeTarget: () => Promise.resolve(self.readText()) }))
      return 'installed'
    })
    out.phase5_probeTarget = await Promise.resolve(ctx.fs?.probeTarget?.())
      .catch((error) => 'threw: ' + (error?.message ?? error))
    out.phase5_whoWinsAfterIntercept = await who(ctx)
  }
  await ctx.stop?.()
})

// Phase 6: route mode across module instances. The plugin (foreign copy of
// cordis) publishes a router for \`fs\` on the read path; a consumer fiber of the
// app's own copy must receive it, and the app's provider must stay registered.
await phase('phase6', async () => {
  const ctx = fresh()
  const local = new LocalFileSystem(ctx)
  await ctx.plugin(plugin, { marker: 'plugin-router', register: false })
  plugin.installRouter(ctx, 'plugin-router')
  let consumerView
  let rootView
  await ctx.plugin({
    name: 'consumer',
    inject: ['fs'],
    apply(target) {
      consumerView = target.fs
      rootView = ctx.get('fs', false)
    },
  })
  out.phase6_consumerSees = consumerView?.marker
  out.phase6_consumerRead = await Promise.resolve(consumerView?.readText?.()).catch((error) => 'threw: ' + (error?.message ?? error))
  out.phase6_storeHolds = rootView?.marker ?? rootView?.constructor?.name
  out.phase6_localStillRegistered = local.marker
  await ctx.stop?.()
})

console.log(JSON.stringify(out, null, 2))
`, 'utf8')

const probePath = join(appTree, 'probe.mjs')
const { spawnSync } = await import('node:child_process')
const run = spawnSync(process.execPath, [probePath], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
if (run.status !== 0) {
	check('probe ran', false, `exit ${run.status}: ${String(run.stderr ?? run.stdout).trim().slice(0, 600)}`)
} else {
	const out = JSON.parse(run.stdout)
	console.log('observations:')
	for (const [key, value] of Object.entries(out)) {
		console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
	}
	check('the local provider serves ctx.fs on its own', out.phase1_localOnly === 'local', out.phase1_localOnly)
	check('a second fs provider throws when the plugin mounts first', String(out.phase2_pluginFirst).startsWith('threw: service "fs" has been registered'), out.phase2_pluginFirst)
	check('a second fs provider throws in the real app order too', String(out.phase3_pluginSecond).startsWith('threw: service "fs" has been registered'), out.phase3_pluginSecond)
	check('config is resolved and reaches apply()', typeof out.phase3_seen?.config?.marker === 'string', JSON.stringify(out.phase3_seen?.config))
	check('this cordis exposes no service-wrapping API to lean on', out.phase5_reflectApi?.intercept === 'undefined', JSON.stringify(out.phase5_reflectApi))
	check('a router published on the read path reaches a consumer fiber', out.phase6_consumerRead === 'plugin-router routed', JSON.stringify(out.phase6_consumerRead))
	check('the app provider stays registered and reachable beside the router', out.phase6_storeHolds === 'local' && out.phase6_localStillRegistered === 'local', JSON.stringify([out.phase6_storeHolds, out.phase6_localStillRegistered]))
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
rmSync(root, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
