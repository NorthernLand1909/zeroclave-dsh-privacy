interface SessionSelectionSnapshot {
  current?: string | undefined
  byId: Readonly<Record<string, {
    id: string
    retainedBy?: Readonly<{ mainView?: number }>
  }>>
}

/** DSH 0.1 exposes current; DSH 0.2 marks the session retained by the main view. */
export function selectedSessionId(state: SessionSelectionSnapshot): string | undefined {
  return state.current ?? Object.values(state.byId)
    .find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id
}
