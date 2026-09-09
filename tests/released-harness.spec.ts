// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as cordis from '@deepseek-ai/cordis'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { installSendRedaction } from '../src/send.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

const installed = readdirSync(resolve('node_modules/.pnpm'))
  .find(name => name.startsWith('@deepseek-ai+dsh-client-ui-conversation@0.1.1-rc.2_'))

describe('released Harness 0.1.1-rc.2', () => {
  it.skipIf(installed === undefined)('redacts through the shipped composer service under Cordis tracking', async () => {
    const path = resolve('node_modules/.pnpm', installed ?? '', 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
    let factory: ((require: (name: string) => unknown) => Record<string, unknown>) | undefined
    const loaderWindow = window as Window & { __ModuleLoader__?: { load(value: { factory: typeof factory }): void } }
    const previous = loaderWindow.__ModuleLoader__
    loaderWindow.__ModuleLoader__ = { load: (value) => { factory = value.factory } }
    try {
      // The released browser artifact supplies the service; unrelated UI domains are not mounted.
      // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
      new Function(readFileSync(path, 'utf8'))()
    } finally {
      if (previous === undefined) delete loaderWindow.__ModuleLoader__
      else loaderWindow.__ModuleLoader__ = previous
    }
    if (factory === undefined) throw new Error('released module handoff missing')
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/cordis', cordis], ['@deepseek-ai/dsh-client-ui-slots', slots],
      ['react', react], ['react/jsx-runtime', jsx],
      ['@deepseek-ai/dsh-client-runtime/client', {}], ['@deepseek-ai/dsh-client-ui-primitives', {}],
    ])
    const plugin = factory((name) => {
      if (!modules.has(name)) throw new Error(`unexpected dependency ${name}`)
      return modules.get(name)
    })
    const Released = plugin.ConversationController as cordis.Plugin
    const ctx = new cordis.Context()
    const service = ctx.plugin(Released, { input: {}, blocks: {} })
    await service.await()
    const controller = new PrivacyController(new PrivacyVault(memoryStore()))
    controller.setEnabled(true)
    const conversation = ctx.get('conversation') as {
      sendSession(session: object, text: string, images: unknown[], mode: string): Promise<{ kind: string }>
    }
    const dispose = installSendRedaction(conversation, controller)
    const prompt = vi.fn(async (_content: unknown) => ({ ok: true }))
    try {
      const outcome = await conversation.sendSession({ sessionId: 's1', prompt }, 'demo@example.com', [], 'queue')
      expect(outcome).toEqual({ kind: 'success' })
      const content = prompt.mock.calls[0]?.[0] as Array<{ text: string }>
      expect(content[0]?.text).toMatch(/^ZCPII-EMAIL-/u)
      expect(controller.vault.restore('s1', content[0]?.text ?? '')).toBe('demo@example.com')
    } finally {
      dispose()
      await controller.dispose()
      await service.dispose()
      window.localStorage.clear()
    }
  })
})
