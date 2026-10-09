import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { PrivacyController } from '../controller.ts';
interface ControllerProps {
    controller: PrivacyController;
}
export type HeaderButtonProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'zeroclave.privacy'> & ControllerProps;
export type FooterButtonProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'zeroclave.privacy'> & ControllerProps;
export type PrivacyDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'zeroclave.privacy'> & ControllerProps;
export type PrivacyDrawerProps = PropsRuntime<'shell.overlay'> & PropsLocale<'zeroclave.privacy'> & ControllerProps;
export declare function HeaderButton({ controller, t }: HeaderButtonProps): ReactNode;
export declare function FooterButton({ controller, wide, t }: FooterButtonProps): ReactNode;
export declare function PrivacyDock({ controller, sessionId, t, useInput, inputActions }: PrivacyDockProps): ReactNode;
export declare function PrivacyDrawer({ controller, t, useSessions }: PrivacyDrawerProps): ReactNode;
export {};
//# sourceMappingURL=PrivacySurfaces.d.ts.map