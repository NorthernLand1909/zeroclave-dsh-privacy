export type TelemetryEvent = 'privacy_active' | 'protected_send' | 'detector_used'
export type TelemetryDetector = 'regex' | 'embedded' | 'zeroclave'
export type TelemetryAvailability = 'checking' | 'available' | 'unavailable'

export interface TelemetryClaim {
  dailyId: string
  leaseId: string
  attempts: number
}

export interface TelemetryStore {
  claim(day: string, event: TelemetryEvent, value: string, now: number): Promise<TelemetryClaim | undefined>
  markSent(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void>
  markFailed(day: string, event: TelemetryEvent, value: string, leaseId: string, retryAt: number): Promise<void>
  markTerminal(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void>
  clear(): Promise<void>
  close(): void
}

interface DailyIdRecord { day: string; id: string; createdAt: number }
interface DeliveryRecord {
  key: string
  day: string
  event: TelemetryEvent
  value: string
  state: 'pending' | 'sent'
  attempts: number
  leaseId: string
  leaseUntil: number
}

interface TelemetryInternals {
  fetch: typeof fetch
  now: () => number
  randomBytes: (length: number) => Uint8Array
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

const CONSENT_KEY = 'zeroclave.privacy.telemetry-consent.v1'
const DATABASE_NAME = 'zeroclave-privacy-telemetry'
const DATABASE_VERSION = 1
const CONFIG_PATH = '/api/zeroclave-privacy/telemetry/config'
const EVENTS_PATH = '/api/zeroclave-privacy/telemetry/events'
const MAX_ATTEMPTS = 3
const LEASE_MILLISECONDS = 30_000
const RETRYABLE_STATUS = new Set([429, 503, 504])

function requestResult<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB request failed')) }
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onabort = () => { reject(transaction.error ?? new Error('IndexedDB transaction aborted')) }
    transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB transaction failed')) }
  })
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function deliveryKey(day: string, event: TelemetryEvent, value: string): string {
  return `${day}\u0000${event}\u0000${value}`
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const finish = (): void => { signal.removeEventListener('abort', cancel); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const cancel = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

function globalPrivacyControl(): boolean {
  return typeof navigator !== 'undefined'
    && (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
}

function safeLocalStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try { return window.localStorage } catch { return undefined }
}

export class IndexedDbTelemetryStore implements TelemetryStore {
  private databasePromise: Promise<IDBDatabase> | undefined

  constructor(private readonly makeRandomBytes: (length: number) => Uint8Array = randomBytes) {}

  async claim(day: string, event: TelemetryEvent, value: string, now: number): Promise<TelemetryClaim | undefined> {
    const database = await this.database()
    const transaction = database.transaction(['daily_ids', 'deliveries'], 'readwrite')
    const done = transactionDone(transaction)
    const ids = transaction.objectStore('daily_ids')
    const deliveries = transaction.objectStore('deliveries')
    let daily = await requestResult(ids.get(day) as IDBRequest<DailyIdRecord | undefined>)
    if (daily === undefined) {
      daily = { day, id: base64url(this.makeRandomBytes(16)), createdAt: now }
      await requestResult(ids.put(daily))
    }
    const key = deliveryKey(day, event, value)
    const existing = await requestResult(deliveries.get(key) as IDBRequest<DeliveryRecord | undefined>)
    let claim: TelemetryClaim | undefined
    if (existing?.state !== 'sent' && (existing?.attempts ?? 0) < MAX_ATTEMPTS
      && (existing?.leaseUntil ?? 0) <= now) {
      const leaseId = base64url(this.makeRandomBytes(12))
      const attempts = (existing?.attempts ?? 0) + 1
      await requestResult(deliveries.put({
        key, day, event, value, state: 'pending', attempts, leaseId, leaseUntil: now + LEASE_MILLISECONDS,
      } satisfies DeliveryRecord))
      claim = { dailyId: daily.id, leaseId, attempts }
    }
    await done
    void this.cleanupBefore(day).catch(() => undefined)
    return claim
  }

  async markSent(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void> {
    await this.updateDelivery(day, event, value, leaseId, record => ({
      ...record, state: 'sent', leaseUntil: 0,
    }))
  }

  async markFailed(
    day: string, event: TelemetryEvent, value: string, leaseId: string, retryAt: number,
  ): Promise<void> {
    await this.updateDelivery(day, event, value, leaseId, record => ({
      ...record, state: 'pending', leaseUntil: retryAt,
    }))
  }

  async markTerminal(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void> {
    await this.updateDelivery(day, event, value, leaseId, record => ({
      ...record, state: 'pending', attempts: MAX_ATTEMPTS, leaseUntil: Number.MAX_SAFE_INTEGER,
    }))
  }

  async clear(): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction(['daily_ids', 'deliveries'], 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore('daily_ids').clear()
    transaction.objectStore('deliveries').clear()
    await done
  }

  close(): void {
    void this.databasePromise?.then(
      (database) => { database.close() },
      () => undefined,
    )
    this.databasePromise = undefined
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is unavailable')); return }
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('daily_ids')) database.createObjectStore('daily_ids', { keyPath: 'day' })
        if (!database.objectStoreNames.contains('deliveries')) {
          const deliveries = database.createObjectStore('deliveries', { keyPath: 'key' })
          deliveries.createIndex('day', 'day')
        }
      }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('Unable to open telemetry storage')) }
      request.onblocked = () => { reject(new Error('Telemetry storage upgrade is blocked')) }
    })
    return this.databasePromise
  }

  private async updateDelivery(
    day: string,
    event: TelemetryEvent,
    value: string,
    leaseId: string,
    update: (record: DeliveryRecord) => DeliveryRecord,
  ): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction('deliveries', 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore('deliveries')
    const key = deliveryKey(day, event, value)
    const record = await requestResult(store.get(key) as IDBRequest<DeliveryRecord | undefined>)
    if (record?.leaseId === leaseId) await requestResult(store.put(update(record)))
    await done
  }

  private async cleanupBefore(day: string): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction(['daily_ids', 'deliveries'], 'readwrite')
    const done = transactionDone(transaction)
    const range = IDBKeyRange.upperBound(day, true)
    await this.deleteCursor(transaction.objectStore('daily_ids').openKeyCursor(range), transaction.objectStore('daily_ids'))
    const deliveryStore = transaction.objectStore('deliveries')
    await new Promise<void>((resolve, reject) => {
      const cursor = deliveryStore.index('day').openKeyCursor(range)
      cursor.onsuccess = () => {
        const hit = cursor.result
        if (hit === null) { resolve(); return }
        deliveryStore.delete(hit.primaryKey)
        hit.continue()
      }
      cursor.onerror = () => { reject(cursor.error ?? new Error('Telemetry cleanup failed')) }
    })
    await done
  }

  private deleteCursor(request: IDBRequest<IDBCursor | null>, store: IDBObjectStore): Promise<void> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor === null) { resolve(); return }
        store.delete(cursor.primaryKey)
        cursor.continue()
      }
      request.onerror = () => { reject(request.error ?? new Error('Telemetry cleanup failed')) }
    })
  }
}

export interface TelemetryReporter {
  readonly consent: boolean
  readonly lockedByGpc: boolean
  initialize(signal?: AbortSignal): Promise<TelemetryAvailability>
  setConsent(consent: boolean): boolean
  setConsentListener(listener: (consent: boolean) => void): void
  report(event: TelemetryEvent, value?: TelemetryDetector): void
  dispose(): Promise<void>
}

export class PrivacyTelemetry implements TelemetryReporter {
  private available = false
  private readonly lifetime = new AbortController()
  private consentOperation = new AbortController()
  private readonly inflight = new Map<string, Promise<void>>()
  private consentOverride: boolean | undefined
  private consentListener: (consent: boolean) => void = () => undefined
  private readonly storage: Storage | undefined
  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== CONSENT_KEY) return
    const consent = event.newValue === 'true' && this.available && !this.lockedByGpc
    this.consentOverride = consent
    if (consent) this.startConsentOperation()
    else this.cancelAndClear()
    this.consentListener(this.consent)
  }

  constructor(
    private readonly store: TelemetryStore = new IndexedDbTelemetryStore(),
    storage: Storage | undefined = safeLocalStorage(),
    private readonly internals: TelemetryInternals = {
      fetch: defaultFetch, now: Date.now, randomBytes, wait: defaultWait,
    },
  ) {
    this.storage = storage
    if (typeof window !== 'undefined') window.addEventListener('storage', this.onStorage)
  }

  get lockedByGpc(): boolean { return globalPrivacyControl() }

  get consent(): boolean {
    if (!this.available || this.lockedByGpc || this.storage === undefined) return false
    if (this.consentOverride !== undefined) return this.consentOverride
    try { return this.storage.getItem(CONSENT_KEY) === 'true' } catch { return false }
  }

  async initialize(signal?: AbortSignal): Promise<TelemetryAvailability> {
    if (this.lockedByGpc) {
      this.consentOverride = false
      this.cancelAndClear()
    }
    const combined = AbortSignal.any([
      this.lifetime.signal, ...(signal === undefined ? [] : [signal]), AbortSignal.timeout(2_000),
    ])
    try {
      const response = await this.internals.fetch(CONFIG_PATH, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal: combined,
      })
      const body: unknown = await response.json()
      this.available = response.ok && typeof body === 'object' && body !== null
        && !Array.isArray(body) && (body as { enabled?: unknown }).enabled === true
    } catch {
      this.available = false
    }
    if (this.lockedByGpc) {
      this.consentOverride = false
      this.cancelAndClear()
    }
    return this.available ? 'available' : 'unavailable'
  }

  setConsent(consent: boolean): boolean {
    const resolved = consent && !this.lockedByGpc && this.available
    this.consentOverride = resolved
    if (!resolved) {
      try { this.storage?.setItem(CONSENT_KEY, 'false') } catch {
        // The in-memory override still revokes consent for this page.
      }
      this.cancelAndClear()
      this.consentListener(false)
      return false
    }
    if (this.storage === undefined) {
      this.consentOverride = false
      this.cancelAndClear()
      this.consentListener(false)
      return false
    }
    try { this.storage.setItem(CONSENT_KEY, 'true') } catch {
      this.consentOverride = false
      this.cancelAndClear()
      this.consentListener(false)
      return false
    }
    this.startConsentOperation()
    this.consentListener(true)
    return true
  }

  setConsentListener(listener: (consent: boolean) => void): void {
    this.consentListener = listener
  }

  report(event: TelemetryEvent, value?: TelemetryDetector): void {
    const normalizedValue = event === 'detector_used' ? value : undefined
    if (!this.available || !this.consent || (event === 'detector_used' && normalizedValue === undefined)
      || (event !== 'detector_used' && normalizedValue !== undefined)) return
    const key = `${event}:${normalizedValue ?? ''}`
    if (this.inflight.has(key)) return
    const consentSignal = this.consentOperation.signal
    const task = this.deliver(event, normalizedValue, consentSignal).catch(() => undefined)
    this.inflight.set(key, task)
    void task.then(() => {
      if (this.inflight.get(key) === task) this.inflight.delete(key)
    })
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.consentOperation.abort()
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.onStorage)
    await Promise.allSettled(this.inflight.values())
    this.store.close()
  }

  private async deliver(
    event: TelemetryEvent,
    value: TelemetryDetector | undefined,
    consentSignal: AbortSignal,
  ): Promise<void> {
    while (!this.deliveryCancelled(consentSignal)) {
      const day = utcDay(this.internals.now())
      let claim: TelemetryClaim | undefined
      try { claim = await this.store.claim(day, event, value ?? '', this.internals.now()) } catch { return }
      if (claim === undefined) return
      if (this.deliveryCancelled(consentSignal)) return
      const body = JSON.stringify({
        schema_version: 1,
        event,
        daily_id: claim.dailyId,
        ...(value === undefined ? {} : { value }),
      })
      const signal = AbortSignal.any([
        this.lifetime.signal, consentSignal, AbortSignal.timeout(2_000),
      ])
      try {
        const response = await this.internals.fetch(EVENTS_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          keepalive: true,
          referrerPolicy: 'no-referrer',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
        })
        if (response.ok) {
          await this.store.markSent(day, event, value ?? '', claim.leaseId)
          return
        }
        if (!RETRYABLE_STATUS.has(response.status)) {
          await this.store.markTerminal(day, event, value ?? '', claim.leaseId)
          return
        }
      } catch {
        if (this.deliveryCancelled(consentSignal)) return
      }
      if (this.deliveryCancelled(consentSignal)) return
      const delay = Math.min(2_000, 250 * (2 ** (claim.attempts - 1)))
        * (0.75 + (this.internals.randomBytes(1)[0] ?? 0) / 255 * 0.5)
      try {
        await this.store.markFailed(day, event, value ?? '', claim.leaseId, this.internals.now() + delay)
        if (claim.attempts >= MAX_ATTEMPTS) return
        await this.internals.wait(delay, AbortSignal.any([this.lifetime.signal, consentSignal]))
      } catch { return }
    }
  }

  private cancelAndClear(): void {
    this.consentOperation.abort()
    void this.store.clear().catch(() => undefined)
  }

  private startConsentOperation(): void {
    if (this.consentOperation.signal.aborted) this.consentOperation = new AbortController()
  }

  private deliveryCancelled(consentSignal: AbortSignal): boolean {
    return this.lifetime.signal.aborted || consentSignal.aborted || !this.consent
  }
}
