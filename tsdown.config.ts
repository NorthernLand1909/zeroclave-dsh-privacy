import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBundle } from '../../client/tsdown.client.ts'

const bundle = clientBundle('@zeroclave/dsh-privacy', ['lib/types/index.js'])
const transformersRoot = realpathSync(fileURLToPath(new URL(
  './node_modules/@huggingface/transformers',
  import.meta.url,
)))
const transformersWeb = resolve(transformersRoot, 'dist/transformers.web.js')
const onnxRuntimeWeb = resolve(transformersRoot, '../../onnxruntime-web/dist/ort.min.mjs')
const utilCryptoSource = fileURLToPath(new URL('../../util/crypto/src/index.ts', import.meta.url))
const brandLogoSource = fileURLToPath(new URL('./src/client/assets/zeroclave-logo.png', import.meta.url))
const BRAND_LOGO_VIRTUAL_ID = '\0zeroclave-brand-logo.mjs'

export default ((options: Parameters<typeof bundle>[0]) => bundle(options).map((config) => {
  if (config.name !== '@zeroclave/dsh-privacy/client') return config
  return {
    ...config,
    minify: true,
    sourcemap: 'hidden',
    plugins: [{
      name: 'zeroclave-brand-logo-inline',
      resolveId: {
        order: 'pre' as const,
        handler(source: string) {
          return source.endsWith('/assets/zeroclave-logo.png') ? BRAND_LOGO_VIRTUAL_ID : null
        },
      },
      load(id: string) {
        if (id !== BRAND_LOGO_VIRTUAL_ID) return null
        const value = `data:image/png;base64,${readFileSync(brandLogoSource).toString('base64')}`
        return `export default ${JSON.stringify(value)};`
      },
    }, ...(config.plugins ?? [])],
    define: {
      ...config.define,
      'import.meta': '{}',
    },
    inputOptions: {
      ...config.inputOptions,
      resolve: {
        ...config.inputOptions?.resolve,
        alias: {
          '@huggingface/transformers': transformersWeb,
          '@deepseek-ai/dsh-util-crypto': utilCryptoSource,
          'onnxruntime-web': onnxRuntimeWeb,
        },
        conditionNames: ['browser', 'import', 'module', 'default'],
      },
    },
  }
})) satisfies typeof bundle
