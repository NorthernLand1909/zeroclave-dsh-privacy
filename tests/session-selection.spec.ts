import { describe, expect, it } from 'vitest'
import { selectedSessionId } from '../src/client/session-selection.ts'

describe('selected Harness session', () => {
  it('uses the explicit selection on DSH 0.1', () => {
    expect(selectedSessionId({ current: 's1', byId: { s1: { id: 's1' } } })).toBe('s1')
  })

  it('follows main-view retention on DSH 0.2 rather than a background session', () => {
    const background = { id: 's1', retainedBy: {} }
    expect(selectedSessionId({ byId: { s1: background, s2: { id: 's2', retainedBy: { mainView: 1 } } } })).toBe('s2')
    expect(selectedSessionId({ byId: { s1: background } })).toBeUndefined()
  })
})
