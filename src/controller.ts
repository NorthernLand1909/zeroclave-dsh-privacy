import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { DEFAULT_REGEX_RULES, finalizeScan, scanRegex } from './detector.ts'
import { EmbeddedModelDetector } from './embedded-model.ts'
import { PrivacyVault } from './vault.ts'
import {
  loadRegexRules, RegexRuleError, runRegexWorker, saveRegexRules, scanConfiguredRules, validateRule,
} from './regex-rules.ts'
import type { RegexExecutor } from './regex-rules.ts'
import type {
  DetectorMode, DetectorRuntimeState, PrivacySnapshot, RiskLevel, ScanResult, EditableRegexRule, SendPolicy,
} from './types.ts'

const ENABLED_STORAGE_KEY = 'zeroclave.privacy.enabled'
const SEND_POLICY_STORAGE_KEY = 'zeroclave.privacy.send-policy'

export class SendReviewCancelledError extends Error {}

function storedEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function storedSendPolicy(): SendPolicy {
  if (typeof window === 'undefined') return 'review-critical'
  try { return window.localStorage.getItem(SEND_POLICY_STORAGE_KEY) === 'auto-redact' ? 'auto-redact' : 'review-critical' } catch {
    return 'review-critical'
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

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

function privacyEnabled(snapshot: PrivacySnapshot): boolean {
  return snapshot.enabled
}

export class PrivacyController {
  constructor(readonly vault = new PrivacyVault(), private readonly executeRegex: RegexExecutor = runRegexWorker) {}
  private readonly embedded = new EmbeddedModelDetector()
  private readonly storedRules = loadRegexRules()
  private settingsError = this.storedRules.error
  private readonly lifetime = new AbortController()
  private readonly inspections = new Map<string, AbortController>()
  private snapshot: PrivacySnapshot = {
    enabled: storedEnabled(),
    open: false,
    activeTab: 'audit',
    detectorMode: 'regex',
    detectorStates: {
      regex: { status: 'ready' },
      embedded: { status: 'idle' },
      zeroclave: { status: 'unconfigured' },
    },
    liveBySession: new Map(),
    sendRecordsBySession: new Map(),
    regexRules: this.storedRules.rules,
    regexRevision: 0,
    regexError: this.storedRules.error,
    sendPolicy: storedSendPolicy(),
  }

  private readonly listeners = new Set<() => void>()
  private sendReview: {
    id: string
    resolve: (redactByFinding: Readonly<Record<string, boolean>> | undefined) => void
    signal: AbortSignal
    abort: () => void
  } | undefined

  readonly getSnapshot = (): PrivacySnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) this.cancelSendReview()
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

  confirmSendReview(): void {
    const review = this.snapshot.pendingSendReview
    if (review !== undefined) this.settleSendReview(review.id, review.redactByFinding)
  }

  cancelSendReview(): void {
    const review = this.snapshot.pendingSendReview
    if (review !== undefined) this.settleSendReview(review.id, undefined)
  }

  setDetectorMode(detectorMode: DetectorMode): void {
    this.update({ ...this.snapshot, detectorMode })
    for (const [sessionId, live] of this.snapshot.liveBySession) {
      void this.inspect(sessionId, live.text)
    }
  }

  scan(text: string): ScanResult {
    if (!this.snapshot.enabled) return disabledResult(text, this.snapshot.detectorMode)
    return scanRegex(text, this.snapshot.detectorMode, this.snapshot.regexRules)
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
    this.settingsError = undefined
    const live = [...this.snapshot.liveBySession]
    this.update({ ...this.snapshot, regexRules: rules, regexRevision: this.snapshot.regexRevision + 1,
      regexError: undefined, liveBySession: new Map() })
    for (const [id, state] of live) void this.inspect(id, state.text)
  }

  async inspect(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    this.inspections.get(sessionId)?.abort()
    const operation = new AbortController()
    this.inspections.set(sessionId, operation)
    signal = AbortSignal.any([operation.signal, this.lifetime.signal, ...(signal === undefined ? [] : [signal])])
    const requested = this.snapshot.detectorMode
    const revision = this.snapshot.regexRevision
    const baseline = this.scan(text)
    this.updateLive(sessionId, text, baseline)
    if (!this.snapshot.enabled || aborted(signal)) return
    let result: ScanResult
    try {
      if (this.settingsError !== undefined) throw new RegexRuleError(this.settingsError)
      const candidates = await scanConfiguredRules(text, this.snapshot.regexRules, this.executeRegex, signal)
      result = requested === 'embedded' && this.embedded.available()
        ? await this.embedded.scan(text, signal, candidates)
        : finalizeScan(text, candidates, requested, 'regex', requested !== 'regex')
    } catch (error) {
      if (aborted(signal) || (error instanceof DOMException && error.name === 'AbortError')) return
      if (error instanceof RegexRuleError) {
        this.update({ ...this.snapshot, regexError: error.code })
        return
      }
      this.setDetectorState(requested, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    } finally {
      if (this.inspections.get(sessionId) === operation) this.inspections.delete(sessionId)
    }
    if (aborted(signal)) return
    const current = this.snapshot.liveBySession.get(sessionId)
    if (!privacyEnabled(this.snapshot) || this.snapshot.detectorMode !== requested || current?.text !== text
      || this.snapshot.regexRevision !== revision) return
    if (this.snapshot.regexError !== undefined) this.update({ ...this.snapshot, regexError: undefined })
    this.updateLive(sessionId, text, result)
  }

  async loadEmbedded(): Promise<void> {
    if (this.snapshot.detectorStates.embedded.status === 'error') await this.embedded.dispose()
    if (this.embedded.available()) return
    this.setDetectorState('embedded', { status: 'loading', progress: 0 })
    try {
      await this.embedded.load((progress) => {
        this.setDetectorState('embedded', { status: 'loading', progress })
      })
      this.setDetectorState('embedded', { status: 'ready', progress: 100 })
      for (const [sessionId, live] of this.snapshot.liveBySession) {
        if (this.snapshot.detectorMode === 'embedded') void this.inspect(sessionId, live.text)
      }
    } catch (error) {
      this.setDetectorState('embedded', {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async prepareSend(sessionId: string, text: string, signal?: AbortSignal): Promise<ScanResult> {
    return (await this.prepareSendBatch(sessionId, [text], signal))[0] ?? disabledResult(text, this.snapshot.detectorMode)
  }

  async prepareSendBatch(sessionId: string, texts: readonly string[], signal?: AbortSignal): Promise<ScanResult[]> {
    signal = AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal])])
    signal.throwIfAborted()
    if (!this.snapshot.enabled) return texts.map(text => disabledResult(text, this.snapshot.detectorMode))
    const requested = this.snapshot.detectorMode
    const revision = this.snapshot.regexRevision
    if (this.settingsError !== undefined) throw new RegexRuleError(this.settingsError)
    const scanned: ScanResult[] = []
    try {
      for (const text of texts) {
        const candidates = await scanConfiguredRules(text, this.snapshot.regexRules, this.executeRegex, signal)
        scanned.push(requested === 'embedded' && this.embedded.available()
          ? await this.embedded.scan(text, signal, candidates)
          : finalizeScan(text, candidates, requested, 'regex', requested !== 'regex'))
      }
    } catch (error) {
      if (error instanceof RegexRuleError) this.update({ ...this.snapshot, regexError: error.code })
      throw error
    }
    signal.throwIfAborted()
    if (this.snapshot.regexRevision !== revision) throw new RegexRuleError('changed')
    let decisions: Readonly<Record<string, boolean>> | undefined
    if (scanned.some(result => result.overallRisk === 'critical') && this.snapshot.sendPolicy === 'review-critical') {
      const parts = texts.map((text, index) => {
        const result = scanned[index]
        if (result === undefined) throw new Error('Privacy scan result missing')
        return { text, result }
      })
      decisions = await this.requestSendReview(sessionId, parts, signal)
      if (decisions === undefined) throw new SendReviewCancelledError('Send cancelled during privacy review')
    }
    signal.throwIfAborted()
    if (this.snapshot.regexRevision !== revision) throw new RegexRuleError('changed')
    const outgoing: ScanResult[] = []
    for (const [index, result] of scanned.entries()) {
      const text = texts[index]
      if (text === undefined) throw new Error('Privacy scan input missing')
      outgoing.push(await this.vault.redact(sessionId, text, {
        ...result,
        findings: result.findings.map(finding => ({
          ...finding,
          action: decisions?.[`${String(index)}:${finding.id}`] === false ? 'kept' : 'redacted',
        })),
      }))
    }
    return outgoing
  }

  private requestSendReview(
    sessionId: string, parts: readonly { text: string; result: ScanResult }[], signal: AbortSignal,
  ): Promise<Readonly<Record<string, boolean>> | undefined> {
    this.cancelSendReview()
    const id = randomUUID()
    const redactByFinding = Object.fromEntries(parts.flatMap((part, index) => (
      part.result.findings.map(finding => [`${String(index)}:${finding.id}`, true])
    )))
    return new Promise((resolve) => {
      const abort = (): void => { this.settleSendReview(id, undefined) }
      this.sendReview = { id, resolve, signal, abort }
      signal.addEventListener('abort', abort, { once: true })
      this.update({ ...this.snapshot, open: true, pendingSendReview: {
        id, sessionId, parts, redactByFinding,
      } })
    })
  }

  private settleSendReview(id: string, decisions: Readonly<Record<string, boolean>> | undefined): void {
    const pending = this.sendReview
    if (pending?.id !== id) return
    pending.signal.removeEventListener('abort', pending.abort)
    this.sendReview = undefined
    const { pendingSendReview: _review, ...snapshot } = this.snapshot
    this.update(snapshot)
    pending.resolve(decisions)
  }

  clearSendRecords(sessionId: string): void {
    if (!this.snapshot.sendRecordsBySession.has(sessionId)) return
    const sendRecordsBySession = new Map(this.snapshot.sendRecordsBySession)
    sendRecordsBySession.delete(sessionId)
    this.update({ ...this.snapshot, sendRecordsBySession })
  }

  async dispose(): Promise<void> {
    this.cancelSendReview()
    this.lifetime.abort()
    this.inspections.clear()
    this.listeners.clear()
    await this.embedded.dispose()
    await this.vault.dispose()
  }

  updateLive(sessionId: string, text: string, result: ScanResult): void {
    const previous = this.snapshot.liveBySession.get(sessionId)
    if (
      previous?.text === text
      && previous.result.detector.requested === result.detector.requested
      && previous.result.detector.used === result.detector.used
      && previous.result.redactedText === result.redactedText
    ) return
    const liveBySession = new Map(this.snapshot.liveBySession)
    liveBySession.set(sessionId, { text, result, updatedAt: Date.now() })
    this.update({ ...this.snapshot, liveBySession })
  }

  recordSend(sessionId: string, results: readonly ScanResult[]): void {
    const findings = results.flatMap(result => result.findings)
    const detectors = [...new Set(findings.map(finding => finding.detector))]
    if (detectors.length === 0) detectors.push(...new Set(results.map(result => result.detector.used)))
    const riskRank: Record<RiskLevel, number> = { none: 0, medium: 1, high: 2, critical: 3 }
    const overallRisk = results.reduce<RiskLevel>((highest, result) => (
      riskRank[result.overallRisk] > riskRank[highest] ? result.overallRisk : highest
    ), 'none')
    const sendRecordsBySession = new Map(this.snapshot.sendRecordsBySession)
    const records = sendRecordsBySession.get(sessionId) ?? []
    sendRecordsBySession.set(sessionId, [...records.slice(-9), {
      id: randomUUID(),
      updatedAt: Date.now(),
      overallRisk,
      findingCount: findings.length,
      redactedCount: findings.filter(finding => finding.action !== 'kept').length,
      keptCount: findings.filter(finding => finding.action === 'kept').length,
      policySignalCount: results.reduce((count, result) => count + result.policySignals.length, 0),
      detectors,
      fallbackUsed: results.some(result => result.detector.fallback),
    }])
    this.update({ ...this.snapshot, sendRecordsBySession })
  }

  private setDetectorState(mode: DetectorMode, state: DetectorRuntimeState): void {
    this.update({
      ...this.snapshot,
      detectorStates: { ...this.snapshot.detectorStates, [mode]: state },
    })
  }

  private update(snapshot: PrivacySnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
