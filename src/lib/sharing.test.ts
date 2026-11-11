import { describe, expect, it } from 'vitest'
import { isShared, isValidEmail, normalizeEmail, sharedView, sharedWrite } from './sharing'
import type { Note } from './types'

const note: Note = {
  id: 'n1',
  title: 'Groceries',
  content: '{"type":"doc"}',
  preview: 'milk',
  folderId: 'owner-folder',
  order: 'a5',
  pinned: true,
  locked: true,
  color: 'mint',
  trashed: false,
  trashedAt: null,
  createdAt: 1,
  updatedAt: 2,
  ownerEmail: 'ana@x.com',
  members: ['bob@x.com'],
}

describe('sharedView', () => {
  it("takes folder, order, pin and lock from the invitee's own prefs and keeps the shared text and color", () => {
    const view = sharedView(note, 'ana-uid', { folderId: 'bob-folder', order: 'a1', pinned: false, locked: false })
    expect(view).toMatchObject({
      ownerUid: 'ana-uid',
      title: 'Groceries',
      content: '{"type":"doc"}',
      color: 'mint',
      folderId: 'bob-folder',
      order: 'a1',
      pinned: false,
      locked: false,
    })
  })

  it("never shows the owner's folder, pin or lock when the invitee has no prefs yet", () => {
    expect(sharedView(note, 'ana-uid', undefined)).toMatchObject({ folderId: null, order: 'a5', pinned: false, locked: false })
  })

  it('ignores prefs with the wrong types', () => {
    const view = sharedView(note, 'ana-uid', { folderId: 3, order: null, pinned: 'yes', locked: 1 })
    expect(view).toMatchObject({ folderId: null, order: 'a5', pinned: false, locked: false })
  })
})

describe('sharedWrite', () => {
  it("stores personal fields under the invitee's email and shared fields on the note", () => {
    const data = sharedWrite(
      { title: 'T', content: 'C', preview: 'P', color: 'sky', rev: 3, baseRev: 2, device: 'd', updatedAt: 9, folderId: 'f', order: 'a2', pinned: true, locked: false },
      'bob@x.com',
    )
    expect(data).toEqual({
      title: 'T',
      content: 'C',
      preview: 'P',
      color: 'sky',
      rev: 3,
      baseRev: 2,
      device: 'd',
      updatedAt: 9,
      prefs: { 'bob@x.com': { folderId: 'f', order: 'a2', pinned: true, locked: false } },
    })
  })

  it('drops what an invitee may not change (trash, creation date, sharing lists)', () => {
    expect(sharedWrite({ trashed: true, trashedAt: 5, createdAt: 1, members: [], invited: [], ownerEmail: 'z' }, 'bob@x.com')).toEqual({})
  })
})

describe('emails', () => {
  it('normalizes to trimmed lowercase', () => {
    expect(normalizeEmail('  Bob@X.Com ')).toBe('bob@x.com')
  })

  it('accepts a plain address and rejects anything else', () => {
    expect(isValidEmail('bob@x.com')).toBe(true)
    expect(isValidEmail('bob@x')).toBe(false)
    expect(isValidEmail('bob x@x.com')).toBe(false)
    expect(isValidEmail('')).toBe(false)
  })
})

describe('isShared', () => {
  it('is true with members or pending invites and false otherwise', () => {
    expect(isShared(note)).toBe(true)
    expect(isShared({ ...note, members: [], invited: ['c@x.com'] })).toBe(true)
    expect(isShared({ ...note, members: [], invited: [] })).toBe(false)
    expect(isShared({ ...note, members: undefined, invited: undefined })).toBe(false)
  })
})
