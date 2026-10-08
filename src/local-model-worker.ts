import { AutoModelForCausalLM, AutoTokenizer, env } from '@huggingface/transformers'
import { buildQwenMessages, buildQwenPrompt, LocalModelProtocolError, modelOutputToCandidates, parseModelOutput } from './local-model-protocol.ts'
import type { EntityType } from './types.ts'

type WorkerRequest = {
  type: 'load' | 'scan'
  files?: Array<{ path: string; bytes: ArrayBuffer }>
  manifest?: { modelId: string; chatTemplate: string; entityTypes: readonly string[]; maxContextLength: number; recommendedGeneration: { maxTokens: number } }
  config?: Record<string, unknown>
  text?: string
}

type WorkerScope = {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void
}
const scope = globalThis as unknown as WorkerScope
let tokenizer: any
let model: any
let manifest: WorkerRequest['manifest']
let originalFetch: typeof fetch | undefined
const localFiles = new Map<string, Uint8Array>()

function errorCode(error: unknown): string {
  if (error instanceof LocalModelProtocolError) return error.reason === 'partial' ? 'partial_result' : 'output_invalid'
  const message = error instanceof Error ? error.message : String(error)
  if (/out of memory|allocation failed|oom/iu.test(message)) return 'out_of_memory'
  if (/device.*lost|webgpu.*lost|gpu.*lost/iu.test(message)) return 'device_lost'
  if (/timeout|timed out/iu.test(message)) return 'inference_timeout'
  return 'runtime_unavailable'
}

function postError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  scope.postMessage({ type: 'error', code: errorCode(error), error: message })
}

function localPath(url: string): string {
  try { return new URL(url).pathname.replace(/^\/+/, '') } catch { return url.replace(/^\/+/, '') }
}

function installLocalFetch(): void {
  if (originalFetch !== undefined) return
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const path = localPath(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const key = [...localFiles.keys()].find(candidate => {
      const basename = candidate.split('/').pop() ?? candidate
      return path.endsWith(candidate) || candidate.endsWith(path) || path.endsWith(`/${basename}`) || path === basename
    })
    if (key !== undefined) {
      const bytes = localFiles.get(key)!.slice()
      return new Response(bytes.buffer, { status: 200, headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/octet-stream' } })
    }
    if (/\/onnx(?:\/|$)/iu.test(path)) throw new Error('The bundled browser backend requires ONNX weights; raw safetensors Qwen3.5 inference is not available in this runtime')
    throw new Error(`Remote model fetch blocked: ${path}`)
  }
}

async function load(request: WorkerRequest): Promise<void> {
  if (request.files === undefined || request.manifest === undefined) throw new Error('Worker received no user-selected model files')
  localFiles.clear()
  for (const entry of request.files) localFiles.set(entry.path, new Uint8Array(entry.bytes))
  manifest = request.manifest
  installLocalFetch()
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useBrowserCache = false
  scope.postMessage({ type: 'progress', progress: 20 })
  tokenizer = await AutoTokenizer.from_pretrained(manifest.modelId)
  scope.postMessage({ type: 'progress', progress: 55 })
  model = await AutoModelForCausalLM.from_pretrained(manifest.modelId, { device: 'webgpu', dtype: 'fp16' })
  scope.postMessage({ type: 'progress', progress: 90 })
  // A one-token warmup verifies the graph and WebGPU device before the model is selectable.
  const warmupInputs = await tokenizer('PII', { return_tensors: 'pt' })
  await model.generate({ ...warmupInputs, max_new_tokens: 1, do_sample: false })
}

async function scan(request: WorkerRequest): Promise<void> {
  if (tokenizer === undefined || model === undefined || manifest === undefined) throw new Error('Local Transformers model is not ready')
  const text = request.text ?? ''
  const messages = buildQwenMessages(text, manifest as never)
  const prompt = typeof tokenizer.apply_chat_template === 'function'
    ? tokenizer.apply_chat_template([
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.user },
    ], { tokenize: false, add_generation_prompt: true }) as string
    : buildQwenPrompt(text, manifest as never)
  const inputs = await tokenizer(prompt, { return_tensors: 'pt' })
  const output = await model.generate({ ...inputs, max_new_tokens: Math.min(manifest.recommendedGeneration.maxTokens, 512), do_sample: false, temperature: 0, top_p: 1 })
  const inputIds = typeof inputs.input_ids?.tolist === 'function' ? inputs.input_ids.tolist()[0] as number[] : undefined
  const outputIds = typeof output?.tolist === 'function' ? output.tolist()[0] as number[] : undefined
  const generatedIds = inputIds !== undefined && outputIds !== undefined ? outputIds.slice(inputIds.length) : output
  const decoded = Array.isArray(generatedIds) && typeof generatedIds[0] === 'number'
    ? tokenizer.decode(generatedIds, { skip_special_tokens: false })
    : tokenizer.batch_decode(output, { skip_special_tokens: false })[0]
  if (typeof decoded !== 'string') throw new Error('Transformers model returned no text')
  const parsed = parseModelOutput(decoded, text, manifest.entityTypes as readonly EntityType[])
  scope.postMessage({ type: 'result', result: modelOutputToCandidates(parsed) })
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void (event.data.type === 'load' ? load(event.data).then(() => scope.postMessage({ type: 'result', result: true })) : scan(event.data)).catch(postError)
})
