import type { Context } from '@deepseek-ai/cordis';
import type { PrivacyVault } from '../vault.ts';
/** Restore only renderer fields that are visible prose; all other node data remains opaque. */
export declare function restoreDisplayValue(kind: string, value: unknown, restore: (text: string) => string): unknown;
/** Adapt both released Chat layouts while retaining their slots, actions, stores and locale. */
export declare function installDisplayRestoration(ctx: Context, vault: PrivacyVault): () => void;
//# sourceMappingURL=display.d.ts.map