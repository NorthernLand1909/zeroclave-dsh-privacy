import { createElement, useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrivacyVault } from '../vault.ts'

type DisplayNodeKind = 'user' | 'steering' | 'assistant-step' | 'turn-tail' | 'context' | 'compaction'

interface ProtectedRange { start: number; end: number }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function markdownProtectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = []
  const protect = (start: number, end: number): void => {
    if (end > start) ranges.push({ start, end })
  }
  const lineRanges: ProtectedRange[] = []
  let fence: { marker: '`' | '~'; size: number; start: number } | undefined
  let lineStart = 0
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline + 1
    const line = text.slice(lineStart, newline === -1 ? text.length : newline)
    if (fence !== undefined) {
      const closing = new RegExp(`^ {0,3}${fence.marker === '`' ? '`' : '~'}{${fence.size},}\\s*$`, 'u')
      if (closing.test(line)) {
        protect(fence.start, lineEnd)
        lineRanges.push({ start: fence.start, end: lineEnd })
        fence = undefined
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
      if (opening !== null) {
        const run = opening[1] as string
        fence = { marker: run[0] as '`' | '~', size: run.length, start: lineStart }
      } else if (/^(?: {4}|\t)/u.test(line) || /^ {0,3}\[[^\]\n]+\]:/u.test(line)) {
        protect(lineStart, lineEnd)
        lineRanges.push({ start: lineStart, end: lineEnd })
      }
    }
    lineStart = lineEnd
  }
  if (fence !== undefined) {
    protect(fence.start, text.length)
    lineRanges.push({ start: fence.start, end: text.length })
  }

  let lineRangeIndex = 0
  for (let index = 0; index < text.length;) {
    let previousLineRange = lineRanges[lineRangeIndex]
    while (previousLineRange !== undefined && previousLineRange.end <= index) {
      lineRangeIndex += 1
      previousLineRange = lineRanges[lineRangeIndex]
    }
    const lineRange = lineRanges[lineRangeIndex]
    if (lineRange !== undefined && index >= lineRange.start) {
      index = lineRange.end
      continue
    }
    if (text[index] === '`') {
      let size = 1
      while (text[index + size] === '`') size += 1
      let closing = -1
      let cursor = index + size
      while (cursor < text.length) {
        const candidate = text.indexOf('`', cursor)
        if (candidate === -1) break
        let candidateSize = 1
        while (text[candidate + candidateSize] === '`') candidateSize += 1
        if (candidateSize === size) {
          closing = candidate
          break
        }
        cursor = candidate + candidateSize
      }
      const end = closing === -1 ? text.length : closing + size
      protect(index, end)
      index = end
      continue
    }
    if (text[index] === '<') {
      const closing = text.indexOf('>', index + 1)
      if (closing !== -1) {
        protect(index, closing + 1)
        index = closing + 1
        continue
      }
    }
    if (text[index] === ']' && text[index + 1] === '(') {
      let cursor = index + 2
      let depth = 1
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '\\') cursor += 2
        else {
          if (text[cursor] === '(') depth += 1
          if (text[cursor] === ')') depth -= 1
          cursor += 1
        }
      }
      protect(index + 1, cursor)
      index = cursor
      continue
    }
    if (text[index] === ']' && text[index + 1] === '[') {
      const closing = text.indexOf(']', index + 2)
      if (closing !== -1) {
        protect(index + 1, closing + 1)
        index = closing + 1
        continue
      }
    }
    index += 1
  }

  const url = /(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>]+/giu
  let match: RegExpExecArray | null
  while ((match = url.exec(text)) !== null) protect(match.index, match.index + match[0].length)
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end)
}

/** Restore prose while leaving Markdown destinations and code byte-for-byte unchanged. */
function restoreVisibleMarkdown(text: string, restore: (text: string) => string): string {
  const ranges = markdownProtectedRanges(text)
  if (ranges.length === 0) return restore(text)
  let cursor = 0
  let output = ''
  for (const range of ranges) {
    if (range.end <= cursor) continue
    if (range.start > cursor) output += restore(text.slice(cursor, range.start))
    const protectedStart = Math.max(cursor, range.start)
    output += text.slice(protectedStart, range.end)
    cursor = range.end
  }
  if (cursor < text.length) output += restore(text.slice(cursor))
  return output
}

function restoreBlocks(
  value: unknown,
  discriminator: 'type' | 'kind',
  visibleKinds: ReadonlySet<string>,
  restore: (text: string) => string,
): unknown {
  if (!Array.isArray(value)) return value
  const blocks = value as readonly unknown[]
  const next = blocks.map((item) => {
    const block = asRecord(item)
    if (block === undefined || !visibleKinds.has(String(block[discriminator])) || typeof block['text'] !== 'string') {
      return item
    }
    const text = restoreVisibleMarkdown(block['text'], restore)
    if (text === block['text']) return item
    return { ...block, text }
  })
  return next.every((item, index) => item === blocks[index]) ? value : next
}

function restoreContent(value: unknown, restore: (text: string) => string): unknown {
  const data = asRecord(value)
  if (data === undefined) return value
  const content = restoreBlocks(data['content'], 'type', new Set(['text']), restore)
  return content === data['content'] ? value : { ...data, content }
}

function restoreAssistant(value: unknown, restore: (text: string) => string): unknown {
  const data = asRecord(value)
  if (data === undefined) return value
  const blocks = restoreBlocks(data['blocks'], 'kind', new Set(['text', 'reasoning']), restore)
  return blocks === data['blocks'] ? value : { ...data, blocks }
}

/** Restore only renderer fields that are visible prose; all other node data remains opaque. */
export function restoreDisplayValue(
  kind: string,
  value: unknown,
  restore: (text: string) => string,
): unknown {
  if (kind === 'user' || kind === 'steering' || kind === 'context') return restoreContent(value, restore)
  if (kind === 'assistant-step') return restoreAssistant(value, restore)
  const data = asRecord(value)
  if (data === undefined) return value
  if (kind === 'compaction' && typeof data['summary'] === 'string') {
    const summary = restoreVisibleMarkdown(data['summary'], restore)
    return summary === data['summary'] ? value : { ...data, summary }
  }
  if (kind === 'turn-tail') {
    const closing = asRecord(data['closing'])
    if (closing === undefined) return value
    const restored = restoreAssistant(closing, restore)
    return restored === closing ? value : { ...data, closing: restored }
  }
  return value
}

interface DisplayProps { sessionId: string; node?: { data?: unknown }; [key: string]: unknown }

function restoredRenderer(component: unknown, kind: DisplayNodeKind, vault: PrivacyVault): ComponentType<DisplayProps> {
  // StoredEntry deliberately erases the registered component type at the registry boundary.
  const Original = component as ComponentType<DisplayProps>
  return function RestoredMessage(props: DisplayProps) {
    const [loadedSession, setLoadedSession] = useState<string>()
    useEffect(() => {
      let active = true
      void vault.load(props.sessionId).then(() => {
        if (active) setLoadedSession(props.sessionId)
      }, () => {
        if (active) setLoadedSession(props.sessionId)
      })
      return () => { active = false }
    }, [props.sessionId])
    const node = useMemo(() => {
      if (props.node === undefined) return undefined
      const data = restoreDisplayValue(kind, props.node.data, text => vault.restore(props.sessionId, text))
      return data === props.node.data ? props.node : { ...props.node, data }
    }, [props.node, props.sessionId, loadedSession])
    if (loadedSession !== props.sessionId) return null
    return createElement(Original, { ...props, ...(node === undefined ? {} : { node }) })
  }
}

/** Adapt both released Chat layouts while retaining their slots, actions, stores and locale. */
export function installDisplayRestoration(ctx: Context, vault: PrivacyVault): () => void {
  const originals = new Map<StoredEntry, { original: unknown; wrapper: unknown }>()
  const keys = new Set<DisplayNodeKind>(['user', 'steering', 'assistant-step', 'turn-tail', 'context', 'compaction'])
  const update = (): void => {
    // Both supported Harness versions expose the same public StoredEntry registry.
    const entries = ctx.slots.entries('conversation.chat.node' as Parameters<typeof ctx.slots.entries>[0])
    for (const entry of entries) {
      const kind = entry.options.key
      if (!keys.has(kind as DisplayNodeKind) || originals.has(entry)) continue
      const original = entry.component
      const wrapper = restoredRenderer(original, kind as DisplayNodeKind, vault)
      originals.set(entry, { original, wrapper })
      entry.component = wrapper
    }
  }
  const off = ctx.on('slots/changed', (key) => { if (key === 'conversation.chat.node') update() })
  update()
  return () => {
    off()
    for (const [entry, { original, wrapper }] of originals) {
      if (entry.component === wrapper) entry.component = original
    }
    originals.clear()
  }
}
