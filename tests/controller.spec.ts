// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { DEFAULT_REGEX_RULES } from '../src/detector.ts'
import type { TelemetryReporter } from '../src/telemetry.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

afterEach(() => { window.localStorage.clear() })

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

describe('controller telemetry boundaries', () => {
  it('restores the finding action and current redaction after undoing unprotect', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    await controller.inspect('session-1', 'demo@example.com')
    const finding = controller.getSnapshot().liveBySession.get('session-1')?.result.findings[0]
    if (finding === undefined) throw new Error('email finding missing')

    controller.setLiveFindingProtection('session-1', finding.id, false, 'demo@example.com')
    expect(controller.getSnapshot().liveBySession.get('session-1')?.result.findings[0]?.action).toBe('kept')
    expect(controller.getSnapshot().liveBySession.get('session-1')?.result.redactedText).toBe('demo@example.com')

    controller.setLiveFindingProtection('session-1', finding.id, true, finding.replacement)
    expect(controller.getSnapshot().liveBySession.get('session-1')?.result.findings[0]?.action).toBe('redacted')
    expect(controller.getSnapshot().liveBySession.get('session-1')?.result.redactedText).toBe(finding.replacement)
  })

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
