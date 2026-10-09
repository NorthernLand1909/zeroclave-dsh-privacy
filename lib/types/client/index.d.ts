import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type PrivacyKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'zeroclave.privacy': PrivacyKey;
    }
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map