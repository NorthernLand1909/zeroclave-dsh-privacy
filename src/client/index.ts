import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PrivacyController } from '../controller.ts'
import { installSendRedaction } from '../send.ts'
import { installDisplayRestoration } from './display.tsx'
import { FooterButton, HeaderButton, PrivacyDock, PrivacyDrawer } from './PrivacySurfaces.tsx'
import { en, NS, zh, type PrivacyKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'zeroclave.privacy': PrivacyKey
  }
}

export const inject = ['slots', 'locale', 'conversation']

export function apply(ctx: ClientContext): void {
  const controller = new PrivacyController()
  void controller.initializeTelemetry()
  ctx.effect(() => () => { void controller.dispose() }, 'zeroclave-privacy: controller')
  ctx.effect(() => installSendRedaction(ctx.conversation, controller), 'zeroclave-privacy: outgoing prompts')
  ctx.effect(() => installDisplayRestoration(ctx, controller.vault), 'zeroclave-privacy: original display')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'zeroclave-privacy: dictionaries')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'zeroclave-privacy',
    order: 30,
    locale: NS,
    inject: () => ({ controller }),
  }, HeaderButton))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'zeroclave-privacy',
    order: 10,
    locale: NS,
    inject: () => ({ controller }),
  }, FooterButton))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'zeroclave-privacy',
    order: -10,
    locale: NS,
    inject: () => ({ controller }),
  }, PrivacyDock))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'zeroclave-privacy',
    order: 10,
    locale: NS,
    inject: () => ({ controller }),
  }, PrivacyDrawer))
}
