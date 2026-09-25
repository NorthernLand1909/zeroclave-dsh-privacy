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
  EditableRegexRule, EntityType, FindingCategory, RegexErrorCode,
} from '../types.ts'
import { DEFAULT_REGEX_RULES } from '../detector.ts'
import { RULE_ENTITY_TYPES } from '../regex-rules.ts'
import type { PrivacyKey } from './locales.ts'
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
  PropsRuntime<'shell.overlay'> & PropsLocale<'zeroclave.privacy'> & ControllerProps & DrawerInjectedProps

interface DrawerInjectedProps {
  sessions: {
    binding(sessionId: string): { session: object } | undefined
    scope(sessionId: string): object | undefined
  }
  conversation: object
}

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
  'local-model': 'model.localModel',
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
      type="button"
      aria-pressed={snapshot.open}
      onClick={() => { controller.toggleOpen() }}
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
      onClick={() => { controller.toggleOpen() }}
    >
      <ShieldIcon size={16} />
      {wide ? <span>{t('brand')}</span> : null}
      {wide ? <small>{snapshot.enabled ? t('footerEnabled') : t('paused')}</small> : null}
    </button>
  )
}

export function PrivacyDock({ controller, sessionId, t, useInput }: PrivacyDockProps): ReactNode {
  const snapshot = usePrivacy(controller)
  const draft = useInput(state => state.draft)
  const baseline = useMemo(
    () => controller.scan(draft),
    [controller, draft, snapshot.detectorMode, snapshot.enabled, snapshot.regexRevision],
  )
  const live = snapshot.liveBySession.get(sessionId)
  const result = live?.text === draft ? live.result : baseline

  useEffect(() => {
    const abort = new AbortController()
    const delay = snapshot.detectorMode === 'zeroclave'
      ? 650
      : snapshot.detectorMode === 'embedded' || snapshot.detectorMode === 'local-model' ? 300 : 0
    const timer = window.setTimeout(() => {
      void controller.inspect(sessionId, draft, abort.signal)
    }, delay)
    return () => {
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [controller, draft, sessionId, snapshot.detectorMode, snapshot.enabled,
    snapshot.detectorStates.embedded.status, snapshot.regexRevision])

  const incomplete = result.detector.status === 'partial'
  const zeroClaveState = snapshot.detectorStates.zeroclave
  const remotePhase = snapshot.detectorMode === 'zeroclave'
    && (zeroClaveState.status === 'loading' || zeroClaveState.status === 'error')
    ? zeroClaveState.status : undefined
  if (!snapshot.enabled || (
    result.findings.length === 0 && result.policySignals.length === 0 && !incomplete && remotePhase === undefined
  )) return null

  const count = result.findings.length + result.policySignals.length
  const title = remotePhase === 'loading' ? t('dock.checking')
    : remotePhase === 'error' ? t('dock.error')
      : t(incomplete ? 'dock.partial' : 'dock.title')
  const detail = remotePhase === 'loading' ? t('dock.checkingReminder')
    : remotePhase === 'error' ? t('dock.errorReminder')
      : incomplete ? t('dock.partialReminder')
        : `${String(count)} ${t('dock.items')} · ${t(
          snapshot.sendPolicy === 'review-manual' ? 'dock.reviewReminder' : 'dock.reminder',
        )}`
  return (
    <div className={css.dock} data-risk={result.overallRisk}
      data-status={remotePhase ?? (incomplete ? 'partial' : undefined)}>
      <div className={css.dockSummary}>
        <ShieldIcon size={16} />
        <div>
          <strong>{title}</strong>
          <small>{detail}</small>
        </div>
      </div>
      <div className={css.dockActions}>
        <button
          className={css.secondaryButton}
          type="button"
          onClick={() => {
            if (remotePhase !== undefined) controller.setTab('model')
            controller.setOpen(true)
          }}
        >
          {t('dock.open')}
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

function AuditFindings({ controller, live, sessionId, incomplete, t }: {
  controller: PrivacyController
  live: NonNullable<ReturnType<PrivacySnapshot['liveBySession']['get']>>
  sessionId: string | undefined
  incomplete: boolean
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const [editingFindingId, setEditingFindingId] = useState<string>()
  const [editValue, setEditValue] = useState('')
  const [unprotectFinding, setUnprotectFinding] = useState<{ id: string; original: string; replacement: string }>()
  const [undoFinding, setUndoFinding] = useState<{ id: string; original: string; replacement: string }>()
  const [cancelledIds, setCancelledIds] = useState<ReadonlySet<string>>(new Set())
  const [addingEntity, setAddingEntity] = useState(false)
  const [addType, setAddType] = useState('')
  const [addOriginal, setAddOriginal] = useState('')
  const [addReplacement, setAddReplacement] = useState('')
  const [addError, setAddError] = useState(false)
  const [expandedValue, setExpandedValue] = useState<{ label: string; value: string }>()
  useEffect(() => {
    if (unprotectFinding === undefined || sessionId === undefined) return
    if (window.confirm(t('review.unprotectMessage'))) {
      controller.setLiveFindingProtection(sessionId, unprotectFinding.id, false, unprotectFinding.original)
      setUndoFinding({ id: unprotectFinding.id, original: unprotectFinding.original, replacement: unprotectFinding.replacement })
      setCancelledIds(current => new Set(current).add(unprotectFinding.id))
    }
    setUnprotectFinding(undefined)
  }, [controller, sessionId, t, unprotectFinding])
  return (
    <section className={css.findingsSection}>
      <div className={css.sectionHeading}>
        <strong>{`${t('audit.findings')} (${String(live.result.findings.length - cancelledIds.size)})`}</strong>
        <button className={css.reviewAddButton} type="button" title={t('review.addEntity')}
          aria-label={t('review.addEntity')} onClick={() => { setAddingEntity(true); setAddError(false) }}>
          <LucideIcon icon={Plus} size={18} />
        </button>
      </div>
      {live.result.findings.length === cancelledIds.size ? (
        <p className={incomplete ? css.incompleteFindings : css.noFindings}>
          {incomplete ? t('audit.partialNoFindings') : `✓ ${t('audit.noFindings')}`}
        </p>
      ) : (
        <div className={css.findingRows}>
          {live.result.findings.filter(finding => !cancelledIds.has(finding.id)).map(finding => {
            const original = live.text.slice(finding.start, finding.end)
            const editing = editingFindingId === finding.id
            return (
                <div className={css.findingRow} data-cancelled={cancelledIds.has(finding.id) || undefined} key={finding.id}>
                <div>
                  <strong>{findingTypeLabel(finding, t)}</strong>
                  <small>{t(CATEGORY_KEYS[finding.category])}</small>
                </div>
                {editing ? (
                  <div className={css.findingEdit}>
                    <input
                      aria-label={`${t('review.editLabel')}: ${findingTypeLabel(finding, t)}`}
                      value={editValue}
                      onChange={event => { setEditValue(event.target.value) }}
                      autoFocus
                    />
                    <div className={css.reviewEditActions}>
                      <button type="button" onClick={() => {
                        if (sessionId !== undefined) controller.setLiveFindingReplacement(sessionId, finding.id, editValue)
                        setEditingFindingId(undefined)
                      }}>{t('review.saveEdit')}</button>
                      <button type="button" onClick={() => { setEditingFindingId(undefined) }}>{t('review.cancelEdit')}</button>
                    </div>
                  </div>
                ) : (
                  <div className={css.findingTransform}>
                    <button className={css.entityValueButton} type="button" title={t('review.openValue')}
                      onClick={() => { setExpandedValue({ label: findingTypeLabel(finding, t), value: original || finding.maskedEvidence }) }}>
                      {original || finding.maskedEvidence}
                    </button>
                    <span className={css.reviewArrow}><LucideIcon icon={ArrowRight} size={17} /></span>
                    <button className={`${css.entityValueButton} ${css.entityValueReplacement}`} type="button"
                      title={t('review.openValue')} onClick={() => { setExpandedValue({ label: t('review.redactedOutput'), value: finding.replacement || '—' }) }}>
                      {finding.replacement || '—'}
                    </button>
                  </div>
                )}
                <div className={css.findingMeta}>
                  <button className={css.reviewIconButton} type="button" title={t('review.edit')}
                    aria-label={t('review.edit')} disabled={sessionId === undefined}
                    onClick={() => {
                      setEditingFindingId(finding.id)
                      setEditValue(finding.replacement)
                    }}><LucideIcon icon={Pencil} size={16} /></button>
                    <button className={css.reviewIconButton} type="button" title={t('review.keep')}
                      aria-label={t('review.keep')} disabled={sessionId === undefined}
                      onClick={() => {
                        if (sessionId !== undefined) setUnprotectFinding({
                          id: finding.id, original, replacement: finding.replacement,
                        })
                      }}><LucideIcon icon={X} size={17} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {addingEntity ? (
        <div className={css.reviewAddForm}>
          <strong>{t('review.addTitle')}</strong>
          <input value={addType} placeholder={t('review.entityTypePlaceholder')} maxLength={40}
            onChange={event => { setAddType(event.target.value); setAddError(false) }} />
          <div className={css.reviewAddValues}>
            <input value={addOriginal} placeholder={t('review.originalPlaceholder')}
              onChange={event => { setAddOriginal(event.target.value); setAddError(false) }} />
            <span className={css.reviewArrow}><LucideIcon icon={ArrowRight} size={17} /></span>
            <input value={addReplacement} placeholder={t('review.replacementPlaceholder')}
              onChange={event => { setAddReplacement(event.target.value); setAddError(false) }} />
          </div>
          {addError ? <small className={css.reviewAddError}>{t('review.addError')}</small> : null}
          <div className={css.reviewAddActions}>
            <button type="button" onClick={() => { setAddingEntity(false) }}>{t('review.cancelEdit')}</button>
            <button type="button" onClick={() => {
              const added = sessionId !== undefined && controller.addLiveFinding(sessionId, addOriginal, addReplacement, addType)
              if (!added) { setAddError(true); return }
              setAddingEntity(false)
              setAddType('')
              setAddOriginal('')
              setAddReplacement('')
            }}>{t('review.add')}</button>
          </div>
        </div>
      ) : null}
      {live.result.policySignals.map(signal => (
        <div className={css.policyRow} key={signal.policyId}>
          <strong>{t('policy.CUSTOMER_KYC')}</strong>
          <span>{t('risk.high')}</span>
        </div>
      ))}
      {undoFinding !== undefined ? (
        <div className={css.reviewUndoBar}>
          <span>{t('review.undoDone').replace('{value}', undoFinding.original)}</span>
          <button type="button" onClick={() => {
            if (sessionId !== undefined) {
              controller.setLiveFindingProtection(sessionId, undoFinding.id, true, undoFinding.replacement)
              controller.setLiveFindingReplacement(sessionId, undoFinding.id, undoFinding.replacement)
            }
            setUndoFinding(undefined)
            setCancelledIds(current => {
              const next = new Set(current)
              next.delete(undoFinding.id)
              return next
            })
          }}>{t('review.undo')}</button>
        </div>
      ) : null}
      {expandedValue !== undefined ? (
        <div className={css.entityValuePopover} role="dialog" aria-label={t('review.fullValue')}>
          <div><strong>{expandedValue.label}</strong><button type="button" aria-label={t('review.closeValue')}
            onClick={() => { setExpandedValue(undefined) }}><LucideIcon icon={X} size={16} /></button></div>
          <pre>{expandedValue.value}</pre>
        </div>
      ) : null}
    </section>
  )
}

function AuditView({
  controller, live, sessionId, t,
}: {
  controller: PrivacyController
  live: ReturnType<PrivacySnapshot['liveBySession']['get']>
  sessionId: string | undefined
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const [rechecking, setRechecking] = useState(false)
  if (live === undefined || live.text.trim() === '') {
    return <div className={css.emptyState}>{t('audit.empty')}</div>
  }
  const payload = JSON.stringify(normalized(live.result), null, 2)
  const incomplete = live.result.detector.status === 'partial'
  const statusText = incomplete ? t('audit.partialStatus')
    : live.durationMs === undefined ? t('audit.checking') : t('audit.completed')
  const findingCount = live.result.findings.length
  const recheck = async (): Promise<void> => {
    if (sessionId === undefined || rechecking) return
    setRechecking(true)
    try { await controller.inspect(sessionId, live.text) } finally { setRechecking(false) }
  }
  return (
    <div className={css.auditView}>
      <section className={css.pipelineSection}>
        <div className={css.monitorHeading}>
          <div>
            <h3>{t('audit.pipeline')}</h3>
            <p><strong>{t('audit.method')}：</strong>{detectorSummary(live.result, t)}</p>
          </div>
          <div className={css.monitorMeta}>
            <span data-status={incomplete ? 'partial' : live.durationMs === undefined ? 'checking' : 'complete'}>
              {statusText}
              {live.durationMs === undefined ? '' : ` · ${String(findingCount)}${t('audit.findingsUnit')} · ${String(live.durationMs)}ms`}
            </span>
            <button className={css.secondaryButton} type="button" disabled={sessionId === undefined || rechecking}
              onClick={() => { void recheck() }}>
              {rechecking ? t('audit.rechecking') : t('audit.recheck')}
            </button>
          </div>
        </div>
        <AuditFindings controller={controller} live={live} sessionId={sessionId} incomplete={incomplete} t={t} />
        <div className={css.stage} data-stage="plain">
          <div className={css.stageHeading}>
            <strong>{t('audit.stage1')}</strong>
            <CopyButton text={live.text} label={t('audit.copyOriginal')} />
          </div>
          <p>{live.text === '' ? '—' : <HighlightedText text={live.text} findings={live.result.findings} t={t} />}</p>
        </div>
        <div className={css.stage} data-stage="redacted">
          <div className={css.stageHeading}>
            <strong>{t('audit.stage2')}</strong>
            <CopyButton text={live.result.redactedText} label={t('audit.copyRedacted')} />
          </div>
          <p>{live.result.redactedText || '—'}</p>
        </div>
      </section>

      {incomplete ? <p className={css.partialWarning}>{t('audit.partial')}</p> : null}
      {live.result.detector.fallback ? <p className={css.fallback}>{t('audit.fallback')}</p> : null}

      <details className={css.jsonSection}>
        <summary>
          <span>{t('audit.json')}</span>
          <CopyButton text={payload} label={t('audit.copyJson')} />
        </summary>
        <pre>{payload}</pre>
      </details>
    </div>
  )
}

function DetectionView({ controller, live, sessionId, t }: {
  controller: PrivacyController
  live: ReturnType<PrivacySnapshot['liveBySession']['get']>
  sessionId: string | undefined
  t: PrivacyDrawerProps['t']
}): ReactNode {
  return <div className={css.detectionView}><AuditView controller={controller} live={live} sessionId={sessionId} t={t} /></div>
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

function LocalModelActions({ controller, snapshot, t, state }: { controller: PrivacyController; snapshot: PrivacySnapshot; t: PrivacyDrawerProps['t']; state: PrivacySnapshot['detectorStates'][DetectorMode] }): ReactNode {
  const [modelFile, setModelFile] = useState<File>()
  const [manifestFile, setManifestFile] = useState<File>()
  const choose = (kind: 'model' | 'manifest', file: File | undefined): void => {
    if (kind === 'model') setModelFile(file)
    else setManifestFile(file)
  }
  return <div className={css.modelActions}>
    <label><span>{t('model.chooseModel')}</span><input type="file" accept=".gguf,application/octet-stream" onChange={event => { choose('model', event.target.files?.[0]) }} /></label>
    <label><span>{t('model.chooseManifest')}</span><input type="file" accept="application/json,.json" onChange={event => { choose('manifest', event.target.files?.[0]) }} /></label>
    <button className={css.primaryButton} type="button" disabled={modelFile === undefined || manifestFile === undefined || state.status === 'loading'} onClick={() => { if (modelFile !== undefined && manifestFile !== undefined) void controller.selectLocalModel(modelFile, manifestFile).then(() => controller.loadLocalModel()).catch(() => undefined) }}>
      {state.status === 'loading' ? t('model.loading') : t('model.loadLocal')}
    </button>
    {snapshot.localModel !== undefined ? <small>{`${t('model.localSelected')}: ${snapshot.localModel.modelId} · ${snapshot.localModel.architecture} · ${snapshot.localModel.version} · ${snapshot.localModel.quantization} · ${String(snapshot.localModel.fileSize)} bytes`}</small> : null}
    {state.error !== undefined ? <code>{state.code === undefined ? state.error : `${state.code}: ${state.error}`}</code> : null}
    <small>{t('model.localRuntimeNotice')}</small>
  </div>
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
    ['local-model', 'model.localModel', 'model.localModelDesc'],
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
  const localModelState = snapshot.detectorStates['local-model']
  const zeroClaveState = snapshot.detectorStates.zeroclave
  const showTelemetry = snapshot.telemetry.availability === 'available' || snapshot.telemetry.consent
  const [telemetryDetailsOpen, setTelemetryDetailsOpen] = useState(false)
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
      {snapshot.detectorMode === 'local-model' ? <LocalModelActions controller={controller} snapshot={snapshot} t={t} state={localModelState} /> : null}
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
      {showTelemetry ? <section className={css.telemetrySection}>
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
        {telemetryDetailsOpen ? <div className={css.telemetryDetails}>
          <p>{t('telemetry.detailParagraph1')}</p>
          <p>{t('telemetry.detailParagraph2')}</p>
          <p>{t('telemetry.detailParagraph3')}</p>
        </div> : null}
      </section> : null}
    </div>
  )
}

export function PrivacyDrawer({ controller, t, useSessions, sessions, conversation }: PrivacyDrawerProps): ReactNode {
  const snapshot = usePrivacy(controller)
  const drawerBodyRef = useRef<HTMLDivElement>(null)
  const sessionId = useSessions(state => state.current)
  const live = sessionId === undefined ? undefined : snapshot.liveBySession.get(sessionId)
  const [sending, setSending] = useState(false)
  const tabs: Array<[PrivacySnapshot['activeTab'], PrivacyKey]> = [
    ['audit', 'tab.audit'],
    ['model', 'tab.model'],
    ['rules', 'tab.rules'],
  ]
  useEffect(() => {
    if (drawerBodyRef.current !== null) drawerBodyRef.current.scrollTop = 0
  }, [snapshot.activeTab, snapshot.pendingSendReview?.id])
  if (!snapshot.open) return null

  return (
    <aside className={css.drawer} data-zero-privacy-drawer="open">
      <header className={css.drawerHeader}>
        <div className={css.brandIdentity}>
          <img className={css.brandLogo} src={zeroclaveLogo} alt={t('brand')} />
          <small>{sessionId ?? t('sessionFallback')}</small>
        </div>
        <div className={css.headerStatus}>
          <span data-enabled={snapshot.enabled || undefined}>{snapshot.enabled ? t('active') : t('paused')}</span>
          <SwitchControl checked={snapshot.enabled} label={snapshot.enabled ? t('disable') : t('enable')}
            onChange={(enabled) => { controller.setEnabled(enabled) }} />
        </div>
        <button className={css.iconButton} type="button" aria-label={t('close')} onClick={() => {
          if (snapshot.pendingSendReview !== undefined) controller.cancelSendReview()
          controller.setOpen(false)
        }}><LucideIcon icon={X} size={18} /></button>
      </header>
      <nav className={css.tabs}>
        {tabs.map(([id, label]) => (
          <button
            data-selected={snapshot.activeTab === id || undefined}
            disabled={snapshot.pendingSendReview !== undefined}
            key={id}
            type="button"
            onClick={() => { controller.setTab(id) }}
          >
            {t(label)}
          </button>
        ))}
      </nav>
      <div className={css.drawerBody} data-zero-privacy-scroll ref={drawerBodyRef}>
        {snapshot.pendingSendReview !== undefined ? (
          <AuditView controller={controller} live={live} sessionId={sessionId} t={t} />
        ) : null}
        {snapshot.pendingSendReview === undefined && snapshot.activeTab === 'audit' ? (
          <DetectionView
            controller={controller}
            live={live}
            sessionId={sessionId}
            t={t}
          />
        ) : null}
        {snapshot.pendingSendReview === undefined && snapshot.activeTab === 'rules'
          ? <RulesView controller={controller} snapshot={snapshot} t={t} /> : null}
        {snapshot.pendingSendReview === undefined && snapshot.activeTab === 'model'
          ? <ModelView controller={controller} snapshot={snapshot} t={t} /> : null}
      </div>
      <footer className={css.drawerFooter}>
        {snapshot.pendingSendReview !== undefined ? (
          <div className={css.drawerSendActions}>
            <button className={css.secondaryButton} type="button" onClick={() => { controller.cancelSendReview() }}>
              {t('review.cancelSend')}
            </button>
            <button className={css.primaryButton} type="button" onClick={() => { controller.confirmSendReview() }}>
              {t('review.confirmSend')}
            </button>
          </div>
        ) : snapshot.activeTab === 'audit' && live?.result.findings.length !== 0 && sessionId !== undefined ? (
          <div className={css.drawerSendActions}>
            <button className={css.secondaryButton} type="button" onClick={() => { controller.setOpen(false) }}>
              {t('review.cancelSend')}
            </button>
            <button className={css.primaryButton} type="button" disabled={sending}
              onClick={() => {
                const session = sessions.binding(sessionId)?.session
                if (session === undefined || live === undefined) return
                setSending(true)
                const sendSession = (conversation as {
                  sendSession?: (target: object, text: string, attachments: readonly string[], mode: 'queue') => Promise<unknown>
                }).sendSession
                if (sendSession === undefined) { setSending(false); return }
                void sendSession.call(conversation, session, live.result.redactedText, [], 'queue')
                  .then((outcome: unknown) => {
                    if (typeof outcome !== 'object' || outcome === null || !('kind' in outcome)
                      || outcome.kind !== 'success') return
                    const scope = sessions.scope(sessionId)
                    const input = (conversation as {
                      input?: { for?: (target: object) => { setDraft(text: string): void } }
                    }).input
                    if (scope !== undefined && input?.for !== undefined) input.for(scope).setDraft('')
                  })
                  .finally(() => { setSending(false) })
              }}>
              {t('review.confirmSend')}
            </button>
          </div>
        ) : null}
        {snapshot.pendingSendReview === undefined ? <div className={css.drawerFooterMeta}>
          <a className={css.communityLink} href="https://zeroclave.com/community" target="_blank" rel="noreferrer">
            <i />{t('footer.core')}
          </a>
          <button type="button" onClick={() => { controller.setTab('model') }}>{t('footer.configure')} →</button>
        </div> : null}
      </footer>
    </aside>
  )
}
