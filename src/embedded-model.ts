import { pipeline } from '@huggingface/transformers'
import {
  graphemeCount, maskPerson, mergeModelCandidates, scanRegex, type FindingCandidate,
} from './detector.ts'
import type {
  DetectorProvider, EntityType, FindingCategory, RiskLevel, ScanResult,
} from './types.ts'

export const EMBEDDED_MODEL_ID = 'gravitee-io/bert-small-pii-detection'
export const EMBEDDED_MODEL_REVISION = 'f8c27a85c51c0168f07b9dcf00265bf0a4097939'

const MODEL_FILE_NAME = 'model.quant'
const CHUNK_CHARS = 384
const CHUNK_OVERLAP = 48
const SCORE_THRESHOLD = 0.65

interface TokenEntity {
  entity?: string
  entity_group?: string
  score?: number
  index?: number
  start?: number
  end?: number
  word?: string
}

type TokenClassifier = ((
  text: string,
  options: { ignore_labels: string[] },
) => Promise<TokenEntity[] | TokenEntity>) & { dispose?: () => Promise<void> }

interface AlignedEntity {
  label: string
  prefix: string
  score: number
  start: number
  end: number
}

const ENTITY_MAP: Readonly<Record<string, EntityType>> = {
  AGE: 'AGE',
  COORDINATE: 'COORDINATE',
  CREDIT_CARD: 'CREDIT_CARD',
  DATE_TIME: 'DATE_TIME',
  EMAIL_ADDRESS: 'EMAIL',
  FINANCIAL: 'FINANCIAL',
  HONORIFIC: 'HONORIFIC',
  IBAN_CODE: 'IBAN_CODE',
  IMEI: 'IMEI',
  IP_ADDRESS: 'IP_ADDRESS',
  LOCATION: 'ADDRESS',
  MAC_ADDRESS: 'MAC_ADDRESS',
  NRP: 'NRP',
  ORGANIZATION: 'ORGANIZATION',
  PASSWORD: 'PASSWORD',
  PERSON: 'PERSON',
  PHONE_NUMBER: 'PHONE',
  TITLE: 'TITLE',
  URL: 'URL',
  US_BANK_NUMBER: 'BANK_ACCOUNT',
  US_DRIVER_LICENSE: 'US_DRIVER_LICENSE',
  US_ITIN: 'US_ITIN',
  US_LICENSE_PLATE: 'US_LICENSE_PLATE',
  US_PASSPORT: 'US_PASSPORT',
  US_SSN: 'US_SSN',
}

function categoryFor(type: EntityType): FindingCategory {
  if (type === 'PASSWORD') return 'SECRET'
  if (type === 'CREDIT_CARD' || type === 'IBAN_CODE' || type === 'BANK_ACCOUNT' || type === 'FINANCIAL') return 'FINANCIAL'
  if (type === 'ORGANIZATION') return 'BUSINESS'
  return 'DIRECT_PII'
}

function severityFor(type: EntityType): Exclude<RiskLevel, 'none'> {
  if (
    type === 'PASSWORD' || type === 'PRIVATE_KEY' || type === 'API_KEY'
    || type === 'CREDIT_CARD' || type === 'IBAN_CODE' || type === 'BANK_ACCOUNT'
    || type === 'NATIONAL_ID' || type === 'US_DRIVER_LICENSE' || type === 'US_ITIN'
    || type === 'US_PASSPORT' || type === 'US_SSN'
  ) return 'critical'
  if (
    type === 'EMAIL' || type === 'PHONE' || type === 'PERSON' || type === 'ADDRESS'
    || type === 'FINANCIAL' || type === 'IMEI' || type === 'MAC_ADDRESS' || type === 'NRP'
  ) return 'high'
  return 'medium'
}

function maskModelEvidence(type: EntityType, value: string): string {
  if (type === 'EMAIL') {
    const at = value.lastIndexOf('@')
    return at > 0 ? `${value.slice(0, 1)}***${value.slice(at)}` : '[REDACTED_EMAIL]'
  }
  if (type === 'PHONE') return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : '[REDACTED_PHONE]'
  if (type === 'PERSON') return maskPerson(value)
  return `[REDACTED_${type}:${String(graphemeCount(value))}]`
}

function chunks(text: string): Array<{ text: string; offset: number }> {
  if (text.length <= CHUNK_CHARS) return [{ text, offset: 0 }]
  const values: Array<{ text: string; offset: number }> = []
  const step = CHUNK_CHARS - CHUNK_OVERLAP
  for (let offset = 0; offset < text.length; offset += step) {
    values.push({ text: text.slice(offset, offset + CHUNK_CHARS), offset })
    if (offset + CHUNK_CHARS >= text.length) break
  }
  return values
}

function progressValue(info: unknown): number | undefined {
  if (typeof info !== 'object' || info === null || !('progress' in info)) return undefined
  const value = Number((info as { progress?: unknown }).progress)
  if (!Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value))
}

function labelParts(entity: TokenEntity): { label: string; prefix: string } | undefined {
  const raw = entity.entity_group ?? entity.entity ?? ''
  if (raw === '') return undefined
  if (raw === 'O') return { label: 'O', prefix: 'O' }
  const match = /^(?:([BIES])-)?(.+)$/u.exec(raw)
  if (match === null || match[2] === undefined || !(match[2] in ENTITY_MAP)) return undefined
  return { label: match[2], prefix: entity.entity_group === undefined ? (match[1] ?? 'B') : 'S' }
}

function tokenSurface(word: string): { value: string; continuation: boolean } | undefined {
  if (word === '[UNK]' || word === '[CLS]' || word === '[SEP]' || word === '[PAD]') return undefined
  const continuation = word.startsWith('##')
  const value = word.replace(/^##/u, '').replace(/^[▁Ġ]+/u, '')
  return value === '' ? undefined : { value, continuation }
}

function alignedEntities(text: string, entities: readonly TokenEntity[]): AlignedEntity[] {
  const aligned: AlignedEntity[] = []
  const folded = text.toLowerCase()
  let cursor = 0
  for (const entity of entities) {
    const parts = labelParts(entity)
    const score = Number(entity.score)
    const explicitStart = Number(entity.start)
    const explicitEnd = Number(entity.end)
    if (Number.isInteger(explicitStart) && Number.isInteger(explicitEnd)
      && explicitStart >= 0 && explicitEnd > explicitStart && explicitEnd <= text.length) {
      cursor = explicitEnd
      if (parts !== undefined && Number.isFinite(score)) aligned.push({ ...parts, score, start: explicitStart, end: explicitEnd })
      continue
    }

    const surface = tokenSurface(entity.word ?? '')
    if (surface === undefined) {
      if (parts?.label === 'O' && Number.isFinite(score)) {
        aligned.push({ ...parts, score, start: cursor, end: cursor })
      }
      continue
    }
    const needle = surface.value.toLowerCase()
    const exactContinuation = surface.continuation && folded.startsWith(needle, cursor)
    const start = exactContinuation ? cursor : folded.indexOf(needle, cursor)
    if (start < 0) continue
    const end = start + surface.value.length
    cursor = end
    if (parts !== undefined && Number.isFinite(score)) aligned.push({ ...parts, score, start, end })
  }
  return aligned
}

function candidateFromGroup(text: string, entities: readonly AlignedEntity[], offset: number): FindingCandidate | undefined {
  const first = entities[0]
  const last = entities.at(-1)
  if (first === undefined || last === undefined) return undefined
  const type = ENTITY_MAP[first.label]
  if (type === undefined) return undefined
  const confidence = entities.reduce((sum, entity) => sum + entity.score, 0) / entities.length
  if (confidence < SCORE_THRESHOLD) return undefined
  const start = offset + first.start
  const end = offset + last.end
  const evidence = text.slice(first.start, last.end)
  return {
    category: categoryFor(type),
    entityType: type,
    start,
    end,
    maskedEvidence: maskModelEvidence(type, evidence),
    confidence,
    severity: severityFor(type),
    detector: 'embedded',
  }
}

export function tokenEntitiesToCandidates(
  text: string,
  entities: readonly TokenEntity[],
  offset = 0,
): FindingCandidate[] {
  const candidates: FindingCandidate[] = []
  let group: AlignedEntity[] = []
  const flush = (): void => {
    const candidate = candidateFromGroup(text, group, offset)
    if (candidate !== undefined) candidates.push(candidate)
    group = []
  }
  for (const entity of alignedEntities(text, entities)) {
    if (entity.label === 'O') {
      flush()
      continue
    }
    const previous = group.at(-1)
    const startsGroup = entity.prefix === 'B' || entity.prefix === 'S'
      || previous === undefined || previous.label !== entity.label
    if (startsGroup) flush()
    group.push(entity)
    if (entity.prefix === 'E' || entity.prefix === 'S') flush()
  }
  flush()
  return candidates
}

export class EmbeddedModelDetector implements DetectorProvider {
  readonly id = 'embedded' as const
  readonly label = 'BERT Small PII Detection'
  readonly locality = 'browser' as const
  private classifier: TokenClassifier | undefined
  private loading: Promise<void> | undefined

  available(): boolean { return this.classifier !== undefined }

  async load(onProgress?: (progress: number) => void): Promise<void> {
    if (this.classifier !== undefined) return
    this.loading ??= this.loadClassifier(onProgress)
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  async scan(text: string, signal?: AbortSignal, regex?: readonly FindingCandidate[]): Promise<ScanResult> {
    if (this.classifier === undefined) return scanRegex(text, this.id)
    const candidates: FindingCandidate[] = []
    for (const chunk of chunks(text)) {
      if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const raw = await this.classifier(chunk.text, { ignore_labels: [] })
      candidates.push(...tokenEntitiesToCandidates(chunk.text, Array.isArray(raw) ? raw : [raw], chunk.offset))
    }
    return mergeModelCandidates(text, candidates, EMBEDDED_MODEL_ID, regex)
  }

  async dispose(): Promise<void> {
    const classifier = this.classifier
    this.classifier = undefined
    await classifier?.dispose?.()
  }

  private async loadClassifier(onProgress?: (progress: number) => void): Promise<void> {
    const classifier = await pipeline('token-classification', EMBEDDED_MODEL_ID, {
      revision: EMBEDDED_MODEL_REVISION,
      subfolder: '',
      model_file_name: MODEL_FILE_NAME,
      dtype: 'fp32',
      device: 'wasm',
      progress_callback: (info: unknown) => {
        const progress = progressValue(info)
        if (progress !== undefined) onProgress?.(progress)
      },
    })
    this.classifier = classifier
  }
}
