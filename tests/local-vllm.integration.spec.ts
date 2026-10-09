import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { finalizeScan } from '../src/detector.ts'
import { LocalVllmSupervisor, type ValidatedLocalVllmConfig } from '../src/local-vllm-supervisor.ts'

// This is an opt-in test because it requires a GPU, vLLM and a local model.
// Keep all machine-specific values outside the repository (for example in a
// developer's shell or an ignored .env wrapper).
const env = process.env
const modelDirectory = env.ZC_LOCAL_VLLM_MODEL_DIR
const condaExecutable = env.ZC_LOCAL_VLLM_CONDA_EXECUTABLE
const condaEnvironment = env.ZC_LOCAL_VLLM_CONDA_ENV ?? 'vllm'
const runIntegration = modelDirectory !== undefined && condaExecutable !== undefined

describe.skipIf(!runIntegration)('local vLLM end-to-end flow', () => {
  const supervisor = new LocalVllmSupervisor()

  afterEach(async () => { await supervisor.dispose() })

  it('starts the configured model, detects PII, builds a mask, and sends only masked text', async () => {
    const config: ValidatedLocalVllmConfig = {
      condaExecutable: condaExecutable as string,
      condaEnvironment: { kind: 'name', value: condaEnvironment },
      modelDirectory: modelDirectory as string,
      gpuMemoryUtilization: Number(env.ZC_LOCAL_VLLM_GPU_MEMORY_UTILIZATION ?? '0.72'),
      maxModelLength: Number(env.ZC_LOCAL_VLLM_MAX_MODEL_LENGTH ?? '8192'),
      dtype: (env.ZC_LOCAL_VLLM_DTYPE ?? 'auto') as ValidatedLocalVllmConfig['dtype'],
      tensorParallelSize: Number(env.ZC_LOCAL_VLLM_TENSOR_PARALLEL_SIZE ?? '1'),
      autoStart: true,
    }

    await supervisor.start(config)
    const source = env.ZC_LOCAL_VLLM_TEST_TEXT ?? 'Please contact demo@example.com about the account.'
    const candidates = await supervisor.detect(source)
    const scan = finalizeScan(source, candidates, 'local-model', 'local-model', false, 'zeroclave-local-pii')
    expect(scan.findings.length).toBeGreaterThan(0)
    expect(scan.redactedText).not.toContain('demo@example.com')

    let sentBody = ''
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => { sentBody = Buffer.concat(chunks).toString('utf8'); response.end('ok') })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Could not start echo server')
    const response = await fetch(`http://127.0.0.1:${String(address.port)}`, { method: 'POST', body: scan.redactedText })
    await new Promise<void>(resolve => server.close(() => resolve()))
    expect(sentBody).not.toContain('demo@example.com')
    expect(response.status).toBe(200)
  }, Number(env.ZC_LOCAL_VLLM_TEST_TIMEOUT_MS ?? '600000'))
})
