// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { ComposerBlockRegistry } from '../../../client/ui-conversation/src/client/input/blocks.ts'
import { InputHub } from '../../../client/ui-conversation/src/client/input/hub.ts'
import { ConversationController } from '../../../client/ui-conversation/src/client/service.ts'
import { zh } from '../../../client/ui-conversation/src/client/locales.ts'
import { PrivacyController } from '../src/controller.ts'
import { installSendRedaction } from '../src/send.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

afterEach(() => { window.localStorage.clear() })

describe('Harness conversation integration', () => {
  it('intercepts the real scoped composer service and preserves its local submission echo', async () => {
    const runtime = await SlotTestRuntime.create()
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    controller.setSendPolicy('auto-redact')
    const prompt = vi.fn(async (_content: unknown) => ({ ok: true as const, value: { accepted: true as const } }))
    await runtime.sessions.add({ id: 's1', session: { prompt } })
    const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
    const serviceFiber = runtime.ctx.plugin(ConversationController, {
      input: hub, blocks: new ComposerBlockRegistry(), maxConcurrentFileUploads: 2,
    })
    await serviceFiber.await()
    const raw = runtime.ctx.get('conversation') as ConversationController
    const binding = runtime.sessions.binding('s1')
    const scope = runtime.sessions.scope('s1')
    if (binding === undefined || scope === undefined) throw new Error('session fixture missing')
    const scoped = scope.get('conversation') as ConversationController
    const privacyFiber = runtime.ctx.plugin({
      inject: ['conversation'],
      apply: ctx => ctx.effect(() => installSendRedaction(ctx.conversation, controller), 'test privacy admission'),
    })
    await privacyFiber.await()
    const echo = vi.spyOn(binding.session, 'beginSubmission')
    try {
      await expect(scoped.sendSession(binding.session, 'demo@example.com', [], 'queue')).resolves.toEqual({ kind: 'success' })
      expect(echo.mock.calls[0]?.[0].text).toBe('demo@example.com')
      const content = prompt.mock.calls[0]?.[0] as Array<{ type: string; text: string }>
      expect(content[0]?.type).toBe('text')
      expect(content[0]?.text).toMatch(/^ZCPII-EMAIL-/u)
      await privacyFiber.dispose()
      prompt.mockClear()
      await raw.sendSession(binding.session, 'demo@example.com', [], 'queue')
      expect(prompt.mock.calls[0]?.[0]).toEqual([{ type: 'text', text: 'demo@example.com' }])
    } finally {
      await runtime.dispose()
      await controller.dispose()
    }
  })
})
