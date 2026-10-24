/**
 * Ambient declaration for `@deepseek-ai/dsh-tools`.
 *
 * The package lives inside `app.asar` and is NOT resolvable from a plugin's
 * module path — see the header of `seams.ts` for why. The plugin imports it
 * dynamically and copes with the import failing, so the compile-time shape
 * here exists to type that attempt, not to promise the package is present.
 *
 * This file must stay a global script (no top-level import/export), otherwise
 * the `declare module` turns into an augmentation of a module that does not
 * exist, which TypeScript rejects.
 */

declare module '@deepseek-ai/dsh-tools' {
	export function defineTool(definition: any): any
}
