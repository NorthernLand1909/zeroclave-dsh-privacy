interface SessionSelectionSnapshot {
    current?: string | undefined;
    byId: Readonly<Record<string, {
        id: string;
        retainedBy?: Readonly<{
            mainView?: number;
        }>;
    }>>;
}
/** DSH 0.1 exposes current; DSH 0.2 marks the session retained by the main view. */
export declare function selectedSessionId(state: SessionSelectionSnapshot): string | undefined;
export {};
//# sourceMappingURL=session-selection.d.ts.map