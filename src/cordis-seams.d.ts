import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
	interface Context {
		fs?: any
		subprocess?: any
		tools: {
			register(definition: any): unknown
		}
		// route mode gates this top-level; the replace entry reaches it via ctx.inject/polling so headless still activates
		webServer?: {
			register(route: { kind: string; path: string; handler: (req: any, res: any) => void | Promise<void> }): () => void
		}
	}
}
