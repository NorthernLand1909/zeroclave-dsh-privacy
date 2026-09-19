// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { DEFAULT_REGEX_RULES, scanRegex } from '../src/detector.ts'
import type { TelemetryReporter } from '../src/telemetry.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

afterEach(() => { window.localStorage.clear() })

function sentResult(text: string, kept = false) {
  const result = scanRegex(text)
  return {
    ...result,
    findings: result.findings.map(finding => ({
      ...finding, action: kept ? 'kept' as const : 'redacted' as const,
    })),
  }
}

function telemetryReporter(report = vi.fn()): TelemetryReporter {
  return {
    consent: true,
    lockedByGpc: false,
    initialize: async () => 'available',
    setConsent: consent => consent,
    setConsentListener: () => undefined,
    report,
    dispose: async () => undefined,
  }
}

describe('session send activity', () => {
  it('stores only a bounded summary of successful privacy processing', () => {
    const controller = new PrivacyController()
    for (let index = 0; index < 12; index += 1) {
      controller.recordSend('session-1', [sentResult(`person${String(index)}@example.com`, index === 11)])
    }
    const records = controller.getSnapshot().sendRecordsBySession.get('session-1')
    expect(records).toHaveLength(10)
    expect(records?.at(-1)).toEqual(expect.objectContaining({
      findingCount: 1, redactedCount: 0, keptCount: 1, detectors: ['regex'],
    }))
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('person11@example.com')
    expect(serialized).not.toContain('redactedText')
    expect(serialized).not.toContain('findings')
  })

  it('keeps session summaries separate and clears only the selected session', () => {
    const controller = new PrivacyController()
    controller.recordSend('session-1', [sentResult('one@example.com')])
    controller.recordSend('session-2', [sentResult('two@example.com')])
    controller.clearSendRecords('session-1')
    expect(controller.getSnapshot().sendRecordsBySession.has('session-1')).toBe(false)
    expect(controller.getSnapshot().sendRecordsBySession.get('session-2')).toHaveLength(1)
  })

  it('starts with no activity after a refresh-equivalent controller recreation', () => {
    const first = new PrivacyController()
    first.recordSend('session-1', [sentResult('demo@example.com')])
    expect(first.getSnapshot().sendRecordsBySession.get('session-1')).toHaveLength(1)
    expect(new PrivacyController().getSnapshot().sendRecordsBySession.size).toBe(0)
  })
})

describe('controller telemetry boundaries', () => {
  it('reports activity and the actual detector only after a successful non-empty scan', async () => {
    const report = vi.fn()
    const reporter = telemetryReporter(report)
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()), async () => [], undefined, reporter,
    )
    controller.setEnabled(true)
    controller.setDetectorMode('embedded')

    await controller.inspect('session-1', 'plain text')

    expect(report.mock.calls).toEqual([
      ['privacy_active', undefined],
      ['detector_used', 'regex'],
    ])

    report.mockClear()
    await controller.inspect('session-1', '')
    expect(report).not.toHaveBeenCalled()
  })

  it('does not report a failed scan as privacy activity', async () => {
    const report = vi.fn()
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()),
      async () => { throw new Error('worker failed') },
      undefined,
      telemetryReporter(report),
    )
    controller.setEnabled(true)
    const changedRule = DEFAULT_REGEX_RULES[0]
    if (changedRule === undefined) throw new Error('Expected at least one default regex rule')
    controller.saveRule({ ...changedRule, pattern: '(plain)' })

    await controller.inspect('session-1', 'plain text')

    expect(report).not.toHaveBeenCalled()
  })
})
