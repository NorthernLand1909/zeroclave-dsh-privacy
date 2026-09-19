import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { createDetectProxyHandler, ZEROCLAVE_DETECT_PROXY_PATH } from './proxy.ts'
import {
  createTelemetryHandlers,
  TELEMETRY_CONFIG_PATH,
  TELEMETRY_EVENTS_PATH,
} from './telemetry-proxy.ts'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const name = 'zeroclave-privacy'
export const inject = ['webServer']

export interface Config {
  gatewayBaseURL: string
  timeoutMs: number
  telemetryEnabled: boolean
  telemetryEndpoint: string
  telemetryKeyId: string
  telemetrySecretEnv: string
  telemetryTimeoutMs: number
}

export const Config: z<Config> = z.object({
  gatewayBaseURL: z.string().default('https://zeroclave.com/v1'),
  timeoutMs: z.number().min(100).max(30_000).default(15_000),
  telemetryEnabled: z.boolean().default(false),
  telemetryEndpoint: z.string().default('https://telemetry.zeroclave.com'),
  telemetryKeyId: z.string().default('dsh-prod-1'),
  telemetrySecretEnv: z.string().default('ZEROCLAVE_TELEMETRY_HMAC_SECRET'),
  telemetryTimeoutMs: z.number().min(100).max(10_000).default(2_000),
})

export function apply(ctx: Context, config: Config): void {
  const handler = createDetectProxyHandler(config)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ZEROCLAVE_DETECT_PROXY_PATH,
    handler,
  }), 'zeroclave-privacy: anonymous detection proxy')
  const secretEnvValid = /^[A-Z_][A-Z0-9_]*$/u.test(config.telemetrySecretEnv)
  const secret = secretEnvValid ? process.env[config.telemetrySecretEnv] : undefined
  const keyIdValid = /^[A-Za-z0-9_.-]{1,64}$/u.test(config.telemetryKeyId)
  if (config.telemetryEnabled && (!secretEnvValid || secret === undefined || secret.length < 32 || !keyIdValid)) {
    ctx.logger.warn('zeroclave-privacy: telemetry is enabled but its Host credential configuration is invalid')
  }
  const telemetry = createTelemetryHandlers({
    enabled: config.telemetryEnabled,
    endpoint: config.telemetryEndpoint,
    keyId: config.telemetryKeyId,
    secret,
    timeoutMs: config.telemetryTimeoutMs,
    pluginVersion: version,
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TELEMETRY_CONFIG_PATH,
    handler: telemetry.config,
  }), 'zeroclave-privacy: telemetry availability')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TELEMETRY_EVENTS_PATH,
    handler: telemetry.events,
  }), 'zeroclave-privacy: telemetry relay')
}

export { RegexDetector, scanRegex } from './detector.ts'
export {
  ZEROCLAVE_PROXY_PATH,
  ZeroClaveDetectError,
  ZeroClaveDetector,
} from './zeroclave-detector.ts'
export type * from './types.ts'
