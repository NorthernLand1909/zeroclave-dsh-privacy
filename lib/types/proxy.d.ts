import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const ZEROCLAVE_DETECT_PROXY_PATH = "/api/zeroclave-privacy/detect";
export declare const MAX_DETECT_REQUEST_BODY_BYTES: number;
export declare const MAX_DETECT_RESPONSE_BODY_BYTES: number;
export interface DetectProxyConfig {
    gatewayBaseURL: string;
    timeoutMs: number;
}
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare function createDetectProxyHandler(config: DetectProxyConfig, fetchImpl?: Fetch): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export {};
//# sourceMappingURL=proxy.d.ts.map