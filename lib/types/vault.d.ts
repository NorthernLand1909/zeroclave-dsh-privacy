import type { ScanResult } from './types.ts';
interface Mapping {
    sessionId: string;
    token: string;
    original: string;
    entityType: string;
}
export interface MappingStore {
    read(sessionId: string): Promise<Mapping[]>;
    write(mappings: readonly Mapping[]): Promise<void>;
    close(): void;
}
/** Browser-local mappings never accompany a prompt or enter the Host session log. */
export declare class BrowserMappingStore implements MappingStore {
    private database;
    private open;
    read(sessionId: string): Promise<Mapping[]>;
    write(mappings: readonly Mapping[]): Promise<void>;
    close(): void;
}
/** Session-scoped reversible redaction with durable browser-only storage. */
export declare class PrivacyVault {
    private readonly store;
    private readonly sessions;
    private readonly loads;
    private readonly operations;
    private readonly reservations;
    constructor(store?: MappingStore);
    load(sessionId: string): Promise<void>;
    /** Reserve preview tokens in memory; unsent originals are never written to IndexedDB. */
    preview(sessionId: string, text: string, result: ScanResult): Promise<ScanResult>;
    redact(sessionId: string, text: string, result: ScanResult): Promise<ScanResult>;
    restore(sessionId: string, text: string): string;
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=vault.d.ts.map