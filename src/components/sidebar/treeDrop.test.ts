import { describe, expect, it } from 'vitest'
import { byOrder } from '../../lib/order'
import type { Folder, Note } from '../../lib/types'
import { dropZone, resolveTreeDrop, type DropResult } from './treeDrop'

function note(id: string, order: string, folderId: string | null, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: id,
    content: '',
    preview: '',
    folderId,
    order,
    pinned: false,
    color: null,
    trashed: false,
    trashedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

function folder(id: string, order: string, parentId: string | null): Folder {
  return { id, name: id, parentId, order, createdAt: 0, updatedAt: 0 }
}

function byId<T extends { id: string }>(...items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]))
}

// Árbol de prueba:
// raíz: carpetas A (con A1 > A1a), B; notas r1, r2, r3 (r3 fijada)
// A: notas a1, a2, a3 (a2 fijada) · B: vacía
const folders = byId(
  folder('A', 'a0', null),
  folder('B', 'a1', null),
  folder('A1', 'a0', 'A'),
  folder('A2', 'a1', 'A'),
  folder('A1a', 'a0', 'A1'),
)
const notes = byId(
  note('r1', 'a0', null),
  note('r2', 'a2', null),
  note('r3', 'a4', null, { pinned: true }),
  note('a1', 'a1', 'A'),
  note('a2', 'a3', 'A', { pinned: true }),
  note('a3', 'a5', 'A'),
  note('t1', 'a6', 'A', { trashed: true, trashedAt: 1 }),
)

/** Ids de las notas visibles (no fijadas) del contenedor tras aplicar el resultado. */
function noteSequence(result: DropResult, folderId: string | null, pinned = false): string[] {
  if (!result || result.kind !== 'note') throw new Error('expected a note result')
  const moved = { ...notes[result.id], folderId: result.folderId, order: result.order }
  return Object.values({ ...notes, [moved.id]: moved })
    .filter((n) => !n.trashed && n.pinned === pinned && (pinned || n.folderId === folderId))
    .sort(byOrder)
    .map((n) => n.id)
}

/** Ids de las carpetas hijas de `parentId` tras aplicar el resultado. */
function folderSequence(result: DropResult, parentId: string | null): string[] {
  if (!result || result.kind !== 'folder') throw new Error('expected a folder result')
  const moved = { ...folders[result.id], parentId: result.parentId, order: result.order }
  return Object.values({ ...folders, [moved.id]: moved })
    .filter((f) => f.parentId === parentId)
    .sort(byOrder)
    .map((f) => f.id)
}

describe('dropZone', () => {
  it('splits note rows in halves', () => {
    expect(dropZone('note', { kind: 'note', id: 'x', section: 'tree' }, 0.3)).toBe('before')
    expect(dropZone('note', { kind: 'note', id: 'x', section: 'tree' }, 0.7)).toBe('after')
    expect(dropZone('folder', { kind: 'note', id: 'x', section: 'tree' }, 0.2)).toBe('before')
  })

  it('always drops notes into folder rows', () => {
    for (const ratio of [0.05, 0.5, 0.95]) expect(dropZone('note', { kind: 'folder', id: 'A' }, ratio)).toBe('into')
  })

  it('uses 25% bands before/after for folders over folders', () => {
    expect(dropZone('folder', { kind: 'folder', id: 'A' }, 0.1)).toBe('before')
    expect(dropZone('folder', { kind: 'folder', id: 'A' }, 0.5)).toBe('into')
    expect(dropZone('folder', { kind: 'folder', id: 'A' }, 0.9)).toBe('after')
  })

  it('treats the root zone as into', () => {
    expect(dropZone('note', { kind: 'root' }, 0.1)).toBe('into')
    expect(dropZone('folder', { kind: 'root' }, 0.9)).toBe('into')
  })
})

describe('resolveTreeDrop: notes', () => {
  it('reorders a note before or after another in the same folder', () => {
    const before = resolveTreeDrop({ kind: 'note', id: 'a3' }, { kind: 'note', id: 'a1', section: 'tree' }, 'before', notes, folders)
    expect(before).toMatchObject({ kind: 'note', id: 'a3', folderId: 'A' })
    expect(noteSequence(before, 'A')).toEqual(['a3', 'a1'])

    const after = resolveTreeDrop({ kind: 'note', id: 'a1' }, { kind: 'note', id: 'a3', section: 'tree' }, 'after', notes, folders)
    expect(noteSequence(after, 'A')).toEqual(['a3', 'a1'])
  })

  it('moves a note next to a note of another folder', () => {
    const result = resolveTreeDrop({ kind: 'note', id: 'r2' }, { kind: 'note', id: 'a3', section: 'tree' }, 'before', notes, folders)
    expect(result).toMatchObject({ kind: 'note', id: 'r2', folderId: 'A' })
    expect(noteSequence(result, 'A')).toEqual(['a1', 'r2', 'a3'])
  })

  it('drops a note into a folder at the top of its notes', () => {
    const result = resolveTreeDrop({ kind: 'note', id: 'r2' }, { kind: 'folder', id: 'A' }, 'into', notes, folders)
    expect(result).toMatchObject({ kind: 'note', id: 'r2', folderId: 'A' })
    expect(noteSequence(result, 'A')).toEqual(['r2', 'a1', 'a3'])
  })

  it('keeps the order when dropped into an empty folder', () => {
    const result = resolveTreeDrop({ kind: 'note', id: 'r2' }, { kind: 'folder', id: 'B' }, 'into', notes, folders)
    expect(result).toEqual({ kind: 'note', id: 'r2', folderId: 'B', order: 'a2' })
  })

  it('moves a note to the end of the root notes with the root zone', () => {
    const result = resolveTreeDrop({ kind: 'note', id: 'a1' }, { kind: 'root' }, 'into', notes, folders)
    expect(result).toMatchObject({ kind: 'note', id: 'a1', folderId: null })
    expect(noteSequence(result, null)).toEqual(['r1', 'r2', 'a1'])
  })

  it('reorders pinned notes inside the pinned section without changing their folder', () => {
    const result = resolveTreeDrop({ kind: 'note', id: 'r3' }, { kind: 'note', id: 'a2', section: 'pinned' }, 'before', notes, folders)
    expect(result).toMatchObject({ kind: 'note', id: 'r3', folderId: null })
    expect(noteSequence(result, null, true)).toEqual(['r3', 'a2'])
  })

  it('does not drop an unpinned note into the pinned section', () => {
    expect(resolveTreeDrop({ kind: 'note', id: 'r1' }, { kind: 'note', id: 'a2', section: 'pinned' }, 'after', notes, folders)).toBeNull()
  })

  it('lets a pinned note move to another folder', () => {
    const result = resolveTreeDrop({ kind: 'note', id: 'a2' }, { kind: 'folder', id: 'B' }, 'into', notes, folders)
    expect(result).toMatchObject({ kind: 'note', id: 'a2', folderId: 'B' })
  })

  it('ignores drops on itself, missing targets and trashed notes', () => {
    expect(resolveTreeDrop({ kind: 'note', id: 'r1' }, { kind: 'note', id: 'r1', section: 'tree' }, 'after', notes, folders)).toBeNull()
    expect(resolveTreeDrop({ kind: 'note', id: 'r1' }, { kind: 'folder', id: 'nope' }, 'into', notes, folders)).toBeNull()
    expect(resolveTreeDrop({ kind: 'note', id: 't1' }, { kind: 'folder', id: 'B' }, 'into', notes, folders)).toBeNull()
  })
})

describe('resolveTreeDrop: folders', () => {
  it('places a folder before or after a sibling of the target', () => {
    const before = resolveTreeDrop({ kind: 'folder', id: 'B' }, { kind: 'folder', id: 'A' }, 'before', notes, folders)
    expect(before).toMatchObject({ kind: 'folder', id: 'B', parentId: null })
    expect(folderSequence(before, null)).toEqual(['B', 'A'])

    const after = resolveTreeDrop({ kind: 'folder', id: 'B' }, { kind: 'folder', id: 'A1' }, 'after', notes, folders)
    expect(after).toMatchObject({ kind: 'folder', id: 'B', parentId: 'A' })
    expect(folderSequence(after, 'A')).toEqual(['A1', 'B', 'A2'])
  })

  it('drops a folder into another at the end of its children', () => {
    const result = resolveTreeDrop({ kind: 'folder', id: 'B' }, { kind: 'folder', id: 'A' }, 'into', notes, folders)
    expect(result).toMatchObject({ kind: 'folder', id: 'B', parentId: 'A' })
    expect(folderSequence(result, 'A')).toEqual(['A1', 'A2', 'B'])
  })

  it('never moves a folder into itself or its descendants', () => {
    expect(resolveTreeDrop({ kind: 'folder', id: 'A' }, { kind: 'folder', id: 'A' }, 'into', notes, folders)).toBeNull()
    expect(resolveTreeDrop({ kind: 'folder', id: 'A' }, { kind: 'folder', id: 'A1' }, 'into', notes, folders)).toBeNull()
    expect(resolveTreeDrop({ kind: 'folder', id: 'A' }, { kind: 'folder', id: 'A1a' }, 'before', notes, folders)).toBeNull()
    expect(resolveTreeDrop({ kind: 'folder', id: 'A' }, { kind: 'note', id: 'a1', section: 'tree' }, 'before', notes, folders)).toBeNull()
  })

  it('moves a folder to the note container when dropped on a note row', () => {
    const result = resolveTreeDrop({ kind: 'folder', id: 'A1' }, { kind: 'note', id: 'r1', section: 'tree' }, 'after', notes, folders)
    expect(result).toMatchObject({ kind: 'folder', id: 'A1', parentId: null })
    expect(folderSequence(result, null)).toEqual(['A', 'B', 'A1'])
  })

  it('does not drop folders on the pinned section', () => {
    expect(resolveTreeDrop({ kind: 'folder', id: 'B' }, { kind: 'note', id: 'r3', section: 'pinned' }, 'before', notes, folders)).toBeNull()
  })

  it('moves a folder to the end of the root folders with the root zone', () => {
    const result = resolveTreeDrop({ kind: 'folder', id: 'A1a' }, { kind: 'root' }, 'into', notes, folders)
    expect(result).toMatchObject({ kind: 'folder', id: 'A1a', parentId: null })
    expect(folderSequence(result, null)).toEqual(['A', 'B', 'A1a'])
  })
})

describe('resolveTreeDrop with data from two devices', () => {
  it('places a folder dropped next to one on a parent cycle at the top level, where that folder is shown', () => {
    const cyclic = byId(folder('X', 'a0', 'Y'), folder('Y', 'a1', 'X'), folder('M', 'a2', null))
    const result = resolveTreeDrop({ kind: 'folder', id: 'M' }, { kind: 'folder', id: 'X' }, 'before', {}, cyclic)
    expect(result).toMatchObject({ kind: 'folder', id: 'M', parentId: null })
    expect((result as { order: string }).order < 'a0').toBe(true)
  })

  it('a note dropped after one of two notes sharing an order key goes before the next note, not tied with it', () => {
    const dup = byId(note('n1', 'a0', null), note('n2', 'a1', null), note('n3', 'a1', null), note('n4', 'a2', null), note('m', 'a5', null))
    const result = resolveTreeDrop({ kind: 'note', id: 'm' }, { kind: 'note', id: 'n2', section: 'tree' }, 'after', dup, {})
    const order = (result as { order: string }).order
    expect(order > 'a1' && order < 'a2').toBe(true)
  })
})
