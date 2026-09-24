// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { DEFAULT_REGEX_RULES } from '../src/detector.ts'
import {
  executeRegexBatch, loadRegexRules, RegexRuleError, saveRegexRules, scanConfiguredRules, validateRule,
} from '../src/regex-rules.ts'
import type { EditableRegexRule, RegexMatch } from '../src/types.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

const customRule: EditableRegexRule = {
  id: 'custom-employee',
  name: 'Employee ID',
  pattern: '员工编号[：:]\\s*(EMP-\\d{4})',
  flags: 'u',
  capture: 1,
  entityType: 'OTHER',
  category: 'BUSINESS',
  severity: 'high',
  enabled: true,
}

afterEach(() => { localStorage.clear() })

describe('editable regex rules', () => {
  it('validates patterns and capture groups without executing a user sample', () => {
    expect(() => { validateRule(customRule) }).not.toThrow()
    expect(() => { validateRule({ ...customRule, pattern: '(' }) }).toThrow(RegexRuleError)
    expect(() => { validateRule({ ...customRule, capture: 2 }) }).toThrow(RegexRuleError)
    expect(() => { validateRule({ ...customRule, flags: 'gg' }) }).toThrow(RegexRuleError)
  })

  it('matches the selected capture group and creates a configured finding', async () => {
    const text = '申请人：测试用户，员工编号：EMP-2048。'
    const matches = executeRegexBatch(text, [customRule])
    expect(text.slice(matches[0]?.start, matches[0]?.end)).toBe('EMP-2048')
    const candidates = await scanConfiguredRules(text, [customRule], async () => matches)
    expect(candidates).toEqual([expect.objectContaining({
      entityType: 'OTHER', category: 'BUSINESS', severity: 'high',
      ruleId: customRule.id, ruleName: customRule.name,
    })])
  })

  it('persists edits locally and falls back to defaults for malformed storage', () => {
    saveRegexRules([customRule])
    expect(loadRegexRules()).toEqual({ rules: [customRule] })
    localStorage.setItem('zeroclave.privacy.regex-rules.v1', '{broken')
    expect(loadRegexRules()).toEqual({ rules: DEFAULT_REGEX_RULES, error: 'storage' })
  })

  it('applies saved custom rules to preview and the outbound redacted copy', async () => {
    const execute = vi.fn(async (text: string): Promise<RegexMatch[]> => executeRegexBatch(text, [customRule]))
    const controller = new PrivacyController(new PrivacyVault(memoryStore()), execute)
    controller.setEnabled(true)
    controller.setSendPolicy('auto-redact')
    controller.saveRule(customRule)
    const text = '员工编号：EMP-2048'
    await controller.inspect('s1', text)
    expect(controller.getSnapshot().liveBySession.get('s1')?.result.findings[0]?.entityType).toBe('OTHER')
    const outgoing = await controller.prepareSend('s1', text)
    expect(outgoing.redactedText).toMatch(/员工编号：ZCPII-OTHER-/u)
    expect(controller.vault.restore('s1', outgoing.redactedText)).toBe(text)
  })

  it('disables and deletes custom rules while restoring built-in rules', () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()), async () => [])
    controller.saveRule(customRule)
    controller.saveRule({ ...customRule, enabled: false })
    expect(controller.getSnapshot().regexRules.find(rule => rule.id === customRule.id)?.enabled).toBe(false)
    controller.deleteRule(customRule.id)
    expect(controller.getSnapshot().regexRules.some(rule => rule.id === customRule.id)).toBe(false)
    const edited = { ...DEFAULT_REGEX_RULES[0]!, pattern: '(never-match)' }
    controller.saveRule(edited)
    controller.resetRule(edited.id)
    expect(controller.getSnapshot().regexRules[0]).toEqual(DEFAULT_REGEX_RULES[0])
  })

  it('rejects sending when custom rule execution fails', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()), async () => {
      throw new RegexRuleError('timeout')
    })
    controller.setEnabled(true)
    controller.saveRule(customRule)
    await expect(controller.prepareSend('s1', '员工编号：EMP-2048')).rejects.toMatchObject({ code: 'timeout' })
    expect(controller.getSnapshot().regexError).toBe('timeout')
  })
})
