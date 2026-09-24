// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbTelemetryStore, PrivacyTelemetry } from '../src/telemetry.ts'
import type {
  TelemetryClaim, TelemetryEvent, TelemetryStore,
} from '../src/telemetry.ts'

const CONSENT_KEY = 'zeroclave.privacy.telemetry-consent.v1'
const CONFIG_PATH = '/api/zeroclave-privacy/telemetry/config'
const EVENTS_PATH = '/api/zeroclave-privacy/telemetry/events'

interface Delivery {
  attempts: number
  leaseId: string
  leaseUntil: number
  sent: boolean
  terminal: boolean
}

class MemoryTelemetryStore implements TelemetryStore {
  readonly dailyIds = new Map<string, string>()
  readonly deliveries = new Map<string, Delivery>()
  clearCount = 0
  closeCount = 0
  beforeClaim: (() => Promise<void>) | undefined

  async claim(
    day: string, event: TelemetryEvent, value: string, now: number,
  ): Promise<TelemetryClaim | undefined> {
    await this.beforeClaim?.()
    const key = JSON.stringify([day, event, value])
    const existing = this.deliveries.get(key)
    if (existing?.sent === true || existing?.terminal === true || (existing?.attempts ?? 0) >= 3
      || (existing?.leaseUntil ?? 0) > now) return undefined
    let dailyId = this.dailyIds.get(day)
    if (dailyId === undefined) {
      dailyId = String.fromCharCode(65 + this.dailyIds.size).repeat(22)
      this.dailyIds.set(day, dailyId)
    }
    const attempts = (existing?.attempts ?? 0) + 1
    const leaseId = `lease-${String(attempts)}`
    this.deliveries.set(key, { attempts, leaseId, leaseUntil: now + 30_000, sent: false, terminal: false })
    return { dailyId, leaseId, attempts }
  }

  async markSent(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void> {
    this.update(day, event, value, leaseId, delivery => ({ ...delivery, sent: true, leaseUntil: 0 }))
  }

  async markFailed(
    day: string, event: TelemetryEvent, value: string, leaseId: string, retryAt: number,
  ): Promise<void> {
    this.update(day, event, value, leaseId, delivery => ({ ...delivery, leaseUntil: retryAt }))
  }

  async markTerminal(day: string, event: TelemetryEvent, value: string, leaseId: string): Promise<void> {
    this.update(day, event, value, leaseId, delivery => ({ ...delivery, terminal: true }))
  }

  async clear(): Promise<void> {
    this.clearCount += 1
    this.dailyIds.clear()
    this.deliveries.clear()
  }

  close(): void { this.closeCount += 1 }

  private update(
    day: string,
    event: TelemetryEvent,
    value: string,
    leaseId: string,
    transform: (delivery: Delivery) => Delivery,
  ): void {
    const key = JSON.stringify([day, event, value])
    const delivery = this.deliveries.get(key)
    if (delivery?.leaseId === leaseId) this.deliveries.set(key, transform(delivery))
  }
}

interface MutableClock { value: number }

const reporters: PrivacyTelemetry[] = []

function inputURL(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function enabledFetch(eventResponses: readonly number[] = [204]): ReturnType<typeof vi.fn<typeof fetch>> {
  let eventIndex = 0
  return vi.fn<typeof fetch>(async (input) => {
    const url = inputURL(input)
    if (url === CONFIG_PATH) return Response.json({ enabled: true })
    if (url !== EVENTS_PATH) throw new Error(`Unexpected URL: ${url}`)
    const status = eventResponses[Math.min(eventIndex, eventResponses.length - 1)] ?? 204
    eventIndex += 1
    return new Response(null, { status })
  })
}

function makeTelemetry(
  store: TelemetryStore,
  fetchImpl: typeof fetch,
  clock: MutableClock = { value: Date.UTC(2026, 8, 19, 12) },
): PrivacyTelemetry {
  const telemetry = new PrivacyTelemetry(store, window.localStorage, {
    fetch: fetchImpl,
    now: () => clock.value,
    randomBytes: length => new Uint8Array(length).fill(128),
    wait: async (milliseconds, signal) => {
      signal.throwIfAborted()
      clock.value += milliseconds
    },
  })
  reporters.push(telemetry)
  return telemetry
}

function eventCalls(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Parameters<typeof fetch>[] {
  return fetchMock.mock.calls.filter(call => inputURL(call[0]) === EVENTS_PATH)
}

function requestBody(call: Parameters<typeof fetch>): string {
  const body = call[1]?.body
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  throw new Error('Unexpected telemetry request body')
}

afterEach(async () => {
  await Promise.all(reporters.splice(0).map(async (reporter) => { await reporter.dispose() }))
  window.localStorage.clear()
  Reflect.deleteProperty(navigator, 'globalPrivacyControl')
})

describe('privacy-preserving telemetry reporter', () => {
  it('fails closed without leaving an unhandled rejection when IndexedDB is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
    try {
      const store = new IndexedDbTelemetryStore()
      await expect(store.claim('2026-09-19', 'privacy_active', '', Date.now())).rejects.toThrow(
        'IndexedDB is unavailable',
      )
      store.close()
      await Promise.resolve()
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'indexedDB')
      else Object.defineProperty(globalThis, 'indexedDB', descriptor)
    }
  })

  it('starts on by default when the Host advertises telemetry', async () => {
    const store = new MemoryTelemetryStore()
    const fetchMock = enabledFetch()
    const telemetry = makeTelemetry(store, fetchMock)

    await expect(telemetry.initialize()).resolves.toBe('available')
    expect(telemetry.consent).toBe(true)
    expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull()

    telemetry.report('privacy_active')
    await vi.waitFor(() => { expect(eventCalls(fetchMock)).toHaveLength(1) })

    expect(store.dailyIds.size).toBe(1)
  })

  it('sends Plausible events directly from the browser when the Host advertises the direct destination', async () => {
    const store = new MemoryTelemetryStore()
    const directEndpoint = 'https://plausible.io/api/event'
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = inputURL(input)
      if (url === CONFIG_PATH) return Response.json({
        enabled: true, provider: 'plausible', endpoint: directEndpoint, site: 'zeroclave-dsh-privacy',
      })
      if (url === directEndpoint) return new Response(null, { status: 202 })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const telemetry = makeTelemetry(store, fetchMock)

    await expect(telemetry.initialize()).resolves.toBe('available')
    telemetry.report('detector_used', 'regex')
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(call => inputURL(call[0]) === directEndpoint)).toHaveLength(1)
    })

    const call = fetchMock.mock.calls.find(item => inputURL(item[0]) === directEndpoint)
    if (call === undefined) throw new Error('Direct Plausible request missing')
    expect(JSON.parse(requestBody(call))).toEqual({
      domain: 'zeroclave-dsh-privacy', name: 'detector_used_regex', url: 'app://zeroclave-dsh-privacy/',
    })
    expect(call[1]?.mode).toBe('cors')
    expect(call[1]?.credentials).toBe('omit')
  })

  it('preserves an explicit opt-out across initialization', async () => {
    window.localStorage.setItem(CONSENT_KEY, 'false')
    const store = new MemoryTelemetryStore()
    const fetchMock = enabledFetch()
    const telemetry = makeTelemetry(store, fetchMock)

    await expect(telemetry.initialize()).resolves.toBe('available')
    expect(telemetry.consent).toBe(false)
    telemetry.report('privacy_active')
    await Promise.resolve()

    expect(eventCalls(fetchMock)).toHaveLength(0)
    expect(store.dailyIds.size).toBe(0)
  })

  it('treats Global Privacy Control as an overriding opt-out', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true })
    const store = new MemoryTelemetryStore()
    const fetchMock = enabledFetch()
    const telemetry = makeTelemetry(store, fetchMock)

    await expect(telemetry.initialize()).resolves.toBe('available')

    expect(telemetry.lockedByGpc).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(CONFIG_PATH, expect.objectContaining({ method: 'GET' }))
    expect(telemetry.setConsent(true)).toBe(false)
    telemetry.report('privacy_active')
    await vi.waitFor(() => { expect(store.clearCount).toBeGreaterThan(0) })
    expect(eventCalls(fetchMock)).toHaveLength(0)
  })

  it('uses one rotating daily id and sends each event/value at most once per UTC day', async () => {
    const store = new MemoryTelemetryStore()
    const clock = { value: Date.UTC(2026, 8, 19, 23, 59) }
    const fetchMock = enabledFetch()
    const telemetry = makeTelemetry(store, fetchMock, clock)
    await telemetry.initialize()
    expect(telemetry.setConsent(true)).toBe(true)

    telemetry.report('privacy_active')
    await vi.waitFor(() => { expect(eventCalls(fetchMock)).toHaveLength(1) })
    telemetry.report('privacy_active')
    telemetry.report('detector_used', 'regex')
    await vi.waitFor(() => { expect(eventCalls(fetchMock)).toHaveLength(2) })

    const firstDayBodies = eventCalls(fetchMock).map(call => JSON.parse(requestBody(call)) as {
      daily_id: string
      event: string
    })
    expect(new Set(firstDayBodies.map(body => body.daily_id)).size).toBe(1)
    expect(firstDayBodies.map(body => body.event).sort()).toEqual(['detector_used', 'privacy_active'])

    clock.value = Date.UTC(2026, 8, 20, 0, 1)
    telemetry.report('privacy_active')
    await vi.waitFor(() => { expect(eventCalls(fetchMock)).toHaveLength(3) })
    const nextDayCall = eventCalls(fetchMock)[2]
    if (nextDayCall === undefined) throw new Error('Expected a next-day telemetry request')
    const nextDayBody = JSON.parse(requestBody(nextDayCall)) as { daily_id: string }
    expect(nextDayBody.daily_id).not.toBe(firstDayBodies[0]?.daily_id)
    expect([...store.dailyIds.keys()]).toEqual(['2026-09-19', '2026-09-20'])
  })

  it('never fetches after consent is withdrawn while a claim is delayed', async () => {
    let releaseClaim: (() => void) | undefined
    let claimStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { claimStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseClaim = resolve })
    const store = new MemoryTelemetryStore()
    store.beforeClaim = async () => { claimStarted?.(); await blocked }
    const fetchMock = enabledFetch()
    const telemetry = makeTelemetry(store, fetchMock)
    await telemetry.initialize()
    telemetry.setConsent(true)

    telemetry.report('privacy_active')
    await started
    expect(telemetry.setConsent(false)).toBe(false)
    releaseClaim?.()
    await telemetry.dispose()

    expect(telemetry.consent).toBe(false)
    expect(eventCalls(fetchMock)).toHaveLength(0)
    expect(store.clearCount).toBeGreaterThan(0)
  })

  it('retries transient failures up to three total attempts and then stops', async () => {
    const store = new MemoryTelemetryStore()
    const fetchMock = enabledFetch([503])
    const telemetry = makeTelemetry(store, fetchMock)
    await telemetry.initialize()
    telemetry.setConsent(true)

    telemetry.report('privacy_active')
    await vi.waitFor(() => { expect(eventCalls(fetchMock)).toHaveLength(3) })
    telemetry.report('privacy_active')
    await Promise.resolve()

    expect(eventCalls(fetchMock)).toHaveLength(3)
    expect([...store.deliveries.values()][0]?.attempts).toBe(3)
  })

  it('marks a retry successful and deduplicates later reports', async () => {
    const store = new MemoryTelemetryStore()
    const fetchMock = enabledFetch([503, 204])
    const telemetry = makeTelemetry(store, fetchMock)
    await telemetry.initialize()
    telemetry.setConsent(true)

    telemetry.report('detector_used', 'zeroclave')
    await vi.waitFor(() => {
      expect(eventCalls(fetchMock)).toHaveLength(2)
      expect([...store.deliveries.values()][0]?.sent).toBe(true)
    })
    telemetry.report('detector_used', 'zeroclave')
    await Promise.resolve()

    expect(eventCalls(fetchMock)).toHaveLength(2)
    expect([...store.deliveries.values()][0]).toMatchObject({ attempts: 2, sent: true })
  })
})
