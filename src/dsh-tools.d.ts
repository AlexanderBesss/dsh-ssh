// this file must stay a global script (no top-level import/export), or the declare module becomes an augmentation TypeScript rejects

declare module '@deepseek-ai/dsh-tools' {
	export function defineTool(definition: any): any
}
