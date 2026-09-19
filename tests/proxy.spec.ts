import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createDetectProxyHandler,
  MAX_DETECT_REQUEST_BODY_BYTES,
  MAX_DETECT_RESPONSE_BODY_BYTES,
  type DetectProxyConfig,
} from '../src/proxy.ts'

interface ResponseSnapshot {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function requestURL(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

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

async function invoke(
  fetchImpl: typeof fetch,
  options: {
    method?: string
    headers?: IncomingHttpHeaders
    body?: string | Uint8Array
    config?: Partial<DetectProxyConfig>
  } = {},
): Promise<ResponseSnapshot> {
  const request = Readable.from(options.body === undefined ? [] : [options.body]) as IncomingMessage
  request.method = options.method ?? 'POST'
  request.headers = options.headers ?? { 'content-type': 'application/json' }
  Object.defineProperty(request, 'aborted', { value: false, writable: true })
  const response = new TestResponse()
  const handler = createDetectProxyHandler({
    gatewayBaseURL: 'https://zeroclave.com/v1/',
    timeoutMs: 1_000,
    ...options.config,
  }, fetchImpl)
  await handler(request, response as unknown as ServerResponse)
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
  }
}

describe('ZeroClave anonymous detection proxy', () => {
  it('forwards only the JSON body and request id, then preserves an upstream non-JSON response', async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(requestURL(input)).toBe('https://zeroclave.com/v1/pii/detect')
      expect(init?.method).toBe('POST')
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ['content-type', 'application/json'],
        ['x-request-id', 'plugin-request-1'],
      ])
      expect(Buffer.from(init?.body as Uint8Array).toString('utf8')).toBe('{"texts":[]}')
      expect(init?.redirect).toBe('manual')
      return new Response('busy outside the Gateway', {
        status: 429,
        headers: {
          'cache-control': 'public, max-age=60',
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': '3',
          'set-cookie': 'secret=do-not-forward',
          'x-internal-debug': 'hidden',
          'x-request-id': 'plugin-request-1',
        },
      })
    })

    const response = await invoke(upstream, {
      headers: {
        authorization: 'Bearer must-not-forward',
        cookie: 'session=must-not-forward',
        'content-type': 'application/json',
        'x-private-header': 'must-not-forward',
        'x-request-id': 'plugin-request-1',
      },
      body: '{"texts":[]}',
    })

    expect(response.status).toBe(429)
    expect(response.body.toString('utf8')).toBe('busy outside the Gateway')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(response.headers['retry-after']).toBe('3')
    expect(response.headers['x-request-id']).toBe('plugin-request-1')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['x-internal-debug']).toBeUndefined()
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('replaces invalid request ids and does not trust an invalid upstream response id', async () => {
    let generatedID = ''
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      generatedID = new Headers(init?.headers).get('x-request-id') ?? ''
      return new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'invalid response id',
        },
      })
    })

    const response = await invoke(upstream, {
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'invalid request id',
      },
      body: '{}',
    })

    expect(generatedID).toMatch(/^[A-Za-z0-9_.-]{1,64}$/u)
    expect(generatedID).not.toBe('invalid request id')
    expect(response.headers['x-request-id']).toBe(generatedID)
  })

  it('accepts a configured full endpoint and permits HTTP only for loopback', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response('{}'))
    await invoke(upstream, {
      body: '{}',
      config: { gatewayBaseURL: 'http://127.0.0.1:8080/v1/pii/detect/' },
    })
    const calledURL = upstream.mock.calls[0]?.[0]
    if (calledURL === undefined) throw new Error('Upstream was not called')
    expect(requestURL(calledURL)).toBe('http://127.0.0.1:8080/v1/pii/detect')

    upstream.mockClear()
    await expect(invoke(upstream, {
      body: '{}',
      config: { gatewayBaseURL: 'http://gateway.example/v1' },
    })).rejects.toThrow('Gateway URL must use HTTPS')
    await expect(invoke(upstream, {
      body: '{}',
      config: { gatewayBaseURL: 'http://127.evil.example/v1' },
    })).rejects.toThrow('Gateway URL must use HTTPS')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('adds the public v1 path when configured with an origin URL', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response('{}'))
    await invoke(upstream, {
      body: '{}',
      config: { gatewayBaseURL: 'https://gateway.example' },
    })
    const calledURL = upstream.mock.calls[0]?.[0]
    if (calledURL === undefined) throw new Error('Upstream was not called')
    expect(requestURL(calledURL)).toBe('https://gateway.example/v1/pii/detect')
  })

  it('rejects unsupported media and oversized bodies before contacting the Gateway', async () => {
    const upstream = vi.fn<typeof fetch>()

    const unsupported = await invoke(upstream, {
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(unsupported.status).toBe(415)
    expect(JSON.parse(unsupported.body.toString('utf8'))).toMatchObject({
      error: { code: 'unsupported_media_type' },
    })

    const oversized = await invoke(upstream, {
      headers: {
        'content-length': String(MAX_DETECT_REQUEST_BODY_BYTES + 1),
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(oversized.status).toBe(413)
    expect(JSON.parse(oversized.body.toString('utf8'))).toMatchObject({
      error: { code: 'request_body_too_large' },
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('maps an upstream timeout to a low-detail structured 504', async () => {
    const upstream = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    }))

    const response = await invoke(upstream, {
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'timeout-1',
      },
      body: '{}',
      config: { timeoutMs: 10 },
    })

    expect(response.status).toBe(504)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      request_id: 'timeout-1',
      error: {
        code: 'detector_timeout',
        message: 'Detection service timed out',
      },
    })
  })

  it('aborts the upstream request when the browser disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined
    const upstream = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init?.signal ?? undefined
      upstreamSignal?.addEventListener('abort', () => {
        const reason: unknown = upstreamSignal?.reason
        reject(reason instanceof Error ? reason : new Error('Upstream request aborted'))
      }, { once: true })
    }))
    const request = Readable.from(['{}']) as IncomingMessage
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json' }
    const response = new TestResponse()
    const handler = createDetectProxyHandler({
      gatewayBaseURL: 'https://zeroclave.com/v1', timeoutMs: 1_000,
    }, upstream)

    const handling = handler(request, response as unknown as ServerResponse)
    await vi.waitFor(() => { expect(upstream).toHaveBeenCalledOnce() })
    response.emit('close')
    await handling

    expect(upstreamSignal?.aborted).toBe(true)
    expect(response.writableEnded).toBe(false)
  })

  it('rejects an oversized upstream response with a structured 502', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_DETECT_RESPONSE_BODY_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })))

    const response = await invoke(upstream, {
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'oversized-response-1',
      },
      body: '{}',
    })

    expect(response.status).toBe(502)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      request_id: 'oversized-response-1',
      error: {
        code: 'detector_response_invalid',
        message: 'Detection service returned an invalid response',
      },
    })
  })

  it('maps connection failures to a low-detail structured 503', async () => {
    const upstream = vi.fn<typeof fetch>(async () => {
      throw new Error('sensitive internal network detail')
    })

    const response = await invoke(upstream, {
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'unavailable-1',
      },
      body: '{}',
    })

    expect(response.status).toBe(503)
    const body = response.body.toString('utf8')
    expect(body).not.toContain('sensitive internal network detail')
    expect(JSON.parse(body)).toEqual({
      request_id: 'unavailable-1',
      error: {
        code: 'detector_unavailable',
        message: 'Detection service is unavailable',
      },
    })
  })
})
