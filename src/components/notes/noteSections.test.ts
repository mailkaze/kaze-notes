import { describe, expect, it } from 'vitest'
import { byOrder } from '../../lib/order'
import type { Note } from '../../lib/types'
import { reorderKey, splitPinned } from './noteSections'

function note(id: string, order: string, pinned = false): Note {
  return {
    id,
    title: id,
    content: '',
    preview: '',
    folderId: null,
    order,
    pinned,
    color: null,
    trashed: false,
    trashedAt: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

const section = [note('a', 'a0'), note('b', 'a1'), note('c', 'a2'), note('d', 'a3')]

function sequenceAfter(activeId: string, order: string): string[] {
  return section
    .map((n) => (n.id === activeId ? { ...n, order } : n))
    .sort(byOrder)
    .map((n) => n.id)
}

describe('splitPinned', () => {
  it('keeps the order and separates pinned notes', () => {
    const list = [note('a', 'a0', true), note('b', 'a1'), note('c', 'a2', true)]
    const { pinned, others } = splitPinned(list)
    expect(pinned.map((n) => n.id)).toEqual(['a', 'c'])
    expect(others.map((n) => n.id)).toEqual(['b'])
  })
})

describe('reorderKey', () => {
  it('moves a note down to the position of the target', () => {
    const key = reorderKey(section, 'a', 'c')
    expect(key).not.toBeNull()
    expect(sequenceAfter('a', key!)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a note up to the position of the target', () => {
    const key = reorderKey(section, 'd', 'b')
    expect(sequenceAfter('d', key!)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves to the ends', () => {
    expect(sequenceAfter('b', reorderKey(section, 'b', 'd')!)).toEqual(['a', 'c', 'd', 'b'])
    expect(sequenceAfter('c', reorderKey(section, 'c', 'a')!)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('returns null when nothing changes or an id is unknown', () => {
    expect(reorderKey(section, 'b', 'b')).toBeNull()
    expect(reorderKey(section, 'x', 'b')).toBeNull()
    expect(reorderKey(section, 'b', 'x')).toBeNull()
  })
})
