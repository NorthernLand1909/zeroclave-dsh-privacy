import type { FindingCandidate } from './detector.ts';
import type { EditableRegexRule, EntityType, RegexErrorCode, RegexMatch } from './types.ts';
export declare const RULE_ENTITY_TYPES: readonly EntityType[];
export declare class RegexRuleError extends Error {
    readonly code: RegexErrorCode;
    constructor(code: RegexErrorCode);
}
export declare function validateRule(rule: EditableRegexRule): void;
export declare function loadRegexRules(): {
    rules: readonly EditableRegexRule[];
    error?: RegexErrorCode;
};
export declare function saveRegexRules(rules: readonly EditableRegexRule[]): void;
/** Runs only in a terminable worker for user-authored patterns. Keep this function self-contained. */
export declare function executeRegexBatch(text: string, rules: readonly EditableRegexRule[]): RegexMatch[];
export type RegexExecutor = (text: string, rules: readonly EditableRegexRule[], signal?: AbortSignal) => Promise<RegexMatch[]>;
export declare const runRegexWorker: RegexExecutor;
export declare function scanConfiguredRules(text: string, rules: readonly EditableRegexRule[], execute: RegexExecutor, signal?: AbortSignal): Promise<FindingCandidate[]>;
//# sourceMappingURL=regex-rules.d.ts.map