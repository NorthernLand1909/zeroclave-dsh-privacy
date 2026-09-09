import { describe, expect, it } from 'vitest'
import { scanRegex, mergeModelCandidates, ZeroClaveDetector } from '../src/detector.ts'
import { EmbeddedModelDetector, tokenEntitiesToCandidates } from '../src/embedded-model.ts'

describe('privacy regex detector', () => {
  it('finds an email, keeps KYC as policy context, and replaces only the email span', () => {
    const text = 'KYC测试资料：邮箱 demo@example.com。请检测并脱敏。'
    const result = scanRegex(text)
    expect(result.overallRisk).toBe('high')
    expect(result.findings).toEqual([expect.objectContaining({
      entityType: 'EMAIL',
      ruleId: 'builtin-9',
      ruleName: 'Email address',
      start: 11,
      end: 27,
      maskedEvidence: 'd***@example.com',
      replacement: '__PII_EMAIL_00000001__',
    })])
    expect(result.policySignals).toEqual([{ policyId: 'CUSTOMER_KYC', severity: 'high' }])
    expect(result.redactedText).toBe('KYC测试资料：邮箱 __PII_EMAIL_00000001__。请检测并脱敏。')
  })

  it('treats configured secrets and private keys as critical', () => {
    const token = 'abcdefghijklmnopqrstuvwx'
    const key = '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----'
    const result = scanRegex(`api_key=${token}\n${key}`)
    expect(result.overallRisk).toBe('critical')
    expect(result.recommendedAction).toBe('block')
    expect(result.findings.map(finding => finding.entityType)).toEqual(['API_KEY', 'PRIVATE_KEY'])
    expect(result.redactedText).toBe('api_key=__PII_API_KEY_00000001__\n__PII_PRIVATE_KEY_00000002__')
  })

  it('uses one stable placeholder for a repeated value in the same scan', () => {
    const result = scanRegex('demo@example.com and demo@example.com')
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0]?.replacement).toBe('__PII_EMAIL_00000001__')
    expect(result.findings[1]?.replacement).toBe('__PII_EMAIL_00000001__')
    expect(result.redactedText).toBe('__PII_EMAIL_00000001__ and __PII_EMAIL_00000001__')
  })

  it('accepts Luhn-valid cards and rejects a same-length numeric lookalike', () => {
    expect(scanRegex('card 4111 1111 1111 1111').findings).toEqual([
      expect.objectContaining({ entityType: 'CREDIT_CARD' }),
    ])
    expect(scanRegex('value 1234 5678 9012 3456').findings).toEqual([])
  })
})

describe('embedded model adapter', () => {
  it('redacts the full union of overlapping entity spans', () => {
    const result = mergeModelCandidates('John Smith', [
      { category: 'DIRECT_PII', entityType: 'PERSON', start: 0, end: 7, maskedEvidence: 'J***', confidence: 0.99, severity: 'high', detector: 'embedded' },
      { category: 'DIRECT_PII', entityType: 'PERSON', start: 5, end: 10, maskedEvidence: 'S***', confidence: 0.99, severity: 'high', detector: 'embedded' },
    ], 'test-model')
    expect(result.redactedText).toBe('__PII_PERSON_00000001__')
    expect(result.findings).toHaveLength(1)
  })

  it('preserves existing placeholders instead of detecting them as contract fields', () => {
    const text = '合同编号：__PII_CONTRACT_ID_00000001__\n甲方（买方）：__PII_ORGANIZATION_00000002__'
    expect(scanRegex(text).redactedText).toBe(text)
    const token = `ZCPII-CONTRACT_ID-${'a'.repeat(32)}`
    expect(scanRegex(`合同编号：${token}`).redactedText).toBe(`合同编号：${token}`)
  })
  it('reconstructs and groups WordPiece entities when Transformers.js omits offsets', () => {
    const text = 'Contact John Smith at john@example.com'
    const candidates = tokenEntitiesToCandidates(text, [
      { entity: 'O', score: 0.99, word: 'contact' },
      { entity: 'B-PERSON', score: 0.96, word: 'john' },
      { entity: 'I-PERSON', score: 0.94, word: 'smith' },
      { entity: 'O', score: 0.99, word: 'at' },
      { entity: 'B-EMAIL_ADDRESS', score: 0.99, word: 'john' },
      { entity: 'I-EMAIL_ADDRESS', score: 0.99, word: '@' },
      { entity: 'I-EMAIL_ADDRESS', score: 0.99, word: 'example' },
      { entity: 'I-EMAIL_ADDRESS', score: 0.99, word: '.' },
      { entity: 'I-EMAIL_ADDRESS', score: 0.99, word: 'com' },
    ])
    expect(candidates).toEqual([
      expect.objectContaining({ entityType: 'PERSON', start: 8, end: 18, confidence: 0.95 }),
      expect.objectContaining({ entityType: 'EMAIL', start: 22, end: 38, confidence: 0.99 }),
    ])
  })

  it('maps aggregated high-impact US identifiers using explicit offsets', () => {
    const candidates = tokenEntitiesToCandidates('SSN 123-45-6789', [{
      entity_group: 'US_SSN',
      score: 0.98,
      start: 4,
      end: 15,
      word: '123-45-6789',
    }])
    expect(candidates).toEqual([
      expect.objectContaining({ entityType: 'US_SSN', severity: 'critical', start: 4, end: 15 }),
    ])
  })

  it('reports regex fallback until the embedded model is loaded', async () => {
    const detector = new EmbeddedModelDetector()
    const result = await detector.scan('demo@example.com')
    expect(detector.available()).toBe(false)
    expect(result.detector).toEqual({ requested: 'embedded', used: 'regex', fallback: true })
  })
})

describe('ZeroClave provider placeholder', () => {
  it('stays explicitly unavailable and falls back to regex', async () => {
    const detector = new ZeroClaveDetector()
    expect(detector.available()).toBe(false)
    expect((await detector.scan('demo@example.com')).detector).toEqual({
      requested: 'zeroclave',
      used: 'regex',
      fallback: true,
    })
  })
})
