/**
 * `@deepseek-ai/dsh-tools` lives inside app.asar and is not resolvable from a
 * plugin's module path; the dynamic import copes with failure.
 * This file must stay a global script (no top-level import/export), or the
 * `declare module` becomes an augmentation TypeScript rejects.
 */

declare module '@deepseek-ai/dsh-tools' {
	export function defineTool(definition: any): any
}
