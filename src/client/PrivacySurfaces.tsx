import { createElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { ArrowLeft, Copy, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide'
import type { IconNode as LucideNode } from 'lucide'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PrivacyController } from '../controller.ts'
import type {
  DetectorMode, PrivacyFinding, PrivacySnapshot, RiskLevel, ScanResult, SendRecord,
  EditableRegexRule, EntityType, FindingCategory, RegexErrorCode,
} from '../types.ts'
import { DEFAULT_REGEX_RULES } from '../detector.ts'
import { RULE_ENTITY_TYPES } from '../regex-rules.ts'
import type { PrivacyKey } from './locales.ts'
import css from './PrivacySurfaces.module.css'

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

function DetectorBadge({ mode, fallback = false, t }: {
  mode: DetectorMode
  fallback?: boolean
  t: PrivacyDrawerProps['t']
}): ReactNode {
  return (
    <span className={css.detectorBadge} data-detector={mode}>
      {t(fallback && mode === 'regex' ? 'source.regexFallback' : DETECTOR_KEYS[mode])}
    </span>
  )
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
      {copied ? '✓' : '⧉'} {label}
    </button>
  )
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
      : snapshot.detectorMode === 'embedded' ? 300 : 0
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
          snapshot.sendPolicy === 'review-critical' ? 'dock.reviewReminder' : 'dock.reminder',
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

function AuditView({
  live, t,
}: {
  live: ReturnType<PrivacySnapshot['liveBySession']['get']>
  t: PrivacyDrawerProps['t']
}): ReactNode {
  if (live === undefined || live.text.trim() === '') {
    return <div className={css.emptyState}>{t('audit.empty')}</div>
  }
  const payload = JSON.stringify(normalized(live.result), null, 2)
  const incomplete = live.result.detector.status === 'partial'
  return (
    <div className={css.auditView}>
      <div className={css.inputMeta}>
        <span>{t('audit.input')}</span>
        <time>{new Date(live.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </div>

      <section className={css.pipelineSection}>
        <div className={css.sectionHeading}>
          <ShieldIcon size={16} />
          <strong>{t('audit.pipeline')}</strong>
          <small>{detectorSummary(live.result, t)}</small>
        </div>
        <div className={css.stage} data-stage="plain">
          <div className={css.stageHeading}>
            <strong>{t('audit.stage1')}</strong>
            <CopyButton text={live.text} label={t('audit.copyOriginal')} />
          </div>
          <p>{live.text || '—'}</p>
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

      <section className={css.findingsSection}>
        <div className={css.sectionHeading}>
          <strong>{`${t('audit.findings')} (${String(live.result.findings.length)})`}</strong>
        </div>
        {live.result.findings.length === 0 ? (
          <p className={incomplete ? css.incompleteFindings : css.noFindings}>
            {incomplete ? t('audit.partialNoFindings') : `✓ ${t('audit.noFindings')}`}
          </p>
        ) : (
          <div className={css.findingRows}>
            {live.result.findings.map(finding => (
              <div className={css.findingRow} key={finding.id}>
                <div>
                  <strong>{findingTypeLabel(finding, t)}</strong>
                  <small>{t(CATEGORY_KEYS[finding.category])}</small>
                </div>
                <code>{finding.maskedEvidence}</code>
                <div className={css.findingMeta}>
                  <DetectorBadge mode={finding.detector} t={t} />
                  <span>{finding.detector === 'regex'
                    ? ruleDisplayName(finding.ruleId, finding.entityType, finding.ruleName, t)
                    : finding.detector === 'zeroclave'
                      ? t('audit.gatewayFinding')
                      : finding.confidence === undefined
                        ? t('audit.modelFinding')
                        : `${Math.round(finding.confidence * 100)}%`}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {live.result.policySignals.map(signal => (
          <div className={css.policyRow} key={signal.policyId}>
            <strong>{t('policy.CUSTOMER_KYC')}</strong>
            <span>{t('risk.high')}</span>
          </div>
        ))}
      </section>

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

function RecentSends({ controller, records, sessionId, t }: {
  controller: PrivacyController
  records: readonly SendRecord[]
  sessionId: string
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const recent = [...records].reverse()
  return (
    <section className={css.activitySection}>
      <div className={css.activityHeading}>
        <div><h3>{t('activity.title')}</h3><small>{t('activity.sessionOnly')}</small></div>
        <button type="button" aria-label={t('activity.clear')} title={t('activity.clear')}
          onClick={() => { controller.clearSendRecords(sessionId) }}><LucideIcon icon={Trash2} /></button>
      </div>
      <div className={css.activityRows}>
        {recent.map(record => (
          <article className={css.activityRow} key={record.id}>
            <div className={css.activityMain}>
              <time>{new Date(record.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              <div><strong>{t('activity.sent')}</strong><small>
                {`${String(record.redactedCount)} ${t('activity.redacted')}`}
                {record.keptCount > 0 ? ` · ${String(record.keptCount)} ${t('activity.kept')}` : ''}
              </small></div>
              <span className={css.riskBadge} data-risk={record.overallRisk}>{t(RISK_KEYS[record.overallRisk])}</span>
            </div>
            <div className={css.activityMeta}>
              {record.detectors.map(mode => <DetectorBadge mode={mode} key={mode} t={t} />)}
              {record.fallbackUsed ? <small>{t('source.regexFallback')}</small> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function DetectionView({ controller, live, records, sessionId, t }: {
  controller: PrivacyController
  live: ReturnType<PrivacySnapshot['liveBySession']['get']>
  records: readonly SendRecord[]
  sessionId: string | undefined
  t: PrivacyDrawerProps['t']
}): ReactNode {
  return (
    <div className={css.detectionView}>
      <AuditView live={live} t={t} />
      {sessionId !== undefined && records.length > 0
        ? <RecentSends controller={controller} records={records} sessionId={sessionId} t={t} /> : null}
    </div>
  )
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
  const [filter, setFilter] = useState<'all' | 'builtin' | 'custom'>('all')
  const defaults = new Map(DEFAULT_REGEX_RULES.map(rule => [rule.id, rule]))
  const visible = snapshot.regexRules.filter((rule) => {
    const builtin = defaults.has(rule.id)
    return (filter === 'all' || (filter === 'builtin') === builtin)
      && `${rule.name} ${rule.pattern} ${rule.entityType}`.toLowerCase().includes(query.trim().toLowerCase())
  })
  if (editing !== undefined) return (
    <RuleEditor controller={controller} original={editing} t={t} onClose={() => { setEditing(undefined) }} />
  )
  return (
    <div className={css.tabPage}>
      <div className={css.rulesHeading}><div><h3>{t('rules.title')}</h3><p>{t('rules.desc')}</p></div>
        <button className={css.primaryButton} type="button" onClick={() => { setEditing(emptyRule()) }}>
          <LucideIcon icon={Plus} /> {t('rules.add')}
        </button></div>
      {snapshot.regexError !== undefined ? <p className={css.ruleError}>{t(ruleErrorKey(snapshot.regexError))}</p> : null}
      <div className={css.ruleTools}>
        <label className={css.searchBox}><LucideIcon icon={Search} /><input aria-label={t('rules.search')} placeholder={t('rules.search')}
          value={query} onChange={(event) => { setQuery(event.target.value) }} /></label>
        <select aria-label={t('rules.filter')} value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter) }}>
          <option value="all">{t('rules.all')}</option><option value="builtin">{t('rules.builtin')}</option><option value="custom">{t('rules.custom')}</option>
        </select>
      </div>
      <div className={css.ruleRows}>{visible.map((rule) => {
        const defaultRule = defaults.get(rule.id)
        const changed = defaultRule !== undefined && JSON.stringify(defaultRule) !== JSON.stringify(rule)
        const displayName = ruleDisplayName(rule.id, rule.entityType, rule.name, t)
        return <article className={css.ruleCard} key={rule.id} data-enabled={rule.enabled || undefined}>
          <label className={css.ruleToggle}><input type="checkbox" checked={rule.enabled}
            onChange={(event) => { controller.saveRule({ ...rule, enabled: event.target.checked }) }} /><span /></label>
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

function reviewFindingKey(partIndex: number, findingId: string): string {
  return `${String(partIndex)}:${findingId}`
}

function reviewPreview(text: string, result: ScanResult, partIndex: number, decisions: Readonly<Record<string, boolean>>): string {
  return [...result.findings].sort((left, right) => right.start - left.start).reduce((value, finding) => {
    if (decisions[reviewFindingKey(partIndex, finding.id)] === false) return value
    return value.slice(0, finding.start) + finding.replacement + value.slice(finding.end)
  }, text)
}

function SendReviewView({ controller, review, t }: {
  controller: PrivacyController
  review: NonNullable<PrivacySnapshot['pendingSendReview']>
  t: PrivacyDrawerProps['t']
}): ReactNode {
  useEffect(() => {
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.cancelSendReview()
    }
    window.addEventListener('keydown', cancel)
    return () => { window.removeEventListener('keydown', cancel) }
  }, [controller, review.id])
  const findings = review.parts.flatMap((part, partIndex) => (
    part.result.findings.map(finding => ({ finding, partIndex, key: reviewFindingKey(partIndex, finding.id) }))
  ))
  const kept = findings.filter(item => review.redactByFinding[item.key] === false).length
  return (
    <div className={css.sendReview}>
      <div className={css.reviewHeading}>
        <span className={css.reviewShield}><ShieldIcon size={20} /></span>
        <div><h3>{t('review.title')}</h3><p>{t('review.desc')}</p></div>
      </div>
      <div className={css.reviewSummary}>
        <strong>{`${String(findings.length)} ${t('review.items')}`}</strong>
        <span className={css.riskBadge} data-risk="critical">{t('risk.critical')}</span>
      </div>
      <div className={css.reviewFindings}>{findings.map(({ finding, key }) => (
        <article className={css.reviewFinding} key={key}>
          <div className={css.reviewFindingText}>
            <div className={css.reviewFindingTitle}>
              <strong>{findingTypeLabel(finding, t)}</strong>
              <span data-risk={finding.severity}>{t(RISK_KEYS[finding.severity])}</span>
            </div>
            <code>{finding.maskedEvidence}</code>
            <small>{finding.ruleName === undefined
              ? t('review.model')
              : `${t('review.rule')}: ${ruleDisplayName(finding.ruleId, finding.entityType, finding.ruleName, t)}`}</small>
          </div>
          <div className={css.disposition}>
            <button type="button" data-selected={review.redactByFinding[key] !== false || undefined}
              onClick={() => { controller.setSendReviewFinding(key, true) }}>{t('review.redact')}</button>
            <button type="button" data-selected={review.redactByFinding[key] === false || undefined}
              onClick={() => { controller.setSendReviewFinding(key, false) }}>{t('review.keep')}</button>
          </div>
        </article>
      ))}</div>
      <section className={css.reviewPreview}>
        <strong>{t('review.preview')}</strong>
        {review.parts.map((part, index) => (
          <pre key={index}>{reviewPreview(part.text, part.result, index, review.redactByFinding)}</pre>
        ))}
      </section>
      {kept > 0 ? <p className={css.reviewWarning}>{t('review.keptWarning')}</p> : null}
      <div className={css.reviewActions}>
        <button className={css.secondaryButton} type="button" onClick={() => { controller.cancelSendReview() }}>
          {t('review.cancel')}
        </button>
        <button className={css.primaryButton} type="button" onClick={() => { controller.confirmSendReview() }}>
          {kept > 0 ? t('review.confirmKeep').replace('{count}', String(kept)) : t('review.confirm')}
        </button>
      </div>
    </div>
  )
}

function ModelView({ controller, snapshot, t }: {
  controller: PrivacyController
  snapshot: PrivacySnapshot
  t: PrivacyDrawerProps['t']
}): ReactNode {
  const rows: Array<[DetectorMode, PrivacyKey, PrivacyKey]> = [
    ['regex', 'model.regex', 'model.regexDesc'],
    ['embedded', 'model.embedded', 'model.embeddedDesc'],
    ['zeroclave', 'model.zeroclave', 'model.zeroclaveDesc'],
  ]
  const statusKey = (mode: DetectorMode): PrivacyKey => {
    const status = snapshot.detectorStates[mode].status
    if (status === 'ready') return mode === 'regex' ? 'model.running' : 'model.ready'
    if (status === 'loading') return 'model.loading'
    if (status === 'partial') return 'model.partial'
    if (status === 'error') return 'model.error'
    if (status === 'unconfigured') return 'model.unconfigured'
    return mode === 'zeroclave' ? 'model.untested' : 'model.idle'
  }
  const embeddedState = snapshot.detectorStates.embedded
  const zeroClaveState = snapshot.detectorStates.zeroclave
  return (
    <div className={css.tabPage}>
      <h3>{t('model.title')}</h3>
      <p>{t('model.desc')}</p>
      <section className={css.policySection}>
        <div><strong>{t('policy.title')}</strong><small>{t('policy.desc')}</small></div>
        <div className={css.policyOptions}>
          {([
            ['review-critical', 'policy.review', 'policy.reviewDesc'],
            ['auto-redact', 'policy.auto', 'policy.autoDesc'],
          ] as const).map(([policy, title, description]) => (
            <button type="button" key={policy} data-selected={snapshot.sendPolicy === policy || undefined}
              onClick={() => { controller.setSendPolicy(policy) }}>
              <span className={css.radioMark} /><span><strong>{t(title)}</strong><small>{t(description)}</small></span>
            </button>
          ))}
        </div>
      </section>
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
            <span><strong>{t(title)}</strong><small>{t(description)}</small></span>
            <em>
              {t(statusKey(mode))}
              {mode === 'embedded' && embeddedState.status === 'loading' && embeddedState.progress !== undefined
                ? ` ${Math.round(embeddedState.progress)}%`
                : ''}
            </em>
          </button>
        ))}
      </div>
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
        ? <><p className={css.gatewayNotice}>{t('model.gatewayNotice')}</p>
          <p className={css.modelNote}>{t('model.textOnly')}</p></>
        : null}
      <p className={css.modelNote}>{t('model.fallback')}</p>
      {snapshot.detectorMode === 'embedded'
        ? <p className={css.modelNote}>{t('model.limitation')}</p>
        : null}
      <section className={css.telemetrySection}>
        <div className={css.telemetryHeading}>
          <div><strong>{t('telemetry.title')}</strong><small>{t('telemetry.summary')}</small></div>
        </div>
        <p>{t('telemetry.detail')}</p>
        <p>{snapshot.telemetry.lockedByGpc ? t('telemetry.gpc') : t('telemetry.network')}</p>
        <div className={css.telemetryControl}>
          <strong className={css.telemetryConsent}>{t('telemetry.consent')}</strong>
          <label className={css.telemetryToggle} data-enabled={snapshot.telemetry.consent || undefined}>
            <input
              type="checkbox"
              role="switch"
              aria-label={t('telemetry.consent')}
              checked={snapshot.telemetry.consent}
              disabled={snapshot.telemetry.availability !== 'available' || snapshot.telemetry.lockedByGpc}
              onChange={(event) => { controller.setTelemetryConsent(event.target.checked) }}
            />
            <span aria-hidden="true"><i /></span>
            <em>{snapshot.telemetry.availability === 'checking'
              ? t('telemetry.checking')
              : snapshot.telemetry.lockedByGpc
                ? t('telemetry.off')
                : snapshot.telemetry.availability === 'unavailable'
                  ? t('telemetry.unavailable')
                  : snapshot.telemetry.consent ? t('telemetry.on') : t('telemetry.off')}</em>
          </label>
        </div>
      </section>
    </div>
  )
}

export function PrivacyDrawer({ controller, t, useSessions }: PrivacyDrawerProps): ReactNode {
  const snapshot = usePrivacy(controller)
  const sessionId = useSessions(state => state.current)
  const live = sessionId === undefined ? undefined : snapshot.liveBySession.get(sessionId)
  const records = sessionId === undefined ? [] : snapshot.sendRecordsBySession.get(sessionId) ?? []
  const tabs: Array<[PrivacySnapshot['activeTab'], PrivacyKey]> = [
    ['audit', 'tab.audit'],
    ['rules', 'tab.rules'],
    ['model', 'tab.model'],
  ]
  if (!snapshot.open) return null

  return (
    <aside className={css.drawer} data-zero-privacy-drawer="open"
      data-review={snapshot.pendingSendReview === undefined ? undefined : 'send'}>
      <header className={css.drawerHeader}>
        <span className={css.brandIcon}><ShieldIcon size={20} /></span>
        <div><strong>{t('brand')}</strong><small>{sessionId ?? t('sessionFallback')}</small></div>
        <button
          className={css.toggleButton}
          data-enabled={snapshot.enabled || undefined}
          type="button"
          aria-label={snapshot.enabled ? t('disable') : t('enable')}
          aria-pressed={snapshot.enabled}
          onClick={() => { controller.setEnabled(!snapshot.enabled) }}
        >
          <i />
          {snapshot.enabled ? t('active') : t('paused')}
        </button>
        <button className={css.iconButton} type="button" aria-label={t('close')} onClick={() => {
          if (snapshot.pendingSendReview !== undefined) controller.cancelSendReview()
          controller.setOpen(false)
        }}>×</button>
      </header>
      {snapshot.pendingSendReview === undefined ? <nav className={css.tabs}>
        {tabs.map(([id, label]) => (
          <button
            data-selected={snapshot.activeTab === id || undefined}
            key={id}
            type="button"
            onClick={() => { controller.setTab(id) }}
          >
            {t(label)}
          </button>
        ))}
      </nav> : null}
      <div className={css.drawerBody}>
        {snapshot.pendingSendReview !== undefined ? (
          <SendReviewView controller={controller} review={snapshot.pendingSendReview} t={t} />
        ) : null}
        {snapshot.pendingSendReview === undefined && snapshot.activeTab === 'audit' ? (
          <DetectionView
            controller={controller}
            live={live}
            records={records}
            sessionId={sessionId}
            t={t}
          />
        ) : null}
        {snapshot.pendingSendReview === undefined && snapshot.activeTab === 'rules'
          ? <RulesView controller={controller} snapshot={snapshot} t={t} /> : null}
        {snapshot.pendingSendReview === undefined && snapshot.activeTab === 'model'
          ? <ModelView controller={controller} snapshot={snapshot} t={t} /> : null}
      </div>
      {snapshot.pendingSendReview === undefined ? <footer className={css.drawerFooter}>
        <span><i />{t('footer.core')}</span>
        <button type="button" onClick={() => { controller.setTab('model') }}>{t('footer.configure')} →</button>
      </footer> : null}
    </aside>
  )
}
