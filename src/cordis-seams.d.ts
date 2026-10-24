/**
 * Context augmentation for the two service seams this plugin serves, plus the
 * tool registry it injects.
 *
 * The app's own packages (`dsh-fs`, `dsh-subprocess`, `dsh-tools`) each
 * augment `Context` with their service type inside `app.asar`, where this
 * plugin cannot resolve them. The augmentation below is the plugin's side of
 * that contract: typed loosely on purpose, mirroring `seams.ts` — the shapes
 * are what the app promises at runtime, not types this package owns.
 */

import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
	interface Context {
		/** The filesystem service, as the app's `dsh-fs` provides it. */
		fs?: any
		/** The subprocess service, as the app's `dsh-subprocess-local` provides it. */
		subprocess?: any
		/** The tool registry; present whenever this plugin's `inject: ['tools']` is satisfied. */
		tools: {
			register(definition: any): unknown
		}
		/**
		 * The web server service, as the app's `dsh-host-webserver` provides it
		 * (the slice this plugin uses: route registration). The route-mode
		 * entry (`dsh-ssh`) gates it top-level — the desktop composition always
		 * has one; the replace entry (`dsh-ssh/replace`) reaches it through
		 * `ctx.inject`/polling instead, so a headless composition without a web
		 * server still activates there.
		 */
		webServer?: {
			register(route: { kind: string; path: string; handler: (req: any, res: any) => void | Promise<void> }): () => void
		}
	}
}
