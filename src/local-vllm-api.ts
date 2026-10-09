import { basename, isAbsolute } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  LocalVllmSupervisor,
  LocalVllmSupervisorError,
  type LocalVllmDtype,
  type ValidatedLocalVllmConfig,
} from './local-vllm-supervisor.ts'

export const LOCAL_VLLM_API_BASE = '/api/zeroclave-privacy/local-model'
export const LOCAL_VLLM_API_PATHS = {
  config: `${LOCAL_VLLM_API_BASE}/config`,
  status: `${LOCAL_VLLM_API_BASE}/status`,
  diagnostics: `${LOCAL_VLLM_API_BASE}/diagnostics`,
  start: `${LOCAL_VLLM_API_BASE}/start`,
  stop: `${LOCAL_VLLM_API_BASE}/stop`,
  test: `${LOCAL_VLLM_API_BASE}/test`,
  detect: `${LOCAL_VLLM_API_BASE}/detect`,
} as const

export const MAX_LOCAL_VLLM_API_BODY_BYTES = 128 * 1024
const MAX_DETECT_TEXT_LENGTH = 64 * 1024
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u

type ApiPath = typeof LOCAL_VLLM_API_PATHS[keyof typeof LOCAL_VLLM_API_PATHS]
type SaveConfig = (config: ValidatedLocalVllmConfig) => void | Promise<void>

interface ApiErrorBody { error: { code: string; message: string } }

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  })
}

function failure(status: number, code: string, message: string, extra?: Record<string, string>): Response {
  return json(status, { error: { code, message } } satisfies ApiErrorBody, extra)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfig(value: unknown): ValidatedLocalVllmConfig {
  if (!isRecord(value)) throw new Error('Configuration must be an object')
  const allowed = new Set([
    'condaExecutable', 'condaEnvironment', 'modelDirectory', 'gpuMemoryUtilization',
    'maxModelLength', 'dtype', 'tensorParallelSize', 'autoStart',
  ])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Configuration contains unknown fields')
  const environment = value.condaEnvironment
  if (typeof value.condaExecutable !== 'string' || !isAbsolute(value.condaExecutable)) throw new Error('Conda executable must be an absolute path')
  if (!isRecord(environment) || (environment.kind !== 'name' && environment.kind !== 'prefix') || typeof environment.value !== 'string') {
    throw new Error('Conda environment is invalid')
  }
  if (environment.kind === 'name' && !ENVIRONMENT_PATTERN.test(environment.value)) throw new Error('Conda environment name is invalid')
  if (environment.kind === 'prefix' && !isAbsolute(environment.value)) throw new Error('Conda environment prefix must be absolute')
  if (typeof value.modelDirectory !== 'string' || !isAbsolute(value.modelDirectory)) throw new Error('Model directory must be an absolute path')
  if (typeof value.gpuMemoryUtilization !== 'number' || !Number.isFinite(value.gpuMemoryUtilization)
    || value.gpuMemoryUtilization < 0.1 || value.gpuMemoryUtilization > 0.95) throw new Error('GPU memory utilization is invalid')
  if (!Number.isSafeInteger(value.maxModelLength) || (value.maxModelLength as number) < 512 || (value.maxModelLength as number) > 32_768) {
    throw new Error('Maximum model length is invalid')
  }
  if (value.dtype !== 'auto' && value.dtype !== 'bfloat16' && value.dtype !== 'float16') throw new Error('dtype is invalid')
  if (value.tensorParallelSize !== undefined
    && (!Number.isSafeInteger(value.tensorParallelSize) || (value.tensorParallelSize as number) < 1 || (value.tensorParallelSize as number) > 16)) {
    throw new Error('Tensor parallel size is invalid')
  }
  if (typeof value.autoStart !== 'boolean') throw new Error('autoStart is invalid')
  return {
    condaExecutable: value.condaExecutable,
    condaEnvironment: { kind: environment.kind, value: environment.value },
    modelDirectory: value.modelDirectory,
    gpuMemoryUtilization: value.gpuMemoryUtilization,
    maxModelLength: value.maxModelLength as number,
    dtype: value.dtype as LocalVllmDtype,
    ...(value.tensorParallelSize === undefined ? {} : { tensorParallelSize: value.tensorParallelSize as number }),
    autoStart: value.autoStart,
  }
}

function configSummary(config: ValidatedLocalVllmConfig | undefined): unknown {
  if (config === undefined) return { configured: false }
  return {
    configured: true,
    condaExecutable: basename(config.condaExecutable),
    condaEnvironment: { kind: config.condaEnvironment.kind, value: basename(config.condaEnvironment.value) },
    modelDirectory: basename(config.modelDirectory),
    gpuMemoryUtilization: config.gpuMemoryUtilization,
    maxModelLength: config.maxModelLength,
    dtype: config.dtype,
    tensorParallelSize: config.tensorParallelSize ?? 1,
    autoStart: config.autoStart,
  }
}

async function requestJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Use Content-Type: application/json')
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_LOCAL_VLLM_API_BODY_BYTES) throw new RangeError('Request body is too large')
  if (request.body === null) throw new SyntaxError('Request body is not valid UTF-8 JSON')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_LOCAL_VLLM_API_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new RangeError('Request body is too large')
    }
    chunks.push(value)
  }
  const bytes = Buffer.concat(chunks, size)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown } catch { throw new SyntaxError('Request body is not valid UTF-8 JSON') }
}

/** Authenticated same-origin API owner. Authentication is applied by the caller through DSH Connection. */
export class LocalVllmHostApi {
  private config: ValidatedLocalVllmConfig | undefined

  constructor(
    private readonly supervisor: LocalVllmSupervisor,
    initialConfig?: ValidatedLocalVllmConfig,
    private readonly saveConfig: SaveConfig = () => undefined,
  ) {
    this.config = initialConfig
  }

  async fetch(path: ApiPath, request: Request): Promise<Response> {
    try {
      if (path === LOCAL_VLLM_API_PATHS.config && request.method === 'GET') return json(200, configSummary(this.config))
      if (path === LOCAL_VLLM_API_PATHS.status && request.method === 'GET') return json(200, this.publicStatus())
      if (path === LOCAL_VLLM_API_PATHS.diagnostics && request.method === 'GET') return json(200, this.publicDiagnostics())
      if (path === LOCAL_VLLM_API_PATHS.config && request.method === 'PUT') {
        let next: ValidatedLocalVllmConfig
        try { next = parseConfig(await requestJson(request)) } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) throw error
          return failure(400, 'invalid_request', error instanceof Error ? error.message : 'Configuration is invalid')
        }
        await this.supervisor.stop()
        await this.saveConfig(next)
        this.config = next
        if (next.autoStart) await this.supervisor.start(next)
        return json(200, { config: configSummary(next), status: this.publicStatus() })
      }
      if (path === LOCAL_VLLM_API_PATHS.start && request.method === 'POST') {
        if (this.config === undefined) return failure(409, 'not_configured', 'Local model is not configured')
        await this.supervisor.start(this.config)
        return json(200, this.publicStatus())
      }
      if (path === LOCAL_VLLM_API_PATHS.stop && request.method === 'POST') {
        await this.supervisor.stop()
        return json(200, this.publicStatus())
      }
      if (path === LOCAL_VLLM_API_PATHS.test && request.method === 'POST') {
        const findings = await this.supervisor.detect('Synthetic contact: demo@example.com', request.signal)
        return json(200, { complete: true, findings })
      }
      if (path === LOCAL_VLLM_API_PATHS.detect && request.method === 'POST') {
        const body = await requestJson(request)
        if (!isRecord(body) || Object.keys(body).some(key => key !== 'text') || typeof body.text !== 'string' || body.text.length > MAX_DETECT_TEXT_LENGTH) {
          return failure(400, 'invalid_request', 'Detection request must contain one bounded text field')
        }
        const findings = await this.supervisor.detect(body.text, request.signal)
        return json(200, { complete: true, findings })
      }
      const allow = path === LOCAL_VLLM_API_PATHS.config ? 'GET, PUT'
        : path === LOCAL_VLLM_API_PATHS.status || path === LOCAL_VLLM_API_PATHS.diagnostics ? 'GET' : 'POST'
      return failure(405, 'method_not_allowed', 'HTTP method is not allowed', { allow })
    } catch (error) {
      if (error instanceof TypeError) return failure(415, 'unsupported_media_type', error.message)
      if (error instanceof RangeError) return failure(413, 'request_body_too_large', error.message)
      if (error instanceof SyntaxError) {
        return failure(400, 'invalid_request', error.message)
      }
      if (error instanceof LocalVllmSupervisorError) {
        const status = error.code === 'not_ready' || error.code === 'busy' ? 409
          : error.code === 'input_too_long' ? 413
          : error.code === 'inference_timeout' ? 504 : 502
        return failure(status, error.code, error.message)
      }
      if (request.signal.aborted) return failure(499, 'request_cancelled', 'Request was cancelled')
      return failure(500, 'internal_error', 'Local model operation failed')
    }
  }

  private publicStatus(): unknown {
    const state = this.supervisor.snapshot()
    return {
      status: state.status,
      generation: state.generation,
      modelName: state.modelName,
      ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
      ...(state.readyAt === undefined ? {} : { readyAt: state.readyAt }),
      ...(state.error === undefined ? {} : { error: state.error }),
      modelDirectory: this.config === undefined ? undefined : basename(this.config.modelDirectory),
    }
  }

  private publicDiagnostics(): unknown {
    const state = this.supervisor.snapshot()
    return {
      status: state.status,
      generation: state.generation,
      ...(state.error === undefined ? {} : { error: state.error }),
      ...(state.diagnostic === undefined ? {} : { diagnostic: state.diagnostic }),
      logs: state.logs,
    }
  }
}

export function nodeRequest(request: IncomingMessage, signal: AbortSignal): Request {
  const host = request.headers.host ?? '127.0.0.1'
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
  }
  const method = request.method ?? 'GET'
  return new Request(`http://${host}${request.url ?? '/'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: request as unknown as BodyInit, duplex: 'half' as never }),
    signal,
  })
}

export async function writeNodeResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  target.writeHead(response.status, headers)
  target.end(new Uint8Array(await response.arrayBuffer()))
}
