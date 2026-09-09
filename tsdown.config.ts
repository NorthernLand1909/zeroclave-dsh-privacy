import { realpathSync } from 'node:fs'
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

export default ((options: Parameters<typeof bundle>[0]) => bundle(options).map((config) => {
  if (config.name !== '@zeroclave/dsh-privacy/client') return config
  return {
    ...config,
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
