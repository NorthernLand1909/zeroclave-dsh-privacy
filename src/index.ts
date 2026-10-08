import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { LocalVllmSupervisor, type ValidatedLocalVllmConfig } from './local-vllm-supervisor.ts'
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
  telemetryProvider: 'zeroclave' | 'plausible'
  telemetryEnabled: boolean
  telemetryEndpoint: string
  telemetrySite: string
  telemetryTimeoutMs: number
  localVllmAutoStart: boolean
  localVllmCondaExecutable: string
  localVllmCondaEnvironment: string
  localVllmModelDirectory: string
  localVllmGpuMemoryUtilization: number
  localVllmMaxModelLength: number
  localVllmDtype: 'auto' | 'bfloat16' | 'float16'
  localVllmTensorParallelSize: number
}

export const Config: z<Config> = z.object({
  gatewayBaseURL: z.string().default('https://zeroclave.com/v1'),
  timeoutMs: z.number().min(100).max(30_000).default(15_000),
  telemetryProvider: z.union(['zeroclave', 'plausible'] as const).default('zeroclave'),
  telemetryEnabled: z.boolean().default(false),
  telemetryEndpoint: z.string().default('https://telemetry.zeroclave.ai'),
  telemetrySite: z.string().min(1).max(128).default('zeroclave-dsh-privacy'),
  telemetryTimeoutMs: z.number().min(100).max(10_000).default(2_000),
  localVllmAutoStart: z.boolean().default(false),
  localVllmCondaExecutable: z.string().default(''),
  localVllmCondaEnvironment: z.string().default('vllm'),
  localVllmModelDirectory: z.string().default(''),
  localVllmGpuMemoryUtilization: z.number().min(0.1).max(0.95).default(0.72),
  localVllmMaxModelLength: z.number().min(512).max(32_768).default(8_192),
  localVllmDtype: z.union(['auto', 'bfloat16', 'float16'] as const).default('auto'),
  localVllmTensorParallelSize: z.number().min(1).max(16).default(1),
})

export function apply(ctx: Context, config: Config): void {
  const localVllm = new LocalVllmSupervisor()
  ctx.effect(() => {
    if (config.localVllmAutoStart && config.localVllmCondaExecutable !== '' && config.localVllmModelDirectory !== '') {
      const runtimeConfig: ValidatedLocalVllmConfig = {
        condaExecutable: config.localVllmCondaExecutable,
        condaEnvironment: { kind: 'name', value: config.localVllmCondaEnvironment },
        modelDirectory: config.localVllmModelDirectory,
        gpuMemoryUtilization: config.localVllmGpuMemoryUtilization,
        maxModelLength: config.localVllmMaxModelLength,
        dtype: config.localVllmDtype,
        tensorParallelSize: config.localVllmTensorParallelSize,
        autoStart: true,
      }
      // Startup is intentionally background work: a slow model must not block DSH boot.
      void localVllm.start(runtimeConfig).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Local vLLM failed to start'
        ctx.logger.warn(`zeroclave-privacy: ${message}`)
      })
    }
    return () => localVllm.dispose()
  }, 'zeroclave-privacy: local vLLM supervisor')
  const handler = createDetectProxyHandler(config)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ZEROCLAVE_DETECT_PROXY_PATH,
    handler,
  }), 'zeroclave-privacy: anonymous detection proxy')
  const telemetry = createTelemetryHandlers({
    enabled: config.telemetryEnabled,
    provider: config.telemetryProvider,
    site: config.telemetrySite,
    endpoint: config.telemetryEndpoint,
    timeoutMs: config.telemetryTimeoutMs,
    pluginVersion: version,
  })
  if (config.telemetryEnabled && !telemetry.active) {
    ctx.logger.warn('zeroclave-privacy: telemetry is enabled but its Host configuration is invalid')
  }
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

export {
  LOCAL_VLLM_MODEL_NAME,
  LocalVllmSupervisor,
  LocalVllmSupervisorError,
} from './local-vllm-supervisor.ts'
export type {
  LocalVllmDtype,
  LocalVllmErrorCode,
  LocalVllmSnapshot,
  LocalVllmStatus,
  ValidatedLocalVllmConfig,
} from './local-vllm-supervisor.ts'

export { LocalModelDetector, LocalModelError, WebWorkerModelRuntimeAdapter, parseGguf, parseManifest, parseTransformersDirectory, validateLocalModel, validateTransformersModel } from './local-model.ts'
export type { ModelManifest, ModelRuntimeAdapter, ParsedGguf, TransformersModelConfig, TransformersModelDirectory, TransformersModelFile, ValidatedLocalModel } from './local-model.ts'
