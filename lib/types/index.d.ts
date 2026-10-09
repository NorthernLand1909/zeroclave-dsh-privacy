import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "zeroclave-privacy";
export declare const inject: string[];
export interface Config {
    gatewayBaseURL: string;
    timeoutMs: number;
    telemetryProvider: 'zeroclave' | 'plausible';
    telemetryEnabled: boolean;
    telemetryEndpoint: string;
    telemetrySite: string;
    telemetryTimeoutMs: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { RegexDetector, scanRegex } from './detector.ts';
export { ZEROCLAVE_PROXY_PATH, ZeroClaveDetectError, ZeroClaveDetector, } from './zeroclave-detector.ts';
export type * from './types.ts';
//# sourceMappingURL=index.d.ts.map