// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { installSendRedaction } from '../src/send.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

afterEach(() => { window.localStorage.clear() })

class Composer {
  echo = ''
  async sendSession(
    session: { prompt: (...args: unknown[]) => Promise<{ ok: boolean }> },
    text: string, attachments: unknown[], mode: string, signal?: AbortSignal,
  ) {
    this.echo = text
    return session.prompt([...attachments, { type: 'text', text }], mode, signal, 'request-1')
  }
}

describe('composer send boundary', () => {
  it('sends redacted text and keeps the composer echo, attachment and admission metadata intact', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    const composer = new Composer()
    installSendRedaction(composer, controller)
    const prompt = vi.fn(async () => ({ ok: true }))
    const session = { sessionId: 's1', prompt }
    const signal = new AbortController().signal
    const image = { type: 'image', data: 'example' }
    await composer.sendSession(session, 'demo@example.com', [image], 'steer', signal)
    const call = prompt.mock.calls[0] as unknown as [Array<{ text?: string }>, string, AbortSignal, string]
    expect(composer.echo).toBe('demo@example.com')
    expect(call[0][0]).toBe(image)
    expect(call[0][1]?.text).toMatch(/^ZCPII-EMAIL-/u)
    expect(controller.vault.restore('s1', call[0][1]!.text!)).toBe('demo@example.com')
    expect(call.slice(1)).toEqual(['steer', signal, 'request-1'])
    expect(controller.getSnapshot().auditsBySession.get('s1')?.[0]?.action).toBe('sent')
    expect(controller.getSnapshot().open).toBe(false)
  })

  it('does not send anything when persistence fails and leaves the original available for retry', async () => {
    const vault = new PrivacyVault({ ...memoryStore(), write: async () => { throw new Error('quota') } })
    const controller = new PrivacyController(vault)
    controller.setEnabled(true)
    const composer = new Composer()
    installSendRedaction(composer, controller)
    const prompt = vi.fn(async () => ({ ok: true }))
    await expect(composer.sendSession({ sessionId: 's1', prompt } as Parameters<Composer['sendSession']>[0], 'demo@example.com', [], 'queue')).rejects.toThrow('quota')
    expect(prompt).not.toHaveBeenCalled()
    expect(composer.echo).toBe('demo@example.com')
    expect(controller.getSnapshot().auditsBySession.size).toBe(0)
  })

  it('pauses a critical send for one review and applies per-finding choices', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    const composer = new Composer()
    installSendRedaction(composer, controller)
    const prompt = vi.fn(async () => ({ ok: true }))
    const secret = 'abcdefghijklmnopqrstuvwx'
    const text = `api_key=${secret}\nemail=demo@example.com`
    const sending = composer.sendSession({ sessionId: 's1', prompt }, text, [], 'queue')
    await vi.waitFor(() => { expect(controller.getSnapshot().pendingSendReview).toBeDefined() })
    expect(prompt).not.toHaveBeenCalled()
    const review = controller.getSnapshot().pendingSendReview!
    const secretFinding = review.parts[0]?.result.findings.find(finding => finding.entityType === 'API_KEY')
    if (secretFinding === undefined) throw new Error('critical finding missing')
    controller.setSendReviewFinding(`0:${secretFinding.id}`, false)
    controller.confirmSendReview()
    await sending
    const outgoing = (prompt.mock.calls[0]?.[0] as Array<{ text: string }>)[0]?.text ?? ''
    expect(outgoing).toContain(secret)
    expect(outgoing).not.toContain('demo@example.com')
    expect(controller.getSnapshot().pendingSendReview).toBeUndefined()
    const audit = controller.getSnapshot().auditsBySession.get('s1')?.[0]
    expect(audit?.result.findings.find(finding => finding.entityType === 'API_KEY')?.action).toBe('kept')
  })

  it('cancels a critical review without sending or writing mappings', async () => {
    const write = vi.fn(async () => undefined)
    const controller = new PrivacyController(new PrivacyVault({ ...memoryStore(), write }))
    controller.setEnabled(true)
    const composer = new Composer()
    installSendRedaction(composer, controller)
    const prompt = vi.fn(async () => ({ ok: true }))
    const sending = composer.sendSession(
      { sessionId: 's1', prompt }, 'api_key=abcdefghijklmnopqrstuvwx', [], 'queue',
    )
    await vi.waitFor(() => { expect(controller.getSnapshot().pendingSendReview).toBeDefined() })
    controller.cancelSendReview()
    await expect(sending).resolves.toEqual({ ok: false })
    expect(prompt).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(controller.getSnapshot().auditsBySession.size).toBe(0)
  })

  it('supports automatic critical redaction when the user selects that policy', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    controller.setSendPolicy('auto-redact')
    const composer = new Composer()
    installSendRedaction(composer, controller)
    const prompt = vi.fn(async () => ({ ok: true }))
    await composer.sendSession({ sessionId: 's1', prompt }, 'api_key=abcdefghijklmnopqrstuvwx', [], 'queue')
    expect(controller.getSnapshot().pendingSendReview).toBeUndefined()
    expect((prompt.mock.calls[0]?.[0] as Array<{ text: string }>)[0]?.text).toMatch(/^api_key=ZCPII-API_KEY-/u)
  })

  it('reviews all text parts once and keeps finding identities separate', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    const conversation = {
      async sendSession(session: { prompt: (parts: unknown[]) => Promise<{ ok: boolean }> }): Promise<{ ok: boolean }> {
        return session.prompt([
          { type: 'text', text: 'api_key=abcdefghijklmnopqrstuvwx' },
          { type: 'text', text: 'password=example-password-123' },
        ])
      },
    }
    installSendRedaction(conversation, controller)
    const prompt = vi.fn(async () => ({ ok: true }))
    const sending = conversation.sendSession({ sessionId: 's1', prompt } as never)
    await vi.waitFor(() => { expect(controller.getSnapshot().pendingSendReview?.parts).toHaveLength(2) })
    expect(prompt).not.toHaveBeenCalled()
    const keys = Object.keys(controller.getSnapshot().pendingSendReview?.redactByFinding ?? {})
    expect(keys.some(key => key.startsWith('0:'))).toBe(true)
    expect(keys.some(key => key.startsWith('1:'))).toBe(true)
    controller.confirmSendReview()
    await sending
    expect(prompt).toHaveBeenCalledOnce()
    const parts = prompt.mock.calls[0]?.[0] as Array<{ text: string }>
    expect(parts[0]?.text).toMatch(/^api_key=ZCPII-API_KEY-/u)
    expect(parts[1]?.text).toMatch(/^password=ZCPII-PASSWORD-/u)
  })

  it('honors cancellation before sending and does not record a rejected admission as sent', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    const composer = new Composer()
    installSendRedaction(composer, controller)
    const session = { sessionId: 's1', prompt: vi.fn(async () => ({ ok: false })) }
    await composer.sendSession(session, 'demo@example.com', [], 'queue')
    expect(controller.getSnapshot().auditsBySession.size).toBe(0)
    session.prompt.mockClear()
    await expect(composer.sendSession(session, 'demo@example.com', [], 'queue', AbortSignal.abort())).rejects.toThrow()
    expect(session.prompt).not.toHaveBeenCalled()
  })

  it('preserves the original path while disabled and restores the method on plugin unload', async () => {
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    const composer = new Composer()
    const original: unknown = Object.getOwnPropertyDescriptor(Composer.prototype, 'sendSession')?.value
    const dispose = installSendRedaction(composer, controller)
    const session = { sessionId: 's1', prompt: vi.fn(async () => ({ ok: true })) }
    await composer.sendSession(session, 'demo@example.com', [], 'queue')
    expect(session.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'demo@example.com' }], 'queue', undefined, 'request-1')
    dispose()
    expect(Reflect.get(composer, 'sendSession')).toBe(original)
  })
})
