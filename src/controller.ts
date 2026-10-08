import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { DEFAULT_REGEX_RULES, finalizeScan, scanRegex } from './detector.ts'
import { EmbeddedModelDetector } from './embedded-model.ts'
import { PrivacyVault } from './vault.ts'
import {
  loadRegexRules, RegexRuleError, runRegexWorker, saveRegexRules, scanConfiguredRules, validateRule,
} from './regex-rules.ts'
import type { RegexExecutor } from './regex-rules.ts'
import { ZeroClaveDetectError, ZeroClaveDetector } from './zeroclave-detector.ts'
import { PrivacyTelemetry } from './telemetry.ts'
import type { TelemetryDetector, TelemetryEvent, TelemetryReporter } from './telemetry.ts'
import type {
  DetectorMode, DetectorRuntimeState, PrivacySnapshot, RiskLevel, ScanResult, EditableRegexRule, SendPolicy,
  PrivacyFinding, PrivacyLiveState, PendingSendReview,
} from './types.ts'

const ENABLED_STORAGE_KEY = 'zeroclave.privacy.enabled'
const SEND_POLICY_STORAGE_KEY = 'zeroclave.privacy.send-policy'
const DETECTOR_STORAGE_KEY = 'zeroclave.privacy.detector-mode'
const ZEROCLAVE_CONNECTION_TEST_TEXT = 'ZeroClave synthetic connection test: demo@example.com'

export class SendReviewCancelledError extends Error {}

interface SendReviewDecisions {
  redactByFinding: Readonly<Record<string, boolean>>
  replacementByFinding: Readonly<Record<string, string>>
  parts: readonly { text: string; result: ScanResult }[]
}

interface CustomFindingInput {
  id: string
  original: string
  replacement: string
  sourceType: string
  start: number
}

interface DraftDecisions {
  findings: Map<string, { redact?: boolean; replacement?: string }>
  additions: CustomFindingInput[]
}

function rebuildScanResult(text: string, result: ScanResult, findings: readonly PrivacyFinding[]): ScanResult {
  const ordered = [...findings].sort((left, right) => left.start - right.start)
  const redactedText = [...ordered].filter(finding => finding.action !== 'kept').sort((left, right) => right.start - left.start).reduce((value, finding) => (
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

function storedDetector(): DetectorMode {
  try {
    const value = window.localStorage.getItem(DETECTOR_STORAGE_KEY)
    return value === 'embedded' || value === 'zeroclave' ? value : 'regex'
  } catch { return 'regex' }
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
  private readonly storedRules = loadRegexRules()
  private settingsError = this.storedRules.error
  private readonly lifetime = new AbortController()
  private readonly inspections = new Map<string, AbortController>()
  private readonly sends = new Set<AbortController>()
  private readonly draftDecisions = new Map<string, Map<string, DraftDecisions>>()
  private readonly composerSends = new Map<string, { getText: () => string; submit: () => void | Promise<void> }>()
  private readonly activeSends = new Set<string>()
  private preapproved: { sessionId: string; detector: DetectorMode; revision: number; parts: SendReviewDecisions['parts'] } | undefined
  private zeroClaveTest: AbortController | undefined
  private zeroClaveStateOwner = 0
  private snapshot: PrivacySnapshot = {
    enabled: storedEnabled(),
    open: false,
    activeTab: 'audit',
    detectorMode: storedDetector(),
    detectorStates: {
      regex: { status: 'ready' },
      embedded: { status: 'idle' },
      zeroclave: { status: 'idle' },
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
      this.draftDecisions.clear()
      this.preapproved = undefined
    }
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled))
    } catch {
      // Storage may be unavailable in a hardened browser; the in-memory setting still applies.
    }
    this.update({ ...this.snapshot, enabled, liveBySession: enabled ? this.snapshot.liveBySession : new Map() })
  }

  setOpen(open: boolean): void {
    if (!open) this.preapproved = undefined
    if (!open && this.snapshot.pendingSendReview !== undefined) { this.cancelSendReview(); return }
    this.update({ ...this.snapshot, open, ...(open ? { activeTab: 'audit' as const } : {}) })
  }
  toggleOpen(): void { this.setOpen(!this.snapshot.open) }
  setActiveSession(sessionId: string): void {
    if (this.snapshot.activeSessionId !== sessionId) this.preapproved = undefined
    if (this.snapshot.pendingSendReview?.status !== 'sending' && this.snapshot.pendingSendReview?.sessionId !== undefined
      && this.snapshot.pendingSendReview.sessionId !== sessionId) {
      this.cancelSendReview()
    }
    if (this.snapshot.activeSessionId === sessionId) return
    this.update({ ...this.snapshot, activeSessionId: sessionId })
  }
  setTab(activeTab: PrivacySnapshot['activeTab']): void { this.update({ ...this.snapshot, activeTab }) }

  setSendPolicy(sendPolicy: SendPolicy): void {
    try { window.localStorage.setItem(SEND_POLICY_STORAGE_KEY, sendPolicy) } catch {
      // The in-memory policy remains effective when browser persistence is unavailable.
    }
    this.update({ ...this.snapshot, sendPolicy })
  }

  registerComposerSend(sessionId: string, composer: { getText: () => string; submit: () => void | Promise<void> }): () => void {
    this.composerSends.set(sessionId, composer)
    return () => { if (this.composerSends.get(sessionId) === composer) this.composerSends.delete(sessionId) }
  }

  canRequestComposerSend(sessionId: string): boolean {
    const composer = this.composerSends.get(sessionId)
    const live = this.snapshot.liveBySession.get(sessionId)
    return composer !== undefined && live?.text === composer.getText() && live.phase === 'ready'
      && live.regexRevision === this.snapshot.regexRevision && live.result.detector.requested === this.snapshot.detectorMode
      && live.result.detector.status !== 'partial' && live.text.trim() !== '' && this.activeSends.size === 0
  }

  async requestComposerSend(sessionId: string): Promise<void> {
    if (this.activeSends.size > 0) return
    const composer = this.composerSends.get(sessionId)
    if (composer === undefined) throw new Error('The message composer is unavailable')
    const text = composer.getText()
    const live = this.snapshot.liveBySession.get(sessionId)
    const review = this.snapshot.pendingSendReview
    const parts = review?.sessionId === sessionId && (review.status === 'error' || review.status === 'reviewing')
      && review.parts.length === 1 && review.parts[0]?.text === text
      ? review.parts : live === undefined ? [] : [{ text: live.text, result: live.result }]
    const ready = live?.text === text && live.phase === 'ready'
      && live.regexRevision === this.snapshot.regexRevision
      && live.result.detector.requested === this.snapshot.detectorMode
      && live.result.detector.status !== 'partial'
    this.preapproved = ready ? {
      sessionId, detector: this.snapshot.detectorMode, revision: this.snapshot.regexRevision, parts,
    } : undefined
    try { await composer.submit() } catch (error) { this.preapproved = undefined; throw error }
  }

  beginSend(sessionId: string): boolean {
    if (this.activeSends.size > 0) return false
    this.activeSends.add(sessionId)
    this.update({ ...this.snapshot, sendState: { sessionId, status: 'preparing' } })
    return true
  }

  markSending(sessionId: string): void {
    const review = this.snapshot.pendingSendReview
    this.update({ ...this.snapshot, sendState: { sessionId, status: 'sending' },
      ...(review?.sessionId === sessionId ? { pendingSendReview: { ...review, status: 'sending' as const } } : {}),
    })
  }

  finishSend(sessionId: string, ok: boolean, error?: string): void {
    const review = this.snapshot.pendingSendReview
    if (ok) {
      this.draftDecisions.delete(sessionId)
      const liveBySession = new Map(this.snapshot.liveBySession)
      liveBySession.delete(sessionId)
      const { sendState: _send, pendingSendReview: _review, ...snapshot } = this.snapshot
      this.update({ ...snapshot, liveBySession,
        ...(review !== undefined && review.sessionId !== sessionId ? { pendingSendReview: review } : {}),
        open: this.snapshot.activeSessionId !== sessionId && this.snapshot.open,
      })
    } else {
      const message = error ?? 'The message could not be sent. Your draft and privacy changes have been kept.'
      this.update({ ...this.snapshot, sendState: { sessionId, status: 'error', error: message },
        ...(review?.sessionId === sessionId ? { pendingSendReview: { ...review, status: 'error' as const, error: message } } : {}),
      })
    }
  }

  endSendAttempt(sessionId: string): void {
    this.activeSends.delete(sessionId)
    if (this.snapshot.sendState?.sessionId === sessionId && this.snapshot.sendState.status !== 'error') {
      const { sendState: _send, ...snapshot } = this.snapshot
      this.update(snapshot)
    } else this.update({ ...this.snapshot })
  }

  setSendReviewFinding(findingId: string, redact: boolean): void {
    const review = this.snapshot.pendingSendReview
    if (review === undefined || review.status === 'sending') return
    this.editReviewFinding(findingId, { redact })
  }

  setSendReviewReplacement(findingId: string, replacement: string): void {
    const review = this.snapshot.pendingSendReview
    if (review === undefined || review.status === 'sending') return
    this.editReviewFinding(findingId, { replacement })
  }

  addSendReviewFinding(original: string, replacement: string, sourceType: string): boolean {
    const review = this.snapshot.pendingSendReview
    if (review === undefined || review.status === 'sending') return false
    const part = review.parts.find(item => item.text.includes(original.trim()))
    return part !== undefined && this.addFinding(review.sessionId, part.text, part.result, original, replacement, sourceType)
  }

  addLiveFinding(sessionId: string, original: string, replacement: string, sourceType: string, allOccurrences = false): boolean {
    const live = this.snapshot.liveBySession.get(sessionId)
    if (live === undefined || live.phase !== 'ready' || this.snapshot.pendingSendReview?.status === 'sending') return false
    let added = this.addFinding(sessionId, live.text, live.result, original, replacement, sourceType)
    const anyAdded = added
    while (allOccurrences && added) {
      const current = this.snapshot.liveBySession.get(sessionId)
      added = current !== undefined && this.addFinding(sessionId, current.text, current.result, original, replacement, sourceType)
    }
    return anyAdded
  }

  setReviewPart(index: number): void {
    const review = this.snapshot.pendingSendReview
    const part = review?.parts[index]
    if (review === undefined || part === undefined || review.status === 'checking' || review.status === 'sending') return
    this.updateLive(review.sessionId, part.text, part.result, undefined, 'ready')
    this.update({ ...this.snapshot, pendingSendReview: { ...review, activePartIndex: index } })
  }

  confirmSendReview(): void {
    const review = this.snapshot.pendingSendReview
    const composer = review === undefined ? undefined : this.composerSends.get(review.sessionId)
    if (review !== undefined && this.sendReview?.id !== review.id
      && composer !== undefined && !review.parts.some(part => part.text === composer.getText())) {
      this.cancelSendReview()
      void this.inspect(review.sessionId, composer.getText())
      return
    }
    if (review?.status === 'reviewing' && this.sendReview?.id !== review.id) {
      void this.requestComposerSend(review.sessionId).catch((error: unknown) => {
        this.finishSend(review.sessionId, false, error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (review?.status === 'reviewing') this.settleSendReview(review.id, {
      redactByFinding: review.redactByFinding,
      replacementByFinding: review.replacementByFinding,
      parts: review.parts,
    })
  }

  cancelSendReview(): void {
    this.preapproved = undefined
    const review = this.snapshot.pendingSendReview
    if (review?.status === 'sending') return
    if (review !== undefined) {
      if (this.sendReview?.id === review.id) this.settleSendReview(review.id, undefined)
      else {
        const { pendingSendReview: _review, ...snapshot } = this.snapshot
        if (this.activeSends.has(review.sessionId)) this.update({ ...snapshot, open: false })
        else {
          const { sendState: _send, ...rest } = snapshot
          this.update({ ...rest, open: false })
        }
      }
    }
  }

  setDetectorMode(detectorMode: DetectorMode): void {
    if (detectorMode === this.snapshot.detectorMode) return
    this.cancelActiveOperations()
    this.preapproved = undefined
    try { window.localStorage.setItem(DETECTOR_STORAGE_KEY, detectorMode) } catch { /* In-memory selection still works. */ }
    this.update({ ...this.snapshot, detectorMode, liveBySession: new Map() })
  }

  scan(text: string): ScanResult {
    if (!this.snapshot.enabled) return disabledResult(text, this.snapshot.detectorMode)
    if (this.snapshot.detectorMode === 'zeroclave') {
      return finalizeScan(text, [], 'zeroclave', 'zeroclave', false)
    }
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
    this.cancelActiveOperations()
    this.preapproved = undefined
    this.settingsError = undefined
    this.update({ ...this.snapshot, regexRules: rules, regexRevision: this.snapshot.regexRevision + 1,
      regexError: undefined, liveBySession: new Map() })
  }

  async inspect(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    const activeReview = this.snapshot.pendingSendReview
    // Native submit detaches the editor before reaching the privacy boundary. Its new draft is independent.
    if (this.activeSends.has(sessionId) && (activeReview?.sessionId !== sessionId
      || activeReview.status === 'sending' || !activeReview.parts.some(part => part.text === text))) return
    if (activeReview?.sessionId === sessionId && activeReview.status === 'sending') return
    if (this.preapproved?.sessionId === sessionId) this.preapproved = undefined
    const startedAt = Date.now()
    this.inspections.get(sessionId)?.abort()
    const operation = new AbortController()
    this.inspections.set(sessionId, operation)
    signal = AbortSignal.any([operation.signal, this.lifetime.signal, ...(signal === undefined ? [] : [signal])])
    const requested = this.snapshot.detectorMode
    const revision = this.snapshot.regexRevision
    const pending = this.snapshot.pendingSendReview
    if (pending?.sessionId === sessionId && !pending.parts.some(part => part.text === text)) this.cancelSendReview()
    this.bindDrafts(sessionId, pending?.sessionId === sessionId && pending.parts.some(part => part.text === text)
      ? pending.parts.map(part => part.text) : [text])
    const previous = this.snapshot.liveBySession.get(sessionId)
    const baseline = previous?.text === text && previous.result.detector.requested === requested
      ? previous.result : this.scan(text)
    this.updateLive(sessionId, text, this.applyDecisions(sessionId, text, baseline), undefined, this.snapshot.enabled ? 'checking' : 'ready')
    this.setReviewPhase(sessionId, 'checking')
    if (!this.snapshot.enabled || aborted(signal)) return
    let result: ScanResult
    let zeroClaveOwner: number | undefined
    try {
      if (this.settingsError !== undefined) throw new RegexRuleError(this.settingsError)
      this.requireEmbedded(requested)
      const candidates = requested === 'zeroclave'
        ? []
        : await scanConfiguredRules(text, this.snapshot.regexRules, this.executeRegex, signal)
      if (requested === 'zeroclave') {
        zeroClaveOwner = this.beginZeroClaveOperation()
        const [remote] = await this.zeroclave.scanBatch([{
          id: 'draft', revision: `r-${randomUUID()}`, text, regex: [],
        }], signal)
        if (remote === undefined) {
          throw new ZeroClaveDetectError('detector_response_invalid', 'ZeroClave result is missing')
        }
        result = remote
      } else {
        result = requested === 'embedded'
          ? await this.embedded.scan(text, signal, candidates)
          : finalizeScan(text, candidates, requested, 'regex', false)
      }
      result = await this.vault.preview(sessionId, text, this.applyDecisions(sessionId, text, result))
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
      } else if (requested === 'zeroclave') this.finishZeroClaveOperation(zeroClaveOwner, this.zeroClaveError(error))
      else if (!(requested === 'embedded' && this.snapshot.detectorStates.embedded.status === 'loading')) this.setDetectorState(requested, {
        status: 'error', error: error instanceof Error ? error.message : String(error),
      })
      const message = error instanceof Error ? error.message : String(error)
      this.updateLive(sessionId, text, current.result, undefined, 'error', message)
      this.setReviewPhase(sessionId, 'error', message)
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
    } else this.setDetectorState(requested, { status: 'ready' })
    result = this.applyDecisions(sessionId, text, result)
    this.updateLive(sessionId, text, result, Math.max(0, Date.now() - startedAt), result.detector.status === 'partial' ? 'error' : 'ready')
    const review = this.snapshot.pendingSendReview
    if (review?.sessionId === sessionId) {
      const { error: _error, ...rest } = review
      this.update({ ...this.snapshot, pendingSendReview: this.reviewWithParts({ ...rest,
        status: result.detector.status === 'partial' ? 'error' : 'reviewing',
      }, review.parts.map(part => part.text === text ? { text, result } : part)) })
    }
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
      this.requireEmbedded(requested)
      this.inspections.get(sessionId)?.abort()
      this.inspections.delete(sessionId)
      this.bindDrafts(sessionId, texts)
      const approval = this.preapproved
      this.preapproved = undefined
      const approved = approval?.sessionId === sessionId && approval.detector === requested
        && approval.revision === revision && approval.parts.length === texts.length
        && approval.parts.every((part, index) => part.text === texts[index] && part.result.detector.status !== 'partial')
      const firstText = texts[0]
      if (firstText !== undefined) {
        const live = this.snapshot.liveBySession.get(sessionId)
        this.updateLive(sessionId, firstText, live?.text === firstText ? live.result : this.scan(firstText), undefined, 'checking')
      }
      if (this.settingsError !== undefined) throw new RegexRuleError(this.settingsError)
      const candidates: Awaited<ReturnType<typeof scanConfiguredRules>>[] = []
      for (const text of approved ? [] : texts) {
        candidates.push(requested === 'zeroclave'
          ? []
          : await scanConfiguredRules(text, this.snapshot.regexRules, this.executeRegex, signal))
      }
      let scanned: ScanResult[]
      try {
        if (approved) {
          scanned = approval.parts.map(part => part.result)
        } else if (requested === 'zeroclave') {
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
        } else {
          scanned = []
          for (const [index, text] of texts.entries()) {
            const itemCandidates = candidates[index] ?? []
            scanned.push(requested === 'embedded'
              ? await this.embedded.scan(text, signal, itemCandidates)
              : finalizeScan(text, itemCandidates, requested, 'regex', false))
          }
        }
      } catch (error) {
        if (error instanceof RegexRuleError) this.update({ ...this.snapshot, regexError: error.code })
        if (requested === 'zeroclave' && !signal.aborted
          && !(error instanceof ZeroClaveDetectError && error.code === 'partial_result')) {
          if (this.finishZeroClaveOperation(zeroClaveOwner, this.zeroClaveError(error))) this.showDetectorDetails()
        }
        throw error
      }
      scanned = await Promise.all(scanned.map((result, index) => {
        const text = texts[index] ?? ''
        return this.vault.preview(sessionId, text, this.applyDecisions(sessionId, text, result))
      }))
      signal.throwIfAborted()
      if (!privacyEnabled(this.snapshot) || this.snapshot.detectorMode !== requested
        || this.snapshot.regexRevision !== revision) throw new RegexRuleError('changed')
      this.reportScanTelemetry(texts, scanned)
      if (firstText !== undefined && scanned[0] !== undefined) this.updateLive(sessionId, firstText, scanned[0], undefined, 'ready')
      let decisions: SendReviewDecisions | undefined
      if (scanned.some(result => result.findings.length > 0) && this.snapshot.sendPolicy === 'review-manual' && !approved) {
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
      const reviewedParts = decisions?.parts ?? texts.map((text, index) => {
        const result = scanned[index]
        if (result === undefined) throw new Error('Privacy scan result missing')
        return { text, result }
      })
      const outgoing: ScanResult[] = []
      for (const [index, part] of reviewedParts.entries()) {
        this.assertSendCurrent(signal, requested, revision)
        const result = part.result
        const redacted = await this.vault.redact(sessionId, part.text, {
          ...result,
          findings: result.findings.map(finding => {
            const key = `${String(index)}:${finding.id}`
            const replacement = decisions?.replacementByFinding[key]
            return {
              ...finding,
              action: (decisions?.redactByFinding[key] ?? finding.action !== 'kept') ? 'redacted' : 'kept',
              ...(replacement !== undefined && replacement !== finding.replacement ? { sendReplacement: replacement } : {}),
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
      if (!(error instanceof SendReviewCancelledError) && !signal.aborted) {
        const current = this.snapshot.liveBySession.get(sessionId)
        const message = error instanceof Error ? error.message : String(error)
        if (current !== undefined) this.updateLive(sessionId, current.text, current.result, current.durationMs, 'error', message)
        if (requested === 'embedded' && this.snapshot.detectorStates.embedded.status !== 'loading') {
          this.setDetectorState('embedded', { status: 'error', error: message })
        }
        this.showDetectorDetails()
      }
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
      part.result.findings.map(finding => [`${String(index)}:${finding.id}`, finding.action !== 'kept'])
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
      this.update({ ...this.snapshot, open: true, activeTab: 'audit', pendingSendReview: {
        id, sessionId, parts, redactByFinding, replacementByFinding, status: 'reviewing', activePartIndex: 0,
      } })
    })
  }

  private settleSendReview(id: string, decisions: SendReviewDecisions | undefined): void {
    const pending = this.sendReview
    if (pending?.id !== id) return
    pending.signal.removeEventListener('abort', pending.abort)
    this.sendReview = undefined
    if (decisions === undefined) {
      const { pendingSendReview: _review, ...snapshot } = this.snapshot
      this.update({ ...snapshot, open: false })
    } else {
      const review = this.snapshot.pendingSendReview
      if (review?.id === id) this.update({ ...this.snapshot, pendingSendReview: { ...review, status: 'sending' } })
    }
    pending.resolve(decisions)
  }

  setLiveFindingReplacement(sessionId: string, findingId: string, replacement: string): void {
    this.setLiveFindingsReplacement(sessionId, [findingId], replacement)
  }

  setLiveFindingProtection(sessionId: string, findingId: string, protectedValue: boolean, _original?: string): void {
    this.setLiveFindingsProtection(sessionId, [findingId], protectedValue)
  }

  setLiveFindingsReplacement(sessionId: string, findingIds: readonly string[], replacement: string): void {
    this.editLiveFindings(sessionId, findingIds, { replacement })
  }

  setLiveFindingsProtection(sessionId: string, findingIds: readonly string[], protectedValue: boolean): void {
    this.editLiveFindings(sessionId, findingIds, { redact: protectedValue })
  }

  private editLiveFindings(sessionId: string, ids: readonly string[], patch: { redact?: boolean; replacement?: string }): void {
    const live = this.snapshot.liveBySession.get(sessionId)
    if (live === undefined || live.phase !== 'ready' || this.snapshot.pendingSendReview?.status === 'sending') return
    for (const finding of live.result.findings) {
      if (ids.includes(finding.id)) this.saveDecision(sessionId, live.text, finding, patch)
    }
    this.refreshDraft(sessionId, live.text)
  }

  private editReviewFinding(key: string, patch: { redact?: boolean; replacement?: string }): void {
    const review = this.snapshot.pendingSendReview
    if (review === undefined || review.status === 'checking' || review.status === 'sending') return
    const separator = key.indexOf(':')
    const part = review.parts[Number(key.slice(0, separator))]
    const finding = part?.result.findings.find(item => item.id === key.slice(separator + 1))
    if (part === undefined || finding === undefined) return
    this.saveDecision(review.sessionId, part.text, finding, patch)
    this.refreshDraft(review.sessionId, part.text)
  }

  private decisionKey(text: string, finding: PrivacyFinding): string {
    return `${String(finding.start)}:${String(finding.end)}:${finding.entityType}:${text.slice(finding.start, finding.end)}`
  }

  private decisions(sessionId: string, text: string): DraftDecisions {
    let session = this.draftDecisions.get(sessionId)
    if (session === undefined) { session = new Map(); this.draftDecisions.set(sessionId, session) }
    let draft = session.get(text)
    if (draft === undefined) { draft = { findings: new Map(), additions: [] }; session.set(text, draft) }
    return draft
  }

  private bindDrafts(sessionId: string, texts: readonly string[]): void {
    if (this.preapproved?.sessionId === sessionId && !this.preapproved.parts.every(part => texts.includes(part.text))) {
      this.preapproved = undefined
    }
    const session = this.draftDecisions.get(sessionId)
    if (session !== undefined && [...session.keys()].some(text => !texts.includes(text))) {
      this.draftDecisions.delete(sessionId)
    }
    for (const text of texts) this.decisions(sessionId, text)
  }

  private saveDecision(sessionId: string, text: string, finding: PrivacyFinding, patch: { redact?: boolean; replacement?: string }): void {
    this.preapproved = undefined
    const draft = this.decisions(sessionId, text)
    const key = this.decisionKey(text, finding)
    draft.findings.set(key, { ...draft.findings.get(key), ...patch })
  }

  private applyDecisions(sessionId: string, text: string, result: ScanResult): ScanResult {
    const draft = this.decisions(sessionId, text)
    const findings = [...result.findings]
    for (const item of draft.additions) {
      const end = item.start + item.original.length
      if (!findings.some(finding => item.start < finding.end && end > finding.start)) {
        findings.push(this.makeCustomFinding(item, item.start, end, result.detector.used))
      }
    }
    return rebuildScanResult(text, result, findings.map(finding => {
      const choice = draft.findings.get(this.decisionKey(text, finding))
      return { ...finding,
        ...(choice?.redact === undefined ? {} : { action: choice.redact ? 'redacted' as const : 'kept' as const }),
        ...(choice?.replacement === undefined ? {} : { replacement: choice.replacement, sendReplacement: choice.replacement }),
      }
    }))
  }

  private reviewWithParts(review: PendingSendReview, parts: PendingSendReview['parts']): PendingSendReview {
    return { ...review, parts,
      redactByFinding: Object.fromEntries(parts.flatMap((part, index) => part.result.findings.map(finding => [
        `${String(index)}:${finding.id}`, finding.action !== 'kept',
      ]))),
      replacementByFinding: Object.fromEntries(parts.flatMap((part, index) => part.result.findings.map(finding => [
        `${String(index)}:${finding.id}`, finding.replacement,
      ]))),
    }
  }

  private refreshDraft(sessionId: string, text: string): void {
    const live = this.snapshot.liveBySession.get(sessionId)
    if (live?.text === text) this.updateLive(sessionId, text, this.applyDecisions(sessionId, text, live.result), live.durationMs, live.phase)
    const review = this.snapshot.pendingSendReview
    if (review?.sessionId === sessionId) {
      this.update({ ...this.snapshot, pendingSendReview: this.reviewWithParts(review, review.parts.map(part => (
        part.text === text ? { ...part, result: this.applyDecisions(sessionId, text, part.result) } : part
      ))) })
    }
  }

  private addFinding(sessionId: string, text: string, result: ScanResult, original: string, replacement: string, sourceType: string): boolean {
    const source = original.trim()
    const target = replacement.trim()
    if (source === '' || target === '') return false
    let start = text.indexOf(source)
    while (start >= 0 && result.findings.some(finding => start < finding.end && start + source.length > finding.start)) {
      start = text.indexOf(source, start + source.length)
    }
    if (start < 0) return false
    this.preapproved = undefined
    this.decisions(sessionId, text).additions.push({
      id: `custom_${randomUUID()}`, original: source, replacement: target, sourceType: sourceType.trim() || 'CUSTOM', start,
    })
    this.refreshDraft(sessionId, text)
    return true
  }

  async dispose(): Promise<void> {
    this.cancelSendReview()
    this.cancelActiveOperations()
    this.lifetime.abort()
    this.inspections.clear()
    this.draftDecisions.clear()
    this.composerSends.clear()
    this.listeners.clear()
    await this.embedded.dispose()
    await this.vault.dispose()
    await this.telemetryReporter.dispose()
  }

  updateLive(sessionId: string, text: string, result: ScanResult, durationMs?: number, phase: PrivacyLiveState['phase'] = 'ready', error?: string): void {
    const liveBySession = new Map(this.snapshot.liveBySession)
    liveBySession.set(sessionId, {
      text, result, updatedAt: Date.now(), phase, regexRevision: this.snapshot.regexRevision,
      ...(error === undefined ? {} : { error }),
      ...(durationMs === undefined ? {} : { durationMs }),
    })
    this.update({ ...this.snapshot, liveBySession })
  }

  private assertSendCurrent(signal: AbortSignal, requested: DetectorMode, revision: number): void {
    signal.throwIfAborted()
    if (!privacyEnabled(this.snapshot) || this.snapshot.detectorMode !== requested
      || this.snapshot.regexRevision !== revision) throw new RegexRuleError('changed')
  }

  private requireEmbedded(mode: DetectorMode): void {
    if (mode === 'embedded' && !this.embedded.available()) {
      throw new Error('BERT is not loaded. Load the model or explicitly select local regex before sending.')
    }
  }

  private setReviewPhase(sessionId: string, status: PendingSendReview['status'], error?: string): void {
    const review = this.snapshot.pendingSendReview
    if (review?.sessionId !== sessionId) return
    const { error: _previousError, ...rest } = review
    this.update({ ...this.snapshot, pendingSendReview: { ...rest, status, ...(error === undefined ? {} : { error }) } })
  }

  private makeCustomFinding(item: CustomFindingInput, start: number, end: number, detector: DetectorMode): PrivacyFinding {
    return {
      id: item.id,
      category: 'DIRECT_PII', entityType: 'OTHER', sourceType: item.sourceType,
      start, end, maskedEvidence: item.original, replacement: item.replacement, sendReplacement: item.replacement,
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
    this.update({ ...this.snapshot, open: true, activeTab: 'audit' })
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
