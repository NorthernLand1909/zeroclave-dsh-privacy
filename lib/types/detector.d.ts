import type { DetectorMode, DetectorProvider, EntityType, FindingCategory, RiskLevel, ScanResult, EditableRegexRule, RegexMatch } from './types.ts';
interface FindingCandidate {
    category: FindingCategory;
    entityType: EntityType;
    start: number;
    end: number;
    maskedEvidence: string;
    confidence?: number;
    severity: Exclude<RiskLevel, 'none'>;
    detector: DetectorMode;
    ruleId?: string;
    ruleName?: string;
    sourceType?: string;
}
export declare function graphemeCount(value: string): number;
export declare function maskPerson(value: string): string;
export declare const DEFAULT_REGEX_RULES: readonly EditableRegexRule[];
export declare function isDefaultPattern(rule: EditableRegexRule): boolean;
export declare function configuredCandidates(text: string, matches: readonly RegexMatch[], rules: readonly EditableRegexRule[]): FindingCandidate[];
export declare function finalizeScan(text: string, candidates: readonly FindingCandidate[], requested: DetectorMode, used: DetectorMode, fallback: boolean, model?: string): ScanResult;
export declare function regexCandidates(text: string, rules?: readonly EditableRegexRule[]): FindingCandidate[];
export declare function scanRegex(text: string, requested?: DetectorMode, rules?: readonly EditableRegexRule[]): ScanResult;
export declare function mergeModelCandidates(text: string, modelCandidates: readonly FindingCandidate[], model: string, regex?: readonly FindingCandidate[]): ScanResult;
export type { FindingCandidate };
export declare class RegexDetector implements DetectorProvider {
    readonly id: "regex";
    readonly label = "Local regex rules";
    readonly locality: "browser";
    available(): boolean;
    scan(text: string): Promise<ScanResult>;
}
//# sourceMappingURL=detector.d.ts.map