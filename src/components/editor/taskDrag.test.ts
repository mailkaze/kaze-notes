import { describe, expect, it } from 'vitest'
import { gapIndexAt, moveTarget } from './taskDrag'

describe('gapIndexAt', () => {
  // Tres casillas de 20px de alto: puntos medios en 10, 30 y 50.
  const mids = [10, 30, 50]

  it('returns the gap before the first item whose middle is below the pointer', () => {
    expect(gapIndexAt(mids, 0)).toBe(0)
    expect(gapIndexAt(mids, 15)).toBe(1)
    expect(gapIndexAt(mids, 35)).toBe(2)
    expect(gapIndexAt(mids, 99)).toBe(3)
  })
})

describe('moveTarget', () => {
  it('is null when the item would stay in place', () => {
    expect(moveTarget(1, 1)).toBeNull()
    expect(moveTarget(1, 2)).toBeNull()
  })

  it('returns the final index of the moved item', () => {
    expect(moveTarget(0, 3)).toBe(2)
    expect(moveTarget(2, 0)).toBe(0)
    expect(moveTarget(0, 2)).toBe(1)
    expect(moveTarget(3, 1)).toBe(1)
  })
})
