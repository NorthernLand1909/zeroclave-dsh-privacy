import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ScanResult } from './types.ts'

interface Mapping { sessionId: string; token: string; original: string; entityType: string }

export interface MappingStore {
  read(sessionId: string): Promise<Mapping[]>
  write(mappings: readonly Mapping[]): Promise<void>
  close(): void
}

/** Browser-local mappings never accompany a prompt or enter the Host session log. */
export class BrowserMappingStore implements MappingStore {
  private database: Promise<IDBDatabase> | undefined

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('zeroclave-privacy', 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('mappings', { keyPath: ['sessionId', 'token'] })
        store.createIndex('sessionId', 'sessionId')
      }
      request.onerror = () => { this.database = undefined; reject(request.error ?? new Error('Privacy mapping database unavailable')) }
      request.onsuccess = () => { resolve(request.result) }
    })
    return this.database
  }

  async read(sessionId: string): Promise<Mapping[]> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('mappings', 'readonly')
      const request = transaction.objectStore('mappings').index('sessionId').getAll(sessionId)
      transaction.oncomplete = () => { resolve(request.result as Mapping[]) }
      transaction.onabort = () => { reject(transaction.error ?? new Error('Privacy mapping read aborted')) }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Privacy mapping read failed')) }
    })
  }

  async write(mappings: readonly Mapping[]): Promise<void> {
    if (mappings.length === 0) return
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('mappings', 'readwrite')
      for (const mapping of mappings) transaction.objectStore('mappings').put(mapping)
      transaction.oncomplete = () => { resolve() }
      transaction.onabort = () => { reject(transaction.error ?? new Error('Privacy mapping write aborted')) }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Privacy mapping write failed')) }
    })
  }

  close(): void { void this.database?.then((db) => { db.close() }, () => undefined) }
}

/** Session-scoped reversible redaction with durable browser-only storage. */
export class PrivacyVault {
  private readonly sessions = new Map<string, Map<string, Mapping>>()
  private readonly loads = new Map<string, Promise<void>>()
  private readonly operations = new Map<string, Promise<unknown>>()

  constructor(private readonly store: MappingStore = new BrowserMappingStore()) {}

  async load(sessionId: string): Promise<void> {
    let pending = this.loads.get(sessionId)
    if (pending === undefined) {
      pending = this.store.read(sessionId).then((mappings) => {
        this.sessions.set(sessionId, new Map(mappings.map(mapping => [mapping.token, mapping])))
      }).catch((error: unknown) => { this.loads.delete(sessionId); throw error })
      this.loads.set(sessionId, pending)
    }
    await pending
  }

  async redact(sessionId: string, text: string, result: ScanResult): Promise<ScanResult> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      await this.load(sessionId)
      const mappings = this.sessions.get(sessionId)
      if (mappings === undefined) throw new Error('Privacy mappings were disposed')
      const values = new Map([...mappings.values()].map(mapping => [
        `${mapping.entityType}\u0000${mapping.original}`, mapping,
      ]))
      const additions: Mapping[] = []
      const findings = result.findings.map((finding) => {
        if (finding.action === 'kept') return finding
        const original = text.slice(finding.start, finding.end)
        const key = `${finding.entityType}\u0000${original}`
        let mapping = values.get(key)
        if (mapping === undefined) {
          mapping = {
            sessionId, original, entityType: finding.entityType,
            token: `ZCPII-${finding.entityType}-${randomUUID().replaceAll('-', '')}`,
          }
          values.set(key, mapping)
          additions.push(mapping)
        }
        return { ...finding, replacement: mapping.token }
      })
      // Persist before returning sendable text, so a reload can still restore the response.
      await this.store.write(additions)
      for (const mapping of additions) mappings.set(mapping.token, mapping)
      const redactedText = [...findings].filter(finding => finding.action !== 'kept').reverse().reduce((value, finding) => (
        value.slice(0, finding.start) + finding.replacement + value.slice(finding.end)
      ), text)
      return { ...result, findings, redactedText }
    })
    this.operations.set(sessionId, operation)
    try { return await operation } finally {
      if (this.operations.get(sessionId) === operation) this.operations.delete(sessionId)
    }
  }

  restore(sessionId: string, text: string): string {
    const mappings = this.sessions.get(sessionId)
    if (mappings === undefined) return text
    const partial = /ZCPII-[A-Z][A-Z0-9_]*(?:-[a-f0-9]{0,31})?$/u.exec(text)
    const complete = partial !== null && [...mappings.keys()].some(token => token.startsWith(partial[0]))
      ? text.slice(0, partial.index) : text
    return complete.replace(/ZCPII-[A-Z][A-Z0-9_]*-[a-f0-9]{32}/gu, token => mappings.get(token)?.original ?? token)
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.loads.values(), ...this.operations.values()])
    this.store.close()
    this.sessions.clear()
  }
}
