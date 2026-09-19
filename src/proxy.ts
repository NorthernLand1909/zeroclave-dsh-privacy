import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const ZEROCLAVE_DETECT_PROXY_PATH = '/api/zeroclave-privacy/detect'
export const MAX_DETECT_REQUEST_BODY_BYTES = 10 * 1024 * 1024
export const MAX_DETECT_RESPONSE_BODY_BYTES = 10 * 1024 * 1024

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u

export interface DetectProxyConfig {
  gatewayBaseURL: string
  timeoutMs: number
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

class RequestBodyTooLargeError extends Error {}
class RequestAbortedError extends Error {}
class ResponseBodyTooLargeError extends Error {}
class DetectorProxyTimeoutError extends Error {}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}

function upstreamDetectURL(gatewayBaseURL: string): string {
  const base = new URL(gatewayBaseURL)
  if (base.protocol !== 'https:' && (base.protocol !== 'http:' || !isLoopback(base.hostname))) {
    throw new Error('Gateway URL must use HTTPS unless it targets loopback')
  }
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    throw new Error('Gateway URL must not contain credentials, query parameters, or a fragment')
  }
  const pathname = base.pathname.replace(/\/+$/u, '')
  base.pathname = /\/pii\/detect$/u.test(pathname)
    ? pathname
    : /\/v1$/u.test(pathname) ? `${pathname}/pii/detect` : `${pathname}/v1/pii/detect`
  return base.toString()
}

function requestID(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID()
}

function isJSONContentType(header: string | string[] | undefined): header is string {
  if (typeof header !== 'string') return false
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function sendJSON(
  res: ServerResponse,
  status: number,
  id: string,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-request-id': id,
    ...extraHeaders,
  })
  res.end(JSON.stringify({
    request_id: id,
    error: { code, message },
  }))
}

function declaredBodyTooLarge(header: string | string[] | undefined): boolean {
  if (typeof header !== 'string' || !/^\d+$/u.test(header)) return false
  return Number(header) > MAX_DETECT_REQUEST_BODY_BYTES
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0

    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buffer.byteLength
      if (length > MAX_DETECT_REQUEST_BODY_BYTES) {
        cleanup()
        req.resume()
        reject(new RequestBodyTooLargeError())
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks, length))
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onAborted = (): void => {
      cleanup()
      reject(new RequestAbortedError())
    }

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}

async function readResponseBody(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && /^\d+$/u.test(contentLength)
    && Number(contentLength) > MAX_DETECT_RESPONSE_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new ResponseBodyTooLargeError()
  }
  if (response.body === null) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_DETECT_RESPONSE_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new ResponseBodyTooLargeError()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, length)
}

function responseHeaders(response: Response, fallbackRequestID: string): Record<string, string> {
  const upstreamRequestID = response.headers.get('x-request-id')
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': upstreamRequestID !== null && REQUEST_ID_PATTERN.test(upstreamRequestID)
      ? upstreamRequestID
      : fallbackRequestID,
  }
  const contentType = response.headers.get('content-type')
  const retryAfter = response.headers.get('retry-after')
  if (contentType !== null) headers['content-type'] = contentType
  if (retryAfter !== null) headers['retry-after'] = retryAfter
  return headers
}

export function createDetectProxyHandler(
  config: DetectProxyConfig,
  fetchImpl: Fetch = fetch,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const upstreamURL = upstreamDetectURL(config.gatewayBaseURL)
  return async (req, res) => {
    const id = requestID(req.headers['x-request-id'])

    if (req.method !== 'POST') {
      req.resume()
      sendJSON(res, 405, id, 'method_not_allowed', 'Use POST for this endpoint', { allow: 'POST' })
      return
    }

    const contentType = req.headers['content-type']
    if (!isJSONContentType(contentType)) {
      req.resume()
      sendJSON(res, 415, id, 'unsupported_media_type', 'Use Content-Type: application/json')
      return
    }

    const contentEncoding = req.headers['content-encoding']
    if (contentEncoding !== undefined && contentEncoding !== 'identity') {
      req.resume()
      sendJSON(res, 415, id, 'unsupported_media_type', 'Use an uncompressed UTF-8 JSON request body')
      return
    }

    if (declaredBodyTooLarge(req.headers['content-length'])) {
      req.resume()
      sendJSON(res, 413, id, 'request_body_too_large', 'Request body exceeds 10 MiB')
      return
    }

    let body: Buffer
    try {
      body = await readRequestBody(req)
    } catch (error) {
      if (error instanceof RequestAbortedError || req.destroyed || res.destroyed) return
      if (error instanceof RequestBodyTooLargeError) {
        sendJSON(res, 413, id, 'request_body_too_large', 'Request body exceeds 10 MiB')
        return
      }
      sendJSON(res, 400, id, 'invalid_request', 'Unable to read request body')
      return
    }

    const controller = new AbortController()
    const onRequestAborted = (): void => {
      controller.abort(new RequestAbortedError())
    }
    const onResponseClose = (): void => {
      if (res.writableEnded) return
      controller.abort(new RequestAbortedError())
    }
    req.once('aborted', onRequestAborted)
    res.once('close', onResponseClose)
    const timer = setTimeout(() => {
      controller.abort(new DetectorProxyTimeoutError())
    }, config.timeoutMs)

    try {
      const response = await fetchImpl(upstreamURL, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          'x-request-id': id,
        },
        body: Uint8Array.from(body),
        redirect: 'manual',
        signal: controller.signal,
      })
      const responseBody = await readResponseBody(response)
      if (controller.signal.aborted) throw controller.signal.reason
      if (res.destroyed) return
      res.writeHead(response.status, responseHeaders(response, id))
      res.end(responseBody)
    } catch (error) {
      const reason: unknown = controller.signal.reason
      if (reason instanceof RequestAbortedError || res.destroyed) return
      if (reason instanceof DetectorProxyTimeoutError) {
        sendJSON(res, 504, id, 'detector_timeout', 'Detection service timed out')
        return
      }
      if (error instanceof ResponseBodyTooLargeError) {
        sendJSON(res, 502, id, 'detector_response_invalid', 'Detection service returned an invalid response')
        return
      }
      sendJSON(res, 503, id, 'detector_unavailable', 'Detection service is unavailable')
    } finally {
      clearTimeout(timer)
      req.off('aborted', onRequestAborted)
      res.off('close', onResponseClose)
    }
  }
}
