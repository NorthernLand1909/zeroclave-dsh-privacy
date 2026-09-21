import { describe, expect, it, vi } from 'vitest'
import { ZeroClaveDetectError, ZeroClaveDetector } from '../src/zeroclave-detector.ts'

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type WaitImplementation = (milliseconds: number, signal: AbortSignal) => Promise<void>

const ENDPOINT = 'https://example.test/v1/pii/detect'

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  throw new Error('Unexpected test request body')
}

function input(id = 'doc-1', revision = 'edit-1', text = 'Alice') {
  return { id, revision, text, regex: [] }
}

function requestId(init?: RequestInit): string {
  const value = new Headers(init?.headers).get('x-request-id')
  if (value === null) throw new Error('test request did not contain X-Request-ID')
  return value
}

function jsonResponse(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers })
}

function successResponse(
  init: RequestInit | undefined,
  results: readonly unknown[],
  modelVersion = 'model-test-1',
): Response {
  const id = requestId(init)
  return jsonResponse({
    request_id: id,
    model_version: modelVersion,
    results,
  }, 200, { 'x-request-id': id })
}

function result(
  id = 'doc-1',
  revision = 'edit-1',
  status: 'complete' | 'partial' = 'complete',
  entities: readonly unknown[] = [],
) {
  return { id, revision, status, entities }
}

function createDetector(
  fetchImplementation: FetchImplementation,
  options: {
    retries?: number
    wait?: WaitImplementation
    random?: () => number
  } = {},
): ZeroClaveDetector {
  return new ZeroClaveDetector(ENDPOINT, 1_000, options.retries ?? 2, {
    fetch: fetchImplementation,
    wait: options.wait ?? (() => Promise.resolve()),
    random: options.random ?? (() => 0),
  })
}

describe('ZeroClave anonymous detector contract', () => {
  it('invokes fetch without rebinding its receiver', async () => {
    const receivers: unknown[] = []
    const fetchImplementation: FetchImplementation = async function (this: unknown, _url, init) {
      receivers.push(this)
      return successResponse(init, [result()])
    }
    const detector = createDetector(fetchImplementation)

    await expect(detector.scanBatch([input()])).resolves.toHaveLength(1)
    expect(receivers).toEqual([undefined])
  })

  it('accepts a complete empty result without treating it as a transport fallback', async () => {
    const fetchMock = vi.fn<FetchImplementation>(async (_url, init) => (
      successResponse(init, [result()])
    ))
    const detector = createDetector(fetchMock)

    const scan = await detector.scanBatch([input()])

    expect(scan).toHaveLength(1)
    expect(scan[0]).toMatchObject({
      overallRisk: 'none',
      recommendedAction: 'allow',
      redactedText: 'Alice',
      findings: [],
      detector: {
        requested: 'zeroclave',
        used: 'zeroclave',
        fallback: false,
        model: 'model-test-1',
        status: 'complete',
      },
    })
    expect(scan[0]?.detector.requestId).toMatch(/^dsh-/u)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('retains partial status and any entities returned with the incomplete result', async () => {
    const detector = createDetector(async (_url, init) => successResponse(init, [
      result('doc-1', 'edit-1', 'partial', [{ start: 0, end: 5, type: 'NAME' }]),
    ]))

    const [scan] = await detector.scanBatch([input()])

    expect(scan?.detector.status).toBe('partial')
    expect(scan?.findings).toEqual([
      expect.objectContaining({ entityType: 'PERSON', sourceType: 'NAME', start: 0, end: 5 }),
    ])
    expect(scan?.redactedText).toBe('__PII_PERSON_00000001__')
  })

  it('retains a partial empty result instead of converting it to complete or safe', async () => {
    const detector = createDetector(async (_url, init) => successResponse(init, [
      result('doc-1', 'edit-1', 'partial'),
    ]))

    const [scan] = await detector.scanBatch([input()])

    expect(scan?.findings).toEqual([])
    expect(scan?.detector.status).toBe('partial')
    expect(scan?.recommendedAction).toBe('block')
  })

  it('converts Unicode codepoint offsets to JavaScript UTF-16 offsets after an emoji', async () => {
    const detector = createDetector(async (_url, init) => successResponse(init, [
      result('doc-1', 'edit-1', 'complete', [{ start: 1, end: 6, type: 'NAME' }]),
    ]))

    const [scan] = await detector.scanBatch([input('doc-1', 'edit-1', '😀Alice')])

    expect(scan?.findings).toEqual([
      expect.objectContaining({ start: 2, end: 7, sourceType: 'NAME' }),
    ])
    expect(scan?.redactedText).toBe('😀__PII_PERSON_00000001__')
  })

  it('uses the original unnormalized codepoints when combining marks are present', async () => {
    const text = '😀e\u0301Alice'
    const detector = createDetector(async (_url, init) => successResponse(init, [
      result('doc-1', 'edit-1', 'complete', [{ start: 3, end: 8, type: 'NAME' }]),
    ]))

    const [scan] = await detector.scanBatch([input('doc-1', 'edit-1', text)])

    expect(text.slice(scan?.findings[0]?.start, scan?.findings[0]?.end)).toBe('Alice')
    expect(scan?.findings[0]).toMatchObject({ start: 4, end: 9 })
    expect(scan?.redactedText).toBe('😀e\u0301__PII_PERSON_00000001__')
  })

  it('keeps an unknown uppercase entity type and applies generic sensitive-data semantics', async () => {
    const detector = createDetector(async (_url, init) => successResponse(init, [
      result('doc-1', 'edit-1', 'complete', [{ start: 0, end: 5, type: 'NEW_PROFILE_LABEL' }]),
    ]))

    const [scan] = await detector.scanBatch([input()])

    expect(scan?.findings).toEqual([
      expect.objectContaining({
        entityType: 'OTHER',
        sourceType: 'NEW_PROFILE_LABEL',
        category: 'DIRECT_PII',
        severity: 'medium',
        maskedEvidence: '[REDACTED_NEW_PROFILE_LABEL:5]',
      }),
    ])
  })

  it.each([
    ['negative start', { start: -1, end: 2, type: 'NAME' }],
    ['empty interval', { start: 2, end: 2, type: 'NAME' }],
    ['end beyond the original', { start: 0, end: 6, type: 'NAME' }],
    ['fractional offset', { start: 0.5, end: 2, type: 'NAME' }],
  ])('rejects an entity with %s', async (_name, entity) => {
    const detector = createDetector(async (_url, init) => successResponse(init, [
      result('doc-1', 'edit-1', 'complete', [entity]),
    ]))

    await expect(detector.scanBatch([input()])).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code: 'detector_response_invalid',
    })
  })

  it.each([
    ['stale revision', [result('doc-1', 'edit-0')]],
    ['missing revision', [{ id: 'doc-1', status: 'complete', entities: [] }]],
    ['missing result', []],
    ['unknown result id', [result('doc-other')]],
    ['duplicate result ids', [result('doc-1', 'edit-1'), result('doc-1', 'edit-1')]],
  ])('rejects correlation failure: %s', async (_name, results) => {
    const inputs = _name === 'duplicate result ids'
      ? [input('doc-1', 'edit-1'), input('doc-2', 'edit-2')]
      : [input()]
    const detector = createDetector(async (_url, init) => successResponse(init, results))

    await expect(detector.scanBatch(inputs)).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code: 'detector_response_invalid',
    })
  })

  it('accepts unordered results but returns scans in the original input order', async () => {
    const detector = createDetector(async (_url, init) => successResponse(init, [
      result('doc-b', 'rev-b', 'complete', [{ start: 0, end: 3, type: 'NAME' }]),
      result('doc-a', 'rev-a', 'complete', [{ start: 0, end: 5, type: 'NAME' }]),
    ]))

    const scans = await detector.scanBatch([
      input('doc-a', 'rev-a', 'Alice'),
      input('doc-b', 'rev-b', 'Bob'),
    ])

    expect(scans.map(scan => scan.redactedText)).toEqual([
      '__PII_PERSON_00000001__',
      '__PII_PERSON_00000001__',
    ])
    expect(scans.map(scan => scan.findings[0]?.end)).toEqual([5, 3])
  })

  it.each([
    ['zero texts', [], 'invalid_request'],
    ['65 texts', Array.from({ length: 65 }, (_, index) => input(`doc-${String(index)}`)), 'too_many_texts'],
    ['100001 codepoints', [input('doc-large', 'rev-large', 'a'.repeat(100_001))], 'request_too_large'],
  ])('rejects request limit violation: %s', async (_name, inputs, code) => {
    const fetchMock = vi.fn<FetchImplementation>()
    const detector = createDetector(fetchMock)

    await expect(detector.scanBatch(inputs)).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['isolated high surrogate', input('doc-1', 'edit-1', '\uD800')],
    ['isolated low surrogate', input('doc-1', 'edit-1', '\uDC00')],
    ['invalid id', input('contains whitespace', 'edit-1')],
    ['invalid revision', input('doc-1', 'contains whitespace')],
  ])('rejects invalid client input: %s', async (_name, invalidInput) => {
    const fetchMock = vi.fn<FetchImplementation>()
    const detector = createDetector(fetchMock)

    await expect(detector.scanBatch([invalidInput])).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code: 'invalid_request',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate request ids before contacting the Gateway', async () => {
    const fetchMock = vi.fn<FetchImplementation>()
    const detector = createDetector(fetchMock)

    await expect(detector.scanBatch([
      input('doc-1', 'edit-1'),
      input('doc-1', 'edit-2'),
    ])).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only the public text fields and reuses one request id across a 429 retry', async () => {
    const waits: number[] = []
    const requestIds: string[] = []
    const fetchMock = vi.fn<FetchImplementation>(async (_url, init) => {
      requestIds.push(requestId(init))
      if (requestIds.length === 1) {
        return jsonResponse({
          request_id: requestIds[0],
          error: { code: 'rate_limit_exceeded', message: 'wait' },
        }, 429, { 'retry-after': '1.5' })
      }
      return successResponse(init, [result()])
    })
    const detector = createDetector(fetchMock, {
      wait: (milliseconds) => { waits.push(milliseconds); return Promise.resolve() },
    })

    await detector.scanBatch([input()])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(waits).toEqual([1_500])
    expect(requestIds[0]).toBe(requestIds[1])
    const init = fetchMock.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(JSON.parse(bodyText(init?.body))).toEqual({
      texts: [{ id: 'doc-1', revision: 'edit-1', text: 'Alice' }],
    })
  })

  it.each([503, 504])('retries HTTP %i once and then accepts a complete response', async (status) => {
    let calls = 0
    const wait = vi.fn<WaitImplementation>(() => Promise.resolve())
    const detector = createDetector(async (_url, init) => {
      calls += 1
      if (calls === 1) {
        return jsonResponse({
          request_id: requestId(init),
          error: { code: status === 503 ? 'detector_unavailable' : 'detector_timeout', message: 'retry' },
        }, status)
      }
      return successResponse(init, [result()])
    }, { retries: 1, wait, random: () => 0 })

    await expect(detector.scanBatch([input()])).resolves.toHaveLength(1)
    expect(calls).toBe(2)
    expect(wait).toHaveBeenCalledOnce()
    expect(wait.mock.calls[0]?.[0]).toBe(187.5)
  })

  it('does not retry a non-retryable structured error and preserves its code and request id', async () => {
    const wait = vi.fn<WaitImplementation>(() => Promise.resolve())
    const detector = createDetector(async (_url, init) => jsonResponse({
      request_id: requestId(init),
      error: { code: 'invalid_request', message: 'bad text id' },
    }, 422), { wait })

    const failure: unknown = await detector.scanBatch([input()]).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ZeroClaveDetectError)
    if (!(failure instanceof ZeroClaveDetectError)) throw new Error('Expected ZeroClaveDetectError')
    expect(failure).toMatchObject({
      code: 'invalid_request', message: 'bad text id', status: 422,
    })
    expect(failure.requestId).toMatch(/^dsh-/u)
    expect(wait).not.toHaveBeenCalled()
  })

  it('rejects a structured error carrying the wrong request id', async () => {
    const detector = createDetector(async () => jsonResponse({
      request_id: 'different-request',
      error: { code: 'invalid_request', message: 'bad request' },
    }, 422, { 'x-request-id': 'different-request' }))

    await expect(detector.scanBatch([input()])).rejects.toMatchObject({
      code: 'detector_response_invalid', status: 502,
    })
  })

  it('reports a non-JSON response without interpreting it as an empty successful scan', async () => {
    const detector = createDetector(async () => new Response('<h1>upstream failed</h1>', {
      status: 500,
      headers: { 'content-type': 'text/html' },
    }))

    await expect(detector.scanBatch([input()])).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code: 'invalid_response',
      status: 500,
    })
  })

  it.each([
    ['missing model version', (id: string) => ({ request_id: id, results: [result()] })],
    ['invalid result status', (id: string) => ({
      request_id: id, model_version: 'm1', results: [{ ...result(), status: 'safe' }],
    })],
    ['invalid entity type label', (id: string) => ({
      request_id: id, model_version: 'm1',
      results: [result('doc-1', 'edit-1', 'complete', [{ start: 0, end: 5, type: 'name' }])],
    })],
    ['mismatched request id', () => ({
      request_id: 'different-request', model_version: 'm1', results: [result()],
    })],
  ])('rejects malformed HTTP 200 response: %s', async (_name, body) => {
    const detector = createDetector(async (_url, init) => jsonResponse(body(requestId(init))))

    await expect(detector.scanBatch([input()])).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code: 'detector_response_invalid',
    })
  })

  it('rejects disagreement between the response body and X-Request-ID header', async () => {
    const detector = createDetector(async (_url, init) => jsonResponse({
      request_id: requestId(init),
      model_version: 'm1',
      results: [result()],
    }, 200, { 'x-request-id': 'different-request' }))

    await expect(detector.scanBatch([input()])).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code: 'detector_response_invalid',
    })
  })

  it('rejects an oversized response before parsing it', async () => {
    const detector = createDetector(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '1048577' },
    }))

    await expect(detector.scanBatch([input()])).rejects.toMatchObject({
      name: 'ZeroClaveDetectError',
      code: 'detector_response_invalid',
    })
  })

  it('stops retrying when the caller cancels during backoff', async () => {
    const controller = new AbortController()
    let enteredBackoff: (() => void) | undefined
    const backoffStarted = new Promise<void>((resolve) => { enteredBackoff = resolve })
    const fetchMock = vi.fn<FetchImplementation>(async (_url, init) => jsonResponse({
      request_id: requestId(init),
      error: { code: 'rate_limit_exceeded', message: 'wait' },
    }, 429))
    const detector = createDetector(fetchMock, {
      wait: (_milliseconds, signal) => new Promise((_resolve, reject) => {
        enteredBackoff?.()
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      }),
    })

    const scanning = detector.scanBatch([input()], controller.signal)
    await backoffStarted
    controller.abort()

    await expect(scanning).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('uses the typed detector error for retry exhaustion', async () => {
    const detector = createDetector(async (_url, init) => jsonResponse({
      request_id: requestId(init),
      error: { code: 'detector_timeout', message: 'still busy' },
    }, 504), { retries: 1 })

    const failure = await detector.scanBatch([input()]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ZeroClaveDetectError)
    expect(failure).toMatchObject({ code: 'detector_timeout', status: 504, message: 'still busy' })
  })
})
