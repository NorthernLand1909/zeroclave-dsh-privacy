import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const TELEMETRY_CONFIG_PATH = '/api/zeroclave-privacy/telemetry/config'
export const TELEMETRY_EVENTS_PATH = '/api/zeroclave-privacy/telemetry/events'
export const MAX_TELEMETRY_BODY_BYTES = 512

export type TelemetryAuthMode = 'anonymous' | 'hmac'
export type TelemetryProvider = 'zeroclave' | 'plausible'

const DAILY_ID = /^[A-Za-z0-9_-]{22}$/u
const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u
const DETECTORS = new Set(['regex', 'embedded', 'zeroclave'])
const EVENTS = new Set(['privacy_active', 'protected_send', 'detector_used'])
const PLAUSIBLE_SITE = /^[A-Za-z0-9_.-]{1,128}$/u

export interface TelemetryProxyConfig {
  enabled: boolean
  provider?: TelemetryProvider
  site?: string
  authMode: TelemetryAuthMode
  endpoint: string
  keyId: string
  secret: string | undefined
  timeoutMs: number
  pluginVersion: string
}

interface BrowserEventBase {
  schema_version: 1
  daily_id: string
}

type BrowserEvent = BrowserEventBase & (
  | { event: 'privacy_active' | 'protected_send' }
  | { event: 'detector_used'; value: 'regex' | 'embedded' | 'zeroclave' }
)

interface TelemetryProxyInternals {
  fetch: typeof fetch
  now: () => number
  randomBytes: (length: number) => Buffer
}

class BodyTooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]'
}

function telemetryURL(value: string, provider: TelemetryProvider, authMode: TelemetryAuthMode): string {
  const url = new URL(value)
  const hasQuery = url.href.includes('?')
  const hasFragment = url.href.includes('#')
  if (provider === 'plausible') {
    if (url.protocol !== 'https:' || url.pathname.replace(/\/+$/u, '') !== '/api/event') {
      throw new Error('Plausible endpoint must be HTTPS /api/event')
    }
    if (url.username !== '' || url.password !== '' || hasQuery || hasFragment) {
      throw new Error('Telemetry endpoint must not contain credentials, query parameters, or a fragment')
    }
    return url.toString()
  }
  const hmacLoopback = authMode === 'hmac' && url.protocol === 'http:' && isLoopback(url.hostname)
  if (url.protocol !== 'https:' && !hmacLoopback) {
    throw new Error('Telemetry endpoint must use HTTPS unless HMAC targets loopback')
  }
  if (url.username !== '' || url.password !== '' || hasQuery || hasFragment) {
    throw new Error('Telemetry endpoint must not contain credentials, query parameters, or a fragment')
  }
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = path.endsWith('/v1/events') ? path : `${path}/v1/events`
  return url.toString()
}

function sendJSON(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(JSON.stringify(value))
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
  res.end()
}

function isJSON(header: string | string[] | undefined): boolean {
  return typeof header === 'string' && header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = (): void => {
      req.off('data', data)
      req.off('end', end)
      req.off('error', error)
      req.off('aborted', aborted)
    }
    const data = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > MAX_TELEMETRY_BODY_BYTES) {
        cleanup()
        req.resume()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(buffer)
    }
    const end = (): void => { cleanup(); resolve(Buffer.concat(chunks, size)) }
    const error = (cause: Error): void => { cleanup(); reject(cause) }
    const aborted = (): void => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    req.once('aborted', aborted)
  })
}

function parseEvent(body: Buffer): BrowserEvent {
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) as unknown } catch { throw new Error('invalid_json') }
  if (!isRecord(value)) throw new Error('invalid_payload')
  const allowed = new Set(['schema_version', 'event', 'daily_id', 'value'])
  if (Object.keys(value).some(key => !allowed.has(key))
    || value.schema_version !== 1 || typeof value.event !== 'string' || !EVENTS.has(value.event)
    || typeof value.daily_id !== 'string' || !DAILY_ID.test(value.daily_id)
    || (value.value !== undefined && typeof value.value !== 'string')) throw new Error('invalid_payload')
  if (Buffer.from(value.daily_id, 'base64url').byteLength !== 16
    || Buffer.from(value.daily_id, 'base64url').toString('base64url') !== value.daily_id) throw new Error('invalid_payload')
  const event = value.event as BrowserEvent['event']
  if (event === 'detector_used') {
    if (typeof value.value !== 'string' || !DETECTORS.has(value.value)) throw new Error('invalid_payload')
    return {
      schema_version: 1,
      event,
      daily_id: value.daily_id,
      value: value.value as 'regex' | 'embedded' | 'zeroclave',
    }
  }
  if (value.value !== undefined) throw new Error('invalid_payload')
  return { schema_version: 1, event, daily_id: value.daily_id }
}

export function createTelemetryHandlers(
  config: TelemetryProxyConfig,
  internals: TelemetryProxyInternals = { fetch, now: Date.now, randomBytes },
): {
  active: boolean
  config: (req: IncomingMessage, res: ServerResponse) => void
  events: (req: IncomingMessage, res: ServerResponse) => Promise<void>
} {
  const provider = config.provider ?? 'zeroclave'
  const site = config.site ?? 'zeroclave-dsh-privacy'
  const secret = config.secret
  let endpoint: string | undefined
  if (config.enabled && (provider === 'plausible' || config.authMode === 'anonymous' || config.authMode === 'hmac')
    && (provider !== 'plausible' || config.authMode === 'anonymous')
    && (provider !== 'plausible' || PLAUSIBLE_SITE.test(site))
    && VERSION.test(config.pluginVersion)) {
    try { endpoint = telemetryURL(config.endpoint, provider, config.authMode) } catch { endpoint = undefined }
  }
  const destination = endpoint === undefined
    ? undefined
    : provider === 'plausible'
      ? { provider, endpoint, site }
      : config.authMode === 'anonymous'
        ? { provider, authMode: config.authMode, endpoint }
      : secret !== undefined && secret.length >= 32 && !secret.startsWith('replace-with-')
        && KEY_ID.test(config.keyId)
        ? { provider, authMode: config.authMode, endpoint, secret }
        : undefined
  const active = destination !== undefined

  return {
    active,
    config: (req, res) => {
      req.resume()
      if (req.method !== 'GET') {
        sendJSON(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET for this endpoint' } }, { allow: 'GET' })
        return
      }
      sendJSON(res, 200, {
        enabled: active,
        ...(active && destination?.provider === 'plausible'
          ? { provider: 'plausible', endpoint: destination.endpoint, site: destination.site }
          : {}),
      })
    },
    events: async (req, res) => {
      if (req.method !== 'POST') {
        req.resume()
        sendJSON(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST for this endpoint' } }, { allow: 'POST' })
        return
      }
      if (destination === undefined) {
        req.resume()
        sendEmpty(res, 204)
        return
      }
      if (!isJSON(req.headers['content-type'])
        || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
        req.resume()
        sendJSON(res, 415, { error: { code: 'unsupported_media_type', message: 'Use uncompressed JSON' } })
        return
      }
      const declared = req.headers['content-length']
      if (typeof declared === 'string' && /^\d+$/u.test(declared) && Number(declared) > MAX_TELEMETRY_BODY_BYTES) {
        req.resume()
        sendJSON(res, 413, { error: { code: 'payload_too_large', message: 'Telemetry payload is too large' } })
        return
      }
      let event: BrowserEvent
      try { event = parseEvent(await readBody(req)) } catch (error) {
        if (req.destroyed || res.destroyed || (error instanceof DOMException && error.name === 'AbortError')) return
        if (error instanceof BodyTooLargeError) {
          sendJSON(res, 413, { error: { code: 'payload_too_large', message: 'Telemetry payload is too large' } })
          return
        }
        const code = error instanceof Error && error.message === 'invalid_json' ? 'invalid_json' : 'invalid_payload'
        sendJSON(res, code === 'invalid_json' ? 400 : 422, { error: { code, message: 'Telemetry payload is invalid' } })
        return
      }
      const outbound = destination.provider === 'plausible'
        ? JSON.stringify({
          domain: destination.site,
          name: event.event === 'detector_used' ? `detector_used_${event.value}` : event.event,
          url: 'app://zeroclave-dsh-privacy/',
        })
        : JSON.stringify({
          schema_version: 1,
          product: 'zeroclave-dsh-privacy',
          event: event.event,
          daily_id: event.daily_id,
          plugin_version: config.pluginVersion,
          ...(event.event === 'detector_used' ? { value: event.value } : {}),
        })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (destination.provider === 'plausible') {
        headers['user-agent'] = 'ZeroClave-Telemetry/0.1'
      } else if (destination.authMode === 'hmac') {
        const timestamp = String(Math.floor(internals.now() / 1_000))
        const nonce = internals.randomBytes(16).toString('base64url')
        const bodyHash = createHash('sha256').update(outbound).digest('hex')
        const canonical = `v1\nPOST\n/v1/events\n${timestamp}\n${nonce}\n${bodyHash}`
        headers['x-zc-key-id'] = config.keyId
        headers['x-zc-timestamp'] = timestamp
        headers['x-zc-nonce'] = nonce
        headers['x-zc-signature'] = createHmac('sha256', destination.secret).update(canonical).digest('hex')
      }
      const controller = new AbortController()
      let timedOut = false
      let disconnected = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
      const close = (): void => {
        if (res.writableEnded) return
        disconnected = true
        controller.abort()
      }
      res.once('close', close)
      try {
        const response = await internals.fetch(destination.endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers,
          body: outbound,
          signal: controller.signal,
        })
        await response.body?.cancel().catch(() => undefined)
        if (res.destroyed) return
        if (response.status === 202) {
          sendEmpty(res, 204)
          return
        }
        const retryAfter = response.headers.get('retry-after')
        if (response.status === 429) {
          sendEmpty(res, 429, retryAfter === null ? {} : { 'retry-after': retryAfter })
          return
        }
        sendJSON(res, 503, { error: { code: 'telemetry_unavailable', message: 'Telemetry is unavailable' } })
      } catch {
        const clientDisconnected = (): boolean => disconnected || res.destroyed
        const requestTimedOut = (): boolean => timedOut
        if (clientDisconnected()) return
        sendJSON(res, requestTimedOut() ? 504 : 503, {
          error: {
            code: requestTimedOut() ? 'telemetry_timeout' : 'telemetry_unavailable',
            message: 'Telemetry is unavailable',
          },
        })
      } finally {
        clearTimeout(timer)
        res.off('close', close)
      }
    },
  }
}
