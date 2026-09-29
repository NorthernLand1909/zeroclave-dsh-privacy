// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { PrivacyController } from '../src/controller.ts'
import { mergeLocalModelCandidates, type FindingCandidate } from '../src/detector.ts'
import { LocalModelDetector, LocalModelError, type ModelManifest, type ModelRuntimeAdapter, type ValidatedLocalModel } from '../src/local-model.ts'
import { buildQwenPrompt, parseModelOutput, type PromptManifestLike } from '../src/local-model-protocol.ts'
import { PrivacyVault } from '../src/vault.ts'
import { memoryStore } from './memory-store.ts'

afterEach(() => { window.localStorage.clear() })

const manifest: ModelManifest = {
  modelId: 'qwen2.5-test',
  version: 'test-1',
  architecture: 'qwen2',
  format: 'gguf',
  languages: ['en', 'zh'],
  chatTemplate: '<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{user}}<|im_end|>\n<|im_start|>assistant\n{{assistant}}',
  systemPromptVersion: 'v1',
  outputProtocolVersion: 'local-model.v1',
  entityTypes: ['PERSON'],
  maxContextLength: 2048,
  recommendedGeneration: { temperature: 0, topP: 1, maxTokens: 96 },
  constrainedJson: true,
}

function pushU32(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

function pushU64(target: number[], value: number): void {
  let remaining = BigInt(value)
  for (let index = 0; index < 8; index += 1) {
    target.push(Number(remaining & 0xffn))
    remaining >>= 8n
  }
}

function pushString(target: number[], value: string): void {
  const bytes = new TextEncoder().encode(value)
  pushU64(target, bytes.length)
  target.push(...bytes)
}

function stringMetadata(target: number[], key: string, value: string): void {
  pushString(target, key)
  pushU32(target, 8)
  pushString(target, value)
}

function u32Metadata(target: number[], key: string, value: number): void {
  pushString(target, key)
  pushU32(target, 4)
  pushU32(target, value)
}

function tokenMetadata(target: number[]): void {
  pushString(target, 'tokenizer.ggml.tokens')
  pushU32(target, 9)
  pushU32(target, 8)
  pushU64(target, 2)
  pushString(target, '<|endoftext|>')
  pushString(target, 'test')
}

function ggufFile(): File {
  const bytes: number[] = []
  pushU32(bytes, 0x46554747)
  pushU32(bytes, 3)
  pushU64(bytes, 0)
  pushU64(bytes, 5)
  stringMetadata(bytes, 'general.architecture', 'qwen2')
  stringMetadata(bytes, 'general.name', 'qwen2.5-test')
  tokenMetadata(bytes)
  u32Metadata(bytes, 'qwen2.context_length', 2048)
  u32Metadata(bytes, 'general.file_type', 7)
  return new File([new Uint8Array(bytes)], 'qwen2.5-test.gguf')
}

function manifestFile(): File {
  return new File([JSON.stringify(manifest)], 'qwen2.5-test.manifest.json', { type: 'application/json' })
}

class TestRuntime implements ModelRuntimeAdapter {
  loaded = false
  async load(_model: ValidatedLocalModel): Promise<void> { this.loaded = true }
  async unload(): Promise<void> { this.loaded = false }
  async scan(text: string): Promise<readonly FindingCandidate[]> {
    const start = text.indexOf('Alice')
    return [{
      category: 'DIRECT_PII', entityType: 'PERSON', start, end: start + 'Alice'.length,
      maskedEvidence: 'A****', severity: 'high', detector: 'local-model', sourceType: 'local-model',
    }]
  }
}

describe('local-model output protocol', () => {
  it('keeps the source text as data and converts code-point offsets to UTF-16 offsets', () => {
    const text = '张😀é Alice'
    const startInCodePoints = Array.from(text.slice(0, text.indexOf('Alice'))).length
    const parsed = parseModelOutput(JSON.stringify({
      offsetUnit: 'codepoint',
      entities: [{ type: 'PERSON', start: startInCodePoints, end: startInCodePoints + 5, text: 'Alice' }],
    }), text, ['PERSON'])
    expect(parsed.entities[0]).toMatchObject({ start: text.indexOf('Alice'), end: text.length, text: 'Alice' })

    const prompt = buildQwenPrompt(text, manifest as PromptManifestLike)
    expect(prompt).toContain('<|zc-data|>' + JSON.stringify({ text }) + '<|/zc-data|>')
    expect(prompt).not.toContain('{"entities":[]}')
  })

  it('rejects a model entity whose returned text does not match the source', () => {
    expect(() => parseModelOutput(JSON.stringify({
      entities: [{ type: 'PERSON', start: 0, end: 3, text: 'Bob' }],
    }), 'Alice', ['PERSON'])).toThrow(/does not match/u)
  })
})

describe('local-model detector integration', () => {
  it('merges local-model and local-regex findings with complete, non-fallback metadata', async () => {
    const runtime = new TestRuntime()
    const detector = new LocalModelDetector(runtime)
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()), undefined, undefined, undefined, detector,
    )
    controller.setEnabled(true)
    controller.setDetectorMode('local-model')
    await controller.selectLocalModel(ggufFile(), manifestFile())
    await controller.loadLocalModel()
    await controller.inspect('session-1', 'Alice: alice@example.com')

    const result = controller.getSnapshot().liveBySession.get('session-1')?.result
    expect(result?.detector).toEqual(expect.objectContaining({
      requested: 'local-model', used: 'local-model', fallback: false,
      model: 'qwen2.5-test', modelVersion: 'test-1', status: 'complete',
    }))
    expect(result?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'PERSON', detector: 'local-model', sourceType: 'local-model' }),
      expect.objectContaining({ entityType: 'EMAIL', detector: 'regex' }),
    ]))
    expect(controller.getSnapshot().detectorStates['local-model'].status).toBe('ready')
    await controller.dispose()
  })

  it('clears stale metadata when a replacement model fails validation', async () => {
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()), undefined, undefined, undefined, new LocalModelDetector(new TestRuntime()),
    )
    await controller.selectLocalModel(ggufFile(), manifestFile())

    await expect(controller.selectLocalModel(
      new File(['not a GGUF model'], 'invalid.gguf'), manifestFile(),
    )).rejects.toMatchObject({ code: 'format_invalid' })

    expect(controller.getSnapshot().localModel).toBeUndefined()
    expect(controller.getSnapshot().detectorStates['local-model']).toMatchObject({
      status: 'error', code: 'format_invalid',
    })
    await controller.dispose()
  })

  it('preserves deterministic regex findings when a semantic finding overlaps only part of them', () => {
    const text = 'Contact Alice at alice@example.com'
    const result = mergeLocalModelCandidates(text, [{
      category: 'DIRECT_PII', entityType: 'PERSON', start: 8, end: 13,
      maskedEvidence: 'A****', severity: 'high', detector: 'local-model', sourceType: 'local-model',
    }], 'qwen2.5-test', 'test-1')
    expect(result.findings.map(item => item.detector)).toEqual(['local-model', 'regex'])
  })

  it('marks a partial semantic result as unsafe instead of producing an empty allow result', async () => {
    const detector = new LocalModelDetector({
      load: async () => undefined,
      unload: async () => undefined,
      scan: async () => { throw new LocalModelError('partial_result', 'Generation stopped before completion') },
    })
    const controller = new PrivacyController(
      new PrivacyVault(memoryStore()), undefined, undefined, undefined, detector,
    )
    controller.setEnabled(true)
    controller.setDetectorMode('local-model')
    await controller.selectLocalModel(ggufFile(), manifestFile())
    await controller.loadLocalModel()
    await controller.inspect('session-1', 'Alice')

    expect(controller.getSnapshot().detectorStates['local-model']).toMatchObject({ status: 'partial', code: 'partial_result' })
    await expect(controller.prepareSend('session-1', 'Alice')).rejects.toMatchObject({ code: 'partial_result' })
    await controller.dispose()
  })
})
