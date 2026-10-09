import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_VLLM_MODEL_NAME,
  LocalVllmSupervisor,
  LocalVllmSupervisorError,
  type ValidatedLocalVllmConfig,
} from '../src/local-vllm-supervisor.ts'

class FakeChild extends EventEmitter {
  readonly pid = undefined
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    queueMicrotask(() => this.emit('exit', 0, signal))
    return true
  }

  crash(code = 1): void {
    this.emit('exit', code, null)
  }
}

function config(): ValidatedLocalVllmConfig {
  return {
    condaExecutable: '/opt/conda/bin/conda',
    condaEnvironment: { kind: 'name', value: 'vllm' },
    modelDirectory: '/mnt/c/Users/jy/Qwen3.5-0.8B-pii-v2-merged',
    gpuMemoryUtilization: 0.72,
    maxModelLength: 8_192,
    dtype: 'bfloat16',
    tensorParallelSize: 1,
    autoStart: true,
  }
}

function warmupResponse(valid = true): Response {
  const content = valid
    ? JSON.stringify({ status: 'complete', offsetUnit: 'utf16', entities: [{ type: 'EMAIL', start: 8, end: 24, text: 'demo@example.com', confidence: 1 }] })
    : JSON.stringify({ status: 'complete', offsetUnit: 'utf16', entities: [] })
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
}

function healthyFetch(validWarmup = true): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:43123\//u)
    expect(init?.redirect).toBe('manual')
    const headers = new Headers(init?.headers)
    if (url.endsWith('/health')) return new Response(null, { status: 200 })
    if (url.endsWith('/v1/models') && headers.get('authorization') === null) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    expect(headers.get('authorization')).toBe('Bearer test-secret-token')
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: LOCAL_VLLM_MODEL_NAME }] })
    if (url.endsWith('/v1/chat/completions')) return warmupResponse(validWarmup)
    return new Response(null, { status: 404 })
  })
}

describe('LocalVllmSupervisor', () => {
  it('starts vLLM with structured loopback-only argv, verifies auth, and performs PII warmup', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const supervisor = new LocalVllmSupervisor({
      spawn,
      fetch: healthyFetch(),
      reservePort: async () => 43_123,
      token: () => 'test-secret-token',
      healthIntervalMs: 1,
      stopGraceMs: 10,
    })

    await supervisor.start(config())

    expect(supervisor.snapshot()).toMatchObject({ status: 'ready', generation: 1, modelName: LOCAL_VLLM_MODEL_NAME })
    const [command, args, options] = spawn.mock.calls[0] ?? []
    expect(command).toBe('/opt/conda/bin/conda')
    expect(args).toEqual([
      'run', '--no-capture-output', '-n', 'vllm',
      'python', '-m', 'vllm.entrypoints.openai.api_server',
      '--model', '/mnt/c/Users/jy/Qwen3.5-0.8B-pii-v2-merged',
      '--host', '127.0.0.1', '--port', '43123', '--api-key', 'test-secret-token',
      '--served-model-name', LOCAL_VLLM_MODEL_NAME,
      '--dtype', 'bfloat16', '--max-model-len', '8192', '--gpu-memory-utilization', '0.72',
      '--language-model-only', '--mm-processor-cache-gb', '0', '--enforce-eager',
      '--tensor-parallel-size', '1',
    ])
    expect(options).toMatchObject({ shell: false, detached: true, cwd: config().modelDirectory })
    expect(options?.env).toMatchObject({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', VLLM_NO_USAGE_STATS: '1' })

    await supervisor.stop()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(supervisor.snapshot().status).toBe('stopped')
  })

  it('fails closed when the synthetic PII warmup output is invalid', async () => {
    const child = new FakeChild()
    const supervisor = new LocalVllmSupervisor({
      spawn: () => child,
      fetch: healthyFetch(false),
      reservePort: async () => 43_123,
      token: () => 'test-secret-token',
      healthIntervalMs: 1,
      stopGraceMs: 10,
    })

    await expect(supervisor.start(config())).rejects.toMatchObject<Partial<LocalVllmSupervisorError>>({ code: 'warmup_failed' })
    expect(supervisor.snapshot()).toMatchObject({
      status: 'warmup_error',
      error: { code: 'warmup_failed' },
      diagnostic: { stage: 'warmup', code: 'expected_email_missing' },
    })
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('marks a ready service crashed and redacts secrets and local paths from bounded logs', async () => {
    const child = new FakeChild()
    const supervisor = new LocalVllmSupervisor({
      spawn: () => child,
      fetch: healthyFetch(),
      reservePort: async () => 43_123,
      token: () => 'test-secret-token',
      healthIntervalMs: 1,
    })
    await supervisor.start(config())

    child.stderr.write(`token=test-secret-token model=${config().modelDirectory}\n`)
    child.crash()

    expect(supervisor.snapshot()).toMatchObject({ status: 'crashed', error: { code: 'process_crashed' } })
    const logs = supervisor.snapshot().logs.join('\n')
    expect(logs).not.toContain('test-secret-token')
    expect(logs).not.toContain(config().modelDirectory)
    expect(logs).toContain('[redacted-token]')
    expect(logs).toContain('[redacted-model-path]')
    expect(logs).not.toMatch(/127\.0\.0\.1:\d+/u)
  })

  it('never accepts a models endpoint that does not enforce authentication', async () => {
    const child = new FakeChild()
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: LOCAL_VLLM_MODEL_NAME }] }))
    const supervisor = new LocalVllmSupervisor({
      spawn: () => child,
      fetch: fetchImpl,
      reservePort: async () => 43_123,
      token: () => 'test-secret-token',
      startupTimeoutMs: 5,
      healthIntervalMs: 1,
      stopGraceMs: 10,
    })

    await expect(supervisor.start(config())).rejects.toMatchObject<Partial<LocalVllmSupervisorError>>({ code: 'health_check_failed' })
    expect(supervisor.snapshot()).toMatchObject({ status: 'startup_error', error: { code: 'health_check_failed' } })
  })

  it('does not spawn a stale generation when disposal wins the port-reservation race', async () => {
    let releasePort: ((port: number) => void) | undefined
    const port = new Promise<number>(resolve => { releasePort = resolve })
    const spawn = vi.fn(() => new FakeChild())
    const supervisor = new LocalVllmSupervisor({ spawn, reservePort: async () => await port })

    const starting = supervisor.start(config())
    await supervisor.stop()
    releasePort?.(43_123)

    await expect(starting).rejects.toMatchObject<Partial<LocalVllmSupervisorError>>({ code: 'process_crashed' })
    expect(spawn).not.toHaveBeenCalled()
    expect(supervisor.snapshot().status).toBe('stopped')
  })

  it('runs bounded authenticated inference and validates model output before returning findings', async () => {
    const child = new FakeChild()
    let completions = 0
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response(null, { status: 200 })
      const auth = new Headers(init?.headers).get('authorization')
      if (url.endsWith('/v1/models') && auth === null) return new Response(null, { status: 401 })
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: LOCAL_VLLM_MODEL_NAME }] })
      completions += 1
      const content = completions === 1
        ? JSON.stringify({ status: 'complete', offsetUnit: 'utf16', entities: [{ type: 'EMAIL', start: 8, end: 24, text: 'demo@example.com' }] })
        : JSON.stringify({ status: 'complete', offsetUnit: 'utf16', entities: [{ type: 'EMAIL', start: 6, end: 22, text: 'demo@example.com', confidence: 0.99 }] })
      const response = Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    const supervisor = new LocalVllmSupervisor({
      spawn: () => child, fetch: fetchImpl, reservePort: async () => 43_123,
      token: () => 'test-secret-token', healthIntervalMs: 1,
    })
    await supervisor.start(config())

    const findings = await supervisor.detect('Email demo@example.com')

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ entityType: 'EMAIL', start: 6, end: 22, confidence: 0.99 })
    expect(supervisor.snapshot().status).toBe('ready')
    const inference = fetchImpl.mock.calls.find(([input]) => String(input).endsWith('/v1/chat/completions')
      && JSON.stringify(input).includes('never-match'))
    expect(inference).toBeUndefined()
    expect(fetchImpl.mock.calls.every(([input]) => new URL(String(input)).hostname === '127.0.0.1')).toBe(true)
    await supervisor.stop()
  })
})
