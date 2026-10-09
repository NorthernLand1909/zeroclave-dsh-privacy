// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { HostLocalModelDetector } from '../src/host-local-model.ts'

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

describe('HostLocalModelDetector', () => {
  it('invokes the default browser fetch with the Window binding', async () => {
    const original = globalThis.fetch
    const fetchMock = vi.fn(function (this: typeof globalThis, input: RequestInfo | URL) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(String(input).endsWith('/config')
        ? json({ configured: false })
        : json({ status: 'stopped', generation: 0, modelName: 'zeroclave-local-pii' }))
    }) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    try {
      const detector = new HostLocalModelDetector()
      await expect(detector.refresh()).resolves.toMatchObject({
        config: { configured: false }, status: { status: 'stopped' },
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      globalThis.fetch = original
    }
  })

  it('uses only authenticated same-origin routes and becomes available only when Host is ready', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input).endsWith('/config')
      ? json({ configured: true, modelDirectory: 'Qwen3.5-0.8B-pii-v2-merged' })
      : json({ status: 'warming', generation: 1, modelName: 'zeroclave-local-pii' }))
    const detector = new HostLocalModelDetector(fetchImpl)
    await detector.refresh()
    expect(detector.available()).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/zeroclave-privacy\/local-model\/(config|status)$/u)
      expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error' })
    }
  })

  it('merges Host semantic findings with regex findings without a regex-only fallback', async () => {
    const text = '巴彬: demo@example.com'
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ complete: true, findings: [{
      category: 'DIRECT_PII', entityType: 'PERSON', start: 0, end: 2,
      maskedEvidence: '[REDACTED_PERSON:2]', severity: 'high', detector: 'local-model', sourceType: 'local-model',
    }] }))
    const result = await new HostLocalModelDetector(fetchImpl).scan(text, undefined, [{
      category: 'DIRECT_PII', entityType: 'EMAIL', start: 4, end: 20,
      maskedEvidence: 'd***@example.com', severity: 'high', detector: 'regex', sourceType: 'regex',
    }])
    expect(result.detector).toMatchObject({ requested: 'local-model', used: 'local-model', fallback: false, status: 'complete' })
    expect(result.findings.map(finding => finding.detector)).toEqual(['local-model', 'regex'])
  })

  it('fails closed on Host errors or malformed detection responses', async () => {
    const unavailable = new HostLocalModelDetector(async () => json({ error: { code: 'process_crashed', message: 'Service stopped' } }, 502))
    await expect(unavailable.scan('demo@example.com')).rejects.toMatchObject({ code: 'process_crashed' })

    const malformed = new HostLocalModelDetector(async () => json({ complete: false, findings: [] }))
    await expect(malformed.scan('demo@example.com')).rejects.toMatchObject({ code: 'output_invalid' })
  })

  it('retrieves only the Host diagnostic payload through the same-origin endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({
      status: 'warmup_error', generation: 2,
      diagnostic: { stage: 'warmup', code: 'finish_reason', message: 'The completion was truncated.' },
      logs: ['INFO ready', 'WARN truncated'],
    }))
    const diagnostics = await new HostLocalModelDetector(fetchImpl).diagnostics()
    expect(diagnostics.diagnostic?.code).toBe('finish_reason')
    expect(fetchImpl).toHaveBeenCalledWith('/api/zeroclave-privacy/local-model/diagnostics',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin', redirect: 'error' }))
  })

  it('exposes configure and lifecycle operations without sending shell fragments', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      if (String(input).endsWith('/config') && init?.method === 'GET') return json({ configured: true, modelDirectory: 'model' })
      if (String(input).endsWith('/status')) return json({ status: 'ready', generation: 2, modelName: 'zeroclave-local-pii' })
      return json({ status: 'ready' })
    })
    const detector = new HostLocalModelDetector(fetchImpl)
    await detector.configure({
      condaExecutable: '/opt/conda/bin/conda', condaEnvironment: { kind: 'name', value: 'vllm' },
      modelDirectory: '/mnt/c/model', gpuMemoryUtilization: 0.72, maxModelLength: 8192,
      dtype: 'auto', tensorParallelSize: 1, autoStart: true,
    })
    await detector.test()
    await detector.restart()
    expect(detector.available()).toBe(true)
    expect(calls).toEqual(expect.arrayContaining([
      'PUT /api/zeroclave-privacy/local-model/config', 'POST /api/zeroclave-privacy/local-model/test',
      'POST /api/zeroclave-privacy/local-model/stop', 'POST /api/zeroclave-privacy/local-model/start',
    ]))
  })
})
