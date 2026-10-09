import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Copy, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide'
import type { IconNode as LucideNode } from 'lucide'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PrivacyController } from '../controller.ts'
import type {
  DetectorMode, PrivacyFinding, PrivacySnapshot, RiskLevel, ScanResult,
  EditableRegexRule, EntityType, FindingCategory, RegexErrorCode, PrivacyLiveState,
} from '../types.ts'
import { DEFAULT_REGEX_RULES } from '../detector.ts'
import { RULE_ENTITY_TYPES } from '../regex-rules.ts'
import type { PrivacyKey } from './locales.ts'
import { selectedSessionId } from './session-selection.ts'
import css from './PrivacySurfaces.module.css'
import zeroclaveLogo from './assets/zeroclave-logo.png'

interface ControllerProps { controller: PrivacyController }

export type HeaderButtonProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'zeroclave.privacy'> & ControllerProps
export type FooterButtonProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'zeroclave.privacy'> & ControllerProps
export type PrivacyDockProps =
  PropsRuntime<'conversation.input.dock'> & PropsLocale<'zeroclave.privacy'> & ControllerProps
export type PrivacyDrawerProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'zeroclave.privacy'> & ControllerProps

const ENTITY_KEYS: Record<PrivacyFinding['entityType'], PrivacyKey> = {
  AGE: 'entity.AGE',
  EMAIL: 'entity.EMAIL',
  PHONE: 'entity.PHONE',
  PERSON: 'entity.PERSON',
  ADDRESS: 'entity.ADDRESS',
  COORDINATE: 'entity.COORDINATE',
  HONORIFIC: 'entity.HONORIFIC',
  ORGANIZATION: 'entity.ORGANIZATION',
  NATIONAL_ID: 'entity.NATIONAL_ID',
  CREDIT_CODE: 'entity.CREDIT_CODE',
  BANK_ACCOUNT: 'entity.BANK_ACCOUNT',
  BANK_NAME: 'entity.BANK_NAME',
  CONTRACT_ID: 'entity.CONTRACT_ID',
  DATE_TIME: 'entity.DATE_TIME',
  FINANCIAL: 'entity.FINANCIAL',
  CREDIT_CARD: 'entity.CREDIT_CARD',
  IBAN_CODE: 'entity.IBAN_CODE',
  IP_ADDRESS: 'entity.IP_ADDRESS',
  IMEI: 'entity.IMEI',
  MAC_ADDRESS: 'entity.MAC_ADDRESS',
  NRP: 'entity.NRP',
  URL: 'entity.URL',
  TITLE: 'entity.TITLE',
  PASSWORD: 'entity.PASSWORD',
  PRIVATE_KEY: 'entity.PRIVATE_KEY',
  API_KEY: 'entity.API_KEY',
  US_DRIVER_LICENSE: 'entity.US_DRIVER_LICENSE',
  US_ITIN: 'entity.US_ITIN',
  US_LICENSE_PLATE: 'entity.US_LICENSE_PLATE',
  US_PASSPORT: 'entity.US_PASSPORT',
  US_SSN: 'entity.US_SSN',
  OTHER: 'entity.OTHER',
}

const CATEGORY_KEYS: Record<PrivacyFinding['category'], PrivacyKey> = {
  DIRECT_PII: 'category.DIRECT_PII',
  FINANCIAL: 'category.FINANCIAL',
  BUSINESS: 'category.BUSINESS',
  SECRET: 'category.SECRET',
}

const DETECTOR_KEYS: Record<DetectorMode, PrivacyKey> = {
  regex: 'source.regex',
  embedded: 'source.embedded',
  zeroclave: 'source.zeroclave',
}

const RISK_KEYS: Record<RiskLevel, PrivacyKey> = {
  none: 'risk.none',
  medium: 'risk.medium',
  high: 'risk.high',
  critical: 'risk.critical',
}

function ruleDisplayName(
  ruleId: string | undefined,
  entityType: PrivacyFinding['entityType'],
  fallback: string | undefined,
  t: PrivacyDrawerProps['t'],
): string {
  if (ruleId === 'builtin-0') return t('rules.fieldKey')
  if (ruleId === 'builtin-1') return t('rules.tokenPrefix')
  if (ruleId === 'builtin-7') return `${t(ENTITY_KEYS[entityType])} · ${t('rules.luhn')}`
  if (ruleId === 'builtin-8') return `${t(ENTITY_KEYS[entityType])} · ${t('rules.iban')}`
  if (ruleId?.startsWith('builtin-') === true) return t(ENTITY_KEYS[entityType])
  return fallback ?? t('audit.deterministic')
}

function findingSources(result: ScanResult): DetectorMode[] {
  const modes = new Set(result.findings.map(finding => finding.detector))
  if (modes.size === 0) modes.add(result.detector.used)
  return (['regex', 'embedded', 'zeroclave'] as const).filter(mode => modes.has(mode))
}

function detectorSummary(result: ScanResult, t: PrivacyDrawerProps['t']): string {
  if (result.detector.fallback) return t('source.regexFallback')
  const sources = findingSources(result)
  if (sources.includes('regex') && sources.includes('embedded')) return t('source.combined')
  return t(DETECTOR_KEYS[result.detector.used])
}

function findingTypeLabel(finding: PrivacyFinding, t: PrivacyDrawerProps['t']): string {
  if (finding.entityType === 'OTHER' && finding.sourceType !== undefined) return finding.sourceType
  return t(ENTITY_KEYS[finding.entityType])
}

function usePrivacy(controller: PrivacyController): PrivacySnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

function ShieldIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path d="M12 2.8 20 6v5.5c0 5-3.2 8.2-8 9.7-4.8-1.5-8-4.7-8-9.7V6l8-3.2Z" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m8.8 12 2.1 2.1 4.5-4.7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LucideIcon({ icon, size = 15 }: { icon: LucideNode; size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      {icon.map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
    </svg>
  )
}

function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={css.textButton}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => { setCopied(false) }, 1200)
        })
      }}
    >
      {copied ? <span aria-hidden="true">✓</span> : <LucideIcon icon={Copy} size={13} />}
      <span>{label}</span>
    </button>
  )
}

function SwitchControl({ checked, label, disabled = false, onChange }: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <button
      className={css.switchControl}
      data-enabled={checked || undefined}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
    >
      <span aria-hidden="true"><i /></span>
    </button>
  )
}

function HighlightedText({ text, findings, t, cancelled }: {
  text: string
  findings: readonly PrivacyFinding[]
  t: PrivacyDrawerProps['t']
  cancelled?: ReadonlySet<string>
}): ReactNode {
  const ordered = [...findings]
    .filter(finding => finding.action !== 'kept'
      && finding.start >= 0 && finding.end > finding.start && finding.end <= text.length)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const output: ReactNode[] = []
  let cursor = 0
  for (const finding of ordered) {
    if (finding.start < cursor) continue
    if (finding.start > cursor) output.push(text.slice(cursor, finding.start))
    output.push(
      <mark
        className={css.sensitiveHighlight}
        data-risk={finding.severity}
        data-cancelled={cancelled?.has(finding.id) || undefined}
        title={`${findingTypeLabel(finding, t)} · ${t(DETECTOR_KEYS[finding.detector])}`}
        key={finding.id}
      >
        {text.slice(finding.start, finding.end)}
      </mark>,
    )
    cursor = finding.end
  }
  if (cursor < text.length) output.push(text.slice(cursor))
  return <>{output}</>
}

export function HeaderButton({ controller, t }: HeaderButtonProps): ReactNode {
  const snapshot = usePrivacy(controller)
  return (
    <button
      className={css.headerButton}
      data-open={snapshot.open || undefined}
      data-enabled={snapshot.enabled || undefined}
      type="button"
      aria-pressed={snapshot.open}
      onClick={() => { controller.setTab('audit'); controller.setOpen(true) }}
    >
      <ShieldIcon size={14} />
      <span>{t('headerAction')}</span>
      <span className={css.liveDot} />
    </button>
  )
}

export function FooterButton({ controller, wide, t }: FooterButtonProps): ReactNode {
  const snapshot = usePrivacy(controller)
  return (
    <button
      className={css.footerButton}
      data-wide={wide || undefined}
      data-enabled={snapshot.enabled || undefined}
      type="button"
      aria-label={t('brand')}
      onClick={() => { controller.setTab('audit'); controller.setOpen(true) }}
    >
      <ShieldIcon size={16} />
      {wide ? <span>{t('brand')}</span> : null}
      {wide ? <small>{snapshot.enabled ? t('footerEnabled') : t('paused')}</small> : null}
    </button>
  )
}

export function PrivacyDock({ controller, sessionId, t, useInput, inputActions }: PrivacyDockProps): ReactNode {
  const snapshot = usePrivacy(controller)
  // Harness trims the serialized message before its send boundary.
  const draft = useInput(state => state.draft).trim()
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => controller.registerComposerSend(sessionId, {
    getText: () => draftRef.current,
    submit: () => { inputActions.submit() },
  }), [controller, sessionId, inputActions])
  const baseline = useMemo(
    () => controller.scan(draft),
    [controller, draft, snapshot.detectorMode, snapshot.enabled, snapshot.regexRevision],
  )
  const live = snapshot.liveBySession.get(sessionId)
  const result = live?.text === draft ? live.result : baseline
  const sendBusy = snapshot.sendState?.sessionId === sessionId
    && (snapshot.sendState.status === 'preparing' || snapshot.sendState.status === 'sending')

  useEffect(() => {
    controller.setActiveSession(sessionId)
    if (sendBusy) return
    const abort = new AbortController()
    const delay = snapshot.detectorMode === 'zeroclave'
      ? 650
      : snapshot.detectorMode === 'embedded' ? 300 : 0
    const timer = window.setTimeout(() => {
      void controller.inspect(sessionId, draft, abort.signal)
    }, delay)
    return () => {
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [controller, draft, sessionId, snapshot.detectorMode, snapshot.enabled,
    snapshot.detectorStates.embedded.status, snapshot.regexRevision, sendBusy])

  const incomplete = result.detector.status === 'partial'
  const detectorState = snapshot.detectorStates[snapshot.detectorMode]
  const remotePhase = live?.text === draft && live.phase === 'error' ? 'error'
    : live?.text === draft && live.phase === 'checking' ? 'loading'
      : detectorState.status === 'loading' || detectorState.status === 'error' ? detectorState.status : undefined
  if (!snapshot.enabled || draft === '' || (
    result.findings.length === 0 && result.policySignals.length === 0 && !incomplete && remotePhase === undefined
  )) return null

  const count = result.findings.length + result.policySignals.length
  const title = remotePhase === 'loading' ? t('flow.checking')
    : remotePhase === 'error' ? t('flow.failed')
      : t(incomplete ? 'dock.partial' : 'dock.title')
  const detail = remotePhase === 'loading' ? t('dock.checkingReminder')
    : remotePhase === 'error' ? t(snapshot.detectorMode === 'embedded' ? 'flow.bertUnavailable' : 'dock.errorReminder')
      : incomplete ? t('dock.partialReminder') : undefined
  const reminder = t(snapshot.sendPolicy === 'review-manual' ? 'dock.reviewReminder' : 'dock.reminder')
  const showFindings = remotePhase === undefined && !incomplete
  return (
    <div className={css.dock} data-risk={result.overallRisk}
      data-status={remotePhase ?? (incomplete ? 'partial' : undefined)}>
      <div className={css.dockSummary}>
        <ShieldIcon size={16} />
        <div>
          <strong>{title}</strong>
          <small>
            {showFindings ? <>
              <span>{t('dock.detected')} </span>
              <span className={css.dockCount}>{String(count)} {t(count === 1 ? 'dock.item' : 'dock.items')}</span>
              <span>{` · ${reminder}`}</span>
            </> : detail}
          </small>
        </div>
      </div>
      <div className={css.dockActions}>
        <button
          className={`${css.secondaryButton} ${css.dockOpenButton}`}
          type="button"
          onClick={() => {
            controller.setTab('audit')
            controller.setOpen(true)
          }}
        >
          {t('dock.open')}
          <LucideIcon icon={ArrowRight} size={14} />
        </button>
      </div>
    </div>
  )
}

function normalized(result: ScanResult): object {
  return {
    overall_risk: result.overallRisk,
    recommended_action: result.recommendedAction,
    findings: result.findings.map(finding => ({
      category: finding.category,
      type: finding.entityType,
      start: finding.start,
      end: finding.end,
      masked_evidence: finding.maskedEvidence,
      replacement: finding.replacement,
      detector: finding.detector,
      ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
      ...(finding.sourceType === undefined ? {} : { source_type: finding.sourceType }),
      ...(finding.ruleId === undefined ? {} : { rule_id: finding.ruleId }),
      ...(finding.ruleName === undefined ? {} : { rule_name: finding.ruleName }),
      ...(finding.action === undefined ? {} : { action: finding.action }),
    })),
    policy_signals: result.policySignals.map(signal => ({
      policy_id: signal.policyId,
      triggered: true,
      severity: signal.severity,
    })),
    detector: result.detector,
  }
}

function AuditFindings({ controller, live, sessionId, incomplete, disabled, onEditingChange, t }: {
  controller: PrivacyController
  live: PrivacyLiveState
  sessionId: string | undefined
  incomplete: boolean
  disabled: boolean
  onEditingChange: (editing: boolean) => void
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const [editingFindingId, setEditingFindingId] = useState<string>()
  const [editValue, setEditValue] = useState('')
  const [editAll, setEditAll] = useState(false)
  const [undoFinding, setUndoFinding] = useState<{ ids: string[]; original: string }>()
  const [addingEntity, setAddingEntity] = useState(false)
  const [addType, setAddType] = useState('')
  const [addOriginal, setAddOriginal] = useState('')
  const [addReplacement, setAddReplacement] = useState('')
  const [addAll, setAddAll] = useState(true)
  const [addError, setAddError] = useState(false)
  const [expandedValue, setExpandedValue] = useState<{ label: string; value: string }>()

  useEffect(() => {
    onEditingChange(editingFindingId !== undefined || addingEntity)
    return () => { onEditingChange(false) }
  }, [onEditingChange, editingFindingId, addingEntity])

  const kept = live.result.findings.filter(finding => finding.action === 'kept')
  const visible = live.result.findings.filter(finding => finding.action !== 'kept')
  const groups = new Map<string, PrivacyFinding[]>()
  for (const finding of visible) {
    const groupKey = JSON.stringify([finding.entityType, finding.sourceType, live.text.slice(finding.start, finding.end)])
    const group = groups.get(groupKey) ?? []
    group.push(finding)
    groups.set(groupKey, group)
  }
  const keep = (findings: PrivacyFinding[]): void => {
    if (sessionId === undefined || disabled) return
    if (!window.confirm(t('review.unprotectMessage'))) return
    const ids = findings.map(finding => finding.id)
    controller.setLiveFindingsProtection(sessionId, ids, false)
    const first = findings[0]
    setUndoFinding({ ids, original: first === undefined ? '' : live.text.slice(first.start, first.end) })
  }
  const row = (finding: PrivacyFinding, group: PrivacyFinding[]): ReactNode => {
    const original = live.text.slice(finding.start, finding.end)
    return (
      <div className={css.findingRow} key={finding.id}>
        <div>
          <strong>{findingTypeLabel(finding, t)}</strong>
          <small>{t(CATEGORY_KEYS[finding.category])}</small>
        </div>
        {editingFindingId === finding.id ? (
          <div className={css.findingEdit}>
            <input aria-label={t('review.editLabel')} value={editValue} autoFocus disabled={disabled}
              onChange={event => { setEditValue(event.target.value) }} />
            {group.length > 1 ? <label className={css.scopeChoice}>
              <input type="checkbox" checked={editAll} disabled={disabled}
                onChange={event => { setEditAll(event.target.checked) }} />{t('flow.editAll')}
            </label> : null}
            <div className={css.reviewEditActions}>
              <button type="button" disabled={disabled || editValue.trim() === ''} onClick={() => {
                if (sessionId !== undefined) controller.setLiveFindingsReplacement(
                  sessionId, editAll ? group.map(item => item.id) : [finding.id], editValue,
                )
                setEditingFindingId(undefined)
              }}>{t('review.saveEdit')}</button>
              <button type="button" onClick={() => { setEditingFindingId(undefined) }}>{t('review.cancelEdit')}</button>
            </div>
          </div>
        ) : (
          <div className={css.findingTransform}>
            <button className={css.entityValueButton} type="button" title={t('review.openValue')}
              onClick={() => { setExpandedValue({ label: findingTypeLabel(finding, t), value: original }) }}>
              {original}
            </button>
            <span className={css.reviewArrow}><LucideIcon icon={ArrowRight} size={17} /></span>
            <button className={`${css.entityValueButton} ${css.entityValueReplacement}`} type="button"
              title={t('review.openValue')} onClick={() => {
                setExpandedValue({ label: t('review.redactedOutput'), value: finding.replacement })
              }}>{finding.replacement}</button>
          </div>
        )}
        <div className={css.findingMeta}>
          <button className={css.reviewIconButton} type="button" title={t('review.edit')} aria-label={t('review.edit')}
            disabled={disabled || sessionId === undefined || addingEntity} onClick={() => {
              setEditingFindingId(finding.id); setEditValue(finding.replacement); setEditAll(false)
            }}><LucideIcon icon={Pencil} size={16} /></button>
          <button className={css.reviewIconButton} type="button" title={t('review.keep')} aria-label={t('review.keep')}
            disabled={disabled || sessionId === undefined || editingFindingId !== undefined || addingEntity}
            onClick={() => { keep([finding]) }}><LucideIcon icon={X} size={17} /></button>
        </div>
      </div>
    )
  }
  return (
    <section className={css.findingsSection}>
      <div className={css.sectionHeading}>
        <strong>{`${t('audit.findings')} (${String(visible.length)})`}</strong>
        <button className={css.reviewAddButton} type="button" title={t('review.addEntity')} aria-label={t('review.addEntity')}
          disabled={disabled || editingFindingId !== undefined || addingEntity}
          onClick={() => { setAddingEntity(true); setAddError(false) }}><LucideIcon icon={Plus} size={18} /></button>
      </div>
      {visible.length === 0 ? <p className={incomplete ? css.incompleteFindings : css.noFindings}>
        {incomplete ? t('audit.partialNoFindings') : kept.length > 0 ? t('flow.allKept') : t('audit.noFindings')}
      </p> : <div className={css.findingRows}>
        {[...groups.entries()].map(([groupKey, group]) => {
          const first = group[0]
          if (first === undefined) return null
          if (group.length === 1) return row(first, group)
          return <details className={css.findingGroup} key={groupKey}>
            <summary><strong>{findingTypeLabel(first, t)}</strong>
              <code>{live.text.slice(first.start, first.end)}</code>
              <span>{t('flow.occurrences').replace('{count}', String(group.length))}</span>
            </summary>
            <div className={css.groupActions}>
              <button className={css.textButton} type="button" disabled={disabled || editingFindingId !== undefined || addingEntity}
                onClick={() => { keep(group) }}>{t('flow.keepAll')}</button>
            </div>
            {group.map(finding => <div className={css.findingOccurrence} key={finding.id}>
              <p>{live.text.slice(Math.max(0, finding.start - 18), Math.min(live.text.length, finding.end + 18))}</p>
              {row(finding, group)}
            </div>)}
          </details>
        })}
      </div>}
      {addingEntity ? <div className={css.reviewAddForm}>
        <strong>{t('review.addTitle')}</strong>
        <input aria-label={t('review.entityTypePlaceholder')} value={addType} placeholder={t('review.entityTypePlaceholder')}
          maxLength={40} disabled={disabled} onChange={event => { setAddType(event.target.value); setAddError(false) }} />
        <div className={css.reviewAddValues}>
          <input aria-label={t('review.originalPlaceholder')} value={addOriginal} placeholder={t('review.originalPlaceholder')}
            disabled={disabled} onChange={event => { setAddOriginal(event.target.value); setAddError(false) }} />
          <span className={css.reviewArrow}><LucideIcon icon={ArrowRight} size={17} /></span>
          <input aria-label={t('review.replacementPlaceholder')} value={addReplacement} placeholder={t('review.replacementPlaceholder')}
            disabled={disabled} onChange={event => { setAddReplacement(event.target.value); setAddError(false) }} />
        </div>
        <label className={css.scopeChoice}><input type="checkbox" checked={addAll} disabled={disabled}
          onChange={event => { setAddAll(event.target.checked) }} />{t('flow.addAll')}</label>
        {addError ? <small className={css.reviewAddError} role="alert">{t('review.addError')}</small> : null}
        <div className={css.reviewAddActions}>
          <button type="button" onClick={() => { setAddingEntity(false) }}>{t('review.cancelEdit')}</button>
          <button type="button" disabled={disabled || !addOriginal.trim() || !addReplacement.trim()} onClick={() => {
            const added = sessionId !== undefined && controller.addLiveFinding(sessionId, addOriginal, addReplacement, addType, addAll)
            if (!added) { setAddError(true); return }
            setAddingEntity(false); setAddType(''); setAddOriginal(''); setAddReplacement('')
          }}>{t('review.add')}</button>
        </div>
      </div> : null}
      {undoFinding !== undefined ? <div className={css.reviewUndoBar} role="status">
        <span>{t('review.undoDone').replace('{value}', undoFinding.original)}</span>
        <button type="button" disabled={disabled} onClick={() => {
          if (sessionId !== undefined) controller.setLiveFindingsProtection(sessionId, undoFinding.ids, true)
          setUndoFinding(undefined)
        }}>{t('review.undo')}</button>
      </div> : null}
      {kept.length > 0 ? <details className={css.keptFindings}>
        <summary>{t('flow.kept')} ({kept.length})</summary>
        <p>{t('review.keptWarning')}</p>
        {kept.map(finding => <div key={finding.id}>
          <span>{live.text.slice(finding.start, finding.end)}</span>
          <button className={css.textButton} type="button" disabled={disabled} onClick={() => {
            if (sessionId !== undefined) controller.setLiveFindingsProtection(sessionId, [finding.id], true)
            setUndoFinding(undefined)
          }}>{t('flow.restore')}</button>
        </div>)}
      </details> : null}
      {live.result.policySignals.map(signal => <div className={css.policyRow} key={signal.policyId}>
        <strong>{t('policy.CUSTOMER_KYC')}</strong><span>{t('risk.high')}</span>
      </div>)}
      {expandedValue !== undefined ? <div className={css.entityValuePopover} role="dialog" aria-label={t('review.fullValue')}>
        <div><strong>{expandedValue.label}</strong><button type="button" aria-label={t('review.closeValue')}
          onClick={() => { setExpandedValue(undefined) }}><LucideIcon icon={X} size={16} /></button></div>
        <pre>{expandedValue.value}</pre>
      </div> : null}
    </section>
  )
}
function AuditView({ controller, live, sessionId, snapshot, editing, onEditingChange, t }: {
  controller: PrivacyController
  live: PrivacyLiveState | undefined
  sessionId: string | undefined
  snapshot: PrivacySnapshot
  editing: boolean
  onEditingChange: (value: boolean) => void
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const [rechecking, setRechecking] = useState(false)
  const review = snapshot.pendingSendReview
  const sending = review?.status === 'sending' || (
    snapshot.sendState?.sessionId === sessionId && snapshot.sendState?.status === 'sending'
  )
  const state = snapshot.detectorStates[snapshot.detectorMode]
  const bertUnavailable = snapshot.detectorMode === 'embedded' && state.status !== 'ready'
  const checking = rechecking || live?.phase === 'checking' || review?.status === 'checking'
  const incomplete = live?.result.detector.status === 'partial'
  const failed = live?.phase === 'error'
  const ready = live?.phase === 'ready' && !incomplete && !bertUnavailable
  const recheck = async (regex = false): Promise<void> => {
    if (sessionId === undefined || live === undefined || rechecking || sending || editing) return
    setRechecking(true)
    try {
      if (regex) controller.setDetectorMode('regex')
      await controller.inspect(sessionId, live.text)
    } finally { setRechecking(false) }
  }
  if (!snapshot.enabled) return <div className={css.emptyState}>
    <strong>{t('paused')}</strong><p>{t('audit.paused')}</p>
    <button className={css.primaryButton} type="button" onClick={() => { controller.setEnabled(true) }}>{t('enable')}</button>
  </div>
  if (live === undefined || live.text.trim() === '') return <div className={css.emptyState}>
    <p>{t('audit.empty')}</p><small>{t('flow.textOnly')}</small>
  </div>
  const payload = JSON.stringify(normalized(live.result), null, 2)
  const status = sending ? t('flow.sending') : checking ? t('flow.checking')
    : bertUnavailable ? (state.status === 'loading' ? t('flow.bertLoading') : t('flow.bertUnavailable'))
      : failed ? t('flow.failed') : incomplete ? t('audit.partialStatus') : t('flow.ready')

  return <div className={css.auditView}>
    <section className={css.pipelineSection}>
      <div className={css.monitorHeading}>
        <div><h3>{t('audit.pipeline')}</h3>
          <p><strong>{t('audit.method')}：</strong>{ready ? detectorSummary(live.result, t) : t(DETECTOR_KEYS[snapshot.detectorMode])}</p>
        </div>
        <div className={css.monitorMeta}>
          <span role="status" data-status={failed || incomplete ? 'partial' : ready ? 'complete' : 'checking'}>{status}</span>
          <button className={css.secondaryButton} type="button"
            disabled={sessionId === undefined || checking || sending || editing || bertUnavailable}
            onClick={() => { void recheck() }}>{checking ? t('audit.rechecking') : t('audit.recheck')}</button>
        </div>
      </div>
      {bertUnavailable || failed || incomplete ? <div className={css.recoveryPanel} role="alert">
        <p>{bertUnavailable ? t('model.embeddedNotice') : incomplete ? t('audit.partial') : t('flow.failedHint')}</p>
        <div className={css.recoveryActions}>
          {bertUnavailable ? <button className={css.secondaryButton} type="button"
            disabled={state.status === 'loading' || sending || editing} onClick={() => { void controller.loadEmbedded() }}>
            {state.status === 'loading' ? t('model.loading') : t('model.load')}
          </button> : null}
          {snapshot.detectorMode !== 'regex' ? <button className={css.secondaryButton} type="button"
            disabled={checking || sending || editing} onClick={() => { void recheck(true) }}>{t('flow.useRegex')}</button> : null}
        </div>
      </div> : null}
      {(ready || incomplete) && !checking ? <AuditFindings
        key={JSON.stringify([sessionId, live.text])} controller={controller} live={live} sessionId={sessionId}
        incomplete={incomplete === true} disabled={!ready || sending} onEditingChange={onEditingChange} t={t}
      /> : null}
      <div className={css.stage} data-stage="plain">
        <div className={css.stageHeading}><strong>{t('audit.stage1')}</strong>
          <CopyButton text={live.text} label={t('audit.copyOriginal')} /></div>
        <p><HighlightedText text={live.text} findings={ready ? live.result.findings : []} t={t} /></p>
      </div>
      {ready && !checking ? <div className={css.stage} data-stage="redacted">
        <div className={css.stageHeading}><strong>{t('audit.stage2')}</strong>
          <CopyButton text={live.result.redactedText} label={t('audit.copyRedacted')} /></div>
        <p>{live.result.redactedText || '—'}</p>
      </div> : null}
      <small className={css.scopeNote}>{t('flow.textOnly')}</small>
    </section>
    {ready || incomplete ? <details className={css.jsonSection}>
      <summary><span>{t('audit.json')}</span><CopyButton text={payload} label={t('audit.copyJson')} /></summary>
      <pre>{payload}</pre>
    </details> : null}
  </div>
}

function reviewLiveState(review: PrivacySnapshot['pendingSendReview'], live: PrivacyLiveState | undefined, regexRevision: number): PrivacyLiveState | undefined {
  const first = review?.parts[review.activePartIndex]
  if (first === undefined || review === undefined) return undefined
  return {
    text: first.text, result: first.result, updatedAt: 0,
    phase: review.status === 'checking' ? 'checking' : live?.text === first.text ? live.phase : 'ready',
    regexRevision: live?.regexRevision ?? regexRevision,
  }
}
function ruleErrorKey(code: RegexErrorCode): PrivacyKey { return `rules.error.${code}` }

function emptyRule(): EditableRegexRule {
  return {
    id: `custom-${randomUUID()}`, name: '', pattern: '', flags: 'u', capture: 0,
    entityType: 'OTHER', category: 'DIRECT_PII', severity: 'high', enabled: true,
  }
}

function RuleEditor({ controller, original, t, onClose }: {
  controller: PrivacyController
  original: EditableRegexRule
  t: PrivacyDrawerProps['t']
  onClose: () => void
}): ReactNode {
  const [rule, setRule] = useState(original)
  const [sample, setSample] = useState('')
  const [result, setResult] = useState<ScanResult>()
  const [error, setError] = useState<RegexErrorCode>()
  const [testing, setTesting] = useState(false)
  const dirty = JSON.stringify(rule) !== JSON.stringify(original)
  const update = <Key extends keyof EditableRegexRule>(key: Key, value: EditableRegexRule[Key]): void => {
    setRule(current => ({ ...current, [key]: value }))
    setResult(undefined)
    setError(undefined)
  }
  const close = (): void => { if (!dirty || window.confirm(t('rules.discardConfirm'))) onClose() }
  const test = async (): Promise<void> => {
    setTesting(true)
    setError(undefined)
    try { setResult(await controller.testRule(rule, sample)) } catch (cause) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause
        ? (cause as { code: RegexErrorCode }).code : 'invalid'
      setError(code)
      setResult(undefined)
    } finally { setTesting(false) }
  }
  return (
    <div className={css.ruleEditor}>
      <button className={css.backButton} type="button" onClick={close}>
        <LucideIcon icon={ArrowLeft} /> {t('rules.back')}
      </button>
      <h3>{t('rules.edit')}</h3>
      <label className={css.field}><span>{t('rules.name')}</span>
        <input value={rule.name} maxLength={80} onChange={(event) => { update('name', event.target.value) }} />
      </label>
      <label className={css.field}><span>{t('rules.pattern')}</span>
        <textarea className={css.patternInput} value={rule.pattern} spellCheck={false} maxLength={2000}
          onChange={(event) => { update('pattern', event.target.value) }} />
      </label>
      <fieldset className={css.flagGroup}><legend>{t('rules.flags')}</legend>
        {(['i', 'm', 's', 'u'] as const).map(flag => (
          <label key={flag}><input type="checkbox" checked={rule.flags.includes(flag)} onChange={(event) => {
            update('flags', event.target.checked ? `${rule.flags}${flag}` : rule.flags.replace(flag, ''))
          }} />{t(`rules.flag.${flag}`)}</label>
        ))}
      </fieldset>
      <div className={css.fieldGrid}>
        <label className={css.field}><span>{t('rules.capture')}</span>
          <select value={rule.capture === 0 ? 'whole' : 'group'} onChange={(event) => {
            update('capture', event.target.value === 'whole' ? 0 : 1)
          }}><option value="whole">{t('rules.wholeMatch')}</option><option value="group">{t('rules.captureGroup')}</option></select>
        </label>
        {rule.capture > 0 ? <label className={css.field}><span>{t('rules.groupNumber')}</span>
          <input type="number" min="1" max="99" value={rule.capture} onChange={(event) => { update('capture', Number(event.target.value)) }} />
        </label> : null}
        <label className={css.field}><span>{t('rules.type')}</span>
          <select value={rule.entityType} onChange={(event) => { update('entityType', event.target.value as EntityType) }}>
            {RULE_ENTITY_TYPES.map(type => <option value={type} key={type}>{t(ENTITY_KEYS[type])}</option>)}
          </select>
        </label>
        <label className={css.field}><span>{t('rules.category')}</span>
          <select value={rule.category} onChange={(event) => { update('category', event.target.value as FindingCategory) }}>
            {(['DIRECT_PII', 'FINANCIAL', 'BUSINESS', 'SECRET'] as const).map(category => (
              <option value={category} key={category}>{t(CATEGORY_KEYS[category])}</option>
            ))}
          </select>
        </label>
        <label className={css.field}><span>{t('rules.severity')}</span>
          <select value={rule.severity} onChange={(event) => { update('severity', event.target.value as EditableRegexRule['severity']) }}>
            {(['medium', 'high', 'critical'] as const).map(risk => <option value={risk} key={risk}>{t(RISK_KEYS[risk])}</option>)}
          </select>
        </label>
      </div>
      <label className={css.switchRow}><input type="checkbox" checked={rule.enabled}
        onChange={(event) => { update('enabled', event.target.checked) }} /><span>{t('rules.enabled')}</span></label>
      <section className={css.ruleTest}>
        <label className={css.field}><span>{t('rules.sample')}</span>
          <textarea value={sample} onChange={(event) => { setSample(event.target.value); setResult(undefined); setError(undefined) }} />
        </label>
        <button className={css.secondaryButton} type="button" disabled={testing || sample === ''} onClick={() => { void test() }}>
          {testing ? t('rules.testing') : t('rules.test')}
        </button>
        {error !== undefined ? <p className={css.ruleError}>{t(ruleErrorKey(error))}</p> : null}
        {result !== undefined ? <div className={css.testResult} data-matched={result.findings.length > 0 || undefined}>
          <strong>{result.findings.length > 0 ? `${String(result.findings.length)} ${t('rules.matches')}` : t('rules.noMatch')}</strong>
          <small>{t('rules.preview')}</small><code>{result.redactedText}</code>
        </div> : null}
      </section>
      <div className={css.editorActions}>
        <button className={css.secondaryButton} type="button" onClick={close}>{t('rules.cancel')}</button>
        <button className={css.primaryButton} type="button"
          disabled={result === undefined || result.findings.length === 0 || testing} onClick={() => {
            try { controller.saveRule(rule); onClose() } catch (cause) {
              setError(typeof cause === 'object' && cause !== null && 'code' in cause
                ? (cause as { code: RegexErrorCode }).code : 'invalid')
            }
          }}>{t('rules.save')}</button>
      </div>
      {result === undefined || result.findings.length === 0
        ? <small className={css.saveHint}>{t('rules.testBeforeSave')}</small> : null}
    </div>
  )
}

function RulesView({ controller, snapshot, t }: {
  controller: PrivacyController
  snapshot: PrivacySnapshot
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const [editing, setEditing] = useState<EditableRegexRule>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled' | 'custom'>('all')
  const surfaceRef = useRef<HTMLDivElement>(null)
  const defaults = new Map(DEFAULT_REGEX_RULES.map(rule => [rule.id, rule]))
  const visible = snapshot.regexRules.filter((rule) => {
    const custom = !defaults.has(rule.id)
    return (filter === 'all' || (filter === 'enabled' && rule.enabled)
      || (filter === 'disabled' && !rule.enabled) || (filter === 'custom' && custom))
      && `${rule.name} ${rule.pattern} ${rule.entityType}`.toLowerCase().includes(query.trim().toLowerCase())
  })
  useEffect(() => {
    const scrollContainer = surfaceRef.current?.closest<HTMLElement>('[data-zero-privacy-scroll]')
    if (scrollContainer !== undefined && scrollContainer !== null) scrollContainer.scrollTop = 0
  }, [editing])
  if (editing !== undefined) return (
    <div className={css.ruleSurface} ref={surfaceRef}>
      <RuleEditor controller={controller} original={editing} t={t} onClose={() => { setEditing(undefined) }} />
    </div>
  )
  return (
    <div className={css.tabPage} ref={surfaceRef}>
      <div className={css.rulesHeading}><div><h3>{t('rules.title')}</h3><p>{t('rules.desc')}</p></div>
        <button className={css.primaryButton} type="button" onClick={() => { setEditing(emptyRule()) }}>
          <LucideIcon icon={Plus} /> {t('rules.add')}
        </button></div>
      {snapshot.regexError !== undefined ? <p className={css.ruleError}>{t(ruleErrorKey(snapshot.regexError))}</p> : null}
      <div className={css.ruleTools}>
        <label className={css.searchBox}><LucideIcon icon={Search} /><input aria-label={t('rules.search')} placeholder={t('rules.search')}
          value={query} onChange={(event) => { setQuery(event.target.value) }} /></label>
        <select aria-label={t('rules.filter')} value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter) }}>
          <option value="all">{t('rules.all')}</option><option value="enabled">{t('rules.enabledOnly')}</option>
          <option value="disabled">{t('rules.disabledOnly')}</option><option value="custom">{t('rules.custom')}</option>
        </select>
      </div>
      <div className={css.ruleRows}>{visible.map((rule) => {
        const defaultRule = defaults.get(rule.id)
        const changed = defaultRule !== undefined && JSON.stringify(defaultRule) !== JSON.stringify(rule)
        const displayName = ruleDisplayName(rule.id, rule.entityType, rule.name, t)
        return <article className={css.ruleCard} key={rule.id} data-enabled={rule.enabled || undefined}>
          <SwitchControl checked={rule.enabled}
            label={`${displayName}: ${rule.enabled ? t('rules.enabled') : t('rules.disabledOnly')}`}
            onChange={(enabled) => { controller.saveRule({ ...rule, enabled }) }} />
          <button className={css.ruleBody} type="button" onClick={() => { setEditing(rule) }}>
            <strong>{displayName}</strong><code>/{rule.pattern}/{rule.flags}</code>
            <small>{defaultRule === undefined ? t('rules.custom') : t('rules.builtin')} · {t(ENTITY_KEYS[rule.entityType])}</small>
          </button>
          <div className={css.ruleActions}>
            <button type="button" title={t('rules.edit')} aria-label={`${t('rules.edit')}: ${displayName}`} onClick={() => { setEditing(rule) }}><LucideIcon icon={Pencil} /></button>
            <button type="button" title={t('rules.copy')} aria-label={`${t('rules.copy')}: ${displayName}`} onClick={() => {
              setEditing({ ...rule, id: `custom-${randomUUID()}`, name: `${displayName} ${t('rules.copySuffix')}` })
            }}><LucideIcon icon={Copy} /></button>
            {defaultRule === undefined ? <button type="button" title={t('rules.delete')} aria-label={`${t('rules.delete')}: ${displayName}`}
              onClick={() => { if (window.confirm(t('rules.deleteConfirm'))) controller.deleteRule(rule.id) }}><LucideIcon icon={Trash2} /></button>
              : changed ? <button type="button" title={t('rules.reset')} aria-label={`${t('rules.reset')}: ${displayName}`}
                onClick={() => { controller.resetRule(rule.id) }}><LucideIcon icon={RotateCcw} /></button> : null}
          </div>
        </article>
      })}</div>
      {visible.length === 0 ? <div className={css.emptyState}>{t('rules.empty')}</div> : null}
      <div className={css.rulesFooter}><span>{`${String(snapshot.regexRules.length)} · ${t('rules.savedLocal')}`}</span>
        <button type="button" onClick={() => { if (window.confirm(t('rules.resetConfirm'))) controller.resetRules() }}>
          <LucideIcon icon={RotateCcw} /> {t('rules.resetAll')}
        </button></div>
    </div>
  )
}

function ModelView({ controller, snapshot, t }: {
  controller: PrivacyController
  snapshot: PrivacySnapshot
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const rows: Array<[DetectorMode, PrivacyKey, PrivacyKey]> = [
    ['zeroclave', 'model.zeroclave', 'model.zeroclaveDesc'],
    ['regex', 'model.regex', 'model.regexDesc'],
    ['embedded', 'model.embedded', 'model.embeddedDesc'],
  ]
  const statusKey = (mode: DetectorMode): PrivacyKey => {
    const status = snapshot.detectorStates[mode].status
    if (status === 'ready') return mode === snapshot.detectorMode ? 'model.running' : 'model.ready'
    if (status === 'loading') return 'model.loading'
    if (status === 'partial') return 'model.partial'
    if (status === 'error') return 'model.error'
    if (status === 'unconfigured') return 'model.unconfigured'
    return mode === 'zeroclave' ? 'model.untested' : 'model.idle'
  }
  const embeddedState = snapshot.detectorStates.embedded
  const zeroClaveState = snapshot.detectorStates.zeroclave
  const [telemetryDetailsOpen, setTelemetryDetailsOpen] = useState(false)
  const telemetryStatus: PrivacyKey = snapshot.telemetry.lockedByGpc ? 'telemetry.gpc'
    : snapshot.telemetry.availability === 'checking' ? 'telemetry.checking'
      : snapshot.telemetry.availability === 'unavailable' ? 'telemetry.unavailable'
        : snapshot.telemetry.consent ? 'flow.telemetryOn' : 'telemetry.off'
  return (
    <div className={css.tabPage}>
      <h3>{t('model.title')}</h3>
      <p>{t('model.desc')}</p>
      <section className={css.policySection}>
        <div><strong>{t('policy.title')}</strong><small>{t('policy.desc')}</small></div>
        <div className={css.policyOptions}>
          {([
            ['review-manual', 'policy.review', 'policy.reviewDesc'],
            ['auto-redact', 'policy.auto', 'policy.autoDesc'],
          ] as const).map(([policy, title, description]) => (
            <button type="button" key={policy} data-selected={snapshot.sendPolicy === policy || undefined}
              onClick={() => { controller.setSendPolicy(policy) }}>
              <span className={css.radioMark} /><span><strong>{t(title)}</strong><small>{t(description)}</small></span>
            </button>
          ))}
        </div>
      </section>
      <section className={css.engineSection}>
        <h4>{t('model.engineTitle')}</h4>
        <div className={css.modelRows}>
          {rows.map(([mode, title, description]) => (
            <button
              className={css.modelRow}
              data-selected={snapshot.detectorMode === mode || undefined}
              key={mode}
              type="button"
              onClick={() => { controller.setDetectorMode(mode) }}
            >
              <span className={css.radioMark} />
              <span>
                <span className={css.modelName}>
                  <strong>{t(title)}</strong>
                  {mode === 'zeroclave'
                    ? <span className={css.recommendedBadge}>{t('model.recommended')}</span>
                    : null}
                </span>
                <small>{t(description)}</small>
              </span>
              <em>
                {t(statusKey(mode))}
                {mode === 'embedded' && embeddedState.status === 'loading' && embeddedState.progress !== undefined
                  ? ` ${Math.round(embeddedState.progress)}%`
                  : ''}
              </em>
            </button>
          ))}
        </div>
      </section>
      {snapshot.detectorMode === 'embedded' ? (
        <div className={css.modelActions}>
          <button
            className={css.primaryButton}
            type="button"
            disabled={embeddedState.status === 'loading' || embeddedState.status === 'ready'}
            onClick={() => { void controller.loadEmbedded() }}
          >
            {embeddedState.status === 'error' ? t('model.retry') : t('model.load')}
          </button>
          <small>{t('model.download')}</small>
          {embeddedState.status === 'error' && embeddedState.error !== undefined
            ? <code>{embeddedState.error}</code>
            : null}
        </div>
      ) : null}
      {snapshot.detectorMode === 'zeroclave' ? (
        <div className={css.modelActions}>
          <button
            className={css.primaryButton}
            type="button"
            disabled={zeroClaveState.status === 'loading'}
            onClick={() => { void controller.testZeroClave() }}
          >
            {zeroClaveState.status === 'loading'
              ? t('model.testing')
              : zeroClaveState.status === 'idle' || zeroClaveState.status === 'unconfigured'
                ? t('model.test')
                : t('model.testAgain')}
          </button>
          <small>{t('model.gatewayRoute')}</small>
          {zeroClaveState.status === 'partial'
            ? <p className={css.partialWarning}>{t('model.partialDetail')}</p>
            : null}
          {zeroClaveState.status === 'error' && zeroClaveState.error !== undefined
            ? <code>{zeroClaveState.code === undefined
              ? zeroClaveState.error : `${zeroClaveState.code}: ${zeroClaveState.error}`}</code>
            : null}
          {zeroClaveState.requestId === undefined ? null : (
            <small className={css.requestId}>{`${t('model.requestId')}: ${zeroClaveState.requestId}`}</small>
          )}
        </div>
      ) : null}
      {snapshot.detectorMode === 'zeroclave'
        ? <p className={css.modelNote}>{t('model.textOnly')}</p>
        : null}
      {snapshot.detectorMode === 'embedded'
        ? <p className={css.modelNote}>{t('model.embeddedNotice')}</p>
        : null}
      <section className={css.telemetrySection}>
        <div className={css.telemetryHeading}>
          <div>
            <strong>{t('telemetry.title')}</strong>
            <div className={css.telemetrySubline}>
              <small>{t('telemetry.summary')}</small>
              <button className={css.telemetryDetailsLink} type="button"
                aria-expanded={telemetryDetailsOpen}
                onClick={() => { setTelemetryDetailsOpen(open => !open) }}>
                {t('telemetry.detailsLink')}
                <LucideIcon icon={telemetryDetailsOpen ? ChevronUp : ChevronDown} size={16} />
              </button>
            </div>
          </div>
          <SwitchControl
            checked={snapshot.telemetry.consent}
            label={t('telemetry.consent')}
            disabled={snapshot.telemetry.availability !== 'available' || snapshot.telemetry.lockedByGpc}
            onChange={(consent) => { controller.setTelemetryConsent(consent) }}
          />
        </div>
        <p className={css.scopeNote} role="status">{t(telemetryStatus)}</p>
        {telemetryDetailsOpen ? <div className={css.telemetryDetails}>
          <p>{t('telemetry.detailParagraph1')}</p>
          <p>{t('telemetry.detailParagraph2')}</p>
          <p>{t('telemetry.detailParagraph3')}</p>
        </div> : null}
      </section>
    </div>
  )
}

export function PrivacyDrawer({ controller, t, useSessions }: PrivacyDrawerProps): ReactNode {
  const snapshot = usePrivacy(controller)
  const drawerBodyRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const currentSessionId = useSessions(selectedSessionId)
  const review = snapshot.pendingSendReview
  const displayedSessionId = review?.sessionId ?? currentSessionId ?? snapshot.activeSessionId
  const live = displayedSessionId === undefined ? undefined : snapshot.liveBySession.get(displayedSessionId)
  const displayedLive = reviewLiveState(review, live, snapshot.regexRevision) ?? live
  const [editing, setEditing] = useState(false)
  const [requestError, setRequestError] = useState(false)
  const sendState = snapshot.sendState?.sessionId === displayedSessionId ? snapshot.sendState : undefined
  const sending = review?.status === 'sending' || sendState?.status === 'sending'
  const checking = review?.status === 'checking' || displayedLive?.phase === 'checking'
    || (sendState?.status === 'preparing' && review === undefined)
  const failedSend = sendState?.status === 'error' || review?.status === 'error'
  const activeTab = review === undefined ? snapshot.activeTab : 'audit'
  const tabs: Array<[PrivacySnapshot['activeTab'], PrivacyKey]> = [
    ['audit', 'tab.audit'], ['model', 'tab.model'], ['rules', 'tab.rules'],
  ]
  useEffect(() => {
    if (drawerBodyRef.current !== null) drawerBodyRef.current.scrollTop = 0
    setRequestError(false)
  }, [activeTab, displayedSessionId])
  useEffect(() => {
    if (!snapshot.open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    closeRef.current?.focus()
    return () => { if (previouslyFocused?.isConnected) previouslyFocused.focus() }
  }, [snapshot.open])
  if (!snapshot.open) return null

  const close = (): void => {
    if (sending) return
    controller.cancelSendReview()
    controller.setOpen(false)
  }
  const canConfirm = snapshot.enabled && !editing && !sending && !checking
    && displayedLive?.phase === 'ready' && displayedLive.result.detector.status !== 'partial'
    && (review?.status === 'reviewing' || (
      displayedSessionId !== undefined && controller.canRequestComposerSend(displayedSessionId)
    ))
  const confirm = (): void => {
    if (!canConfirm || displayedSessionId === undefined) return
    setRequestError(false)
    if (review?.status === 'reviewing') controller.confirmSendReview()
    else void controller.requestComposerSend(displayedSessionId).catch(() => { setRequestError(true) })
  }
  return (
    <aside className={css.drawer} data-zero-privacy-drawer="open" aria-label={t('headerAction')}
      onKeyDown={event => { if (event.key === 'Escape' && !editing) { event.stopPropagation(); close() } }}>
      <header className={css.drawerHeader}>
        <div className={css.brandIdentity}>
          <img className={css.brandLogo} src={zeroclaveLogo} alt={t('brand')} />
          <small>{displayedSessionId ?? t('sessionFallback')}</small>
        </div>
        <div className={css.headerStatus}>
          <span data-enabled={snapshot.enabled || undefined}>{snapshot.enabled ? t('active') : t('paused')}</span>
          <SwitchControl checked={snapshot.enabled} label={snapshot.enabled ? t('disable') : t('enable')}
            disabled={sending} onChange={enabled => { controller.setEnabled(enabled) }} />
        </div>
        <button ref={closeRef} className={css.iconButton} type="button" disabled={sending}
          aria-label={t('close')} onClick={close}><LucideIcon icon={X} size={18} /></button>
      </header>
      <nav className={css.tabs}>
        {tabs.map(([id, label]) => <button data-selected={activeTab === id || undefined}
          disabled={review !== undefined || sending || editing} key={id} type="button"
          onClick={() => { controller.setTab(id) }}>{t(label)}</button>)}
      </nav>
      <div className={css.drawerBody} data-zero-privacy-scroll ref={drawerBodyRef}>
        {activeTab === 'audit' ? <>
          {review !== undefined && review.parts.length > 1 ? <div className={css.partSelector}>
            {review.parts.map((_, index) => <button type="button" key={index}
              className={css.secondaryButton} aria-pressed={index === review.activePartIndex}
              disabled={editing || sending || checking}
              onClick={() => { controller.setReviewPart(index) }}>{t('review.currentInput')} {index + 1}</button>)}
          </div> : null}
          <AuditView key={displayedSessionId} controller={controller} live={displayedLive} sessionId={displayedSessionId}
            snapshot={snapshot} editing={editing} onEditingChange={setEditing} t={t} />
        </> : activeTab === 'rules' ? <RulesView controller={controller} snapshot={snapshot} t={t} />
          : <ModelView controller={controller} snapshot={snapshot} t={t} />}
      </div>
      <footer className={css.drawerFooter}>
        {editing ? <p className={css.footerNotice} role="status">{t('flow.unsaved')}</p> : null}
        {failedSend ? <p className={css.footerError} role="alert">{t('flow.sendFailed')}</p> : null}
        {requestError ? <p className={css.footerError} role="alert">{t('flow.requestFailed')}</p> : null}
        {activeTab === 'audit' && displayedLive !== undefined && displayedLive.text.trim() !== '' ? (
          <div className={css.drawerSendActions}>
            <button className={css.secondaryButton} type="button" disabled={sending} onClick={close}>{t('review.cancelSend')}</button>
            <button className={css.primaryButton} type="button" disabled={!canConfirm} onClick={confirm}>
              {sending ? t('flow.sending') : checking ? t('flow.checking') : failedSend ? t('flow.retrySend') : t('review.confirmSend')}
            </button>
          </div>
        ) : null}
        <div className={css.drawerFooterMeta}>
          <a className={css.communityLink} href="https://zeroclave.com/community" target="_blank" rel="noreferrer">
            <i />{t('footer.core')}
          </a>
          <button type="button" disabled={review !== undefined || sending || editing}
            onClick={() => { controller.setTab('model') }}>{t('footer.configure')} →</button>
        </div>
      </footer>
    </aside>
  )
}
