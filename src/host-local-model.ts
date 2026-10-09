import { mergeLocalModelCandidates, type FindingCandidate } from './detector.ts'
import { LocalModelError, type LocalModelRuntimeEvent } from './local-model.ts'
import type { LocalVllmConfigInput, LocalVllmDiagnostics, LocalVllmPublicStatus, LocalVllmSavedConfig } from './types.ts'
import type { ScanResult } from './types.ts'

const BASE = '/api/zeroclave-privacy/local-model'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withSignal(signal?: AbortSignal): Pick<RequestInit, 'signal'> {
  return signal === undefined ? {} : { signal }
}

async function responseJson(response: Response): Promise<unknown> {
  let value: unknown
  try { value = await response.json() } catch { throw new LocalModelError('output_invalid', 'Host returned invalid JSON') }
  if (!response.ok) {
    const error = record(value) && record(value.error) ? value.error : undefined
    const code = typeof error?.code === 'string' ? error.code : 'runtime_unavailable'
    const message = typeof error?.message === 'string' ? error.message : 'Local model request failed'
    throw new LocalModelError(code as LocalModelError['code'], message)
  }
  return value
}

function finding(value: unknown): value is FindingCandidate {
  if (!record(value)) return false
  return typeof value.entityType === 'string' && typeof value.category === 'string'
    && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
    && typeof value.maskedEvidence === 'string' && typeof value.severity === 'string'
    && value.detector === 'local-model'
}

/** Browser adapter for the authenticated DSH Host local-model API. */
export class HostLocalModelDetector {
  readonly id = 'local-model' as const
  readonly label = 'Local Qwen vLLM model'
  readonly locality = 'remote' as const
  private ready = false
  private listener: ((event: LocalModelRuntimeEvent) => void) | undefined

  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    // Window.fetch is Web-IDL branded in browsers and must not be invoked as a
    // method of this detector instance (which would throw "Illegal invocation").
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  available(): boolean { return this.ready }
  setRuntimeEventListener(listener: (event: LocalModelRuntimeEvent) => void): void { this.listener = listener }

  async refresh(signal?: AbortSignal): Promise<{ config: LocalVllmSavedConfig; status: LocalVllmPublicStatus }> {
    const [config, status] = await Promise.all([
      this.call('/config', { method: 'GET', ...withSignal(signal) }),
      this.call('/status', { method: 'GET', ...withSignal(signal) }),
    ])
    if (!record(config) || !record(status) || typeof status.status !== 'string') throw new LocalModelError('output_invalid', 'Host status is invalid')
    this.ready = status.status === 'ready'
    return { config: config as unknown as LocalVllmSavedConfig, status: status as unknown as LocalVllmPublicStatus }
  }

  async configure(config: LocalVllmConfigInput, signal?: AbortSignal): Promise<void> {
    await this.call('/config', { method: 'PUT', ...withSignal(signal), body: JSON.stringify(config), headers: { 'content-type': 'application/json' } })
    await this.refresh(signal)
  }

  async diagnostics(signal?: AbortSignal): Promise<LocalVllmDiagnostics> {
    const value = await this.call('/diagnostics', { method: 'GET', ...withSignal(signal) })
    if (!record(value) || typeof value.status !== 'string' || !Number.isSafeInteger(value.generation)
      || !Array.isArray(value.logs) || !value.logs.every(line => typeof line === 'string')) {
      throw new LocalModelError('output_invalid', 'Host diagnostics are invalid')
    }
    return value as unknown as LocalVllmDiagnostics
  }

  async start(signal?: AbortSignal): Promise<void> { await this.call('/start', { method: 'POST', ...withSignal(signal) }); await this.refresh(signal) }
  async stop(signal?: AbortSignal): Promise<void> { await this.call('/stop', { method: 'POST', ...withSignal(signal) }); this.ready = false }
  async restart(signal?: AbortSignal): Promise<void> { await this.stop(signal); await this.start(signal) }
  async test(signal?: AbortSignal): Promise<void> { await this.call('/test', { method: 'POST', ...withSignal(signal) }) }
  async unload(): Promise<void> { this.ready = false }

  async scan(text: string, signal?: AbortSignal, regex: readonly FindingCandidate[] = []): Promise<ScanResult> {
    const value = await this.call('/detect', {
      method: 'POST', ...withSignal(signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    })
    if (!record(value) || value.complete !== true || !Array.isArray(value.findings) || !value.findings.every(finding)) {
      throw new LocalModelError('output_invalid', 'Host returned invalid local-model findings')
    }
    this.ready = true
    return mergeLocalModelCandidates(text, value.findings, 'Qwen3.5-0.8B-pii-v2-merged', 'v2', regex)
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    try {
      return await responseJson(await this.fetchImpl(`${BASE}${path}`, { ...init, credentials: 'same-origin', redirect: 'error' }))
    } catch (error) {
      if (error instanceof LocalModelError) throw error
      const resolved = new LocalModelError('runtime_unavailable', error instanceof Error ? error.message : 'Local model Host is unavailable')
      this.listener?.({ code: 'runtime_unavailable', message: resolved.message })
      throw resolved
    }
  }
}
