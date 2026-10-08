import type { PrivacyController } from './controller.ts'
import { SendReviewCancelledError } from './controller.ts'
import type { ScanResult } from './types.ts'

interface PromptPart { type: string; text?: string }
interface PromptSession {
  sessionId: string
  prompt(content: PromptPart[], ...args: unknown[]): Promise<{ ok: boolean }>
  beginSubmission?(...args: unknown[]): { requestId: string; abandon(): void }
}

type Method = (this: object, ...args: unknown[]) => Promise<unknown>

function optionalMethodDescriptor(target: object, name: string): PropertyDescriptor | undefined {
  let owner: object | null = target
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    if (descriptor !== undefined && typeof descriptor.value === 'function') return descriptor
    owner = Object.getPrototypeOf(owner) as object | null
  }
  return undefined
}

function methodDescriptor(target: object, name: string): PropertyDescriptor {
  const descriptor = optionalMethodDescriptor(target, name)
  if (descriptor !== undefined) return descriptor
  throw new Error(`ZeroClave: unsupported Harness conversation.${name}`)
}

/** Wrap the composer admission without changing its draft, local echo, or failed-send restoration. */
export function installSendRedaction(conversation: object, controller: PrivacyController): () => void {
  const own = Object.getOwnPropertyDescriptor(conversation, 'sendSession')
  const original = methodDescriptor(conversation, 'sendSession').value as Method
  const ownSend = Object.getOwnPropertyDescriptor(conversation, 'send')
  const sendDescriptor = optionalMethodDescriptor(conversation, 'send')
  const originalSend = sendDescriptor?.value as Method | undefined
  const replacement: Method = async function (...args) {
    const session = args[0] as PromptSession | undefined
    if (!controller.getSnapshot().enabled) return original.apply(this, args)
    if (typeof session?.sessionId !== 'string' || typeof session.prompt !== 'function') {
      throw new Error('ZeroClave: unsupported Harness prompt session')
    }
    if (!controller.beginSend(session.sessionId)) return { kind: 'error' }
    let outcomeReported = false
    let reviewCancelled = false
    let promptSucceeded = false
    let promptStarted = false
    let pendingSubmission: { abandon(): void } | undefined
    const abandonBeforePrompt = (): void => {
      if (promptStarted) return
      const submission = pendingSubmission
      pendingSubmission = undefined
      submission?.abandon()
    }
    const reportFailure = (error: unknown): void => {
      if (outcomeReported) return
      outcomeReported = true
      controller.finishSend(session.sessionId, false, error instanceof Error ? error.message : String(error))
    }
    const protectedSession = new Proxy(session, {
      get(target, property) {
        if (property === 'beginSubmission' && typeof target.beginSubmission === 'function') {
          return (...submissionArgs: unknown[]) => {
            const submission = target.beginSubmission!(...submissionArgs)
            pendingSubmission = submission
            return submission
          }
        }
        if (property === 'prompt') return async (content: PromptPart[], ...promptArgs: unknown[]) => {
          try {
            const signal = promptArgs.find(value => value instanceof AbortSignal)
            const textParts = content.filter((part): part is PromptPart & { text: string } => (
              part.type === 'text' && typeof part.text === 'string'
            ))
            let results: ScanResult[]
            try { results = await controller.prepareSendBatch(target.sessionId, textParts.map(part => part.text), signal) } catch (error) {
              if (error instanceof SendReviewCancelledError) {
                reviewCancelled = true
                abandonBeforePrompt()
                return { ok: false }
              }
              throw error
            }
            let textIndex = 0
            const outgoing = content.map((part) => {
              if (part.type !== 'text' || typeof part.text !== 'string') return part
              const result = results[textIndex]
              textIndex += 1
              if (result === undefined) throw new Error('ZeroClave: missing prepared text part')
              return { ...part, text: result.redactedText }
            })
            signal?.throwIfAborted()
            controller.markSending(target.sessionId)
            // From here the Host owns retiring its admission, including failures.
            promptStarted = true
            const outcome = await target.prompt(outgoing, ...promptArgs)
            promptSucceeded = outcome.ok
            return outcome
          } catch (error) { abandonBeforePrompt(); reportFailure(error); throw error }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(target) : value
      },
    })
    try {
      const outcome = await original.apply(this, [protectedSession, ...args.slice(1)])
      if (!outcomeReported && !reviewCancelled) {
        const record = typeof outcome === 'object' && outcome !== null ? outcome as Record<string, unknown> : undefined
        const ok = record?.kind === 'success' || (record?.kind === undefined && record?.ok === true)
        controller.finishSend(session.sessionId, ok)
        if (ok && promptSucceeded) controller.reportTelemetry('protected_send')
      }
      return outcome
    } catch (error) {
      reportFailure(error)
      throw error
    } finally { controller.endSendAttempt(session.sessionId) }
  }
  // Cordis tracks method reads. A descriptor replacement preserves the caller's scoped `this`.
  Object.defineProperty(conversation, 'sendSession', { configurable: true, writable: true, value: replacement })
  const sendReplacement: Method | undefined = originalSend === undefined ? undefined : async function (...args) {
    if (controller.getSnapshot().enabled) {
      throw new Error('ZeroClave: conversation.send is blocked while privacy detection is enabled; use the composer')
    }
    return originalSend.apply(this, args)
  }
  if (sendReplacement !== undefined) {
    Object.defineProperty(conversation, 'send', { configurable: true, writable: true, value: sendReplacement })
  }
  return () => {
    if (Object.getOwnPropertyDescriptor(conversation, 'sendSession')?.value === replacement) {
      if (own === undefined) Reflect.deleteProperty(conversation, 'sendSession')
      else Object.defineProperty(conversation, 'sendSession', own)
    }
    if (sendReplacement !== undefined && Object.getOwnPropertyDescriptor(conversation, 'send')?.value === sendReplacement) {
      if (ownSend === undefined) Reflect.deleteProperty(conversation, 'send')
      else Object.defineProperty(conversation, 'send', ownSend)
    }
  }
}
