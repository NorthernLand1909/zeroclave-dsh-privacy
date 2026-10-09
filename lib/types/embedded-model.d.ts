import { type FindingCandidate } from './detector.ts';
import type { DetectorProvider, ScanResult } from './types.ts';
export declare const EMBEDDED_MODEL_ID = "gravitee-io/bert-small-pii-detection";
export declare const EMBEDDED_MODEL_REVISION = "f8c27a85c51c0168f07b9dcf00265bf0a4097939";
interface TokenEntity {
    entity?: string;
    entity_group?: string;
    score?: number;
    index?: number;
    start?: number;
    end?: number;
    word?: string;
}
export declare function tokenEntitiesToCandidates(text: string, entities: readonly TokenEntity[], offset?: number): FindingCandidate[];
export declare class EmbeddedModelDetector implements DetectorProvider {
    readonly id: "embedded";
    readonly label = "BERT Small PII Detection";
    readonly locality: "browser";
    private classifier;
    private loading;
    available(): boolean;
    load(onProgress?: (progress: number) => void): Promise<void>;
    scan(text: string, signal?: AbortSignal, regex?: readonly FindingCandidate[]): Promise<ScanResult>;
    dispose(): Promise<void>;
    private loadClassifier;
}
export {};
//# sourceMappingURL=embedded-model.d.ts.map