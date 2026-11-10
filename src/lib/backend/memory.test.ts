import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryBackend } from './memory'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('memory backend ids', () => {
  it('creates ids without crypto.randomUUID, which Safari hides outside HTTPS (an iPad opening the dev server by its local IP)', () => {
    const real = crypto
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
    const backend = createMemoryBackend()
    const a = backend.newId()
    expect(a).toMatch(/^[0-9a-f]{20}$/)
    expect(backend.newId()).not.toBe(a)
  })
})
