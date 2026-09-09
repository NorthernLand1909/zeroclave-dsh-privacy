import type { PrivacyController } from './controller.ts'
import { SendReviewCancelledError } from './controller.ts'
import type { ScanResult } from './types.ts'

interface PromptPart { type: string; text?: string }
interface PromptSession {
  sessionId: string
  prompt(content: PromptPart[], ...args: unknown[]): Promise<{ ok: boolean }>
}

type Method = (this: object, ...args: unknown[]) => Promise<unknown>

function methodDescriptor(target: object, name: string): PropertyDescriptor {
  let owner: object | null = target
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    if (descriptor !== undefined && typeof descriptor.value === 'function') return descriptor
    owner = Object.getPrototypeOf(owner) as object | null
  }
  throw new Error(`ZeroClave: unsupported Harness conversation.${name}`)
}

/** Wrap the composer admission without changing its draft, local echo, or failed-send restoration. */
export function installSendRedaction(conversation: object, controller: PrivacyController): () => void {
  const own = Object.getOwnPropertyDescriptor(conversation, 'sendSession')
  const original = methodDescriptor(conversation, 'sendSession').value as Method
  const replacement: Method = async function (...args) {
    const session = args[0] as PromptSession | undefined
    if (!controller.getSnapshot().enabled) return original.apply(this, args)
    if (typeof session?.sessionId !== 'string' || typeof session.prompt !== 'function') {
      throw new Error('ZeroClave: unsupported Harness prompt session')
    }
    const protectedSession = new Proxy(session, {
      get(target, property) {
        if (property === 'prompt') return async (content: PromptPart[], ...promptArgs: unknown[]) => {
          const signal = promptArgs.find(value => value instanceof AbortSignal)
          const textParts = content.filter((part): part is PromptPart & { text: string } => (
            part.type === 'text' && typeof part.text === 'string'
          ))
          let results: ScanResult[]
          try { results = await controller.prepareSendBatch(target.sessionId, textParts.map(part => part.text), signal) } catch (error) {
            if (error instanceof SendReviewCancelledError) return { ok: false }
            throw error
          }
          let textIndex = 0
          const scanned: Array<{ text: string; result: ScanResult }> = []
          const outgoing = content.map((part) => {
            if (part.type !== 'text' || typeof part.text !== 'string') return part
            const result = results[textIndex]
            textIndex += 1
            if (result === undefined) throw new Error('ZeroClave: missing prepared text part')
            scanned.push({ text: part.text, result })
            return { ...part, text: result.redactedText }
          })
          signal?.throwIfAborted()
          const outcome = await target.prompt(outgoing, ...promptArgs)
          const resultsSent = scanned.map(item => item.result)
          if (outcome.ok && resultsSent.some(result => result.findings.length > 0 || result.policySignals.length > 0)) {
            controller.recordSend(target.sessionId, resultsSent)
          }
          return outcome
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(target) : value
      },
    })
    return original.apply(this, [protectedSession, ...args.slice(1)])
  }
  // Cordis tracks method reads. A descriptor replacement preserves the caller's scoped `this`.
  Object.defineProperty(conversation, 'sendSession', { configurable: true, writable: true, value: replacement })
  return () => {
    if (Object.getOwnPropertyDescriptor(conversation, 'sendSession')?.value !== replacement) return
    if (own === undefined) Reflect.deleteProperty(conversation, 'sendSession')
    else Object.defineProperty(conversation, 'sendSession', own)
  }
}
