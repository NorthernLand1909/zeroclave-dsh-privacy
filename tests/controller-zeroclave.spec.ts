// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import type { TelemetryReporter } from '../src/telemetry.ts'
import { PrivacyVault } from '../src/vault.ts'
import { ZeroClaveDetector } from '../src/zeroclave-detector.ts'
import { memoryStore } from './memory-store.ts'

interface DetectText { id: string; revision: string; text: string }

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  throw new Error('Unexpected test request body')
}

function request(init: RequestInit | undefined): { requestId: string; texts: DetectText[] } {
  const requestId = new Headers(init?.headers).get('x-request-id')
  if (requestId === null) throw new Error('Missing test request ID')
  return { requestId, texts: (JSON.parse(bodyText(init?.body)) as { texts: DetectText[] }).texts }
}

function response(
  init: RequestInit | undefined,
  statuses: readonly ('complete' | 'partial')[],
  entities: readonly (readonly { start: number; end: number; type: string }[])[] = [],
): Response {
  const parsed = request(init)
  return Response.json({
    request_id: parsed.requestId,
    model_version: 'controller-test-model',
    results: [...parsed.texts].reverse().map((text, reverseIndex) => {
      const originalIndex = parsed.texts.length - reverseIndex - 1
      return {
        id: text.id,
        revision: text.revision,
        status: statuses[originalIndex] ?? 'complete',
        entities: entities[originalIndex] ?? [],
      }
    }),
  })
}

function remote(fetchImpl: typeof fetch, retries = 0): ZeroClaveDetector {
  return new ZeroClaveDetector('https://example.test/v1/pii/detect', 1000, retries, {
    fetch: fetchImpl,
    wait: () => Promise.resolve(),
    random: () => 0,
  })
}

function telemetryReporter(report: TelemetryReporter['report']): TelemetryReporter {
  return {
    consent: true,
    lockedByGpc: false,
    initialize: async () => 'available',
    setConsent: consent => consent,
    setConsentListener: () => undefined,
    report,
    dispose: async () => undefined,
  }
}

afterEach(() => { localStorage.clear() })

describe('ZeroClave controller integration', () => {
  it('tests the connection with fixed synthetic text instead of the current draft', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => response(init, ['complete']))
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()), async () => [], remote(fetchMock),
    )

    await controller.testZeroClave()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(request(fetchMock.mock.calls[0]?.[1]).texts.map(item => item.text)).toEqual([
      'ZeroClave synthetic connection test: demo@example.com',
    ])
    expect(controller.getSnapshot().detectorStates.zeroclave.status).toBe('ready')
  })

  it('uses one correlated Gateway batch and restores the input order', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => response(
      init,
      ['complete', 'complete'],
      [[{ start: 0, end: 5, type: 'NAME' }], [{ start: 0, end: 3, type: 'NAME' }]],
    ))
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()), async () => [], remote(fetchMock),
    )
    controller.setEnabled(true)
    controller.setDetectorMode('zeroclave')

    const scans = await controller.prepareSendBatch('session-1', ['Alice', 'Bob'])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(request(fetchMock.mock.calls[0]?.[1]).texts.map(item => item.text)).toEqual(['Alice', 'Bob'])
    expect(scans.map(scan => controller.vault.restore('session-1', scan.redactedText))).toEqual(['Alice', 'Bob'])
    expect(scans.map(scan => scan.detector.status)).toEqual(['complete', 'complete'])
    expect(controller.getSnapshot().detectorStates.zeroclave.status).toBe('ready')
  })

  it('shows a partial preview but blocks sending before the vault is written', async () => {
    const store = memoryStore()
    const write = vi.fn(async (mappings: Parameters<typeof store.write>[0]) => store.write(mappings))
    const controller = new PrivacyController(
      new PrivacyVault({ ...store, write }),
      async () => [],
      remote(async (_url, init) => response(init, ['partial'], [[{ start: 0, end: 5, type: 'NAME' }]])),
    )
    controller.setEnabled(true)
    controller.setDetectorMode('zeroclave')

    await controller.inspect('session-1', 'Alice')
    expect(controller.getSnapshot().liveBySession.get('session-1')?.result).toMatchObject({
      detector: { status: 'partial' },
      findings: [expect.objectContaining({ sourceType: 'NAME' })],
    })
    await expect(controller.prepareSend('session-1', 'Alice')).rejects.toMatchObject({ code: 'partial_result' })
    expect(write).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      open: true,
      activeTab: 'model',
      detectorStates: { zeroclave: { status: 'partial' } },
    })
  })

  it('counts a direct partial scan as activity before blocking the send', async () => {
    const report = vi.fn()
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()),
      async () => [],
      remote(async (_url, init) => response(init, ['partial'])),
      telemetryReporter(report),
    )
    controller.setEnabled(true)
    controller.setDetectorMode('zeroclave')

    await expect(controller.prepareSend('session-1', 'Alice')).rejects.toMatchObject({
      code: 'partial_result',
    })
    expect(report.mock.calls).toEqual([
      ['privacy_active', undefined],
      ['detector_used', 'zeroclave'],
    ])
  })

  it('fails closed on a Gateway error and does not create a mapping', async () => {
    const store = memoryStore()
    const write = vi.fn(async (mappings: Parameters<typeof store.write>[0]) => store.write(mappings))
    const detector = remote(async (_url, init) => {
      const { requestId } = request(init)
      return Response.json({
        request_id: requestId,
        error: { code: 'detector_unavailable', message: 'Detection service is unavailable' },
      }, { status: 503 })
    })
    const controller = new PrivacyController(new PrivacyVault({ ...store, write }), async () => [], detector)
    controller.setEnabled(true)
    controller.setDetectorMode('zeroclave')

    await expect(controller.prepareSend('session-1', 'Alice')).rejects.toMatchObject({
      code: 'detector_unavailable', status: 503,
    })
    expect(write).not.toHaveBeenCalled()
    const state = controller.getSnapshot().detectorStates.zeroclave
    expect(state).toMatchObject({ status: 'error', code: 'detector_unavailable', statusCode: 503 })
    expect(state.requestId).toMatch(/^dsh-/u)
  })

  it('discards a late response after the draft revision changes', async () => {
    let releaseFirst: ((value: Response) => void) | undefined
    let firstInit: RequestInit | undefined
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve })
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const parsed = request(init)
      if (parsed.texts[0]?.text === 'Alice') {
        firstInit = init
        return firstResponse
      }
      return response(init, ['complete'], [[{ start: 0, end: 3, type: 'NAME' }]])
    })
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()), async () => [], remote(fetchMock),
    )
    controller.setEnabled(true)
    controller.setDetectorMode('zeroclave')

    const older = controller.inspect('session-1', 'Alice')
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    const newer = controller.inspect('session-1', 'Bob')
    await newer
    if (firstInit === undefined) throw new Error('First request was not captured')
    releaseFirst?.(response(firstInit, ['complete'], [[{ start: 0, end: 5, type: 'NAME' }]]))
    await older

    const live = controller.getSnapshot().liveBySession.get('session-1')
    expect(live?.text).toBe('Bob')
    expect(live?.result.redactedText).toBe('__PII_PERSON_00000001__')
  })

  it('returns a cancelled loading state to idle when the detector mode changes', async () => {
    const detector = remote(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    }))
    const controller = new PrivacyController(new PrivacyVault(memoryStore()), async () => [], detector)
    controller.setEnabled(true)
    controller.setDetectorMode('zeroclave')

    const checking = controller.inspect('session-1', 'Alice')
    await vi.waitFor(() => {
      expect(controller.getSnapshot().detectorStates.zeroclave.status).toBe('loading')
    })
    controller.setDetectorMode('regex')
    await checking

    expect(controller.getSnapshot().detectorStates.zeroclave.status).toBe('idle')
  })
})
