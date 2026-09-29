import { Wllama } from '@wllama/wllama/esm/index.js'
import { buildQwenPrompt, LocalModelProtocolError, modelOutputToCandidates, parseModelOutput } from './local-model-protocol.ts'
import { LocalModelError, type LocalModelRuntimeEvent, type ModelRuntimeAdapter, type ValidatedLocalModel } from './local-model.ts'
import type { FindingCandidate } from './detector.ts'
import modelWasm from 'virtual:zeroclave-wllama-wasm'

const DEFAULT_LOAD_TIMEOUT_MS = 120_000
const DEFAULT_INFERENCE_TIMEOUT_MS = 30_000
const MAX_OUTPUT_TOKENS = 512
const ALL_GPU_LAYERS = 99_999
const MINIMUM_BUFFER_BYTES = 64 * 1024 ** 2

interface GpuLimitsLike {
  maxBufferSize?: number
  maxStorageBufferBindingSize?: number
}

interface GpuDeviceLike {
  limits: GpuLimitsLike
  destroy?(): void
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>
}

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>
}

interface NavigatorLike {
  gpu?: GpuLike
}

interface CompletionChoice {
  text: string
  finish_reason: 'stop' | 'length' | 'content_filter' | null
}

interface WllamaLike {
  isSupportWebGPU(): boolean
  /** Disable Wllama's optional CDN-backed compatibility runtime. */
  setCompat?(compat: null): void
  loadModel(files: Blob[], options: Record<string, unknown>): Promise<void>
  getLoadedContextInfo(): { n_ctx: number }
  createCompletion(options: Record<string, unknown>): Promise<{ choices: readonly CompletionChoice[] }>
  exit(): Promise<void>
}

type RuntimeFactory = (wasmURL: string) => WllamaLike

export interface WllamaWebGpuRuntimeInternals {
  navigator?: NavigatorLike
  createRuntime?: RuntimeFactory
  loadTimeoutMs?: number
  inferenceTimeoutMs?: number
}

function defaultNavigator(): NavigatorLike | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator as NavigatorLike
}

function defaultRuntime(wasmURL: string): WllamaLike {
  return new Wllama({ default: wasmURL }, {
    suppressNativeLog: true,
    logger: { debug: () => undefined, log: () => undefined, warn: () => undefined, error: () => undefined },
  }) as unknown as WllamaLike
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

async function withDeadline<T>(
  run: () => Promise<T>, timeoutMs: number, code: 'load_timeout' | 'inference_timeout', signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) throw abortError(signal)
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new LocalModelError(code, code === 'load_timeout'
        ? 'Loading the local model timed out'
        : 'Local-model inference timed out'))
    }, timeoutMs)
    const onAbort = (): void => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void run().then(value => {
      cleanup()
      resolve(value)
    }, error => {
      cleanup()
      reject(error)
    })
  })
}

function localError(error: unknown): LocalModelError {
  if (error instanceof LocalModelError) return error
  if (error instanceof LocalModelProtocolError) {
    return new LocalModelError(error.reason === 'partial' ? 'partial_result' : 'output_invalid', error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (/out of memory|\boom\b|allocation failed/u.test(normalized)) {
    return new LocalModelError('out_of_memory', 'The GPU or browser does not have enough memory for this model')
  }
  if (/device.*lost|webgpu.*lost|gpu.*lost/u.test(normalized)) {
    return new LocalModelError('device_lost', 'The WebGPU device was lost while running the local model')
  }
  if (/context.*(?:full|length|exceed)|(?:full|exceed).*context|n_ctx/u.test(normalized)) {
    return new LocalModelError('context_too_short', 'The draft exceeds the local model context limit')
  }
  return new LocalModelError('runtime_unavailable', message || 'The local GGUF runtime failed')
}

function codePointCount(value: string): number {
  return Array.from(value).length
}

function grammarFor(entityTypes: readonly string[]): string {
  const types = entityTypes.map(type => JSON.stringify(type)).join(' | ')
  return [
    'root ::= ws "{" ws "\\"entities\\"" ws ":" ws "[" ws (entity (ws "," ws entity)*)? ws "]" ws "}" ws',
    'entity ::= "{" ws "\\"type\\"" ws ":" ws entity_type ws "," ws "\\"start\\"" ws ":" ws integer ws "," ws "\\"end\\"" ws ":" ws integer ws "," ws "\\"text\\"" ws ":" ws string (ws "," ws "\\"confidence\\"" ws ":" ws number)? ws "}"',
    'entity_type ::= ' + types,
    'integer ::= "-"? [0-9]+',
    'number ::= "-"? [0-9]+ ("." [0-9]+)? ([eE] [+-]? [0-9]+)?',
    'string ::= "\\"" char* "\\""',
    'char ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" hex hex hex hex)',
    'hex ::= [0-9a-fA-F]',
    'ws ::= [ \\t\\n\\r]*',
  ].join('\n')
}

/**
 * A browser-only GGUF adapter. Wllama owns its own Worker, tokenizer, model buffers and
 * WebGPU backend, so neither model bytes nor the draft leave the page process.
 */
export class WllamaWebGpuRuntimeAdapter implements ModelRuntimeAdapter {
  private runtime: WllamaLike | undefined
  private model: ValidatedLocalModel | undefined
  private listener: ((event: LocalModelRuntimeEvent) => void) | undefined
  private unloading = false
  private readonly internals: {
    navigator: NavigatorLike | undefined
    createRuntime: RuntimeFactory
    loadTimeoutMs: number
    inferenceTimeoutMs: number
  }

  constructor(internals: WllamaWebGpuRuntimeInternals = {}) {
    this.internals = {
      navigator: internals.navigator ?? defaultNavigator(),
      createRuntime: internals.createRuntime ?? defaultRuntime,
      loadTimeoutMs: internals.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      inferenceTimeoutMs: internals.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS,
    }
  }

  setEventListener(listener: (event: LocalModelRuntimeEvent) => void): void {
    this.listener = listener
  }

  async load(model: ValidatedLocalModel, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    await this.unload()
    let runtime: WllamaLike | undefined
    try {
      const gpu = this.internals.navigator?.gpu
      if (gpu === undefined) throw new LocalModelError('webgpu_unavailable', 'WebGPU is not available in this browser')
      onProgress?.(2)
      const adapter = await withDeadline(() => gpu.requestAdapter(), this.internals.loadTimeoutMs, 'load_timeout', signal)
      if (adapter === null) throw new LocalModelError('webgpu_unavailable', 'No compatible WebGPU adapter was found')
      const device = await withDeadline(() => adapter.requestDevice(), this.internals.loadTimeoutMs, 'load_timeout', signal)
      const limit = Math.max(
        Number(device.limits.maxBufferSize ?? 0),
        Number(device.limits.maxStorageBufferBindingSize ?? 0),
      )
      // A model is composed of many buffers, so comparing its whole file size to WebGPU's
      // single-buffer limit would incorrectly reject otherwise usable Qwen models. A reported
      // limit below this floor cannot support the runtime's minimum working buffers.
      if (Number.isFinite(limit) && limit > 0 && limit < MINIMUM_BUFFER_BYTES) {
        device.destroy?.()
        throw new LocalModelError('out_of_memory', 'The WebGPU adapter does not expose enough buffer capacity for this model')
      }
      // This is a capability probe. The inference worker requests and owns its own device.
      device.destroy?.()
      onProgress?.(8)
      runtime = this.internals.createRuntime(modelWasm)
      // Wllama enables a CDN compatibility runtime by default on some browsers. Keep the
      // local-model detector strictly self-contained: an unsupported browser must fail closed.
      runtime.setCompat?.(null)
      if (!runtime.isSupportWebGPU()) throw new LocalModelError('webgpu_unavailable', 'The local runtime cannot use WebGPU in this browser')
      onProgress?.(15)
      await withDeadline(() => runtime!.loadModel([model.file], {
        n_ctx: model.manifest.maxContextLength,
        n_batch: Math.min(512, model.manifest.maxContextLength),
        n_gpu_layers: ALL_GPU_LAYERS,
        // Keep one sequence and a bounded KV cache. A value of zero GPU layers is never used.
        n_threads: 1,
        flash_attn: true,
        warmup: true,
      }), this.internals.loadTimeoutMs, 'load_timeout', signal)
      if (runtime.getLoadedContextInfo().n_ctx < model.manifest.maxContextLength) {
        throw new LocalModelError('context_too_short', 'The loaded runtime context is smaller than the manifest contract')
      }
      this.runtime = runtime
      this.model = model
      onProgress?.(100)
    } catch (error) {
      await runtime?.exit().catch(() => undefined)
      this.runtime = undefined
      this.model = undefined
      throw localError(error)
    }
  }

  async scan(text: string, signal?: AbortSignal): Promise<readonly FindingCandidate[]> {
    const runtime = this.runtime
    const model = this.model
    if (runtime === undefined || model === undefined) throw new LocalModelError('not_ready', 'Local model is not ready')
    const prompt = buildQwenPrompt(text, model.manifest)
    const maxTokens = Math.min(model.manifest.recommendedGeneration.maxTokens, MAX_OUTPUT_TOKENS)
    // This conservative guard prevents an unbounded prompt from reaching the runtime.
    if (codePointCount(prompt) + maxTokens > model.manifest.maxContextLength * 4) {
      throw new LocalModelError('context_too_short', 'The draft exceeds the configured local-model context limit')
    }
    try {
      const response = await withDeadline(() => runtime.createCompletion({
        prompt,
        temperature: 0,
        top_p: 1,
        max_tokens: maxTokens,
        stop: ['<|im_end|>', '<|endoftext|>'],
        abortSignal: signal,
        ...(model.manifest.constrainedJson ? { grammar: grammarFor(model.manifest.entityTypes) } : {}),
      }), this.internals.inferenceTimeoutMs, 'inference_timeout', signal)
      const choice = response.choices[0]
      if (choice === undefined || choice.finish_reason !== 'stop') {
        throw new LocalModelError('partial_result', 'Local-model generation did not complete')
      }
      return modelOutputToCandidates(parseModelOutput(choice.text, text, model.manifest.entityTypes))
    } catch (error) {
      const resolved = localError(error)
      if (resolved.code === 'device_lost') this.listener?.({ code: resolved.code, message: resolved.message })
      if (resolved.code === 'device_lost' || resolved.code === 'out_of_memory'
        || resolved.code === 'inference_timeout' || resolved.code === 'runtime_unavailable') {
        await this.unload().catch(() => undefined)
      }
      throw resolved
    }
  }

  async unload(): Promise<void> {
    if (this.unloading) return
    this.unloading = true
    const runtime = this.runtime
    this.runtime = undefined
    this.model = undefined
    try {
      await runtime?.exit()
    } finally {
      this.unloading = false
    }
  }
}
