import { describe, expect, it } from 'vitest'
import { waitProgress, waitStep } from './wait'

describe('waitProgress', () => {
  it('never claims completion while the image is missing', () => {
    for (const elapsed of [0, 1, 8, 30, 60, 600]) {
      expect(waitProgress(elapsed, false)).toBeLessThanOrEqual(92)
      expect(waitProgress(elapsed, true)).toBeLessThanOrEqual(92)
    }
  })

  it('caps the estimate at 92%', () => {
    expect(waitProgress(60, true)).toBe(92)
    expect(waitProgress(600, false)).toBe(92)
  })

  it('starts the warm curve ahead of the cold one', () => {
    expect(waitProgress(1, true)).toBeGreaterThan(waitProgress(1, false))
  })

  it('moves through the cold phases at 8 and 30 seconds', () => {
    expect(waitStep(0, false)).toBe(0)
    expect(waitStep(7.9, false)).toBe(0)
    expect(waitStep(8, false)).toBe(1)
    expect(waitStep(29.9, false)).toBe(1)
    expect(waitStep(30, false)).toBe(2)
  })

  it('treats a warm container as already loaded', () => {
    expect(waitStep(0, true)).toBe(2)
  })
})
