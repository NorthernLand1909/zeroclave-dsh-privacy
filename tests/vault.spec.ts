import { describe, expect, it } from 'vitest'
import { scanRegex } from '../src/detector.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

describe('local reversible redaction', () => {
  it('keeps the original contract intact while creating a reversible outbound copy', async () => {
    const text = '采购框架协议\n合同编号：TEST-2026-001\n甲方（买方）：示例采购有限公司\n通讯地址：深圳市示例路100号\n邮箱：demo@example.com'
    const vault = new PrivacyVault(memoryStore())
    const result = await vault.redact('s1', text, scanRegex(text))
    expect(result.redactedText).not.toContain('TEST-2026-001')
    expect(result.redactedText).not.toContain('示例采购有限公司')
    expect(vault.restore('s1', result.redactedText)).toBe(text)
    expect(scanRegex(result.redactedText).redactedText).toBe(result.redactedText)
  })

  it('reuses one value across turns but never assigns it to another value or session', async () => {
    const vault = new PrivacyVault(memoryStore())
    const first = await vault.redact('s1', 'first@example.com', scanRegex('first@example.com'))
    const second = await vault.redact('s1', 'second@example.com', scanRegex('second@example.com'))
    const again = await vault.redact('s1', 'first@example.com', scanRegex('first@example.com'))
    expect(second.redactedText).not.toBe(first.redactedText)
    expect(again.redactedText).toBe(first.redactedText)
    expect(vault.restore('s1', `${first.redactedText} / ${second.redactedText}`)).toBe('first@example.com / second@example.com')
    expect(vault.restore('s2', first.redactedText)).toBe(first.redactedText)
  })

  it('restores after a page reload from browser storage', async () => {
    const store = memoryStore()
    const vault = new PrivacyVault(store)
    const result = await vault.redact('s1', 'demo@example.com', scanRegex('demo@example.com'))
    await vault.dispose()
    const reloaded = new PrivacyVault(store)
    await reloaded.load('s1')
    expect(reloaded.restore('s1', `Reply: ${result.redactedText}`)).toBe('Reply: demo@example.com')
  })

  it('does not produce sendable tokens when mapping persistence fails', async () => {
    const vault = new PrivacyVault({ ...memoryStore(), write: async () => { throw new Error('storage unavailable') } })
    await expect(vault.redact('s1', 'demo@example.com', scanRegex('demo@example.com'))).rejects.toThrow('storage unavailable')
  })

  it('keeps mappings consistent across concurrent sends', async () => {
    const vault = new PrivacyVault(memoryStore())
    const results = await Promise.all([1, 2].map(() => vault.redact('s1', 'demo@example.com', scanRegex('demo@example.com'))))
    expect(results[0]?.redactedText).toBe(results[1]?.redactedText)
  })
})
