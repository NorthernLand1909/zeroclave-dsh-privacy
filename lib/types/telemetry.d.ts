export type TelemetryEvent = 'privacy_active' | 'protected_send' | 'detector_used';
export type TelemetryDetector = 'regex' | 'embedded' | 'zeroclave';
export type TelemetryAvailability = 'checking' | 'available' | 'unavailable';
export interface TelemetryClaim {
    dailyId: string;
    leaseId: string;
    attempts: number;
}
export interface TelemetryStore {
    claim(day: string, event: TelemetryEvent, value: string, now: number): Promise<TelemetryClaim | undefined>;
    markSent(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void>;
    markFailed(day: string, event: TelemetryEvent, value: string, leaseId: string, retryAt: number): Promise<void>;
    markTerminal(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void>;
    clear(): Promise<void>;
    close(): void;
}
interface TelemetryInternals {
    fetch: typeof fetch;
    now: () => number;
    randomBytes: (length: number) => Uint8Array;
    wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
export declare class IndexedDbTelemetryStore implements TelemetryStore {
    private readonly makeRandomBytes;
    private databasePromise;
    constructor(makeRandomBytes?: (length: number) => Uint8Array);
    claim(day: string, event: TelemetryEvent, value: string, now: number): Promise<TelemetryClaim | undefined>;
    markSent(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void>;
    markFailed(day: string, event: TelemetryEvent, value: string, leaseId: string, retryAt: number): Promise<void>;
    markTerminal(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void>;
    clear(): Promise<void>;
    close(): void;
    private database;
    private updateDelivery;
    private cleanupBefore;
    private deleteCursor;
}
export interface TelemetryReporter {
    readonly consent: boolean;
    readonly lockedByGpc: boolean;
    initialize(signal?: AbortSignal): Promise<TelemetryAvailability>;
    setConsent(consent: boolean): boolean;
    setConsentListener(listener: (consent: boolean) => void): void;
    report(event: TelemetryEvent, value?: TelemetryDetector): void;
    dispose(): Promise<void>;
}
export declare class PrivacyTelemetry implements TelemetryReporter {
    private readonly store;
    private readonly internals;
    private available;
    private readonly lifetime;
    private consentOperation;
    private readonly inflight;
    private consentOverride;
    private directPlausible;
    private consentListener;
    private readonly storage;
    private readonly onStorage;
    constructor(store?: TelemetryStore, storage?: Storage | undefined, internals?: TelemetryInternals);
    get lockedByGpc(): boolean;
    get consent(): boolean;
    initialize(signal?: AbortSignal): Promise<TelemetryAvailability>;
    setConsent(consent: boolean): boolean;
    setConsentListener(listener: (consent: boolean) => void): void;
    report(event: TelemetryEvent, value?: TelemetryDetector): void;
    dispose(): Promise<void>;
    private deliver;
    private cancelAndClear;
    private startConsentOperation;
    private deliveryCancelled;
}
export {};
//# sourceMappingURL=telemetry.d.ts.map