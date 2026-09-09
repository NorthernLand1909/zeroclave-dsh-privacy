import { configuredCandidates, DEFAULT_REGEX_RULES, isDefaultPattern, regexCandidates } from './detector.ts'
import type { FindingCandidate } from './detector.ts'
import type { EditableRegexRule, EntityType, RegexErrorCode, RegexMatch } from './types.ts'

const STORAGE_KEY = 'zeroclave.privacy.regex-rules.v1'

export const RULE_ENTITY_TYPES: readonly EntityType[] = [
  'OTHER', 'EMAIL', 'PHONE', 'PERSON', 'ADDRESS', 'ORGANIZATION', 'NATIONAL_ID', 'CREDIT_CODE',
  'BANK_ACCOUNT', 'BANK_NAME', 'CONTRACT_ID', 'DATE_TIME', 'FINANCIAL', 'CREDIT_CARD', 'IBAN_CODE',
  'IP_ADDRESS', 'PASSWORD', 'PRIVATE_KEY', 'API_KEY',
]

export class RegexRuleError extends Error {
  constructor(readonly code: RegexErrorCode) { super(`Privacy regex: ${code}`) }
}

export function validateRule(rule: EditableRegexRule): void {
  if (rule.name.trim() === '' || rule.name.length > 80 || rule.pattern === '' || rule.pattern.length > 2000
    || !/^[imsu]*$/u.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length
    || !Number.isInteger(rule.capture) || rule.capture < 0 || rule.capture > 99
    || !RULE_ENTITY_TYPES.includes(rule.entityType)
    || !['DIRECT_PII', 'FINANCIAL', 'BUSINESS', 'SECRET'].includes(rule.category)
    || !['medium', 'high', 'critical'].includes(rule.severity)) throw new RegexRuleError('invalid')
  try {
    // The empty alternate reports capture count without running the expression on a user sample.
    const groups = new RegExp(`|(?:${rule.pattern})`, rule.flags).exec('')
    if (groups === null || rule.capture >= groups.length) throw new RegexRuleError('invalid')
  } catch { throw new RegexRuleError('invalid') }
}

export function loadRegexRules(): { rules: readonly EditableRegexRule[]; error?: RegexErrorCode } {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { rules: DEFAULT_REGEX_RULES }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length > 100) throw new RegexRuleError('invalid')
    const ids = new Set<string>()
    for (const value of parsed as unknown[]) {
      if (typeof value !== 'object' || value === null) throw new RegexRuleError('invalid')
      const rule = value as EditableRegexRule
      if (typeof rule.id !== 'string' || rule.id.length > 100 || ids.has(rule.id) || typeof rule.enabled !== 'boolean'
        || typeof rule.name !== 'string' || typeof rule.pattern !== 'string' || typeof rule.flags !== 'string') {
        throw new RegexRuleError('invalid')
      }
      validateRule(rule)
      ids.add(rule.id)
    }
    return { rules: parsed as EditableRegexRule[] }
  } catch { return { rules: DEFAULT_REGEX_RULES, error: 'storage' } }
}

export function saveRegexRules(rules: readonly EditableRegexRule[]): void {
  if (rules.length > 100) throw new RegexRuleError('limit')
  for (const rule of rules) validateRule(rule)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rules)) } catch { throw new RegexRuleError('storage') }
}

/** Runs only in a terminable worker for user-authored patterns. Keep this function self-contained. */
export function executeRegexBatch(text: string, rules: readonly EditableRegexRule[]): RegexMatch[] {
  if (text.length > 500000 || rules.length > 100) throw new Error('limit')
  const results: RegexMatch[] = []
  let attempts = 0
  for (const rule of rules) {
    if (!rule.enabled) continue
    const regex = new RegExp(rule.pattern, `dg${rule.flags}`)
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (++attempts > 10000) throw new Error('limit')
      const span = match.indices?.[rule.capture]
      if (span !== undefined && span[1] > span[0]) results.push({ ruleId: rule.id, start: span[0], end: span[1] })
      if (match[0].length === 0) {
        const code = text.codePointAt(regex.lastIndex)
        regex.lastIndex += regex.unicode && code !== undefined && code > 0xffff ? 2 : 1
      }
    }
  }
  return results
}

export type RegexExecutor = (text: string, rules: readonly EditableRegexRule[], signal?: AbortSignal) => Promise<RegexMatch[]>

export const runRegexWorker: RegexExecutor = (text, rules, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted === true) { reject(new DOMException('Aborted', 'AbortError')); return }
  if (typeof Worker === 'undefined') { reject(new RegexRuleError('unavailable')); return }
  const source = `onmessage = ({data}) => { try { postMessage({matches: (${executeRegexBatch.toString()})(data.text, data.rules)}) }
    catch(error) { postMessage({error: error.message === 'limit' ? 'limit' : 'invalid'}) } }`
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  let worker: Worker
  try { worker = new Worker(url) } catch { URL.revokeObjectURL(url); reject(new RegexRuleError('unavailable')); return }
  const finish = (): void => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); signal?.removeEventListener('abort', abort) }
  const abort = (): void => { finish(); reject(new DOMException('Aborted', 'AbortError')) }
  const timer = setTimeout(() => { finish(); reject(new RegexRuleError('timeout')) }, 1500)
  signal?.addEventListener('abort', abort, { once: true })
  worker.onmessage = (event: MessageEvent<{ matches?: RegexMatch[]; error?: RegexErrorCode }>) => {
    finish()
    if (event.data.matches !== undefined) resolve(event.data.matches)
    else reject(new RegexRuleError(event.data.error ?? 'invalid'))
  }
  worker.onerror = () => { finish(); reject(new RegexRuleError('unavailable')) }
  worker.postMessage({ text, rules })
})

export async function scanConfiguredRules(
  text: string, rules: readonly EditableRegexRule[], execute: RegexExecutor, signal?: AbortSignal,
): Promise<FindingCandidate[]> {
  const changed = rules.filter(rule => rule.enabled && !isDefaultPattern(rule))
  const builtin = regexCandidates(text, rules)
  if (changed.length === 0) return builtin
  const matches = await execute(text, changed, signal)
  return [...builtin, ...configuredCandidates(text, matches, rules)]
}
