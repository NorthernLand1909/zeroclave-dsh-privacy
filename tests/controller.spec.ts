// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { scanRegex } from '../src/detector.ts'

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
