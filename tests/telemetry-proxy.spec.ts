import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createTelemetryHandlers,
  MAX_TELEMETRY_BODY_BYTES,
  type TelemetryProxyConfig,
} from '../src/telemetry-proxy.ts'

interface ResponseSnapshot {
  status: number
  headers: Record<string, string>
  body: Buffer
}

const vector = {
  keyId: 'test-key-v1',
  secret: 'test-secret-0123456789abcdef0123456789',
  timestamp: 1_789_696_800_000,
  nonce: 'abcdefghijklmnopqrstuv',
  body: '{"schema_version":1,"product":"zeroclave-dsh-privacy","event":"detector_used","daily_id":"AAAAAAAAAAAAAAAAAAAAAA","plugin_version":"0.1.0-alpha.11","value":"zeroclave"}',
  signature: '214ea3a73285e6824e599a6114c083553265c5765fdd4ae89c9cc75e7a88dc37',
} as const

class TestResponse extends EventEmitter {
  destroyed = false
  writableEnded = false
  status = 0
  headers: Record<string, string> = {}
  body = Buffer.alloc(0)

  writeHead(status: number, headers: OutgoingHttpHeaders): this {
    this.status = status
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) this.headers[key.toLowerCase()] = String(value)
    }
    return this
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.body = Buffer.from(chunk)
    this.writableEnded = true
    return this
  }
}

function activeConfig(overrides: Partial<TelemetryProxyConfig> = {}): TelemetryProxyConfig {
  return {
    enabled: true,
    endpoint: 'https://telemetry.example',
    keyId: vector.keyId,
    secret: vector.secret,
    timeoutMs: 1_000,
    pluginVersion: '0.1.0-alpha.11',
    ...overrides,
  }
}

function requestURL(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string | Uint8Array } = {},
): Promise<ResponseSnapshot> {
  const request = Readable.from(options.body === undefined ? [] : [options.body]) as IncomingMessage
  request.method = options.method ?? 'POST'
  request.headers = options.headers ?? { 'content-type': 'application/json' }
  Object.defineProperty(request, 'aborted', { value: false, writable: true })
  // A real IncomingMessage remains usable after its body ends; Readable.from auto-destroys instead.
  Object.defineProperty(request, 'destroyed', { value: false, writable: true })
  const response = new TestResponse()
  await handler(request, response as unknown as ServerResponse)
  return { status: response.status, headers: response.headers, body: response.body }
}

function validBody(event: 'privacy_active' | 'protected_send' = 'privacy_active'): string {
  return JSON.stringify({ schema_version: 1, event, daily_id: 'AAAAAAAAAAAAAAAAAAAAAA' })
}

describe('telemetry Host proxy', () => {
  it('advertises disabled and silently accepts events when configuration is incomplete', async () => {
    const upstream = vi.fn<typeof fetch>()
    const handlers = createTelemetryHandlers(activeConfig({ secret: undefined }), {
      fetch: upstream,
      now: () => vector.timestamp,
      randomBytes: () => Buffer.alloc(16),
    })

    const config = await invoke(handlers.config, { method: 'GET' })
    const event = await invoke(handlers.events, { body: validBody() })

    expect(config.status).toBe(200)
    expect(JSON.parse(config.body.toString('utf8'))).toEqual({ enabled: false })
    expect(event.status).toBe(204)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('enforces the exact browser schema and the 512-byte boundary', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const handlers = createTelemetryHandlers(activeConfig(), {
      fetch: upstream,
      now: () => vector.timestamp,
      randomBytes: () => Buffer.alloc(16),
    })

    const invalidBodies = [
      '{',
      JSON.stringify({ schema_version: 1, event: 'privacy_active', daily_id: 'AAAAAAAAAAAAAAAAAAAAAA', value: 'regex' }),
      JSON.stringify({ schema_version: 1, event: 'detector_used', daily_id: 'AAAAAAAAAAAAAAAAAAAAAA' }),
      JSON.stringify({ schema_version: 1, event: 'privacy_active', daily_id: 'AAAAAAAAAAAAAAAAAAAAAA', product: 'spoofed' }),
      JSON.stringify({ schema_version: 1, event: 'privacy_active', daily_id: 'not-canonical' }),
    ]
    const statuses: number[] = []
    for (const body of invalidBodies) statuses.push((await invoke(handlers.events, { body })).status)
    expect(statuses).toEqual([400, 422, 422, 422, 422])

    const base = validBody()
    const exact = `${base}${' '.repeat(MAX_TELEMETRY_BODY_BYTES - Buffer.byteLength(base))}`
    expect(Buffer.byteLength(exact)).toBe(MAX_TELEMETRY_BODY_BYTES)
    expect((await invoke(handlers.events, { body: exact })).status).toBe(204)
    expect((await invoke(handlers.events, { body: `${exact} ` })).status).toBe(413)
    expect((await invoke(handlers.events, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(MAX_TELEMETRY_BODY_BYTES + 1),
      },
      body: validBody(),
    })).status).toBe(413)
    expect(upstream).toHaveBeenCalledOnce()
  })

  it('rebuilds trusted fields and signs the shared canonical HMAC vector without forwarding browser headers', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const nonceBytes = Buffer.alloc(16)
    // The shared cross-service vector intentionally fixes the canonical text, independent of RNG encoding.
    Object.defineProperty(nonceBytes, 'toString', { value: () => vector.nonce })
    const handlers = createTelemetryHandlers(activeConfig(), {
      fetch: upstream,
      now: () => vector.timestamp,
      randomBytes: () => nonceBytes,
    })

    const response = await invoke(handlers.events, {
      headers: {
        authorization: 'Bearer browser-secret',
        cookie: 'session=browser-secret',
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.7',
        'x-zc-key-id': 'attacker-key',
        'x-zc-signature': 'attacker-signature',
      },
      body: JSON.stringify({
        schema_version: 1,
        event: 'detector_used',
        daily_id: 'AAAAAAAAAAAAAAAAAAAAAA',
        value: 'zeroclave',
      }),
    })

    expect(response.status).toBe(204)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(upstream).toHaveBeenCalledOnce()
    const [input, init] = upstream.mock.calls[0] ?? []
    if (input === undefined) throw new Error('Telemetry upstream was not called')
    expect(requestURL(input)).toBe('https://telemetry.example/v1/events')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(vector.body)
    expect([...new Headers(init?.headers).entries()]).toEqual([
      ['content-type', 'application/json'],
      ['x-zc-key-id', vector.keyId],
      ['x-zc-nonce', vector.nonce],
      ['x-zc-signature', vector.signature],
      ['x-zc-timestamp', String(vector.timestamp / 1_000)],
    ])
    expect(init?.redirect).toBe('manual')
  })

  it('requires HTTPS except for explicit loopback endpoints', async () => {
    expect(() => createTelemetryHandlers(activeConfig({ endpoint: 'http://telemetry.example' }))).toThrow(
      'Telemetry endpoint must use HTTPS',
    )
    expect(() => createTelemetryHandlers(activeConfig({ endpoint: 'http://127.evil.example' }))).toThrow(
      'Telemetry endpoint must use HTTPS',
    )
    expect(() => createTelemetryHandlers(activeConfig({ endpoint: 'http://127.0.0.1:8787' }))).not.toThrow()
  })

  it('maps an upstream deadline to a low-detail 504 response', async () => {
    const upstream = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    }))
    const handlers = createTelemetryHandlers(activeConfig({ timeoutMs: 5 }), {
      fetch: upstream,
      now: () => vector.timestamp,
      randomBytes: () => Buffer.alloc(16),
    })

    const response = await invoke(handlers.events, { body: validBody('protected_send') })

    expect(response.status).toBe(504)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      error: { code: 'telemetry_timeout', message: 'Telemetry is unavailable' },
    })
  })
})
