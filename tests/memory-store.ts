import type { MappingStore } from '../src/vault.ts'

export function memoryStore(): MappingStore {
  const mappings: Awaited<ReturnType<MappingStore['read']>> = []
  return {
    read: async sessionId => mappings.filter(mapping => mapping.sessionId === sessionId),
    write: async (additions) => { mappings.push(...additions) },
    close: () => undefined,
  }
}
