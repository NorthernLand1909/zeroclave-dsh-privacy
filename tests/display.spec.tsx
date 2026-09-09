// @vitest-environment jsdom
import { createElement, act } from 'react'
import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import { scanRegex } from '../src/detector.ts'
import { PrivacyVault } from '../src/vault.ts'
import { installDisplayRestoration, restoreDisplayValue } from '../src/client/display.tsx'
import { memoryStore } from './memory-store.ts'

describe('original message presentation', () => {
  it('restores user text and assistant copy actions without mutating the model-facing node', async () => {
    const store = memoryStore()
    const sendingVault = new PrivacyVault(store)
    const result = await sendingVault.redact('s1', 'demo@example.com', scanRegex('demo@example.com'))
    const vault = new PrivacyVault(store)
    const copy = vi.fn()
    const Original = (props: { node: { data: { closing: { blocks: Array<{ text: string }> } } } }) => {
      const text = props.node.data.closing.blocks[0]?.text ?? ''
      return createElement('button', { onClick: () => { copy(text) } }, text)
    }
    const entry: StoredEntry = { component: Original, options: { key: 'turn-tail' } }
    const ctx = { slots: { entries: () => [entry] }, on: () => () => undefined } as unknown as Context
    const dispose = installDisplayRestoration(ctx, vault)
    const rootElement = document.createElement('div')
    const root = createRoot(rootElement)
    const finalNode = { messageId: 'message-1', blocks: [{ kind: 'text', text: result.redactedText }] }
    const node = {
      data: {
        closing: {
          blocks: [{ kind: 'text', text: `Reply: ${result.redactedText}` }],
          finalNode,
        },
      },
    }
    try {
      await act(async () => {
        root.render(createElement(entry.component as ComponentType<object>, { sessionId: 's1', node }))
      })
      expect(rootElement.textContent).toBe('Reply: demo@example.com')
      rootElement.querySelector('button')?.click()
      expect(copy).toHaveBeenCalledWith('Reply: demo@example.com')
      expect(node.data.closing.blocks[0]?.text).toBe(`Reply: ${result.redactedText}`)
      expect(node.data.closing.finalNode).toBe(finalNode)
      await act(async () => {
        root.render(createElement(entry.component as ComponentType<object>, { sessionId: 's2', node }))
      })
      expect(rootElement.textContent).toBe(`Reply: ${result.redactedText}`)
    } finally {
      act(() => { root.unmount() })
      dispose()
      expect(entry.component).toBe(Original)
      await vault.dispose()
    }
  })

  it('restores streamed text only when its token completes and leaves unknown tokens untouched', async () => {
    const vault = new PrivacyVault(memoryStore())
    const result = await vault.redact('s1', 'demo@example.com', scanRegex('demo@example.com'))
    expect(vault.restore('s1', `Reply: ${result.redactedText.slice(0, -5)}`)).toBe('Reply: ')
    expect(vault.restore('s1', `Reply: ${result.redactedText}`)).toBe('Reply: demo@example.com')
    const unknown = `ZCPII-EMAIL-${'a'.repeat(32)}`
    expect(vault.restore('s1', unknown)).toBe(unknown)
  })

  it('retains object identity for unchanged content and never rewrites map keys or callbacks', () => {
    const original = { content: [{ kind: 'text', text: 'ordinary text' }], date: new Date(), callback: () => undefined }
    expect(restoreDisplayValue('assistant-step', original, text => text)).toBe(original)
    const changed = restoreDisplayValue(
      'assistant-step',
      original,
      text => text === 'ordinary text' ? 'changed' : text,
    ) as typeof original
    expect(changed.content).toBe(original.content)
    expect(changed.date).toBe(original.date)
    expect(changed.callback).toBe(original.callback)
  })

  it('restores only visible Markdown prose and preserves destinations, references and code', () => {
    const token = `ZCPII-EMAIL-${'a'.repeat(32)}`
    const original = 'demo@example.com'
    const markdown = [
      `Visible ${token}`,
      `[label ${token}](https://example.test/${token} "${token}")`,
      `![alt ${token}](https://images.test/${token})`,
      'Inline `' + token + '` and ``' + token + '`` then ' + token,
      '```text',
      token,
      '```',
      `    ${token}`,
      `[shown ${token}][${token}]`,
      `[${token}]: https://references.test/${token}`,
      `Bare https://example.test/${token} and mailto:${token}`,
      `<a href="https://example.test/${token}">${token}</a>`,
    ].join('\n')
    const data = { blocks: [{ kind: 'text', text: markdown }] }
    const restored = restoreDisplayValue(
      'assistant-step',
      data,
      text => text.replaceAll(token, original),
    ) as typeof data

    expect(restored.blocks[0]?.text).toBe([
      `Visible ${original}`,
      `[label ${original}](https://example.test/${token} "${token}")`,
      `![alt ${original}](https://images.test/${token})`,
      'Inline `' + token + '` and ``' + token + '`` then ' + original,
      '```text',
      token,
      '```',
      `    ${token}`,
      `[shown ${original}][${token}]`,
      `[${token}]: https://references.test/${token}`,
      `Bare https://example.test/${token} and mailto:${token}`,
      `<a href="https://example.test/${token}">${original}</a>`,
    ].join('\n'))
  })

  it('restores known text blocks without traversing attachments, tools, paths or metadata', () => {
    const token = `ZCPII-EMAIL-${'b'.repeat(32)}`
    const restore = (text: string): string => text.replaceAll(token, 'demo@example.com')
    const attachment = { name: token, url: `https://example.test/${token}`, path: `/tmp/${token}` }
    const source = { id: token, path: `/workspace/${token}`, attachment }
    const user = {
      content: [
        { type: 'text', text: `Contact ${token}` },
        { type: 'image', attachment },
        { type: 'tool-call', id: token, name: token, arguments: token },
      ],
      source,
    }
    const restoredUser = restoreDisplayValue('user', user, restore) as typeof user
    expect(restoredUser.content[0]?.text).toBe('Contact demo@example.com')
    expect(restoredUser.content[1]).toBe(user.content[1])
    expect(restoredUser.content[2]).toBe(user.content[2])
    expect(restoredUser.source).toBe(source)

    const finalNode = { messageId: token, blocks: [{ kind: 'text', text: token }], usage: { id: token } }
    const assistant = {
      blocks: [
        { kind: 'text', text: `Answer ${token}` },
        { kind: 'reasoning', text: `Reason ${token}` },
        { kind: 'image', attachment },
        { kind: 'tool-call', callId: token, name: token, argsRaw: token },
        { kind: 'other', block: { path: token } },
      ],
      finalNode,
      provenance: { provider: token, model: token },
      requestConfig: { stop: [token] },
    }
    const restoredAssistant = restoreDisplayValue('assistant-step', assistant, restore) as typeof assistant
    expect(restoredAssistant.blocks[0]?.text).toBe('Answer demo@example.com')
    expect(restoredAssistant.blocks[1]?.text).toBe('Reason demo@example.com')
    expect(restoredAssistant.blocks[2]).toBe(assistant.blocks[2])
    expect(restoredAssistant.blocks[3]).toBe(assistant.blocks[3])
    expect(restoredAssistant.blocks[4]).toBe(assistant.blocks[4])
    expect(restoredAssistant.finalNode).toBe(finalNode)
    expect(restoredAssistant.provenance).toBe(assistant.provenance)
    expect(restoredAssistant.requestConfig).toBe(assistant.requestConfig)

    const tail = { closing: assistant, id: token }
    const restoredTail = restoreDisplayValue('turn-tail', tail, restore) as typeof tail
    expect(restoredTail.closing.blocks[0]?.text).toBe('Answer demo@example.com')
    expect(restoredTail.closing.finalNode).toBe(finalNode)
    expect(restoredTail.id).toBe(token)

    const context = restoreDisplayValue('context', user, restore) as typeof user
    expect(context.content[0]?.text).toBe('Contact demo@example.com')
    expect(context.source).toBe(source)
    expect(restoreDisplayValue('tool-call', assistant, restore)).toBe(assistant)
  })

  it('restores a compaction summary as safe Markdown without touching its identifiers', () => {
    const token = `ZCPII-EMAIL-${'c'.repeat(32)}`
    const data = { summary: `Contact ${token}; [open](https://example.test/${token})`, id: token }
    const restored = restoreDisplayValue(
      'compaction',
      data,
      text => text.replaceAll(token, 'demo@example.com'),
    ) as typeof data
    expect(restored.summary).toBe(`Contact demo@example.com; [open](https://example.test/${token})`)
    expect(restored.id).toBe(token)
  })
})
