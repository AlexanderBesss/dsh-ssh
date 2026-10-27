import { defineConfig } from 'tsdown'

// the bundle registers into dsh's browser module table via the banner below; react stays external — the app provides it at runtime, never bundle it
const CLIENT_ID = 'dsh-ssh'

const banner = [
	`window.__ModuleLoader__.load({`,
	`\tid: ${JSON.stringify(CLIENT_ID)},`,
	`\tfactory: (require) => {`,
	`\t\tvar module = { exports: {} };`,
	`\t\tvar exports = module.exports;`,
].join('\n')

const footer = `\t\treturn module.exports;\n\t}\n});`

export default defineConfig({
	entry: { client: 'src/client/index.tsx' },
	outDir: 'dist',
	format: 'cjs',
	platform: 'browser',
	target: 'es2022',
	minify: false,
	dts: false,
	clean: false,
	outExtensions: () => ({ js: '.js' }),
	deps: {
		neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
	},
	banner,
	footer,
})
