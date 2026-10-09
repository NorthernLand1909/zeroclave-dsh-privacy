import { mergeLocalModelCandidates, type FindingCandidate } from './detector.ts'
import type { DetectorProvider, EntityType, LocalModelMetadata, ScanResult } from './types.ts'

export const MAX_LOCAL_MODEL_BYTES = 8 * 1024 ** 3
export const MIN_CONTEXT_LENGTH = 512
export const SUPPORTED_QWEN_ARCHITECTURES = ['qwen', 'qwen2', 'qwen2moe', 'qwen3', 'qwen3_5'] as const
export const SUPPORTED_QUANTIZATION_TYPES = new Set([0, 1, 2, 3, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
export const SUPPORTED_OUTPUT_PROTOCOLS = new Set(['1', '1.0', 'local-model.v1', 'zeroclave.local-model.v1'])

export type LocalModelErrorCode =
  | 'file_too_large' | 'format_invalid' | 'version_unsupported' | 'architecture_unsupported'
  | 'tokenizer_missing' | 'quantization_unsupported' | 'context_too_short' | 'manifest_invalid'
  | 'manifest_architecture_mismatch' | 'manifest_model_mismatch' | 'output_protocol_unsupported'
  | 'runtime_unavailable' | 'webgpu_unavailable' | 'device_lost' | 'out_of_memory' | 'load_timeout' | 'inference_timeout' | 'output_invalid' | 'partial_result' | 'not_configured' | 'not_ready'

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

export interface TransformersModelFile {
  file: Blob & { name?: string; webkitRelativePath?: string }
  path: string
}

export interface TransformersModelConfig {
  modelType: string
  architectures: readonly string[]
  vocabSize?: number | undefined
  hiddenSize?: number | undefined
  numHiddenLayers?: number | undefined
  maxPositionEmbeddings?: number | undefined
  torchDtype?: string | undefined
  raw: Readonly<Record<string, unknown>>
}

export interface TransformersModelDirectory {
  files: ReadonlyMap<string, TransformersModelFile>
  config: TransformersModelConfig
  tokenizer: TransformersModelFile
  tokenizerConfig?: TransformersModelFile
  chatTemplate?: TransformersModelFile
  generationConfig?: TransformersModelFile
  weightFiles: readonly TransformersModelFile[]
  weightIndex?: TransformersModelFile
  totalWeightBytes: number
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
  format: 'gguf' | 'transformers'
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
  if (!modelId || !version || !architecture || format === undefined || languages.length === 0 || typeof templateValue !== 'string' || typeof systemValue !== 'string' || entityTypes.length === 0 || !Number.isInteger(maxContextLength) || maxContextLength < MIN_CONTEXT_LENGTH || !Number.isFinite(temperature) || !Number.isFinite(topP) || !Number.isInteger(maxTokens) || typeof constrainedValue !== 'boolean') throw new LocalModelError('manifest_invalid', 'Manifest is missing required fields or contains unsafe values')
  if (!SUPPORTED_OUTPUT_PROTOCOLS.has(outputProtocolVersion)) throw new LocalModelError('output_protocol_unsupported', `Output protocol ${outputProtocolVersion || '(missing)'} is not supported`)
  if (temperature < 0 || temperature > 2 || topP <= 0 || topP > 1 || maxTokens < 1 || maxTokens > maxContextLength) throw new LocalModelError('manifest_invalid', 'Manifest generation parameters are outside safe bounds')
  const fingerprint = pick('modelFileSha256', 'model_file_sha256', 'sha256')
  return { modelId, version, architecture, format, languages, chatTemplate: templateValue, systemPromptVersion: systemValue, outputProtocolVersion, entityTypes, maxContextLength, recommendedGeneration: { temperature, topP, maxTokens }, constrainedJson: constrainedValue, ...(typeof fingerprint === 'string' ? { modelFileSha256: fingerprint.toLowerCase() } : {}) }
}

function pickFrom(value: Record<string, unknown>, ...keys: string[]): unknown {
  return keys.map(key => value[key]).find(item => item !== undefined)
}

async function sha256(file: Blob): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') }

const DEFAULT_LOCAL_ENTITY_TYPES: readonly EntityType[] = [
  'AGE', 'EMAIL', 'PHONE', 'PERSON', 'ADDRESS', 'COORDINATE', 'HONORIFIC', 'ORGANIZATION',
  'NATIONAL_ID', 'CREDIT_CODE', 'BANK_ACCOUNT', 'BANK_NAME', 'CONTRACT_ID', 'DATE_TIME',
  'FINANCIAL', 'CREDIT_CARD', 'IBAN_CODE', 'IP_ADDRESS', 'IMEI', 'MAC_ADDRESS', 'NRP', 'URL',
  'TITLE', 'PASSWORD', 'PRIVATE_KEY', 'API_KEY', 'US_DRIVER_LICENSE', 'US_ITIN',
  'US_LICENSE_PLATE', 'US_PASSPORT', 'US_SSN', 'OTHER',
]

function normalizedDirectoryPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '')
  if (normalized.split('/').some(part => part === '..' || part === '')) throw new LocalModelError('format_invalid', 'Model file path contains an unsafe directory segment')
  return normalized
}

function modelFilePath(file: TransformersModelFile['file']): string {
  const relative = typeof file.webkitRelativePath === 'string' && file.webkitRelativePath !== ''
    ? file.webkitRelativePath : file.name ?? ''
  return normalizedDirectoryPath(relative)
}

async function jsonObject(file: Blob, message: string): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = JSON.parse(await file.text()) } catch { throw new LocalModelError('format_invalid', message) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalModelError('format_invalid', message)
  return value as Record<string, unknown>
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stringArrayField(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
}

async function readSafeTensorHeader(file: Blob): Promise<Readonly<Record<string, unknown>>> {
  if (file.size < 8) throw new LocalModelError('format_invalid', 'safetensors header is truncated')
  const prefix = new DataView(await file.slice(0, 8).arrayBuffer())
  const headerLength = Number(prefix.getBigUint64(0, true))
  if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > file.size - 8 || headerLength > 64 * 1024 ** 2) {
    throw new LocalModelError('format_invalid', 'safetensors header length is invalid')
  }
  const header = await file.slice(8, 8 + headerLength).text()
  const parsed = await jsonObject(new Blob([header]), 'safetensors header is not valid JSON')
  if (Object.keys(parsed).every(name => name === '__metadata__')) throw new LocalModelError('format_invalid', 'safetensors header contains no tensors')
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '__metadata__') continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalModelError('format_invalid', 'safetensors tensor metadata is invalid')
    const tensor = value as Record<string, unknown>
    if (!Array.isArray(tensor.shape) || !tensor.shape.every(item => Number.isSafeInteger(item) && Number(item) >= 0)
      || !Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2
      || !tensor.data_offsets.every(item => Number.isSafeInteger(item) && Number(item) >= 0)
      || typeof tensor.dtype !== 'string') throw new LocalModelError('format_invalid', `safetensors tensor ${name} is invalid`)
    const offsets = tensor.data_offsets as number[]
    const dataBytes = file.size - 8 - headerLength
    if (offsets[0] === undefined || offsets[1] === undefined || offsets[0] > offsets[1] || offsets[1] > dataBytes) {
      throw new LocalModelError('format_invalid', `safetensors tensor ${name} has out-of-bounds data offsets`)
    }
  }
  return parsed
}

function findDirectoryFile(files: readonly TransformersModelFile[], suffix: string): TransformersModelFile | undefined {
  return files.find(item => item.path.toLowerCase().endsWith(suffix))
}

function modelIdFromConfig(config: TransformersModelConfig, files: readonly TransformersModelFile[]): string {
  const configured = config.raw['_name_or_path']
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim().split(/[\\/]/u).pop() ?? configured.trim()
  const firstPath = files.find(item => item.path.includes('/'))?.path
  const first = firstPath?.split('/')[0]
  return first === undefined || first === '' ? 'user-selected-transformers-model' : first
}

export async function parseTransformersDirectory(
  input: readonly (Blob & { name?: string; webkitRelativePath?: string })[],
): Promise<TransformersModelDirectory> {
  const entries = input.map(file => ({ file, path: modelFilePath(file) })).filter(item => item.path !== '')
  const files = new Map<string, TransformersModelFile>()
  for (const entry of entries) {
    if (files.has(entry.path)) throw new LocalModelError('format_invalid', `Duplicate model file: ${entry.path}`)
    files.set(entry.path, entry)
  }
  const all = [...files.values()]
  const configFile = findDirectoryFile(all, 'config.json')
  if (configFile === undefined) throw new LocalModelError('format_invalid', 'Transformers model directory is missing config.json')
  const raw = await jsonObject(configFile.file, 'config.json is not valid JSON')
  const modelType = typeof raw.model_type === 'string' ? raw.model_type.toLowerCase() : ''
  const architectures = stringArrayField(raw.architectures)
  if (modelType !== 'qwen3_5' || !architectures.some(value => /qwen3_5.*(?:causal|conditional|generation)/iu.test(value))) {
    throw new LocalModelError('architecture_unsupported', `Unsupported Transformers architecture: ${modelType || 'missing'}`)
  }
  const config: TransformersModelConfig = {
    modelType,
    architectures,
    vocabSize: numberField(raw.vocab_size) ?? (typeof raw.text_config === 'object' && raw.text_config !== null ? numberField((raw.text_config as Record<string, unknown>).vocab_size) : undefined),
    hiddenSize: numberField(raw.hidden_size) ?? (typeof raw.text_config === 'object' && raw.text_config !== null ? numberField((raw.text_config as Record<string, unknown>).hidden_size) : undefined),
    numHiddenLayers: numberField(raw.num_hidden_layers) ?? (typeof raw.text_config === 'object' && raw.text_config !== null ? numberField((raw.text_config as Record<string, unknown>).num_hidden_layers) : undefined),
    maxPositionEmbeddings: numberField(raw.max_position_embeddings) ?? (typeof raw.text_config === 'object' && raw.text_config !== null ? numberField((raw.text_config as Record<string, unknown>).max_position_embeddings) : undefined),
    torchDtype: typeof raw.torch_dtype === 'string' ? raw.torch_dtype : typeof raw.dtype === 'string' ? raw.dtype : undefined,
    raw,
  }
  if (config.vocabSize === undefined || config.hiddenSize === undefined || config.numHiddenLayers === undefined
    || config.maxPositionEmbeddings === undefined || config.maxPositionEmbeddings < MIN_CONTEXT_LENGTH) {
    throw new LocalModelError('manifest_invalid', 'Qwen3.5 config is missing safe text-model dimensions')
  }
  const tokenizer = findDirectoryFile(all, 'tokenizer.json')
  if (tokenizer === undefined || tokenizer.file.size === 0) throw new LocalModelError('tokenizer_missing', 'Transformers model directory is missing tokenizer.json')
  const tokenizerConfig = findDirectoryFile(all, 'tokenizer_config.json')
  const chatTemplate = findDirectoryFile(all, 'chat_template.jinja')
  const generationConfig = findDirectoryFile(all, 'generation_config.json')
  if (chatTemplate === undefined && tokenizerConfig === undefined) throw new LocalModelError('tokenizer_missing', 'Transformers model directory is missing chat template metadata')
  const weightIndex = findDirectoryFile(all, 'model.safetensors.index.json')
  const weightFiles = all.filter(item => item.path.toLowerCase().endsWith('.safetensors'))
  if (weightFiles.length === 0) throw new LocalModelError('format_invalid', 'Transformers model directory has no safetensors weights')
  if (weightIndex !== undefined) {
    const index = await jsonObject(weightIndex.file, 'safetensors index is not valid JSON')
    if (typeof index.weight_map !== 'object' || index.weight_map === null || Array.isArray(index.weight_map)) throw new LocalModelError('format_invalid', 'safetensors index has no weight_map')
    const referenced = new Set(Object.values(index.weight_map as Record<string, unknown>).filter((item): item is string => typeof item === 'string'))
    const hasReferencedShard = (name: string): boolean => {
      const normalized = normalizedDirectoryPath(name)
      return files.has(normalized) || all.some(entry => entry.path.endsWith(`/${normalized}`) || entry.path === normalized)
    }
    if (referenced.size === 0 || [...referenced].some(name => !hasReferencedShard(name))) throw new LocalModelError('format_invalid', 'safetensors index references a missing shard')
  }
  let totalWeightBytes = 0
  for (const weight of weightFiles) {
    if (weight.file.size > MAX_LOCAL_MODEL_BYTES || totalWeightBytes > MAX_LOCAL_MODEL_BYTES - weight.file.size) throw new LocalModelError('file_too_large', 'Transformers model exceeds the 8 GiB limit')
    totalWeightBytes += weight.file.size
    await readSafeTensorHeader(weight.file)
  }
  return { files, config, tokenizer, ...(tokenizerConfig === undefined ? {} : { tokenizerConfig }), ...(chatTemplate === undefined ? {} : { chatTemplate }), ...(generationConfig === undefined ? {} : { generationConfig }), weightFiles, ...(weightIndex === undefined ? {} : { weightIndex }), totalWeightBytes }
}

export async function validateTransformersModel(
  input: readonly (Blob & { name?: string; webkitRelativePath?: string })[],
): Promise<ValidatedLocalModel> {
  const directory = await parseTransformersDirectory(input)
  const tokenizerConfig = directory.tokenizerConfig === undefined ? {} : await jsonObject(directory.tokenizerConfig.file, 'tokenizer_config.json is not valid JSON')
  const chatTemplate = directory.chatTemplate === undefined ? String(tokenizerConfig.chat_template ?? '') : await directory.chatTemplate.file.text()
  if (chatTemplate.trim() === '') throw new LocalModelError('tokenizer_missing', 'Qwen3.5 chat template is empty')
  const modelId = modelIdFromConfig(directory.config, [...directory.files.values()])
  const maxContextLength = Math.min(directory.config.maxPositionEmbeddings ?? MIN_CONTEXT_LENGTH, 8192)
  const manifest: ModelManifest = {
    modelId, version: typeof directory.config.raw.transformers_version === 'string' ? directory.config.raw.transformers_version : 'transformers-qwen3_5',
    architecture: 'qwen3_5', format: 'transformers', languages: ['en', 'zh'], chatTemplate,
    systemPromptVersion: 'zeroclave.qwen3_5-pii.v1', outputProtocolVersion: 'local-model.v1', entityTypes: DEFAULT_LOCAL_ENTITY_TYPES,
    maxContextLength, recommendedGeneration: { temperature: 0, topP: 1, maxTokens: 256 }, constrainedJson: true,
  }
  const names = [...directory.files.keys()].sort().map(path => `${path}:${directory.files.get(path)?.file.size ?? 0}`).join('|')
  const fileSha256 = await sha256(new Blob([names]))
  const firstWeight = directory.weightFiles[0]
  const metadata: LocalModelMetadata = {
    modelId, version: manifest.version, architecture: 'qwen3_5', format: 'transformers',
    fileName: firstWeight?.path ?? 'model.safetensors', fileSize: directory.totalWeightBytes, fileSha256,
    quantization: directory.config.torchDtype ?? 'safetensors', contextLength: maxContextLength,
    languages: manifest.languages, outputProtocolVersion: manifest.outputProtocolVersion,
  }
  return { manifest, metadata, directory }
}

export interface ValidatedLocalModel {
  manifest: ModelManifest
  metadata: LocalModelMetadata
  file?: Blob
  gguf?: ParsedGguf
  directory?: TransformersModelDirectory
}

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
  setEventListener?(listener: (event: LocalModelRuntimeEvent) => void): void
}

/** Runtime events that occur outside a single load or inference promise (for example device loss). */
export interface LocalModelRuntimeEvent {
  code: Extract<LocalModelErrorCode, 'device_lost' | 'out_of_memory' | 'runtime_unavailable'>
  message: string
}

export class UnavailableModelRuntimeAdapter implements ModelRuntimeAdapter {
  async load(): Promise<void> { throw new LocalModelError('runtime_unavailable', 'No GGUF/WebGPU runtime is installed') }
  async scan(): Promise<readonly FindingCandidate[]> { throw new LocalModelError('runtime_unavailable', 'No GGUF/WebGPU runtime is installed') }
  async unload(): Promise<void> { return undefined }
}


export class LocalModelDetector implements DetectorProvider {
  readonly id = 'local-model' as const
  readonly label = 'Local Transformers model'
  readonly locality = 'browser' as const
  private selected: ValidatedLocalModel | undefined
  private runtimeReady = false
  constructor(private readonly runtime: ModelRuntimeAdapter = new UnavailableModelRuntimeAdapter()) {}
  available(): boolean { return this.runtimeReady && this.selected !== undefined }
  get metadata(): LocalModelMetadata | undefined { return this.selected?.metadata }
  setRuntimeEventListener(listener: (event: LocalModelRuntimeEvent) => void): void {
    this.runtime.setEventListener?.(listener)
  }
  async select(modelFile: Blob & { name?: string }, manifestFile: Blob): Promise<LocalModelMetadata> {
    // A new file invalidates both the old tokenizer and its GPU allocations.
    try {
      await this.unload()
    } finally {
      this.selected = undefined
    }
    const selected = await validateLocalModel(modelFile, manifestFile)
    this.selected = selected
    return selected.metadata
  }
  async selectDirectory(files: readonly (Blob & { name?: string; webkitRelativePath?: string })[]): Promise<LocalModelMetadata> {
    try {
      await this.unload()
    } finally {
      this.selected = undefined
    }
    const selected = await validateTransformersModel(files)
    this.selected = selected
    return selected.metadata
  }
  async load(onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    if (this.selected === undefined) throw new LocalModelError('not_configured', 'Select a local model directory first')
    await this.runtime.load(this.selected, onProgress, signal)
    this.runtimeReady = true
  }
  async unload(): Promise<void> { this.runtimeReady = false; await this.runtime.unload() }
  async scan(
    text: string, signal?: AbortSignal, regex: readonly FindingCandidate[] = [],
  ): Promise<ScanResult> {
    if (!this.available() || this.selected === undefined) throw new LocalModelError('not_ready', 'Local model is not ready')
    return mergeLocalModelCandidates(
      text,
      await this.runtime.scan(text, signal),
      this.selected.metadata.modelId,
      this.selected.metadata.version,
      regex,
    )
  }
}
