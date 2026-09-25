import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { DEFAULT_REGEX_RULES, finalizeScan, scanRegex } from './detector.ts'
import { EmbeddedModelDetector } from './embedded-model.ts'
import { PrivacyVault } from './vault.ts'
import {
  loadRegexRules, RegexRuleError, runRegexWorker, saveRegexRules, scanConfiguredRules, validateRule,
} from './regex-rules.ts'
import type { RegexExecutor } from './regex-rules.ts'
import { ZeroClaveDetectError, ZeroClaveDetector } from './zeroclave-detector.ts'
import { LocalModelDetector, LocalModelError } from './local-model.ts'
import { PrivacyTelemetry } from './telemetry.ts'
import type { TelemetryDetector, TelemetryEvent, TelemetryReporter } from './telemetry.ts'
import type {
  DetectorMode, DetectorRuntimeState, PrivacySnapshot, RiskLevel, ScanResult, EditableRegexRule, SendPolicy,
  PrivacyFinding, LocalModelMetadata,
} from './types.ts'

const ENABLED_STORAGE_KEY = 'zeroclave.privacy.enabled'
const SEND_POLICY_STORAGE_KEY = 'zeroclave.privacy.send-policy'
const ZEROCLAVE_CONNECTION_TEST_TEXT = 'ZeroClave synthetic connection test: demo@example.com'

export class SendReviewCancelledError extends Error {}

interface SendReviewDecisions {
  redactByFinding: Readonly<Record<string, boolean>>
  replacementByFinding: Readonly<Record<string, string>>
}

interface CustomFindingInput {
  original: string
  replacement: string
  sourceType: string
}

function rebuildScanResult(text: string, result: ScanResult, findings: readonly PrivacyFinding[]): ScanResult {
  const ordered = [...findings].sort((left, right) => left.start - right.start)
  const redactedText = [...ordered].sort((left, right) => right.start - left.start).reduce((value, finding) => (
    value.slice(0, finding.start) + finding.replacement + value.slice(finding.end)
  ), text)
  const riskRank: Record<RiskLevel, number> = { none: 0, medium: 1, high: 2, critical: 3 }
  const overallRisk = ordered.reduce<RiskLevel>((highest, finding) => (
    riskRank[finding.severity] > riskRank[highest] ? finding.severity : highest
  ), 'none')
  return {
    ...result,
    findings: ordered,
    overallRisk,
    recommendedAction: overallRisk === 'critical' ? 'block' : ordered.length > 0 ? 'redact' : 'allow',
    redactedText,
  }
}

function storedEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function storedSendPolicy(): SendPolicy {
  if (typeof window === 'undefined') return 'review-manual'
  try { return window.localStorage.getItem(SEND_POLICY_STORAGE_KEY) === 'auto-redact' ? 'auto-redact' : 'review-manual' } catch {
    return 'review-manual'
  }
}

function disabledResult(text: string, requested: DetectorMode): ScanResult {
  return {
    overallRisk: 'none',
    recommendedAction: 'allow',
    redactedText: text,
    findings: [],
    policySignals: [],
    detector: { requested, used: 'regex', fallback: false },
  }
}

function withFindingReplacements(
  result: ScanResult, replacements: ReadonlyMap<string, string> | undefined, originalText?: string,
): ScanResult {
  if (replacements === undefined || replacements.size === 0) return result
  const findings = result.findings.map(finding => {
    const replacement = replacements.get(finding.id)
    if (replacement === undefined) return finding
    return { ...finding, replacement, sendReplacement: replacement }
  })
  const redactedText = [...findings].sort((left, right) => right.start - left.start).reduce((value, finding) => (
    value.slice(0, finding.start) + finding.replacement + value.slice(finding.end)
  ), originalText ?? result.redactedText)
  return { ...result, findings, redactedText }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

function privacyEnabled(snapshot: PrivacySnapshot): boolean {
  return snapshot.enabled
}

export class PrivacyController {
  constructor(
    readonly vault = new PrivacyVault(),
    private readonly executeRegex: RegexExecutor = runRegexWorker,
    private readonly zeroclave = new ZeroClaveDetector(),
    private readonly telemetryReporter: TelemetryReporter = new PrivacyTelemetry(),
  ) {
    this.snapshot = { ...this.snapshot, telemetry: {
      consent: this.telemetryReporter.consent,
      availability: 'checking',
      lockedByGpc: this.telemetryReporter.lockedByGpc,
    } }
  }
  private readonly embedded = new EmbeddedModelDetector()
  private readonly localModel = new LocalModelDetector()
  private readonly storedRules = loadRegexRules()
  private settingsError = this.storedRules.error
  private readonly lifetime = new AbortController()
  private readonly inspections = new Map<string, AbortController>()
  private readonly sends = new Set<AbortController>()
  private readonly findingReplacements = new Map<string, Map<string, string>>()
  private readonly customFindings = new Map<string, CustomFindingInput[]>()
  private zeroClaveTest: AbortController | undefined
  private zeroClaveStateOwner = 0
  private snapshot: PrivacySnapshot = {
    enabled: storedEnabled(),
    open: false,
    activeTab: 'audit',
    detectorMode: 'regex',
    detectorStates: {
      regex: { status: 'ready' },
      embedded: { status: 'idle' },
      zeroclave: { status: 'idle' },
      'local-model': { status: 'unconfigured' },
    },
    liveBySession: new Map(),
    regexRules: this.storedRules.rules,
    regexRevision: 0,
    regexError: this.storedRules.error,
    sendPolicy: storedSendPolicy(),
    telemetry: {
      consent: false,
      availability: 'checking',
      lockedByGpc: false,
    },
  }

  private readonly listeners = new Set<() => void>()
  private sendReview: {
    id: string
    resolve: (decisions: SendReviewDecisions | undefined) => void
    signal: AbortSignal
    abort: () => void
  } | undefined

  readonly getSnapshot = (): PrivacySnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async initializeTelemetry(): Promise<void> {
    this.telemetryReporter.setConsentListener((consent) => {
      if (this.lifetime.signal.aborted) return
      this.update({ ...this.snapshot, telemetry: {
        ...this.snapshot.telemetry,
        consent,
        lockedByGpc: this.telemetryReporter.lockedByGpc,
      } })
    })
    const availability = await this.telemetryReporter.initialize(this.lifetime.signal)
    if (this.lifetime.signal.aborted) return
    this.update({ ...this.snapshot, telemetry: {
      consent: this.telemetryReporter.consent,
      availability,
      lockedByGpc: this.telemetryReporter.lockedByGpc,
    } })
  }

  setTelemetryConsent(consent: boolean): void {
    const resolved = this.telemetryReporter.setConsent(consent)
    this.update({ ...this.snapshot, telemetry: {
      ...this.snapshot.telemetry,
      consent: resolved,
      lockedByGpc: this.telemetryReporter.lockedByGpc,
    } })
  }

  reportTelemetry(event: TelemetryEvent, value?: TelemetryDetector): void {
    this.telemetryReporter.report(event, value)
  }

  private reportScanTelemetry(texts: readonly string[], scanned: readonly ScanResult[]): void {
    if (texts.some(text => text.length > 0)) this.reportTelemetry('privacy_active')
    for (const detector of new Set(scanned.filter((_, index) => (texts[index]?.length ?? 0) > 0)
      .map(result => result.detector.used))) this.reportTelemetry('detector_used', detector)
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.cancelSendReview()
      this.cancelActiveOperations()
    }
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled))
    } catch {
      // Storage may be unavailable in a hardened browser; the in-memory setting still applies.
    }
    this.update({ ...this.snapshot, enabled })
  }

  setOpen(open: boolean): void {
    if (!open && this.snapshot.pendingSendReview !== undefined) { this.cancelSendReview(); return }
    this.update({ ...this.snapshot, open })
  }
  toggleOpen(): void { this.setOpen(!this.snapshot.open) }
  setTab(activeTab: PrivacySnapshot['activeTab']): void { this.update({ ...this.snapshot, activeTab }) }

  setSendPolicy(sendPolicy: SendPolicy): void {
    try { window.localStorage.setItem(SEND_POLICY_STORAGE_KEY, sendPolicy) } catch {
      // The in-memory policy remains effective when browser persistence is unavailable.
    }
    this.update({ ...this.snapshot, sendPolicy })
  }

  setSendReviewFinding(findingId: string, redact: boolean): void {
    const review = this.snapshot.pendingSendReview
    if (review === undefined || !(findingId in review.redactByFinding)) return
    this.update({ ...this.snapshot, pendingSendReview: {
      ...review, redactByFinding: { ...review.redactByFinding, [findingId]: redact },
    } })
  }

  setSendReviewReplacement(findingId: string, replacement: string): void {
    const review = this.snapshot.pendingSendReview
    if (review === undefined || !(findingId in review.replacementByFinding)) return
    this.update({ ...this.snapshot, pendingSendReview: {
      ...review, replacementByFinding: { ...review.replacementByFinding, [findingId]: replacement },
    } })
  }

  addSendReviewFinding(original: string, replacement: string, sourceType: string): boolean {
    const review = this.snapshot.pendingSendReview
    const source = original.trim()
    if (review === undefined || source === '' || replacement.trim() === '') return false
    const partIndex = review.parts.findIndex(part => part.text.includes(source))
    if (partIndex < 0) return false
    const part = review.parts[partIndex]
    if (part === undefined) return false
    const start = part.text.indexOf(source)
    const end = start + source.length
    if (part.result.findings.some(finding => start < finding.end && end > finding.start)) return false
    const finding: PrivacyFinding = {
      id: `custom_${randomUUID()}`,
      category: 'DIRECT_PII',
      entityType: 'OTHER',
      sourceType: sourceType.trim() || 'CUSTOM',
      start,
      end,
      maskedEvidence: source,
      replacement: replacement.trim(),
      severity: 'high',
      detector: part.result.detector.used,
      ruleName: 'User-added entity',
      action: 'redacted',
    }
    const parts = review.parts.map((item, index) => index === partIndex
      ? { ...item, result: rebuildScanResult(item.text, item.result, [...item.result.findings, finding]) }
      : item)
    const key = `${String(partIndex)}:${finding.id}`
    this.update({ ...this.snapshot, pendingSendReview: {
      ...review,
      parts,
      redactByFinding: { ...review.redactByFinding, [key]: true },
      replacementByFinding: { ...review.replacementByFinding, [key]: finding.replacement },
    } })
    return true
  }

  addLiveFinding(sessionId: string, original: string, replacement: string, sourceType: string): boolean {
    const live = this.snapshot.liveBySession.get(sessionId)
    const source = original.trim()
    const target = replacement.trim()
    if (live === undefined || source === '' || target === '') return false
    const start = live.text.indexOf(source)
    if (start < 0) return false
    const end = start + source.length
    if (live.result.findings.some(finding => start < finding.end && end > finding.start)) return false
    const item = { original: source, replacement: target, sourceType: sourceType.trim() || 'CUSTOM' }
    this.customFindings.set(sessionId, [...(this.customFindings.get(sessionId) ?? []), item])
    const finding = this.makeCustomFinding(item, start, end, live.result.detector.used)
    this.updateLive(sessionId, live.text, rebuildScanResult(live.text, live.result, [...live.result.findings, finding]), live.durationMs)
    if (this.snapshot.pendingSendReview?.sessionId === sessionId) {
      this.addSendReviewFinding(source, target, sourceType)
    }
    return true
  }

  confirmSendReview(): void {
    const review = this.snapshot.pendingSendReview
    if (review !== undefined) this.settleSendReview(review.id, {
      redactByFinding: review.redactByFinding,
      replacementByFinding: review.replacementByFinding,
    })
  }

  cancelSendReview(): void {
    const review = this.snapshot.pendingSendReview
    if (review !== undefined) this.settleSendReview(review.id, undefined)
  }

  setDetectorMode(detectorMode: DetectorMode): void {
    if (detectorMode === this.snapshot.detectorMode) return
    this.cancelActiveOperations()
    this.update({ ...this.snapshot, detectorMode })
  }

  scan(text: string): ScanResult {
    if (!this.snapshot.enabled) return disabledResult(text, this.snapshot.detectorMode)
    if (this.snapshot.detectorMode === 'zeroclave') return finalizeScan(text, [], 'zeroclave', 'zeroclave', false)
    if (this.snapshot.detectorMode === 'local-model') {
      const unavailable = finalizeScan(text, [], 'local-model', 'local-model', false)
      return text.length === 0 ? unavailable : {
        ...unavailable,
        recommendedAction: 'block',
        detector: { requested: 'local-model', used: 'local-model', fallback: false, status: 'partial' },
      }
    }
    return scanRegex(text, this.snapshot.detectorMode, this.snapshot.regexRules)
  }

  async selectLocalModel(modelFile: Blob & { name?: string }, manifestFile: Blob): Promise<LocalModelMetadata> {
    try {
      const metadata = await this.localModel.select(modelFile, manifestFile)
      this.update({ ...this.snapshot, localModel: metadata, detectorStates: {
        ...this.snapshot.detectorStates, 'local-model': { status: 'idle' },
      } })
      return metadata
    } catch (error) {
      const code = error instanceof LocalModelError ? error.code : 'manifest_invalid'
      this.setDetectorState('local-model', { status: 'error', code, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async loadLocalModel(): Promise<void> {
    this.setDetectorState('local-model', { status: 'loading', progress: 0 })
    try {
      await this.localModel.load(progress => { this.setDetectorState('local-model', { status: 'loading', progress }) }, this.lifetime.signal)
      this.setDetectorState('local-model', { status: 'ready', progress: 100 })
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      this.setDetectorState('local-model', { status: 'error', code: error instanceof LocalModelError ? error.code : 'runtime_unavailable', error: error instanceof Error ? error.message : String(error) })
    }
  }

  async unloadLocalModel(): Promise<void> {
    await this.localModel.unload()
    const { localModel: _localModel, ...withoutModel } = this.snapshot
    void _localModel
    this.update({ ...withoutModel, detectorStates: { ...this.snapshot.detectorStates, 'local-model': { status: 'unconfigured' } } })
  }

  saveRule(rule: EditableRegexRule): void {
    validateRule(rule)
    const rules = this.snapshot.regexRules
    this.commitRules(rules.some(item => item.id === rule.id)
      ? rules.map(item => item.id === rule.id ? { ...rule, name: rule.name.trim() } : item)
      : [...rules, { ...rule, name: rule.name.trim() }])
  }

  deleteRule(id: string): void {
    if (DEFAULT_REGEX_RULES.some(rule => rule.id === id)) throw new RegexRuleError('invalid')
    this.commitRules(this.snapshot.regexRules.filter(rule => rule.id !== id))
  }

  resetRule(id: string): void {
    const rule = DEFAULT_REGEX_RULES.find(item => item.id === id)
    if (rule !== undefined) this.saveRule(rule)
  }

  resetRules(): void { this.commitRules(DEFAULT_REGEX_RULES) }

  async testRule(rule: EditableRegexRule, text: string, signal?: AbortSignal): Promise<ScanResult> {
    validateRule(rule)
    const candidates = await scanConfiguredRules(text, [{ ...rule, enabled: true }], this.executeRegex, signal)
    return finalizeScan(text, candidates, 'regex', 'regex', false)
  }

  private commitRules(rules: readonly EditableRegexRule[]): void {
    saveRegexRules(rules)
    this.cancelActiveOperations()
    this.settingsError = undefined
    this.update({ ...this.snapshot, regexRules: rules, regexRevision: this.snapshot.regexRevision + 1,
      regexError: undefined, liveBySession: new Map() })
  }

  async inspect(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    const startedAt = Date.now()
    this.inspections.get(sessionId)?.abort()
    const operation = new AbortController()
    this.inspections.set(sessionId, operation)
    signal = AbortSignal.any([operation.signal, this.lifetime.signal, ...(signal === undefined ? [] : [signal])])
    const requested = this.snapshot.detectorMode
    const revision = this.snapshot.regexRevision
    this.findingReplacements.delete(sessionId)
    this.customFindings.delete(sessionId)
    const baseline = this.scan(text)
    this.updateLive(sessionId, text, baseline)
    if (!this.snapshot.enabled || aborted(signal)) return
    let result: ScanResult
    let zeroClaveOwner: number | undefined
    try {
      if (this.settingsError !== undefined) throw new RegexRuleError(this.settingsError)
      const candidates = requested === 'zeroclave' || requested === 'local-model'
        ? []
        : await scanConfiguredRules(text, this.snapshot.regexRules, this.executeRegex, signal)
      if (requested === 'local-model') {
        result = await this.localModel.scan(text, signal)
      } else if (requested === 'zeroclave') {
        zeroClaveOwner = this.beginZeroClaveOperation()
        const [remote] = await this.zeroclave.scanBatch([{
          id: 'draft', revision: `r-${randomUUID()}`, text, regex: [],
        }], signal)
        if (remote === undefined) {
          throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave result is missing')
        }
        result = remote
      } else {
        result = requested === 'embedded' && this.embedded.available()
          ? await this.embedded.scan(text, signal, candidates)
          : finalizeScan(text, candidates, requested, 'regex', requested !== 'regex')
      }
    } catch (error) {
      if (aborted(signal) || (error instanceof DOMException && error.name === 'AbortError')) {
        this.releaseZeroClaveOperation(zeroClaveOwner)
        return
      }
      const current = this.snapshot.liveBySession.get(sessionId)
      if (this.snapshot.detectorMode !== requested || current?.text !== text
        || this.snapshot.regexRevision !== revision) {
        this.releaseZeroClaveOperation(zeroClaveOwner)
        return
      }
      if (error instanceof RegexRuleError) {
        this.update({ ...this.snapshot, regexError: error.code })
        return
      }
      if (requested === 'zeroclave') this.finishZeroClaveOperation(zeroClaveOwner, this.zeroClaveError(error))
      else this.setDetectorState(requested, {
        status: 'error',
        ...(requested === 'local-model' && error instanceof LocalModelError ? { code: error.code } : {}),
        error: error instanceof Error ? error.message : String(error),
      })
      return
    } finally {
      if (this.inspections.get(sessionId) === operation) this.inspections.delete(sessionId)
    }
    if (aborted(signal)) {
      this.releaseZeroClaveOperation(zeroClaveOwner)
      return
    }
    const current = this.snapshot.liveBySession.get(sessionId)
    if (!privacyEnabled(this.snapshot) || this.snapshot.detectorMode !== requested || current?.text !== text
      || this.snapshot.regexRevision !== revision) {
      this.releaseZeroClaveOperation(zeroClaveOwner)
      return
    }
    if (this.snapshot.regexError !== undefined) this.update({ ...this.snapshot, regexError: undefined })
    if (requested === 'zeroclave') {
      this.finishZeroClaveOperation(zeroClaveOwner, {
        status: result.detector.status === 'partial' ? 'partial' : 'ready',
        ...(result.detector.requestId === undefined ? {} : { requestId: result.detector.requestId }),
      })
    }
    this.updateLive(sessionId, text, result, Math.max(0, Date.now() - startedAt))
    if (text.length > 0) {
      this.reportTelemetry('privacy_active')
      this.reportTelemetry('detector_used', result.detector.used)
    }
  }

  async loadEmbedded(): Promise<void> {
    if (this.snapshot.detectorStates.embedded.status === 'error') await this.embedded.dispose()
    if (this.embedded.available()) return
    this.setDetectorState('embedded', { status: 'loading', progress: 0 })
    try {
      await this.embedded.load((progress) => {
        if (!this.lifetime.signal.aborted) this.setDetectorState('embedded', { status: 'loading', progress })
      })
      if (this.lifetime.signal.aborted) {
        await this.embedded.dispose()
        return
      }
      this.setDetectorState('embedded', { status: 'ready', progress: 100 })
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      this.setDetectorState('embedded', {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async testZeroClave(signal?: AbortSignal): Promise<void> {
    this.zeroClaveTest?.abort()
    const operation = new AbortController()
    this.zeroClaveTest = operation
    const owner = this.beginZeroClaveOperation()
    const combined = AbortSignal.any([
      operation.signal, this.lifetime.signal, ...(signal === undefined ? [] : [signal]),
    ])
    try {
      const result = await this.zeroclave.scan(ZEROCLAVE_CONNECTION_TEST_TEXT, combined)
      this.finishZeroClaveOperation(owner, {
        status: result.detector.status === 'partial' ? 'partial' : 'ready',
        ...(result.detector.requestId === undefined ? {} : { requestId: result.detector.requestId }),
      })
    } catch (error) {
      if (combined.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        this.releaseZeroClaveOperation(owner)
        return
      }
      this.finishZeroClaveOperation(owner, this.zeroClaveError(error))
    } finally {
      if (this.zeroClaveTest === operation) this.zeroClaveTest = undefined
    }
  }

  async prepareSend(sessionId: string, text: string, signal?: AbortSignal): Promise<ScanResult> {
    return (await this.prepareSendBatch(sessionId, [text], signal))[0] ?? disabledResult(text, this.snapshot.detectorMode)
  }

  async prepareSendBatch(sessionId: string, texts: readonly string[], signal?: AbortSignal): Promise<ScanResult[]> {
    const operation = new AbortController()
    this.sends.add(operation)
    signal = AbortSignal.any([operation.signal, this.lifetime.signal, ...(signal === undefined ? [] : [signal])])
    const requested = this.snapshot.detectorMode
    let zeroClaveOwner: number | undefined
    try {
      signal.throwIfAborted()
      if (!this.snapshot.enabled) return texts.map(text => disabledResult(text, requested))
      if (texts.length === 0) return []
      const revision = this.snapshot.regexRevision
      if (this.settingsError !== undefined) throw new RegexRuleError(this.settingsError)
      const candidates: Awaited<ReturnType<typeof scanConfiguredRules>>[] = []
      for (const text of texts) {
        candidates.push(requested === 'zeroclave'
          ? []
          : await scanConfiguredRules(text, this.snapshot.regexRules, this.executeRegex, signal))
      }
      let scanned: ScanResult[]
      try {
        if (requested === 'zeroclave') {
          zeroClaveOwner = this.beginZeroClaveOperation()
          scanned = await this.zeroclave.scanBatch(texts.map((text, index) => ({
            id: `text-${String(index)}`,
            revision: `r-${randomUUID()}`,
            text,
            regex: [],
          })), signal)
          const partial = scanned.find(result => result.detector.status === 'partial')
          if (partial !== undefined) {
            if (!signal.aborted && privacyEnabled(this.snapshot)
              && this.snapshot.detectorMode === requested && this.snapshot.regexRevision === revision) {
              this.reportScanTelemetry(texts, scanned)
            }
            const partialError = new ZeroClaveDetectError(
              'partial_result', 'ZeroClave detection was incomplete; retry before sending', 200,
              partial.detector.requestId,
            )
            if (this.finishZeroClaveOperation(zeroClaveOwner, {
              status: 'partial', code: partialError.code,
              ...(partialError.status === undefined ? {} : { statusCode: partialError.status }),
              ...(partialError.requestId === undefined ? {} : { requestId: partialError.requestId }),
            })) this.showDetectorDetails()
            throw partialError
          }
          this.finishZeroClaveOperation(zeroClaveOwner, {
            status: 'ready',
            ...(scanned[0]?.detector.requestId === undefined ? {} : { requestId: scanned[0].detector.requestId }),
          })
        } else if (requested === 'local-model') {
          scanned = []
          for (const text of texts) scanned.push(await this.localModel.scan(text, signal))
        } else {
          scanned = []
          for (const [index, text] of texts.entries()) {
            const itemCandidates = candidates[index] ?? []
            scanned.push(requested === 'embedded' && this.embedded.available()
              ? await this.embedded.scan(text, signal, itemCandidates)
              : finalizeScan(text, itemCandidates, requested, 'regex', requested !== 'regex'))
          }
        }
      } catch (error) {
        if (error instanceof RegexRuleError) this.update({ ...this.snapshot, regexError: error.code })
        if (requested === 'zeroclave' && !signal.aborted
          && !(error instanceof ZeroClaveDetectError && error.code === 'partial_result')) {
          if (this.finishZeroClaveOperation(zeroClaveOwner, this.zeroClaveError(error))) this.showDetectorDetails()
        } else if (requested === 'local-model' && !signal.aborted) {
          this.setDetectorState('local-model', { status: 'error', code: error instanceof LocalModelError ? error.code : 'runtime_unavailable', error: error instanceof Error ? error.message : String(error) })
        }
        throw error
      }
      scanned = scanned.map((result, index) => {
        const text = texts[index] ?? ''
        const additions = (this.customFindings.get(sessionId) ?? []).flatMap(item => {
          const start = text.indexOf(item.original)
          if (start < 0) return []
          const end = start + item.original.length
          if (result.findings.some(finding => start < finding.end && end > finding.start)) return []
          return [this.makeCustomFinding(item, start, end, result.detector.used)]
        })
        return withFindingReplacements(
          rebuildScanResult(text, result, [...result.findings, ...additions]),
          this.findingReplacements.get(sessionId), text,
        )
      })
      signal.throwIfAborted()
      if (!privacyEnabled(this.snapshot) || this.snapshot.detectorMode !== requested
        || this.snapshot.regexRevision !== revision) throw new RegexRuleError('changed')
      this.reportScanTelemetry(texts, scanned)
      let decisions: SendReviewDecisions | undefined
      if (scanned.some(result => result.findings.length > 0) && this.snapshot.sendPolicy === 'review-manual') {
        const parts = texts.map((text, index) => {
          const result = scanned[index]
          if (result === undefined) throw new Error('Privacy scan result missing')
          return { text, result }
        })
        decisions = await this.requestSendReview(sessionId, parts, signal)
        if (decisions === undefined) throw new SendReviewCancelledError('Send cancelled during privacy review')
      }
      signal.throwIfAborted()
      if (!privacyEnabled(this.snapshot) || this.snapshot.detectorMode !== requested
        || this.snapshot.regexRevision !== revision) throw new RegexRuleError('changed')
      const outgoing: ScanResult[] = []
      for (const [index, result] of scanned.entries()) {
        this.assertSendCurrent(signal, requested, revision)
        const text = texts[index]
        if (text === undefined) throw new Error('Privacy scan input missing')
        const redacted = await this.vault.redact(sessionId, text, {
          ...result,
          findings: result.findings.map(finding => {
            const key = `${String(index)}:${finding.id}`
            const replacement = decisions?.replacementByFinding[key]
            return {
              ...finding,
              action: decisions?.redactByFinding[key] === false ? 'kept' : 'redacted',
              ...(finding.sendReplacement !== undefined
                ? { sendReplacement: finding.sendReplacement }
                : replacement === undefined || replacement === finding.replacement ? {} : { sendReplacement: replacement }),
            }
          }),
        })
        this.assertSendCurrent(signal, requested, revision)
        outgoing.push(redacted)
      }
      this.assertSendCurrent(signal, requested, revision)
      return outgoing
    } catch (error) {
      if (error instanceof RegexRuleError) this.update({ ...this.snapshot, regexError: error.code })
      throw error
    } finally {
      this.sends.delete(operation)
      if (signal.aborted) this.releaseZeroClaveOperation(zeroClaveOwner)
    }
  }

  private requestSendReview(
    sessionId: string, parts: readonly { text: string; result: ScanResult }[], signal: AbortSignal,
  ): Promise<SendReviewDecisions | undefined> {
    this.cancelSendReview()
    const id = randomUUID()
    const redactByFinding = Object.fromEntries(parts.flatMap((part, index) => (
      part.result.findings.map(finding => [`${String(index)}:${finding.id}`, true])
    )))
    const replacementByFinding = Object.fromEntries(parts.flatMap((part, index) => (
      part.result.findings.map(finding => [`${String(index)}:${finding.id}`, finding.replacement])
    )))
    return new Promise((resolve) => {
      const abort = (): void => { this.settleSendReview(id, undefined) }
      this.sendReview = { id, resolve, signal, abort }
      signal.addEventListener('abort', abort, { once: true })
      const first = parts[0]
      if (first !== undefined) this.updateLive(sessionId, first.text, first.result)
      this.update({ ...this.snapshot, open: true, pendingSendReview: {
        id, sessionId, parts, redactByFinding, replacementByFinding,
      } })
    })
  }

  private settleSendReview(id: string, decisions: SendReviewDecisions | undefined): void {
    const pending = this.sendReview
    if (pending?.id !== id) return
    pending.signal.removeEventListener('abort', pending.abort)
    this.sendReview = undefined
    const { pendingSendReview: _review, ...snapshot } = this.snapshot
    this.update(snapshot)
    pending.resolve(decisions)
  }

  setLiveFindingReplacement(sessionId: string, findingId: string, replacement: string): void {
    const live = this.snapshot.liveBySession.get(sessionId)
    if (live === undefined || !live.result.findings.some(finding => finding.id === findingId)) return
    const replacements = new Map(this.findingReplacements.get(sessionId))
    replacements.set(findingId, replacement)
    this.findingReplacements.set(sessionId, replacements)
    this.updateLive(sessionId, live.text, withFindingReplacements(live.result, replacements, live.text), live.durationMs)
    const review = this.snapshot.pendingSendReview
    const partIndex = review?.sessionId === sessionId
      ? review.parts.findIndex(part => part.result.findings.some(finding => finding.id === findingId))
      : -1
    if (review !== undefined && partIndex >= 0) {
      this.setSendReviewReplacement(`${String(partIndex)}:${findingId}`, replacement)
    }
  }

  setLiveFindingProtection(sessionId: string, findingId: string, protectedValue: boolean, original: string): void {
    const live = this.snapshot.liveBySession.get(sessionId)
    if (live === undefined) return
    const findings = live.result.findings.map(finding => finding.id === findingId
      ? { ...finding, action: protectedValue ? 'redacted' as const : 'kept' as const,
        replacement: original }
      : finding)
    this.updateLive(sessionId, live.text, rebuildScanResult(live.text, live.result, findings), live.durationMs)
    const review = this.snapshot.pendingSendReview
    const partIndex = review?.sessionId === sessionId
      ? review.parts.findIndex(part => part.result.findings.some(finding => finding.id === findingId))
      : -1
    if (review !== undefined && partIndex >= 0) {
      const key = `${String(partIndex)}:${findingId}`
      this.setSendReviewReplacement(key, original)
      this.setSendReviewFinding(key, protectedValue)
    }
  }

  async dispose(): Promise<void> {
    this.cancelSendReview()
    this.cancelActiveOperations()
    this.lifetime.abort()
    this.inspections.clear()
    this.findingReplacements.clear()
    this.customFindings.clear()
    this.listeners.clear()
    await this.embedded.dispose()
    await this.localModel.unload()
    await this.vault.dispose()
    await this.telemetryReporter.dispose()
  }

  updateLive(sessionId: string, text: string, result: ScanResult, durationMs?: number): void {
    const previous = this.snapshot.liveBySession.get(sessionId)
    const sameDuration = durationMs === undefined
      ? previous?.durationMs === undefined
      : previous?.durationMs === durationMs
    if (
      previous?.text === text
      && previous.result.detector.requested === result.detector.requested
      && previous.result.detector.used === result.detector.used
      && previous.result.detector.status === result.detector.status
      && previous.result.detector.model === result.detector.model
      && previous.result.detector.requestId === result.detector.requestId
      && previous.result.redactedText === result.redactedText
      && sameDuration
    ) return
    const liveBySession = new Map(this.snapshot.liveBySession)
    liveBySession.set(sessionId, {
      text, result, updatedAt: Date.now(),
      ...(durationMs === undefined ? {} : { durationMs }),
    })
    this.update({ ...this.snapshot, liveBySession })
  }

  private assertSendCurrent(signal: AbortSignal, requested: DetectorMode, revision: number): void {
    signal.throwIfAborted()
    if (!privacyEnabled(this.snapshot) || this.snapshot.detectorMode !== requested
      || this.snapshot.regexRevision !== revision) throw new RegexRuleError('changed')
  }

  private makeCustomFinding(item: CustomFindingInput, start: number, end: number, detector: DetectorMode): PrivacyFinding {
    return {
      id: `custom_${randomUUID()}`,
      category: 'DIRECT_PII', entityType: 'OTHER', sourceType: item.sourceType,
      start, end, maskedEvidence: item.original, replacement: item.replacement,
      severity: 'high', detector, ruleName: 'User-added entity', action: 'redacted',
    }
  }

  private beginZeroClaveOperation(): number {
    const owner = ++this.zeroClaveStateOwner
    this.setDetectorState('zeroclave', { status: 'loading' })
    return owner
  }

  private finishZeroClaveOperation(owner: number | undefined, state: DetectorRuntimeState): boolean {
    if (owner === undefined || owner !== this.zeroClaveStateOwner) return false
    this.setDetectorState('zeroclave', state)
    return true
  }

  private releaseZeroClaveOperation(owner: number | undefined): void {
    if (owner !== this.zeroClaveStateOwner || this.snapshot.detectorStates.zeroclave.status !== 'loading') return
    this.setDetectorState('zeroclave', { status: 'idle' })
  }

  private zeroClaveError(error: unknown): DetectorRuntimeState {
    if (error instanceof ZeroClaveDetectError) {
      return {
        status: 'error', error: error.message, code: error.code,
        ...(error.status === undefined ? {} : { statusCode: error.status }),
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      }
    }
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }

  private setDetectorState(mode: DetectorMode, state: DetectorRuntimeState): void {
    this.update({
      ...this.snapshot,
      detectorStates: { ...this.snapshot.detectorStates, [mode]: state },
    })
  }

  private showDetectorDetails(): void {
    this.update({ ...this.snapshot, open: true, activeTab: 'model' })
  }

  private cancelActiveOperations(): void {
    this.zeroClaveStateOwner += 1
    for (const operation of this.inspections.values()) operation.abort()
    this.inspections.clear()
    for (const operation of this.sends) operation.abort()
    this.zeroClaveTest?.abort()
    this.zeroClaveTest = undefined
    if (this.snapshot.detectorStates.zeroclave.status === 'loading') {
      this.setDetectorState('zeroclave', { status: 'idle' })
    }
  }

  private update(snapshot: PrivacySnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
