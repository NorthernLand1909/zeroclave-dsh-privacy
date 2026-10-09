import { type FindingCandidate } from './detector.ts';
import type { DetectorProvider, ScanResult } from './types.ts';
export declare const ZEROCLAVE_PROXY_PATH = "/api/zeroclave-privacy/detect";
export interface ZeroClaveDetectInput {
    id: string;
    revision: string;
    text: string;
    regex: readonly FindingCandidate[];
}
export declare class ZeroClaveDetectError extends Error {
    readonly code: string;
    readonly status?: number | undefined;
    readonly requestId?: string | undefined;
    constructor(code: string, message: string, status?: number | undefined, requestId?: string | undefined);
}
export interface ZeroClaveDetectorInternals {
    fetch: typeof fetch;
    wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    random: () => number;
    now?: () => number;
}
export declare class ZeroClaveDetector implements DetectorProvider {
    private readonly timeoutMs;
    private readonly retries;
    readonly id: "zeroclave";
    readonly label = "ZeroClave API";
    readonly locality: "remote";
    private endpoint;
    private readonly internals;
    constructor(endpoint?: string, timeoutMs?: number, retries?: number, internals?: ZeroClaveDetectorInternals);
    configure(endpoint: string): void;
    get endpointURL(): string;
    available(): boolean;
    scan(text: string, signal?: AbortSignal): Promise<ScanResult>;
    scanBatch(inputs: readonly ZeroClaveDetectInput[], signal?: AbortSignal): Promise<ScanResult[]>;
}
//# sourceMappingURL=zeroclave-detector.d.ts.map