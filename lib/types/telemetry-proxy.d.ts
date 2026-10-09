import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const TELEMETRY_CONFIG_PATH = "/api/zeroclave-privacy/telemetry/config";
export declare const TELEMETRY_EVENTS_PATH = "/api/zeroclave-privacy/telemetry/events";
export declare const MAX_TELEMETRY_BODY_BYTES = 512;
export type TelemetryProvider = 'zeroclave' | 'plausible';
export interface TelemetryProxyConfig {
    enabled: boolean;
    provider?: TelemetryProvider;
    site?: string;
    endpoint: string;
    timeoutMs: number;
    pluginVersion: string;
}
interface TelemetryProxyInternals {
    fetch: typeof fetch;
}
export declare function createTelemetryHandlers(config: TelemetryProxyConfig, internals?: TelemetryProxyInternals): {
    active: boolean;
    config: (req: IncomingMessage, res: ServerResponse) => void;
    events: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};
export {};
//# sourceMappingURL=telemetry-proxy.d.ts.map