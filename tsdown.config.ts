import { defineConfig } from 'tsdown'

// The client half rides dsh's browser module table: the bundle registers
// itself through window.__ModuleLoader__.load, and the app's own React and
// client packages are required at runtime, never bundled — the exact shape
// dsh-docker-sandbox ships (its tsdown.config.ts is the reference).
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
