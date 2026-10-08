// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PLUGIN_ID = '@zeroclave/dsh-privacy'

interface Handoff {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

type LoaderWindow = Window & { __ModuleLoader__?: { load(handoff: Handoff): void } }

afterEach(() => {
  delete (window as LoaderWindow).__ModuleLoader__
  for (const element of document.querySelectorAll('style')) element.remove()
})

describe('built DSH client bundle', () => {
  it('loads through the DSH module handoff without a Node runtime dependency', async () => {
    const code = readFileSync(resolve('packages/experimental/zeroclave-privacy/lib/client.js'), 'utf8')
    expect(code).toContain('data:image/png;base64,')
    let handoff: Handoff | undefined
    ;(window as LoaderWindow).__ModuleLoader__ = { load: (value) => { handoff = value } }
    // The fixture deliberately evaluates the emitted script in a browser-like global scope.
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
    new Function(code)()
    expect(handoff?.id).toBe(PLUGIN_ID)

    const modules = new Map<string, unknown>([
      ['react', await import('react')],
      ['react/jsx-runtime', await import('react/jsx-runtime')],
    ])
    const plugin = handoff!.factory((specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected browser require: ${specifier}`)
      return modules.get(specifier)
    })

    expect(plugin.inject).toEqual(['slots', 'locale', 'conversation'])
    expect(plugin.apply).toBeTypeOf('function')
    expect(document.querySelector(`style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`)).not.toBeNull()
  })

  it('registers all four UI surfaces through the supplied DSH services', async () => {
    const code = readFileSync(resolve('packages/experimental/zeroclave-privacy/lib/client.js'), 'utf8')
    let handoff: Handoff | undefined
    ;(window as LoaderWindow).__ModuleLoader__ = { load: (value) => { handoff = value } }
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
    new Function(code)()
    const react = await import('react')
    const jsxRuntime = await import('react/jsx-runtime')
    const plugin = handoff!.factory((specifier) => {
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected browser require: ${specifier}`)
    })

    const registered: string[] = []
    const register = vi.fn((options: { name: string }) => {
      registered.push(options.name)
      return () => undefined
    })
    const context = {
      effect: (setup: () => unknown) => setup(),
      on: () => () => undefined,
      conversation: { sendSession: async () => ({ kind: 'success' }) },
      locale: { register: vi.fn(() => () => undefined) },
      slots: {
        inject: (_name: string, setup: () => unknown) => setup(),
        register,
        entries: () => [],
      },
    }
    ;(plugin.apply as (ctx: typeof context) => void)(context)

    expect(registered).toEqual([
      'conversation.session.header.actions',
      'sidebar.footer.action',
      'conversation.input.dock',
      'shell.overlay',
    ])
  })
})
