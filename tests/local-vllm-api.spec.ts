import { describe, expect, it, vi } from 'vitest'
import { LOCAL_VLLM_API_PATHS, LocalVllmHostApi, MAX_LOCAL_VLLM_API_BODY_BYTES } from '../src/local-vllm-api.ts'
import type { LocalVllmSupervisor, ValidatedLocalVllmConfig } from '../src/local-vllm-supervisor.ts'

function config(): ValidatedLocalVllmConfig {
  return {
    condaExecutable: '/home/demo/anaconda3/bin/conda',
    condaEnvironment: { kind: 'name', value: 'vllm' },
    modelDirectory: '/mnt/c/Users/demo/private/Qwen3.5-0.8B-pii-v2-merged',
    gpuMemoryUtilization: 0.72,
    maxModelLength: 8_192,
    dtype: 'bfloat16',
    tensorParallelSize: 1,
    autoStart: false,
  }
}

function fakeSupervisor() {
  return {
    snapshot: vi.fn(() => ({ status: 'ready', generation: 2, modelName: 'zeroclave-local-pii', logs: [] })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    detect: vi.fn(async () => [{ entityType: 'EMAIL', start: 0, end: 16 }]),
  }
}

describe('local vLLM same-origin API', () => {
  it('returns bounded sanitized diagnostics without runtime capabilities', async () => {
    const supervisor = fakeSupervisor()
    supervisor.snapshot.mockReturnValue({
      status: 'warmup_error', generation: 3, modelName: 'zeroclave-local-pii',
      error: { code: 'warmup_failed', message: 'Warmup failed' },
      diagnostic: { stage: 'warmup', code: 'protocol_invalid_json', message: 'Strict JSON was not returned.' },
      logs: ['INFO model loaded', 'ERROR completion rejected'],
    })
    const api = new LocalVllmHostApi(supervisor as unknown as LocalVllmSupervisor, config())
    const response = await api.fetch(LOCAL_VLLM_API_PATHS.diagnostics, new Request('http://localhost/api'))
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({
      status: 'warmup_error', diagnostic: { stage: 'warmup', code: 'protocol_invalid_json' },
      logs: ['INFO model loaded', 'ERROR completion rejected'],
    })
    expect(text).not.toContain('/mnt/c')
    expect(text).not.toContain('token')
    expect(text).not.toContain('port')
  })

  it('returns the authenticated user configuration so the settings form can be restored', async () => {
    const supervisor = fakeSupervisor()
    const api = new LocalVllmHostApi(supervisor as unknown as LocalVllmSupervisor, config())
    const response = await api.fetch(LOCAL_VLLM_API_PATHS.config, new Request('http://localhost/api', { method: 'GET' }))
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('/home/demo')
    expect(text).toContain('/mnt/c')
    expect(text).not.toContain('token')
    expect(JSON.parse(text)).toMatchObject({
      configured: true,
      condaExecutable: '/home/demo/anaconda3/bin/conda',
      modelDirectory: '/mnt/c/Users/demo/private/Qwen3.5-0.8B-pii-v2-merged',
    })
  })

  it('applies stop-old then save then optional start-new for strict PUT configuration', async () => {
    const calls: string[] = []
    const supervisor = fakeSupervisor()
    supervisor.stop.mockImplementation(async () => { calls.push('stop') })
    supervisor.start.mockImplementation(async () => { calls.push('start') })
    const api = new LocalVllmHostApi(
      supervisor as unknown as LocalVllmSupervisor,
      config(),
      async () => { calls.push('save') },
    )
    const next = { ...config(), autoStart: true }
    const response = await api.fetch(LOCAL_VLLM_API_PATHS.config, new Request('http://localhost/api', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
    }))

    expect(response.status).toBe(200)
    expect(calls).toEqual(['stop', 'save', 'start'])
    expect(supervisor.start).toHaveBeenCalledWith(next)
  })

  it('rejects unknown configuration fields and oversized bodies', async () => {
    const api = new LocalVllmHostApi(fakeSupervisor() as unknown as LocalVllmSupervisor)
    const unknown = await api.fetch(LOCAL_VLLM_API_PATHS.config, new Request('http://localhost/api', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config(), command: 'sh -c evil' }),
    }))
    expect(unknown.status).toBe(400)

    const oversized = await api.fetch(LOCAL_VLLM_API_PATHS.detect, new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_LOCAL_VLLM_API_BODY_BYTES + 1) },
      body: '{}',
    }))
    expect(oversized.status).toBe(413)
  })

  it('uses only the fixed synthetic text for test and forwards cancellation to detection', async () => {
    const supervisor = fakeSupervisor()
    const api = new LocalVllmHostApi(supervisor as unknown as LocalVllmSupervisor, config())
    const controller = new AbortController()
    const response = await api.fetch(LOCAL_VLLM_API_PATHS.test, new Request('http://localhost/api', {
      method: 'POST', signal: controller.signal,
    }))

    expect(response.status).toBe(200)
    expect(supervisor.detect).toHaveBeenCalledWith('Synthetic contact: demo@example.com', expect.any(AbortSignal))
  })

  it('accepts only a single bounded text field for detection', async () => {
    const supervisor = fakeSupervisor()
    const api = new LocalVllmHostApi(supervisor as unknown as LocalVllmSupervisor, config())
    const invalid = await api.fetch(LOCAL_VLLM_API_PATHS.detect, new Request('http://localhost/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', model: 'remote' }),
    }))
    expect(invalid.status).toBe(400)
    expect(supervisor.detect).not.toHaveBeenCalled()
  })
})
