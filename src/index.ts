import type { Context } from '@deepseek-ai/cordis'

export const name = 'zeroclave-privacy'

export function apply(_ctx: Context): void {}

export { RegexDetector, scanRegex, ZeroClaveDetector } from './detector.ts'
export type * from './types.ts'
