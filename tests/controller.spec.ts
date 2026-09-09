// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { scanRegex } from '../src/detector.ts'
import type { ScanResult } from '../src/types.ts'

afterEach(() => { window.localStorage.clear() })

describe('privacy audit history', () => {
  it('keeps the latest detector result for one stable draft without duplicating it', () => {
    const controller = new PrivacyController()
    controller.setEnabled(true)
    const text = 'Contact John at demo@example.com'
    const regex = scanRegex(text)
    controller.capture('session-1', text, regex)
    const first = controller.getSnapshot().auditsBySession.get('session-1')?.[0]

    const embedded: ScanResult = {
      ...regex,
      findings: regex.findings.map(finding => ({ ...finding, detector: 'embedded' })),
      detector: { requested: 'embedded', used: 'embedded', fallback: false, model: 'test-model' },
    }
    controller.capture('session-1', text, embedded)
    const records = controller.getSnapshot().auditsBySession.get('session-1')

    expect(records).toHaveLength(1)
    expect(records?.[0]?.id).toBe(first?.id)
    expect(records?.[0]?.result.detector.used).toBe('embedded')
    expect(records?.[0]?.result.findings[0]?.detector).toBe('embedded')
  })

  it('records a redaction action separately and clears only that session history', () => {
    const controller = new PrivacyController()
    controller.setEnabled(true)
    const result = scanRegex('demo@example.com')
    controller.capture('session-1', 'demo@example.com', result)
    controller.capture('session-2', 'other@example.com', scanRegex('other@example.com'))
    controller.record('session-1', 'demo@example.com', result, 'sent')

    expect(controller.getSnapshot().auditsBySession.get('session-1')?.map(record => record.action))
      .toEqual(['detected', 'sent'])
    expect(controller.getSnapshot().activeTab).toBe('audit')

    controller.clearAudits('session-1')
    expect(controller.getSnapshot().auditsBySession.has('session-1')).toBe(false)
    expect(controller.getSnapshot().auditsBySession.get('session-2')).toHaveLength(1)
  })

  it('does not retain safe drafts or detections made while scanning is disabled', () => {
    const controller = new PrivacyController()
    controller.capture('session-1', 'demo@example.com', scanRegex('demo@example.com'))
    controller.setEnabled(true)
    controller.capture('session-1', 'ordinary text', scanRegex('ordinary text'))
    expect(controller.getSnapshot().auditsBySession.has('session-1')).toBe(false)
  })
})
