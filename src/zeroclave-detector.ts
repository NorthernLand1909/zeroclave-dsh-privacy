import { finalizeScan, type FindingCandidate } from './detector.ts'
import type {
  DetectorProvider, EntityType, FindingCategory, RiskLevel, ScanResult,
} from './types.ts'

export const ZEROCLAVE_PROXY_PATH = '/api/zeroclave-privacy/detect'

const MAX_TEXTS = 64
const MAX_CODEPOINTS = 100_000
const MAX_RESPONSE_BYTES = 1_048_576
const MAX_TOTAL_MS = 35_000
const RETRYABLE_STATUS = new Set([429, 503, 504])
const CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u
const REQUEST_ID = /^[A-Za-z0-9_.-]{1,64}$/u
const ENTITY_TYPE = /^[A-Z][A-Z0-9_]*$/u

function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export interface ZeroClaveDetectInput {
  id: string
  revision: string
  text: string
  regex: readonly FindingCandidate[]
}

interface PublicEntity { start: number; end: number; type: string }
interface PublicResult {
  id: string
  revision?: string
  status: 'complete' | 'partial'
  entities: PublicEntity[]
}
interface PublicResponse {
  request_id: string
  model_version: string
  results: PublicResult[]
}

interface ErrorResponse {
  request_id?: string
  error: { code: string; message: string }
}

export class ZeroClaveDetectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ZeroClaveDetectError'
  }
}

export interface ZeroClaveDetectorInternals {
  fetch: typeof fetch
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  random: () => number
  now?: () => number
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    const finish = (): void => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    const cancel = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(abortError())
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

function normalizeEndpoint(value: string): string {
  if (value === ZEROCLAVE_PROXY_PATH) return value
  let url: URL
  try { url = new URL(value) } catch {
    throw new ZeroClaveDetectError('invalid_endpoint', 'Enter a valid ZeroClave endpoint URL')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || value.length > 2048) {
    throw new ZeroClaveDetectError('invalid_endpoint', 'Use an HTTPS URL without credentials, query, or fragment')
  }
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = path.endsWith('/v1/pii/detect')
    ? path
    : path.endsWith('/v1') ? `${path}/pii/detect` : `${path}/v1/pii/detect`
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntity(value: unknown): PublicEntity {
  if (!isRecord(value) || typeof value.start !== 'number' || !Number.isInteger(value.start)
    || typeof value.end !== 'number' || !Number.isInteger(value.end)
    || typeof value.type !== 'string' || !ENTITY_TYPE.test(value.type)) {
    throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave returned an invalid entity')
  }
  return { start: value.start, end: value.end, type: value.type }
}

function parseResult(value: unknown): PublicResult {
  if (!isRecord(value) || typeof value.id !== 'string'
    || (value.revision !== undefined && typeof value.revision !== 'string')
    || (value.status !== 'complete' && value.status !== 'partial') || !Array.isArray(value.entities)) {
    throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave returned an invalid result')
  }
  return {
    id: value.id,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    status: value.status,
    entities: value.entities.map(parseEntity),
  }
}

function parseResponse(value: unknown): PublicResponse {
  if (!isRecord(value) || typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id)
    || typeof value.model_version !== 'string'
    || !Array.isArray(value.results)) {
    throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave returned an invalid response')
  }
  return {
    request_id: value.request_id,
    model_version: value.model_version,
    results: value.results.map(parseResult),
  }
}

function parseErrorResponse(value: unknown, status: number, requestId: string): ErrorResponse {
  if (!isRecord(value) || !isRecord(value.error)
    || typeof value.error.code !== 'string' || typeof value.error.message !== 'string'
    || (value.request_id !== undefined
      && (typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id)))) {
    throw new ZeroClaveDetectError(
      'invalid_response', 'ZeroClave returned an invalid error response', status, requestId,
    )
  }
  return {
    ...(value.request_id === undefined ? {} : { request_id: value.request_id }),
    error: { code: value.error.code, message: value.error.message },
  }
}

function codepointBoundaries(text: string): number[] {
  const boundaries = [0]
  let codeUnit = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        throw new ZeroClaveDetectError('invalid_request', 'Text contains an isolated UTF-16 surrogate')
      }
      index += 1
      codeUnit += 2
    } else {
      if (unit >= 0xDC00 && unit <= 0xDFFF) {
        throw new ZeroClaveDetectError('invalid_request', 'Text contains an isolated UTF-16 surrogate')
      }
      codeUnit += 1
    }
    boundaries.push(codeUnit)
  }
  return boundaries
}

function validateInputs(inputs: readonly ZeroClaveDetectInput[]): Map<string, number[]> {
  if (inputs.length < 1) throw new ZeroClaveDetectError('invalid_request', 'At least one text is required')
  if (inputs.length > MAX_TEXTS) throw new ZeroClaveDetectError('too_many_texts', 'Send no more than 64 texts at once')
  const seen = new Set<string>()
  const boundaries = new Map<string, number[]>()
  let total = 0
  for (const input of inputs) {
    if (!CORRELATION_ID.test(input.id) || !CORRELATION_ID.test(input.revision) || seen.has(input.id)) {
      throw new ZeroClaveDetectError('invalid_request', 'Text IDs and revisions must be valid and unique')
    }
    seen.add(input.id)
    const itemBoundaries = codepointBoundaries(input.text)
    total += itemBoundaries.length - 1
    boundaries.set(input.id, itemBoundaries)
  }
  if (total > MAX_CODEPOINTS) {
    throw new ZeroClaveDetectError('request_too_large', 'Reduce the total text size to 100,000 codepoints')
  }
  return boundaries
}

function entityType(type: string): EntityType {
  const mapped: Readonly<Record<string, EntityType>> = {
    AGE: 'AGE', DATETIME: 'DATE_TIME', DATE_TIME: 'DATE_TIME', FINANCE: 'FINANCIAL',
    LOCATION: 'ADDRESS', NAME: 'PERSON', PERSON: 'PERSON', ORGANIZATION: 'ORGANIZATION',
    EMAIL: 'EMAIL', PHONE: 'PHONE',
  }
  return mapped[type] ?? 'OTHER'
}

function category(type: string): FindingCategory {
  if (type === 'FINANCE') return 'FINANCIAL'
  if (type === 'ORGANIZATION' || type === 'OCCUPATION' || type === 'EDUCATION' || type === 'CODE') return 'BUSINESS'
  return 'DIRECT_PII'
}

function severity(type: string): Exclude<RiskLevel, 'none'> {
  if (type === 'BELIEF' || type === 'HEALTH' || type === 'SEXUAL_ORIENTATION') return 'critical'
  if (type === 'NAME' || type === 'PERSON' || type === 'EMAIL' || type === 'PHONE'
    || type === 'LOCATION' || type === 'FINANCE' || type === 'DEMOGRAPHIC') return 'high'
  return 'medium'
}

function entityCandidates(
  entities: readonly PublicEntity[], boundaries: readonly number[],
): FindingCandidate[] {
  return entities.map((entity) => {
    const start = boundaries[entity.start]
    const end = boundaries[entity.end]
    if (start === undefined || end === undefined || entity.start < 0 || entity.end <= entity.start) {
      throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave returned an invalid entity range')
    }
    return {
      start,
      end,
      category: category(entity.type),
      entityType: entityType(entity.type),
      maskedEvidence: `[REDACTED_${entity.type}:${String(entity.end - entity.start)}]`,
      severity: severity(entity.type),
      detector: 'zeroclave' as const,
      sourceType: entity.type,
    }
  })
}

function retryAfter(response: Response, attempt: number, random: () => number, now: () => number): number {
  const header = response.headers.get('retry-after')
  if (header !== null) {
    const seconds = Number(header)
    const base = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Math.max(0, Date.parse(header) - now())
    if (Number.isFinite(base)) return base + random() * 100
  }
  const base = Math.min(2000, 250 * (2 ** attempt))
  return base * (0.75 + random() * 0.5)
}

async function responseJSON(response: Response, requestId: string): Promise<unknown> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new ZeroClaveDetectError(
      'detector_response_invalid', 'ZeroClave response is too large', response.status, requestId,
    )
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new ZeroClaveDetectError(
      'detector_response_invalid', 'ZeroClave response is too large', response.status, requestId,
    )
  }
  try { return JSON.parse(text) as unknown } catch {
    throw new ZeroClaveDetectError(
      'invalid_response', 'ZeroClave returned a non-JSON response', response.status, requestId,
    )
  }
}

export class ZeroClaveDetector implements DetectorProvider {
  readonly id = 'zeroclave' as const
  readonly label = 'ZeroClave API'
  readonly locality = 'remote' as const
  private endpoint: string
  private readonly internals: Required<ZeroClaveDetectorInternals>

  constructor(
    endpoint = ZEROCLAVE_PROXY_PATH,
    private readonly timeoutMs = MAX_TOTAL_MS,
    private readonly retries = 2,
    internals: ZeroClaveDetectorInternals = { fetch, wait: defaultWait, random: Math.random },
  ) {
    this.endpoint = normalizeEndpoint(endpoint)
    this.internals = { ...internals, now: internals.now ?? Date.now }
  }

  configure(endpoint: string): void { this.endpoint = normalizeEndpoint(endpoint) }
  get endpointURL(): string { return this.endpoint }
  available(): boolean { return this.endpoint !== '' }

  async scan(text: string, signal?: AbortSignal): Promise<ScanResult> {
    const [result] = await this.scanBatch([{
      id: 'text-0', revision: `r-${randomUUID()}`, text, regex: [],
    }], signal)
    if (result === undefined) throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave result is missing')
    return result
  }

  async scanBatch(inputs: readonly ZeroClaveDetectInput[], signal?: AbortSignal): Promise<ScanResult[]> {
    const boundaries = validateInputs(inputs)
    const fetchImpl = this.internals.fetch
    const callerSignal = signal ?? new AbortController().signal
    callerSignal.throwIfAborted()
    const requestId = `dsh-${randomUUID()}`
    const startedAt = this.internals.now()
    let response: Response | undefined
    let transportError: ZeroClaveDetectError | undefined

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      callerSignal.throwIfAborted()
      const remaining = MAX_TOTAL_MS - (this.internals.now() - startedAt)
      if (remaining <= 0) break
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, remaining)))
      try {
        response = await fetchImpl(this.endpoint, {
          method: 'POST',
          ...(this.endpoint.startsWith('/') ? {} : { mode: 'cors' as const }),
          credentials: this.endpoint.startsWith('/') ? 'same-origin' : 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: { 'content-type': 'application/json', 'x-request-id': requestId },
          body: JSON.stringify({ texts: inputs.map(({ id, revision, text }) => ({ id, revision, text })) }),
          signal: AbortSignal.any([callerSignal, timeout]),
        })
        transportError = undefined
      } catch {
        if (callerSignal.aborted) throw abortError()
        transportError = timeout.aborted
          ? new ZeroClaveDetectError('detector_timeout', 'ZeroClave request timed out', 504, requestId)
          : new ZeroClaveDetectError('network_error', 'ZeroClave could not be reached', undefined, requestId)
        if (attempt === this.retries) throw transportError
        const delay = retryAfter(new Response(null, { status: 503 }), attempt, this.internals.random, this.internals.now)
        const retryBudget = MAX_TOTAL_MS - (this.internals.now() - startedAt)
        if (delay > retryBudget) throw transportError
        await this.internals.wait(delay, callerSignal)
        continue
      }
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === this.retries) break
      const delay = retryAfter(response, attempt, this.internals.random, this.internals.now)
      const retryBudget = MAX_TOTAL_MS - (this.internals.now() - startedAt)
      if (delay > retryBudget) break
      await response.body?.cancel().catch(() => undefined)
      await this.internals.wait(delay, callerSignal)
      response = undefined
    }

    if (response === undefined) {
      throw transportError ?? new ZeroClaveDetectError('detector_timeout', 'ZeroClave retry budget was exhausted', 504, requestId)
    }
    const body = await responseJSON(response, requestId)
    if (!response.ok) {
      const failure = parseErrorResponse(body, response.status, requestId)
      const responseHeaderId = response.headers.get('x-request-id')
      if ((failure.request_id !== undefined && failure.request_id !== requestId)
        || (responseHeaderId !== null && responseHeaderId !== requestId)) {
        throw new ZeroClaveDetectError(
          'detector_response_invalid', 'ZeroClave error response correlation failed', 502, requestId,
        )
      }
      throw new ZeroClaveDetectError(
        failure.error.code,
        failure.error.message,
        response.status,
        requestId,
      )
    }

    const parsed = parseResponse(body)
    const responseHeaderId = response.headers.get('x-request-id')
    if (parsed.request_id !== requestId || (responseHeaderId !== null && responseHeaderId !== parsed.request_id)
      || parsed.results.length !== inputs.length) {
      throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave response correlation failed', 502, parsed.request_id)
    }
    const byId = new Map(parsed.results.map(result => [result.id, result]))
    if (byId.size !== parsed.results.length) {
      throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave returned duplicate result IDs', 502, parsed.request_id)
    }

    return inputs.map((input) => {
      const result = byId.get(input.id)
      const itemBoundaries = boundaries.get(input.id)
      if (result === undefined || itemBoundaries === undefined || result.revision !== input.revision) {
        throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave returned a stale or missing revision', 502, parsed.request_id)
      }
      const finalized = finalizeScan(
        input.text, [...input.regex, ...entityCandidates(result.entities, itemBoundaries)],
        'zeroclave', 'zeroclave', false, parsed.model_version,
      )
      return {
        ...finalized,
        ...(result.status === 'partial' ? { recommendedAction: 'block' as const } : {}),
        detector: { ...finalized.detector, status: result.status, requestId: parsed.request_id },
      }
    })
  }
}
