export type DetectorMode = 'regex' | 'embedded' | 'zeroclave'

export type RiskLevel = 'none' | 'medium' | 'high' | 'critical'

export type FindingCategory = 'DIRECT_PII' | 'FINANCIAL' | 'BUSINESS' | 'SECRET'

export interface EditableRegexRule {
  id: string
  name: string
  pattern: string
  flags: string
  capture: number
  entityType: EntityType
  category: FindingCategory
  severity: Exclude<RiskLevel, 'none'>
  enabled: boolean
}

export interface RegexMatch { ruleId: string; start: number; end: number }

export type RegexErrorCode = 'invalid' | 'timeout' | 'limit' | 'unavailable' | 'storage' | 'changed'

export type EntityType =
  | 'AGE'
  | 'EMAIL'
  | 'PHONE'
  | 'PERSON'
  | 'ADDRESS'
  | 'COORDINATE'
  | 'HONORIFIC'
  | 'ORGANIZATION'
  | 'NATIONAL_ID'
  | 'CREDIT_CODE'
  | 'BANK_ACCOUNT'
  | 'BANK_NAME'
  | 'CONTRACT_ID'
  | 'DATE_TIME'
  | 'FINANCIAL'
  | 'CREDIT_CARD'
  | 'IBAN_CODE'
  | 'IP_ADDRESS'
  | 'IMEI'
  | 'MAC_ADDRESS'
  | 'NRP'
  | 'URL'
  | 'TITLE'
  | 'PASSWORD'
  | 'PRIVATE_KEY'
  | 'API_KEY'
  | 'US_DRIVER_LICENSE'
  | 'US_ITIN'
  | 'US_LICENSE_PLATE'
  | 'US_PASSPORT'
  | 'US_SSN'
  | 'OTHER'

export interface PrivacyFinding {
  id: string
  category: FindingCategory
  entityType: EntityType
  start: number
  end: number
  maskedEvidence: string
  replacement: string
  confidence: number
  severity: Exclude<RiskLevel, 'none'>
  detector: DetectorMode
  ruleId?: string
  ruleName?: string
  action?: 'redacted' | 'kept'
}

export type SendPolicy = 'auto-redact' | 'review-critical'

export interface PendingSendReview {
  id: string
  sessionId: string
  parts: readonly { text: string; result: ScanResult }[]
  redactByFinding: Readonly<Record<string, boolean>>
}

export interface PolicySignal {
  policyId: 'CUSTOMER_KYC'
  severity: 'high'
}

export interface ScanResult {
  overallRisk: RiskLevel
  recommendedAction: 'allow' | 'redact' | 'block'
  redactedText: string
  findings: PrivacyFinding[]
  policySignals: PolicySignal[]
  detector: {
    requested: DetectorMode
    used: DetectorMode
    fallback: boolean
    model?: string
  }
}

export type DetectorLoadStatus = 'ready' | 'idle' | 'loading' | 'error' | 'unconfigured'

export interface DetectorRuntimeState {
  status: DetectorLoadStatus
  progress?: number
  error?: string
}

export interface DetectorProvider {
  readonly id: DetectorMode
  readonly label: string
  readonly locality: 'browser' | 'remote'
  available(): boolean
  load?(onProgress?: (progress: number) => void): Promise<void>
  scan(text: string, signal?: AbortSignal): Promise<ScanResult>
}

export interface PrivacyLiveState {
  text: string
  result: ScanResult
  updatedAt: number
}

export interface AuditRecord extends PrivacyLiveState {
  id: string
  sessionId: string
  action: 'detected' | 'sent'
}

export interface PrivacySnapshot {
  enabled: boolean
  open: boolean
  activeTab: 'audit' | 'history' | 'rules' | 'model'
  detectorMode: DetectorMode
  detectorStates: Readonly<Record<DetectorMode, DetectorRuntimeState>>
  liveBySession: ReadonlyMap<string, PrivacyLiveState>
  auditsBySession: ReadonlyMap<string, readonly AuditRecord[]>
  draftRequestBySession: ReadonlyMap<string, { id: string; text: string }>
  regexRules: readonly EditableRegexRule[]
  regexRevision: number
  regexError?: RegexErrorCode | undefined
  sendPolicy: SendPolicy
  pendingSendReview?: PendingSendReview
}
