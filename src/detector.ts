import type {
  DetectorMode, DetectorProvider, EntityType, FindingCategory, PrivacyFinding,
  RiskLevel, ScanResult, EditableRegexRule, RegexMatch,
} from './types.ts'

interface FindingCandidate {
  category: FindingCategory
  entityType: EntityType
  start: number
  end: number
  maskedEvidence: string
  confidence?: number
  severity: Exclude<RiskLevel, 'none'>
  detector: DetectorMode
  ruleId?: string
  ruleName?: string
  sourceType?: string
}

interface RegexRule {
  regex: RegExp
  capture?: number
  category: FindingCategory
  entityType: EntityType
  severity: Exclude<RiskLevel, 'none'>
  mask: (value: string) => string
  validate?: (value: string) => boolean
}

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gu
const PHONE = /(?:^|[^\d])(1[3-9]\d{9})(?!\d)/gu
const API_KEY = /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?([a-z0-9_.-]{20,})['"]?/giu
const KNOWN_TOKEN = /\b((?:sk|rk|pk)-(?:proj-)?[a-zA-Z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[a-zA-Z0-9]{20,})\b/gu
const PASSWORD = /(?:password|passwd|pwd|密码)\s*[:=：]\s*['"]?([^\s'";,]{8,})['"]?/giu
const PRIVATE_KEY = /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/gu
// oxlint-disable-next-line @stylistic/max-len -- Keeping the validated national-ID regex legible is safer than string assembly.
const NATIONAL_ID = /(?:身份证(?:号(?:码)?)?|公民身份号码)\s*[:：]?\s*([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])/gu
const CREDIT_CODE = /(?:统一社会信用代码|信用代码)\s*[:：]\s*([0-9A-HJ-NPQRTUWXY]{18})/giu
const PERSON = /(?:联系人(?:\/授权代表)?|授权代表|经办人|法定代表人)\s*[:：]\s*([^\s,，;；]{2,32})/gu
const ORGANIZATION = /(?:甲方(?:（买方）|\(买方\))?|乙方(?:（卖方）|\(卖方\))?|公司名称|单位名称)\s*[:：]\s*([^\r\n]{2,100})/gu
const ADDRESS = /(?:通讯地址|通信地址|联系地址|签署地点|注册地址|收货地址)\s*[:：]\s*([^\r\n]{4,160})/gu
const BANK_ACCOUNT = /(?:银行账号|银行账户|银行卡号|收款账号)\s*[:：]\s*([\d -]{12,32})/gu
const BANK_NAME = /(?:开户银行|开户行)\s*[:：]\s*([^\r\n]{2,100})/gu
const CONTRACT_ID = /(?:合同编号|协议编号)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,80})/gu
const DATE_TIME = /(?:签署日期|签订日期|出生日期)\s*[:：]\s*([^\r\n]{4,40})/gu
const FINANCIAL = /(?:合同含税金额|合同金额|交易金额|付款金额)\s*[:：]\s*([^\r\n]{2,60})/gu
const IP_ADDRESS = /(?:^|[^\d])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?!\d)/gu
const CREDIT_CARD = /(?:^|[^\d])((?:\d[ -]?){12,18}\d)(?!\d)/gu
const IBAN = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30})\b/giu
const KYC = /\bKYC\b|客户资料|客戶資料|尽职调查|盡職調查/iu
const PLACEHOLDER = /ZCPII-[A-Z][A-Z0-9_]*-[a-f0-9]{32}|__PII_[A-Z][A-Z0-9_]*_\d{8}__/gu

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function graphemeCount(value: string): number {
  return Array.from(GRAPHEME_SEGMENTER.segment(value)).length
}

export function maskPerson(value: string): string {
  const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(value), segment => segment.segment)
  return `${graphemes[0] ?? ''}${'*'.repeat(Math.max(1, graphemes.length - 1))}`
}

function maskEmail(value: string): string {
  const at = value.lastIndexOf('@')
  return at <= 0 ? '[REDACTED_EMAIL]' : `${value.slice(0, 1)}***${value.slice(at)}`
}

function maskTail(value: string, visible = 4): string {
  const compact = value.replace(/[ -]/g, '')
  return compact.length <= visible
    ? '*'.repeat(compact.length)
    : `${'*'.repeat(Math.min(12, compact.length - visible))}${compact.slice(-visible)}`
}

function maskLabel(label: string): (value: string) => string {
  return value => `[REDACTED_${label}:${String(graphemeCount(value))}]`
}

function passesLuhn(value: string): boolean {
  const digits = value.replace(/[ -]/gu, '')
  if (!/^\d{13,19}$/u.test(digits)) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

function passesIbanChecksum(value: string): boolean {
  const compact = value.replace(/\s/gu, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(compact)) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const character of rearranged) {
    const expanded = /\d/u.test(character) ? character : String(character.charCodeAt(0) - 55)
    for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

const RULES: readonly RegexRule[] = [
  { regex: API_KEY, capture: 1, category: 'SECRET', entityType: 'API_KEY', severity: 'critical', mask: () => '[REDACTED_API_KEY]' },
  { regex: KNOWN_TOKEN, capture: 1, category: 'SECRET', entityType: 'API_KEY', severity: 'critical', mask: () => '[REDACTED_API_KEY]' },
  { regex: PASSWORD, capture: 1, category: 'SECRET', entityType: 'PASSWORD', severity: 'critical', mask: () => '[REDACTED_PASSWORD]' },
  { regex: PRIVATE_KEY, category: 'SECRET', entityType: 'PRIVATE_KEY', severity: 'critical', mask: () => '[REDACTED_PRIVATE_KEY]' },
  { regex: NATIONAL_ID, capture: 1, category: 'DIRECT_PII', entityType: 'NATIONAL_ID', severity: 'critical', mask: value => `${value.slice(0, 3)}***********${value.slice(-4)}` },
  { regex: CREDIT_CODE, capture: 1, category: 'BUSINESS', entityType: 'CREDIT_CODE', severity: 'high', mask: value => `${value.slice(0, 4)}**********${value.slice(-4)}` },
  { regex: BANK_ACCOUNT, capture: 1, category: 'FINANCIAL', entityType: 'BANK_ACCOUNT', severity: 'critical', mask: value => maskTail(value) },
  { regex: CREDIT_CARD, capture: 1, category: 'FINANCIAL', entityType: 'CREDIT_CARD', severity: 'critical', mask: value => maskTail(value), validate: passesLuhn },
  { regex: IBAN, capture: 1, category: 'FINANCIAL', entityType: 'IBAN_CODE', severity: 'critical', mask: value => maskTail(value), validate: passesIbanChecksum },
  { regex: EMAIL, category: 'DIRECT_PII', entityType: 'EMAIL', severity: 'high', mask: maskEmail },
  { regex: PHONE, capture: 1, category: 'DIRECT_PII', entityType: 'PHONE', severity: 'high', mask: value => `${value.slice(0, 3)}****${value.slice(-4)}` },
  { regex: PERSON, capture: 1, category: 'DIRECT_PII', entityType: 'PERSON', severity: 'high', mask: maskPerson },
  { regex: ADDRESS, capture: 1, category: 'DIRECT_PII', entityType: 'ADDRESS', severity: 'high', mask: maskLabel('ADDRESS') },
  { regex: ORGANIZATION, capture: 1, category: 'BUSINESS', entityType: 'ORGANIZATION', severity: 'medium', mask: maskLabel('ORGANIZATION') },
  { regex: BANK_NAME, capture: 1, category: 'FINANCIAL', entityType: 'BANK_NAME', severity: 'medium', mask: maskLabel('BANK_NAME') },
  { regex: CONTRACT_ID, capture: 1, category: 'BUSINESS', entityType: 'CONTRACT_ID', severity: 'medium', mask: value => `${value.slice(0, 2)}***${value.slice(-2)}` },
  { regex: DATE_TIME, capture: 1, category: 'DIRECT_PII', entityType: 'DATE_TIME', severity: 'medium', mask: () => '[REDACTED_DATE]' },
  { regex: FINANCIAL, capture: 1, category: 'FINANCIAL', entityType: 'FINANCIAL', severity: 'high', mask: () => '[REDACTED_AMOUNT]' },
  { regex: IP_ADDRESS, capture: 1, category: 'DIRECT_PII', entityType: 'IP_ADDRESS', severity: 'medium', mask: value => `${value.split('.').slice(0, 2).join('.')}.*.*` },
]

const RULE_NAMES = [
  'API key field', 'Known token', 'Password field', 'PEM private key', 'Chinese national ID',
  'Social credit code', 'Bank account', 'Payment card', 'IBAN', 'Email address',
  'Mainland China phone', 'Named person', 'Labeled address', 'Contract party', 'Bank name',
  'Contract ID', 'Labeled date', 'Financial amount', 'IPv4 address',
] as const

export const DEFAULT_REGEX_RULES: readonly EditableRegexRule[] = RULES.map((rule, index) => ({
  id: `builtin-${String(index)}`,
  name: RULE_NAMES[index] ?? rule.entityType,
  pattern: rule.regex.source,
  flags: rule.regex.flags.replace('g', ''),
  capture: rule.capture ?? 0,
  entityType: rule.entityType,
  category: rule.category,
  severity: rule.severity,
  enabled: true,
}))

export function isDefaultPattern(rule: EditableRegexRule): boolean {
  const original = DEFAULT_REGEX_RULES.find(item => item.id === rule.id)
  return original?.pattern === rule.pattern && original.flags === rule.flags && original.capture === rule.capture
}

export function configuredCandidates(
  text: string, matches: readonly RegexMatch[], rules: readonly EditableRegexRule[],
): FindingCandidate[] {
  return matches.flatMap((match) => {
    const rule = rules.find(item => item.id === match.ruleId)
    if (rule === undefined) return []
    const index = DEFAULT_REGEX_RULES.findIndex(item => item.id === rule.id)
    const builtin = RULES[index]
    const evidence = text.slice(match.start, match.end)
    if (builtin?.validate?.(evidence) === false) return []
    return [{
      category: rule.category, entityType: rule.entityType, start: match.start, end: match.end,
      maskedEvidence: builtin?.entityType === rule.entityType ? builtin.mask(evidence) : `[REDACTED_${rule.entityType}]`,
      confidence: 0.99, severity: rule.severity, detector: 'regex' as const,
      ruleId: rule.id, ruleName: rule.name,
    }]
  })
}

function addRuleMatches(
  candidates: FindingCandidate[], text: string, rule: RegexRule,
  attribution?: Pick<EditableRegexRule, 'id' | 'name'>,
): void {
  rule.regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = rule.regex.exec(text)) !== null) {
    const evidence = match[rule.capture ?? 0]
    if (evidence === undefined || evidence.length === 0) continue
    if (rule.validate?.(evidence) === false) continue
    const relativeStart = rule.capture === undefined ? 0 : match[0].lastIndexOf(evidence)
    const start = match.index + relativeStart
    candidates.push({
      category: rule.category,
      entityType: rule.entityType,
      start,
      end: start + evidence.length,
      maskedEvidence: rule.mask(evidence),
      confidence: 0.99,
      severity: rule.severity,
      detector: 'regex',
      ...(attribution === undefined ? {} : { ruleId: attribution.id, ruleName: attribution.name }),
    })
  }
}

function overlaps(left: Pick<FindingCandidate, 'start' | 'end'>, right: Pick<FindingCandidate, 'start' | 'end'>): boolean {
  return left.start < right.end && right.start < left.end
}

function severityRank(value: FindingCandidate['severity']): number {
  return { medium: 1, high: 2, critical: 3 }[value]
}

export function finalizeScan(
  text: string,
  candidates: readonly FindingCandidate[],
  requested: DetectorMode,
  used: DetectorMode,
  fallback: boolean,
  model?: string,
): ScanResult {
  const protectedSpans = Array.from(text.matchAll(PLACEHOLDER), match => ({
    start: match.index, end: match.index + match[0].length,
  }))
  const selected: FindingCandidate[] = []
  for (const candidate of candidates.filter(candidate => (
    !protectedSpans.some(span => overlaps(span, candidate))
  )).sort((left, right) => (
    left.start - right.start
    || severityRank(right.severity) - severityRank(left.severity)
    || (right.end - right.start) - (left.end - left.start)
    || (left.detector === 'regex' ? -1 : 1)
  ))) {
    const previous = selected.at(-1)
    if (previous === undefined || !overlaps(previous, candidate)) {
      selected.push({ ...candidate })
    } else if (candidate.end > previous.end) {
      // Cover the complete union when overlapping model chunks disagree on a boundary.
      previous.end = candidate.end
      previous.maskedEvidence = `[REDACTED_${previous.entityType}]`
      if (severityRank(candidate.severity) > severityRank(previous.severity)) previous.severity = candidate.severity
    }
  }

  const replacements = new Map<string, string>()
  const findings: PrivacyFinding[] = selected.map((candidate, index) => {
    const evidence = text.slice(candidate.start, candidate.end)
    const key = `${candidate.entityType}\u0000${evidence}`
    let replacement = replacements.get(key)
    if (replacement === undefined) {
      replacement = `__PII_${candidate.entityType}_${String(replacements.size + 1).padStart(8, '0')}__`
      replacements.set(key, replacement)
    }
    return { ...candidate, id: `f_${String(index + 1).padStart(3, '0')}`, replacement }
  })
  const redactedText = [...findings].sort((left, right) => right.start - left.start).reduce((value, finding) => (
    value.slice(0, finding.start) + finding.replacement + value.slice(finding.end)
  ), text)
  const hasKyc = KYC.test(text)
  const overallRisk: RiskLevel = findings.some(item => item.severity === 'critical')
    ? 'critical'
    : findings.some(item => item.severity === 'high') || hasKyc
      ? 'high'
      : findings.length > 0 ? 'medium' : 'none'

  return {
    overallRisk,
    recommendedAction: overallRisk === 'critical' ? 'block' : findings.length > 0 ? 'redact' : 'allow',
    redactedText,
    findings,
    policySignals: hasKyc ? [{ policyId: 'CUSTOMER_KYC', severity: 'high' }] : [],
    detector: { requested, used, fallback, ...(model === undefined ? {} : { model }) },
  }
}

export function regexCandidates(text: string, rules: readonly EditableRegexRule[] = DEFAULT_REGEX_RULES): FindingCandidate[] {
  const candidates: FindingCandidate[] = []
  for (const rule of rules) {
    if (!rule.enabled || !isDefaultPattern(rule)) continue
    const builtin = RULES[DEFAULT_REGEX_RULES.findIndex(item => item.id === rule.id)]
    if (builtin !== undefined) addRuleMatches(candidates, text, {
      ...builtin, entityType: rule.entityType, category: rule.category, severity: rule.severity,
    }, rule)
  }
  return candidates
}

export function scanRegex(text: string, requested: DetectorMode = 'regex', rules: readonly EditableRegexRule[] = DEFAULT_REGEX_RULES): ScanResult {
  return finalizeScan(text, regexCandidates(text, rules), requested, 'regex', requested !== 'regex')
}

export function mergeModelCandidates(
  text: string,
  modelCandidates: readonly FindingCandidate[],
  model: string,
  regex: readonly FindingCandidate[] = regexCandidates(text),
): ScanResult {
  return finalizeScan(text, [...regex, ...modelCandidates], 'embedded', 'embedded', false, model)
}

export type { FindingCandidate }

export class RegexDetector implements DetectorProvider {
  readonly id = 'regex' as const
  readonly label = 'Local regex rules'
  readonly locality = 'browser' as const

  available(): boolean { return true }
  scan(text: string): Promise<ScanResult> { return Promise.resolve(scanRegex(text)) }
}
