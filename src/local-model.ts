import { finalizeScan, type FindingCandidate } from './detector.ts'
import type { DetectorProvider, EntityType, LocalModelMetadata, ScanResult } from './types.ts'

export const MAX_LOCAL_MODEL_BYTES = 8 * 1024 ** 3
export const MIN_CONTEXT_LENGTH = 512
export const SUPPORTED_QWEN_ARCHITECTURES = ['qwen', 'qwen2', 'qwen2moe', 'qwen3'] as const
export const SUPPORTED_QUANTIZATION_TYPES = new Set([0, 1, 2, 3, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
export const SUPPORTED_OUTPUT_PROTOCOLS = new Set(['1', '1.0', 'local-model.v1', 'zeroclave.local-model.v1'])

export type LocalModelErrorCode =
  | 'file_too_large' | 'format_invalid' | 'version_unsupported' | 'architecture_unsupported'
  | 'tokenizer_missing' | 'quantization_unsupported' | 'context_too_short' | 'manifest_invalid'
  | 'manifest_architecture_mismatch' | 'manifest_model_mismatch' | 'output_protocol_unsupported'
  | 'runtime_unavailable' | 'not_configured' | 'not_ready'

export class LocalModelError extends Error {
  constructor(readonly code: LocalModelErrorCode, message: string) {
    super(message)
    this.name = 'LocalModelError'
  }
}

export interface ParsedGguf {
  version: number
  architecture: string
  name?: string
  quantization: number
  contextLength: number
  hasTokenizer: boolean
  metadata: Readonly<Record<string, unknown>>
}

class Reader {
  private offset = 0
  constructor(private readonly view: DataView, private readonly bytes: Uint8Array) {}
  get position(): number { return this.offset }
  u32(): number { this.ensure(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value }
  u64(): number { this.ensure(8); const value = Number(this.view.getBigUint64(this.offset, true)); this.offset += 8; if (!Number.isSafeInteger(value)) throw new LocalModelError('format_invalid', 'GGUF integer is too large'); return value }
  str(): string { const length = this.u64(); if (length > this.bytes.length - this.offset) throw new LocalModelError('format_invalid', 'GGUF string is truncated'); let value: string; try { value = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.offset, this.offset + length)) } catch { throw new LocalModelError('format_invalid', 'GGUF contains invalid UTF-8 metadata') }; this.offset += length; return value }
  skip(size: number): void { this.ensure(size); this.offset += size }
  private ensure(size: number): void { if (size < 0 || this.offset > this.bytes.length - size) throw new LocalModelError('format_invalid', 'GGUF metadata is truncated') }
  value(type: number): unknown {
    if (type === 0) { this.ensure(1); const value = this.view.getUint8(this.offset); this.skip(1); return value }
    if (type === 1) { this.ensure(1); const value = this.view.getInt8(this.offset); this.skip(1); return value }
    if (type === 2) { this.ensure(2); const value = this.view.getUint16(this.offset, true); this.skip(2); return value }
    if (type === 3) { this.ensure(2); const value = this.view.getInt16(this.offset, true); this.skip(2); return value }
    if (type === 4) { this.ensure(4); const value = this.view.getUint32(this.offset, true); this.skip(4); return value }
    if (type === 5) { this.ensure(4); const value = this.view.getInt32(this.offset, true); this.skip(4); return value }
    if (type === 6) { this.ensure(4); const value = this.view.getFloat32(this.offset, true); this.skip(4); return value }
    if (type === 7) { this.ensure(1); const value = this.view.getUint8(this.offset) !== 0; this.skip(1); return value }
    if (type === 8) return this.str()
    if (type === 9) { const itemType = this.u32(); const count = this.u64(); if (count > 10_000_000) throw new LocalModelError('format_invalid', 'GGUF array is too large'); const values: unknown[] = []; for (let i = 0; i < count; i += 1) values.push(this.value(itemType)); return values }
    if (type === 10) { this.ensure(8); const value = this.view.getBigUint64(this.offset, true); this.skip(8); return Number(value) }
    if (type === 11) { this.ensure(8); const value = this.view.getBigInt64(this.offset, true); this.skip(8); return Number(value) }
    if (type === 12) { this.ensure(8); const value = this.view.getFloat64(this.offset, true); this.skip(8); return value }
    throw new LocalModelError('format_invalid', `Unknown GGUF metadata type ${String(type)}`)
  }
}

export async function parseGguf(file: Blob): Promise<ParsedGguf> {
  if (file.size > MAX_LOCAL_MODEL_BYTES) throw new LocalModelError('file_too_large', 'GGUF model exceeds the 8 GiB limit')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length < 24) throw new LocalModelError('format_invalid', 'GGUF header is truncated')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46554747) throw new LocalModelError('format_invalid', 'File is not a GGUF model')
  const reader = new Reader(view, bytes)
  reader.u32()
  const version = reader.u32()
  if (version !== 2 && version !== 3) throw new LocalModelError('version_unsupported', `GGUF version ${String(version)} is not supported`)
  reader.u64()
  const metadataCount = reader.u64()
  if (metadataCount > 100_000) throw new LocalModelError('format_invalid', 'GGUF metadata table is too large')
  const metadata: Record<string, unknown> = {}
  for (let i = 0; i < metadataCount; i += 1) { const key = reader.str(); metadata[key] = reader.value(reader.u32()) }
  const architecture = String(metadata['general.architecture'] ?? '').toLowerCase()
  if (!(SUPPORTED_QWEN_ARCHITECTURES as readonly string[]).includes(architecture)) throw new LocalModelError('architecture_unsupported', `Unsupported GGUF architecture: ${architecture || 'missing'}`)
  const tokens = metadata['tokenizer.ggml.tokens']
  if (!Array.isArray(tokens) || tokens.length === 0) throw new LocalModelError('tokenizer_missing', 'GGUF tokenizer vocabulary is missing')
  const contextValue = metadata[`${architecture}.context_length`] ?? metadata['general.context_length']
  const contextLength = Number(contextValue)
  if (!Number.isInteger(contextLength) || contextLength < MIN_CONTEXT_LENGTH) throw new LocalModelError('context_too_short', 'GGUF context length is below the supported minimum')
  const quantization = Number(metadata['general.file_type'])
  if (!Number.isInteger(quantization) || !SUPPORTED_QUANTIZATION_TYPES.has(quantization)) throw new LocalModelError('quantization_unsupported', 'GGUF quantization type is not supported')
  return { version, architecture, ...(typeof metadata['general.name'] === 'string' ? { name: metadata['general.name'] } : {}), quantization, contextLength, hasTokenizer: true, metadata }
}

export interface ModelManifest {
  modelId: string
  version: string
  architecture: string
  format: 'gguf'
  languages: readonly string[]
  chatTemplate: string
  systemPromptVersion: string
  outputProtocolVersion: string
  entityTypes: readonly EntityType[]
  maxContextLength: number
  recommendedGeneration: { temperature: number; topP: number; maxTokens: number }
  constrainedJson: boolean
  modelFileSha256?: string
}

const ENTITY_TYPES = new Set<EntityType>(['AGE','EMAIL','PHONE','PERSON','ADDRESS','COORDINATE','HONORIFIC','ORGANIZATION','NATIONAL_ID','CREDIT_CODE','BANK_ACCOUNT','BANK_NAME','CONTRACT_ID','DATE_TIME','FINANCIAL','CREDIT_CARD','IBAN_CODE','IP_ADDRESS','IMEI','MAC_ADDRESS','NRP','URL','TITLE','PASSWORD','PRIVATE_KEY','API_KEY','US_DRIVER_LICENSE','US_ITIN','US_LICENSE_PLATE','US_PASSPORT','US_SSN','OTHER'])

export async function parseManifest(file: Blob): Promise<ModelManifest> {
  let raw: unknown
  try { raw = JSON.parse(await file.text()) } catch { throw new LocalModelError('manifest_invalid', 'Manifest is not valid JSON') }
  if (typeof raw !== 'object' || raw === null) throw new LocalModelError('manifest_invalid', 'Manifest must be an object')
  const item = raw as Record<string, unknown>
  const pick = (...keys: string[]): unknown => keys.map(key => item[key]).find(value => value !== undefined)
  const modelId = typeof pick('modelId', 'model_id') === 'string' ? String(pick('modelId', 'model_id')).trim() : ''
  const version = typeof pick('version', 'modelVersion', 'model_version') === 'string' ? String(pick('version', 'modelVersion', 'model_version')).trim() : ''
  const architecture = typeof pick('architecture', 'modelArchitecture', 'model_architecture') === 'string' ? String(pick('architecture', 'modelArchitecture', 'model_architecture')).trim().toLowerCase() : ''
  const formatValue = pick('format', 'modelFormat', 'model_format')
  const format = typeof formatValue === 'string' && formatValue.toLowerCase() === 'gguf' ? 'gguf' : undefined
  const languageValue = pick('languages', 'supportedLanguages', 'supported_languages')
  const languages = Array.isArray(languageValue) && languageValue.every(value => typeof value === 'string') ? languageValue as string[] : []
  const entityValue = pick('entityTypes', 'entity_types', 'supportedEntityTypes', 'supported_entity_types')
  const entityTypes = Array.isArray(entityValue) && entityValue.every(value => typeof value === 'string' && ENTITY_TYPES.has(value as EntityType)) ? entityValue as EntityType[] : []
  const outputValue = pick('outputProtocolVersion', 'output_protocol_version')
  const outputProtocolVersion = typeof outputValue === 'number' ? String(outputValue) : typeof outputValue === 'string' ? outputValue : ''
  const contextValue = pick('maxContextLength', 'max_context_length')
  const maxContextLength = Number(contextValue)
  const templateValue = pick('chatTemplate', 'chat_template')
  const systemValue = pick('systemPromptVersion', 'system_prompt_version')
  const generation = pick('recommendedGeneration', 'recommended_generation', 'generation')
  const recommendedGeneration = typeof generation === 'object' && generation !== null ? generation as Record<string, unknown> : {}
  const temperature = Number(pickFrom(recommendedGeneration, 'temperature'))
  const topP = Number(pickFrom(recommendedGeneration, 'topP', 'top_p'))
  const maxTokens = Number(pickFrom(recommendedGeneration, 'maxTokens', 'max_tokens'))
  const constrainedValue = pick('constrainedJson', 'constrained_json', 'supportsConstrainedJson', 'supports_constrained_json')
  if (!modelId || !version || !architecture || format === undefined || languages.length === 0 || typeof templateValue !== 'string' || typeof systemValue !== 'string' || !SUPPORTED_OUTPUT_PROTOCOLS.has(outputProtocolVersion) || entityTypes.length === 0 || !Number.isInteger(maxContextLength) || maxContextLength < MIN_CONTEXT_LENGTH || !Number.isFinite(temperature) || !Number.isFinite(topP) || !Number.isInteger(maxTokens) || typeof constrainedValue !== 'boolean') throw new LocalModelError('manifest_invalid', 'Manifest is missing required fields or contains unsafe values')
  if (temperature < 0 || temperature > 2 || topP <= 0 || topP > 1 || maxTokens < 1 || maxTokens > maxContextLength) throw new LocalModelError('manifest_invalid', 'Manifest generation parameters are outside safe bounds')
  const fingerprint = pick('modelFileSha256', 'model_file_sha256', 'sha256')
  return { modelId, version, architecture, format, languages, chatTemplate: templateValue, systemPromptVersion: systemValue, outputProtocolVersion, entityTypes, maxContextLength, recommendedGeneration: { temperature, topP, maxTokens }, constrainedJson: constrainedValue, ...(typeof fingerprint === 'string' ? { modelFileSha256: fingerprint.toLowerCase() } : {}) }
}

function pickFrom(value: Record<string, unknown>, ...keys: string[]): unknown {
  return keys.map(key => value[key]).find(item => item !== undefined)
}

async function sha256(file: Blob): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') }

export interface ValidatedLocalModel { manifest: ModelManifest; gguf: ParsedGguf; metadata: LocalModelMetadata; file: Blob }

export async function validateLocalModel(modelFile: Blob & { name?: string }, manifestFile: Blob): Promise<ValidatedLocalModel> {
  const gguf = await parseGguf(modelFile); const manifest = await parseManifest(manifestFile)
  if (manifest.architecture !== gguf.architecture) throw new LocalModelError('manifest_architecture_mismatch', 'Manifest architecture does not match GGUF metadata')
  const normalizedName = gguf.name?.toLowerCase().replace(/[^a-z0-9]+/gu, '')
  const normalizedId = manifest.modelId.toLowerCase().replace(/[^a-z0-9]+/gu, '')
  if (normalizedName !== undefined && normalizedName !== '' && !normalizedName.includes(normalizedId) && !normalizedId.includes(normalizedName)) throw new LocalModelError('manifest_model_mismatch', 'Manifest model identifier conflicts with GGUF metadata')
  if (manifest.maxContextLength > gguf.contextLength) throw new LocalModelError('manifest_invalid', 'Manifest context length exceeds GGUF context length')
  const fileSha256 = await sha256(modelFile)
  if (manifest.modelFileSha256 !== undefined && manifest.modelFileSha256 !== fileSha256) throw new LocalModelError('manifest_invalid', 'Manifest model fingerprint does not match the selected file')
  const metadata: LocalModelMetadata = { modelId: manifest.modelId, version: manifest.version, architecture: gguf.architecture, format: 'gguf', fileName: modelFile.name ?? 'model.gguf', fileSize: modelFile.size, fileSha256, quantization: `type-${String(gguf.quantization)}`, contextLength: manifest.maxContextLength, languages: manifest.languages, outputProtocolVersion: manifest.outputProtocolVersion }
  return { manifest, gguf, metadata, file: modelFile }
}

export interface ModelRuntimeAdapter {
  load(model: ValidatedLocalModel, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<void>
  scan(text: string, signal?: AbortSignal): Promise<readonly FindingCandidate[]>
  unload(): Promise<void>
}

export class UnavailableModelRuntimeAdapter implements ModelRuntimeAdapter {
  async load(): Promise<void> { throw new LocalModelError('runtime_unavailable', 'No GGUF/WebGPU runtime is installed') }
  async scan(): Promise<readonly FindingCandidate[]> { throw new LocalModelError('runtime_unavailable', 'No GGUF/WebGPU runtime is installed') }
  async unload(): Promise<void> { return undefined }
}


interface RuntimeWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent | ErrorEvent) => void): void
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent | ErrorEvent) => void): void
}

/** Thin RPC adapter; the worker owns tokenizer, prompt construction and WebGPU state. */
export class WebWorkerModelRuntimeAdapter implements ModelRuntimeAdapter {
  private worker: RuntimeWorker | undefined
  private nextId = 0
  constructor(private readonly createWorker: () => RuntimeWorker, private readonly workerUrl: string | URL) {}
  async load(model: ValidatedLocalModel, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    this.worker?.terminate(); this.worker = this.createWorker()
    const bytes = await model.file.arrayBuffer()
    await this.request('load', { url: String(this.workerUrl), model: bytes, manifest: model.manifest }, [bytes], onProgress, signal)
  }
  async scan(text: string, signal?: AbortSignal): Promise<readonly FindingCandidate[]> {
    const value = await this.request('scan', { text }, [], undefined, signal)
    if (!Array.isArray(value)) throw new LocalModelError('runtime_unavailable', 'Worker returned an invalid detection result')
    return value as FindingCandidate[]
  }
  async unload(): Promise<void> { this.worker?.terminate(); this.worker = undefined }
  private request(type: string, payload: Record<string, unknown>, transfer: Transferable[], onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<unknown> {
    const worker = this.worker
    if (worker === undefined) return Promise.reject(new LocalModelError('runtime_unavailable', 'Worker is not initialized'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); signal?.removeEventListener('abort', onAbort) }
      const onAbort = (): void => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
      const onError = (event: MessageEvent | ErrorEvent): void => { cleanup(); reject(new LocalModelError('runtime_unavailable', event instanceof ErrorEvent ? event.message : 'Worker failed')) }
      const onMessage = (event: MessageEvent | ErrorEvent): void => {
        const data = 'data' in event ? event.data as { id?: number; type?: string; progress?: number; result?: unknown; error?: string } | undefined : undefined
        if (data?.id !== id) return
        if (data.type === 'progress') { if (typeof data.progress === 'number') onProgress?.(data.progress); return }
        cleanup()
        if (data.type === 'error') reject(new LocalModelError('runtime_unavailable', data.error ?? 'Worker request failed'))
        else resolve(data.result)
      }
      worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); signal?.addEventListener('abort', onAbort, { once: true })
      worker.postMessage({ id, type, ...payload }, transfer)
    })
  }
}

export class LocalModelDetector implements DetectorProvider {
  readonly id = 'local-model' as const
  readonly label = 'Local GGUF model'
  readonly locality = 'browser' as const
  private selected?: ValidatedLocalModel
  private runtimeReady = false
  constructor(private readonly runtime: ModelRuntimeAdapter = new UnavailableModelRuntimeAdapter()) {}
  available(): boolean { return this.runtimeReady && this.selected !== undefined }
  get metadata(): LocalModelMetadata | undefined { return this.selected?.metadata }
  async select(modelFile: Blob & { name?: string }, manifestFile: Blob): Promise<LocalModelMetadata> { this.selected = await validateLocalModel(modelFile, manifestFile); this.runtimeReady = false; return this.selected.metadata }
  async load(onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<void> { if (this.selected === undefined) throw new LocalModelError('not_configured', 'Select a GGUF model and manifest first'); await this.runtime.load(this.selected, onProgress, signal); this.runtimeReady = true }
  async unload(): Promise<void> { this.runtimeReady = false; await this.runtime.unload() }
  async scan(text: string, signal?: AbortSignal): Promise<ScanResult> { if (!this.available() || this.selected === undefined) throw new LocalModelError('not_ready', 'Local model is not ready'); return finalizeScan(text, await this.runtime.scan(text, signal), 'local-model', 'local-model', false, this.selected.metadata.modelId) }
}
