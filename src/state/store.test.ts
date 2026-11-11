import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotMeta, WriteOp } from '../lib/backend'
import type { Invite } from '../lib/sharing'
import type { AppUser, Folder, Note } from '../lib/types'

// Backend falso: registra escrituras, suscripciones y borrados de ficheros.
const fake = vi.hoisted(() => {
  type Handlers = {
    notes: (notes: Note[], meta: SnapshotMeta) => void
    folders: (folders: Folder[], meta: SnapshotMeta) => void
    error: (error: Error) => void
  }
  type SharedHandlers = {
    notes: (notes: Note[], meta: SnapshotMeta) => void
    invites: (invites: Invite[]) => void
    error: (error: Error) => void
  }
  let seq = 0
  const state = {
    auth: null as ((user: AppUser | null) => void) | null,
    handlers: [] as Handlers[],
    shared: [] as SharedHandlers[],
  }
  const backend = {
    kind: 'memory' as const,
    onAuthChange: (cb: (user: AppUser | null) => void) => {
      state.auth = cb
      return () => undefined
    },
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    waitForSync: vi.fn(async (_ms: number) => true),
    subscribe: vi.fn((_uid: string, handlers: Handlers) => {
      state.handlers.push(handlers)
      return () => undefined
    }),
    subscribeShared: vi.fn((_uid: string, _email: string, handlers: SharedHandlers) => {
      state.shared.push(handlers)
      return () => undefined
    }),
    share: vi.fn(async (_uid: string, _noteId: string, _ownerEmail: string, _email: string) => undefined),
    acceptShare: vi.fn(async (_ownerUid: string, _noteId: string, _email: string, _prefs: object) => undefined),
    removeShare: vi.fn(async (_ownerUid: string, _noteId: string, _email: string) => undefined),
    newId: () => `new${++seq}`,
    write: vi.fn(async (_uid: string, _ops: WriteOp[]) => undefined),
    uploadFile: vi.fn(),
    deleteNoteFiles: vi.fn(async (_uid: string, _noteId: string, _keep: Set<string>) => undefined),
    deleteFile: vi.fn(async (_uid: string, _path: string) => undefined),
  }
  return { state, backend }
})

vi.mock('../lib/backend', () => ({ backend: fake.backend, backendError: null }))

import {
  acceptInvite,
  closeNote,
  createConflictCopy,
  createFolder,
  createNote,
  deleteAttachmentFile,
  deleteFolder,
  deleteNoteForever,
  discardRejected,
  emptyTrash,
  hasUnsyncedChanges,
  initApp,
  isPermanentUploadError,
  leaveSharedNote,
  markDirty,
  MAX_UPLOAD_BYTES,
  moveNote,
  openNote,
  QUEUED_UPLOAD_KEY,
  referencedPaths,
  registerFlush,
  rejectInvite,
  rejectedVersion,
  renameFolder,
  selectSyncStatus,
  setColor,
  setNoteOrder,
  setPinned,
  shareNote,
  signIn,
  signOut,
  stopSharing,
  trashNote,
  updateNote,
  UPLOAD_KEY,
  uploadAttachment,
  useApp,
} from './store'

const user: AppUser = { uid: 'u1', name: 'Ana', email: 'ana@example.com', photoURL: null }
const meta: SnapshotMeta = { pendingWrites: false, fromCache: false }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function doc(...inline: object[]): string {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: inline }] })
}
const text = (value: string) => ({ type: 'text', text: value })
const chip = (id: string, path: string) => ({
  type: 'attachment',
  attrs: { id, url: `https://files/${id}`, path, name: `${id}.pdf`, mime: 'application/pdf', size: 1, status: 'done' },
})

function note(id: string, patch: Partial<Note> = {}): Note {
  return {
    id,
    title: id,
    content: doc(text(`texto ${id}`)),
    preview: '',
    folderId: null,
    order: 'a0',
    pinned: false,
    color: null,
    trashed: false,
    trashedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function setNotes(...list: Note[]) {
  useApp.setState({ notes: Object.fromEntries(list.map((n) => [n.id, n])) })
}

const writtenOps = () => fake.backend.write.mock.calls.flatMap(([, ops]) => ops)
const writtenData = () =>
  writtenOps().map((op) => (op.type === 'setNote' ? (op.data as Partial<Note>) : {}))
const lastHandlers = () => fake.state.handlers[fake.state.handlers.length - 1]
const sharedHandlers = () => fake.state.shared[fake.state.shared.length - 1]

beforeAll(() => initApp())

beforeEach(() => {
  vi.clearAllMocks()
  fake.state.auth?.(user)
  useApp.setState({
    notes: {},
    folders: {},
    view: { kind: 'notes', folderId: null },
    sync: { online: true, serverPending: false, fromCache: false, dirty: [], error: null, listenerError: null, tooLarge: [], rejected: {} },
  })
  Object.keys(localStorage)
    .filter((key) => key.startsWith('kaze:rejected:'))
    .forEach((key) => localStorage.removeItem(key))
})

afterEach(() => vi.useRealTimers())

describe('data snapshots', () => {
  it('keeps the same records when a snapshot brings no changes', () => {
    const a = note('a')
    const b = note('b')
    const folder: Folder = { id: 'f', name: 'F', parentId: null, order: 'a0', createdAt: 1, updatedAt: 1 }
    lastHandlers().notes([a, b], meta)
    lastHandlers().folders([folder], meta)
    const before = useApp.getState()
    lastHandlers().notes([{ ...a }, { ...b }], meta)
    lastHandlers().folders([{ ...folder }], meta)
    expect(useApp.getState().notes).toBe(before.notes)
    expect(useApp.getState().folders).toBe(before.folders)
  })

  it('still replaces changed records and reuses the unchanged ones', () => {
    const a = note('a')
    const b = note('b')
    lastHandlers().notes([a, b], meta)
    const before = useApp.getState().notes
    lastHandlers().notes([{ ...a, title: 'nuevo' }, { ...b }], meta)
    const after = useApp.getState().notes
    expect(after).not.toBe(before)
    expect(after.a.title).toBe('nuevo')
    expect(after.b).toBe(before.b)
    lastHandlers().notes([{ ...b }], meta)
    expect(Object.keys(useApp.getState().notes)).toEqual(['b'])
  })

  it('takes a change of revision alone', () => {
    const a = note('a', { rev: 1 })
    lastHandlers().notes([a], meta)
    lastHandlers().notes([{ ...a, rev: 2, baseRev: 1, device: 'other-device' }], meta)
    expect(useApp.getState().notes.a.rev).toBe(2)
  })
})

describe('edits overwritten by another device', () => {
  const mine = doc(text('versión de aquí'))
  const theirs = doc(text('versión del iPad'))
  /** Escritura de otro dispositivo que partió de la revisión 4 (no vio la 5 que hay aquí). */
  const fromOlderBase = (n: Note): Note => ({ ...n, content: theirs, rev: 5, baseRev: 4, device: 'other-device' })

  it('stamps each title or text save with the next revision and this page, and leaves metadata changes unstamped', async () => {
    setNotes(note('a', { rev: 3, order: 'a1' }), note('b'))
    updateNote('a', { title: 'T' })
    updateNote('a', { content: doc(text('hola')), preview: 'hola' })
    updateNote('b', { title: 'B' })
    setPinned('a', true)
    setColor('a', 'mint')
    setNoteOrder('a', 'a3')
    await settle()
    const [first, second, other, ...metadata] = writtenData()
    expect(first).toMatchObject({ title: 'T', baseRev: 3, rev: 4, device: expect.any(String) })
    // Los guardados seguidos de esta página parten de la misma versión: la última que vio de otro dispositivo.
    expect(second).toMatchObject({ baseRev: 3, rev: 5, device: first.device })
    expect(other).toMatchObject({ baseRev: 0, rev: 1, device: first.device })
    expect(metadata).toHaveLength(3)
    for (const data of metadata) {
      for (const key of ['rev', 'baseRev', 'device']) expect(data).not.toHaveProperty(key)
    }
    expect(useApp.getState().notes.a).toMatchObject({ rev: 5, baseRev: 3, device: first.device })
  })

  it('every save in a row from this page keeps the base it started from, so an offline chain shows what it missed', async () => {
    setNotes(note('a', { rev: 3 }))
    updateNote('a', { title: 'T1' })
    updateNote('a', { title: 'T2' })
    updateNote('a', { title: 'T3' })
    await settle()
    expect(writtenData().map((d) => [d.baseRev, d.rev])).toEqual([
      [3, 4],
      [3, 5],
      [3, 6],
    ])
  })

  it('a save after a version from another device starts from that version', async () => {
    setNotes(note('a', { rev: 7, baseRev: 3, device: 'tablet' }))
    updateNote('a', { title: 'T' })
    await settle()
    expect(writtenData()[0]).toMatchObject({ baseRev: 7, rev: 8 })
  })

  it('makes no copy when a device replaces its own earlier version', () => {
    const a = note('a', { content: mine, rev: 6, baseRev: 5, device: 'tablet' })
    lastHandlers().notes([a], meta)
    lastHandlers().notes([{ ...a, content: theirs, rev: 8, baseRev: 5 }], meta)
    expect(fake.backend.write).not.toHaveBeenCalled()
  })

  it('keeps the version saved here when another device that saved more times offline replaces it', () => {
    setNotes(note('a', { content: doc(text('base')), rev: 5 }))
    updateNote('a', { content: mine })
    const here = useApp.getState().notes.a
    // La tableta guardó cuatro veces sin conexión partiendo de la revisión 5; aquí solo se guardó una.
    lastHandlers().notes([{ ...here, content: theirs, rev: 9, baseRev: 5, device: 'tablet' }], meta)
    const copies = Object.values(useApp.getState().notes).filter((n) => n.id !== 'a')
    expect(copies.map((n) => n.content)).toEqual([mine])
  })

  it('keeps the version that a write based on an older revision replaced as a conflict copy next to the note', () => {
    const a = note('a', { order: 'a1', title: 'Lista', content: mine, rev: 5, color: 'mint' })
    const b = note('b', { order: 'a2' })
    lastHandlers().notes([a, b], meta)
    lastHandlers().notes([fromOlderBase(a), b], meta)
    const { notes } = useApp.getState()
    expect(notes.a.content).toBe(theirs)
    const copies = Object.values(notes).filter((n) => n.id !== 'a' && n.id !== 'b')
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ title: 'Lista (conflict)', content: mine, color: 'mint', pinned: false, trashed: false })
    expect(copies[0].order > 'a1' && copies[0].order < 'a2').toBe(true)
    expect(writtenOps()).toEqual([expect.objectContaining({ type: 'setNote', id: copies[0].id })])
  })

  it('names the copy after the replaced version, so seeing the same overwrite again writes the same copy', () => {
    const a = note('a', { title: 'Lista', content: mine, rev: 5 })
    setNotes(a)
    lastHandlers().notes([fromOlderBase(a)], meta)
    // Otro dispositivo que tenía la misma versión ve la misma sobrescritura.
    setNotes(a)
    lastHandlers().notes([fromOlderBase(a)], meta)
    // Otra versión sustituida con la misma revisión no choca con la anterior.
    const other = note('a', { title: 'Lista', content: doc(text('otra versión')), rev: 5 })
    setNotes(other)
    lastHandlers().notes([fromOlderBase(other)], meta)
    const ids = writtenOps().map((op) => op.id)
    expect(ids).toHaveLength(3)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
    expect(ids.every((id) => id !== 'a')).toBe(true)
  })

  it('does not write the copy again when it already exists (it may have been edited since)', () => {
    const a = note('a', { title: 'Lista', content: mine, rev: 5 })
    setNotes(a)
    lastHandlers().notes([fromOlderBase(a)], meta)
    const [copyId] = writtenOps().map((op) => op.id)
    const edited = { ...useApp.getState().notes[copyId], content: doc(text('copia editada')) }
    vi.clearAllMocks()
    setNotes(a, edited)
    lastHandlers().notes([fromOlderBase(a), edited], meta)
    expect(fake.backend.write).not.toHaveBeenCalled()
    expect(useApp.getState().notes[copyId].content).toBe(doc(text('copia editada')))
  })

  it('ignores a late echo of an earlier write from this same page', async () => {
    setNotes(note('a', { title: 'Lista', content: mine }))
    updateNote('a', { content: doc(text('v1')) })
    updateNote('a', { content: doc(text('v2')) })
    await settle()
    const [firstWrite] = writtenData()
    expect(firstWrite).toMatchObject({ rev: 1, baseRev: 0, device: expect.any(String) })
    // Llega tarde el eco de la primera escritura, ya superada por la segunda.
    lastHandlers().notes([{ ...useApp.getState().notes.a, ...firstWrite }], meta)
    expect(writtenOps()).toHaveLength(2)
  })

  it('keeps the replaced version as a copy even while the note has unsaved changes in the editor', () => {
    const a = note('a', { content: mine, rev: 5 })
    lastHandlers().notes([a], meta)
    markDirty('note:a')
    lastHandlers().notes([fromOlderBase(a)], meta)
    // El editor solo conserva los campos que se están editando aquí: el resto de esta versión iría a parar a ninguna parte.
    const copies = Object.values(useApp.getState().notes).filter((n) => n.id !== 'a')
    expect(copies.map((n) => n.content)).toEqual([mine])
  })

  it('makes no copy for a text change that carries no new revision (an older app version)', () => {
    const a = note('a', { content: mine, rev: 5, baseRev: 4, device: 'other-device' })
    lastHandlers().notes([a], meta)
    lastHandlers().notes([{ ...a, content: theirs }], meta)
    expect(fake.backend.write).not.toHaveBeenCalled()
  })

  it('makes no copy for a write based on the latest revision', () => {
    const a = note('a', { content: mine, rev: 5 })
    lastHandlers().notes([a], meta)
    lastHandlers().notes([{ ...a, content: theirs, rev: 6, baseRev: 5, device: 'other-device' }], meta)
    expect(fake.backend.write).not.toHaveBeenCalled()
    expect(useApp.getState().notes.a.content).toBe(theirs)
  })
})

describe('notes too large for Firestore', () => {
  const message = 'This note is too large to save (max 1 MB)'

  it('refuses to write a note over the limit and keeps a sync error until a later save fits', async () => {
    setNotes(note('a'), note('b'))
    const original = useApp.getState().notes.a.content
    expect(updateNote('a', { content: 'x'.repeat(950_000) })).toBe(false)
    expect(fake.backend.write).not.toHaveBeenCalled()
    expect(useApp.getState().notes.a.content).toBe(original)
    expect(selectSyncStatus(useApp.getState())).toBe('error')
    expect(useApp.getState().sync.error).toBe(message)

    // Una escritura correcta de otra nota no oculta el error.
    setPinned('b', true)
    await settle()
    expect(fake.backend.write).toHaveBeenCalledTimes(1)
    expect(useApp.getState().sync.error).toBe(message)

    expect(updateNote('a', { content: doc(text('corto')) })).toBe(true)
    await settle()
    expect(useApp.getState().notes.a.content).toBe(doc(text('corto')))
    expect(writtenOps()).toContainEqual(expect.objectContaining({ type: 'setNote', id: 'a' }))
    expect(useApp.getState().sync.error).toBeNull()
    expect(selectSyncStatus(useApp.getState())).toBe('synced')
  })

  it('measures UTF-8 bytes, not characters', () => {
    setNotes(note('a'))
    expect(updateNote('a', { content: 'ñ'.repeat(470_000) })).toBe(false)
    expect(fake.backend.write).not.toHaveBeenCalled()
  })

  it('still writes normal edits', async () => {
    setNotes(note('a'))
    expect(updateNote('a', { title: 'T', content: doc(text('hola')), preview: 'hola' })).toBe(true)
    await settle()
    expect(writtenOps()).toEqual([
      { type: 'setNote', id: 'a', data: expect.objectContaining({ title: 'T', content: doc(text('hola')), preview: 'hola' }) },
    ])
    expect(useApp.getState().notes.a.title).toBe('T')
  })
})

describe('conflict copies', () => {
  it('saves the other version as a new note right after the original, without opening or pinning it', () => {
    setNotes(
      note('a', { order: 'a1', title: 'Lista', folderId: 'f1', color: 'mint', pinned: true }),
      note('b', { order: 'a2' }),
    )
    useApp.setState({ view: { kind: 'note', noteId: 'a' } })
    const remote = doc(text('TEXTO DEL MOVIL'))
    const id = createConflictCopy('a', { title: 'Lista', content: remote })
    const copy = useApp.getState().notes[id]
    expect(copy).toMatchObject({
      title: 'Lista (conflict)',
      content: remote,
      preview: 'TEXTO DEL MOVIL',
      folderId: 'f1',
      color: 'mint',
      pinned: false,
      trashed: false,
    })
    expect(copy.order > 'a1' && copy.order < 'a2').toBe(true)
    expect(useApp.getState().view).toEqual({ kind: 'note', noteId: 'a' })
    expect(useApp.getState().notes.a.content).toBe(note('a').content)
    expect(writtenOps()).toContainEqual(expect.objectContaining({ type: 'setNote', id }))
  })
})

describe('attachment files shared between notes', () => {
  it('collects the Storage paths of every note, trashed included, except the excluded one', () => {
    setNotes(
      note('a', { content: doc(chip('x', 'users/u1/notes/a/1-x.pdf')) }),
      note('b', { trashed: true, content: doc(text('ver '), chip('y', 'users/u1/notes/a/2-y.pdf')) }),
      note('c', { content: 'no es json' }),
    )
    expect(referencedPaths()).toEqual(new Set(['users/u1/notes/a/1-x.pdf', 'users/u1/notes/a/2-y.pdf']))
    expect(referencedPaths('a')).toEqual(new Set(['users/u1/notes/a/2-y.pdf']))
  })

  it('deleting a note forever keeps the files other notes still use', async () => {
    setNotes(
      note('a', { trashed: true, content: doc(chip('x', 'users/u1/notes/a/1-x.pdf'), chip('y', 'users/u1/notes/a/2-y.pdf')) }),
      note('b', { content: doc(chip('y2', 'users/u1/notes/a/2-y.pdf')) }),
    )
    deleteNoteForever('a')
    await settle()
    expect(writtenOps()).toEqual([{ type: 'deleteNote', id: 'a' }])
    expect(useApp.getState().notes.a).toBeUndefined()
    expect(fake.backend.deleteNoteFiles).toHaveBeenCalledWith('u1', 'a', new Set(['users/u1/notes/a/2-y.pdf']))
  })

  it('emptying the trash keeps only the files used by the remaining notes', async () => {
    setNotes(
      note('a', { trashed: true, content: doc(chip('x', 'users/u1/notes/a/1-x.pdf')) }),
      note('b', { trashed: true, content: doc(chip('x2', 'users/u1/notes/a/1-x.pdf')) }),
      note('c', { content: doc(chip('z', 'users/u1/notes/b/3-z.pdf')) }),
    )
    emptyTrash()
    await settle()
    expect(writtenOps()).toEqual([
      { type: 'deleteNote', id: 'a' },
      { type: 'deleteNote', id: 'b' },
    ])
    expect(Object.keys(useApp.getState().notes)).toEqual(['c'])
    expect(fake.backend.deleteNoteFiles).toHaveBeenCalledTimes(2)
    for (const id of ['a', 'b']) {
      expect(fake.backend.deleteNoteFiles).toHaveBeenCalledWith('u1', id, new Set(['users/u1/notes/b/3-z.pdf']))
    }
  })

  it('deletes an attachment file only when no note uses it any more', async () => {
    const path = 'users/u1/notes/a/1-x.pdf'
    setNotes(note('a', { content: doc(text('sin adjunto')) }), note('b', { content: doc(chip('x2', path)) }))
    await deleteAttachmentFile(path, 'a')
    expect(fake.backend.deleteFile).not.toHaveBeenCalled()

    setNotes(note('a', { content: doc(chip('x', path), text(' y otra vez ')) }), note('b'))
    await deleteAttachmentFile(path, 'a')
    expect(fake.backend.deleteFile).not.toHaveBeenCalled()

    setNotes(note('a', { content: doc(text('sin adjunto')) }), note('b'))
    await deleteAttachmentFile(path, 'a')
    expect(fake.backend.deleteFile).toHaveBeenCalledWith('u1', path)
  })

  it('saves the open note before checking, so the removed chip no longer counts', async () => {
    const path = 'users/u1/notes/a/1-x.pdf'
    setNotes(note('a', { content: doc(chip('x', path)) }))
    const unregister = registerFlush(() => updateNote('a', { content: doc(text('ya sin el adjunto')) }))
    await deleteAttachmentFile(path, 'a')
    unregister()
    expect(fake.backend.deleteFile).toHaveBeenCalledWith('u1', path)
  })

  it('closing an empty note discards it and cleans its unused files', async () => {
    setNotes(note('e', { title: '', content: '' }), note('b', { content: doc(chip('k', 'users/u1/notes/e/1-k.pdf')) }))
    useApp.setState({ view: { kind: 'note', noteId: 'e' } })
    closeNote()
    await settle()
    expect(writtenOps()).toEqual([{ type: 'deleteNote', id: 'e' }])
    expect(fake.backend.deleteNoteFiles).toHaveBeenCalledWith('u1', 'e', new Set(['users/u1/notes/e/1-k.pdf']))
    expect(useApp.getState().view).toEqual({ kind: 'notes', folderId: null })
  })

  it('closing a new untitled note whose save was refused as too large keeps it and its files', async () => {
    setNotes(note('e', { title: '', content: '' }))
    useApp.setState({ view: { kind: 'note', noteId: 'e' } })
    expect(updateNote('e', { content: 'x'.repeat(950_000) })).toBe(false)
    closeNote()
    await settle()
    expect(fake.backend.write).not.toHaveBeenCalled()
    expect(fake.backend.deleteNoteFiles).not.toHaveBeenCalled()
    expect(useApp.getState().notes.e).toBeDefined()
    expect(useApp.getState().sync.tooLarge).toEqual(['e'])
    expect(useApp.getState().view).toEqual({ kind: 'notes', folderId: null })
  })

  it('closing a note with content keeps it and its files', async () => {
    setNotes(note('a'))
    useApp.setState({ view: { kind: 'note', noteId: 'a' } })
    closeNote()
    await settle()
    expect(fake.backend.write).not.toHaveBeenCalled()
    expect(fake.backend.deleteNoteFiles).not.toHaveBeenCalled()
    expect(useApp.getState().notes.a).toBeDefined()
  })
})

describe('records deleted on another device', () => {
  it('drops changes to a note or folder that no longer exists, while new ones are still created', async () => {
    setNotes(note('a', { order: 'a1' }))
    setPinned('gone', true)
    renameFolder('gone-folder', 'Nueva')
    await settle()
    expect(fake.backend.write).not.toHaveBeenCalled()
    expect(useApp.getState().notes.gone).toBeUndefined()
    expect(useApp.getState().folders['gone-folder']).toBeUndefined()

    const noteId = createNote(null, false)
    const folderId = createFolder(null, 'Carpeta')
    const copyId = createConflictCopy('a', { title: 'a', content: doc(text('otra versión')) })
    await settle()
    expect(writtenOps().map((op) => [op.type, op.id])).toEqual([
      ['setNote', noteId],
      ['setFolder', folderId],
      ['setNote', copyId],
    ])
    expect(useApp.getState().notes[noteId]).toMatchObject({ title: '', content: '', trashed: false })
    expect(useApp.getState().folders[folderId]).toMatchObject({ name: 'Carpeta', parentId: null })
    expect(useApp.getState().notes[copyId]).toMatchObject({ title: 'a (conflict)', content: doc(text('otra versión')) })
  })
})

describe('sync errors', () => {
  it('clears a sign-in error once signing in succeeds', async () => {
    fake.backend.signIn.mockRejectedValueOnce(new Error('popup blocked'))
    await signIn()
    expect(useApp.getState().sync.error).toBe('popup blocked')
    fake.state.auth?.(user)
    expect(useApp.getState().sync.error).toBeNull()
    expect(selectSyncStatus(useApp.getState())).not.toBe('error')
  })

  it('keeps a listener error over unrelated writes, subscribes again after 10 s and clears it on a snapshot', async () => {
    vi.useFakeTimers()
    setNotes(note('a'))
    const subscriptions = fake.backend.subscribe.mock.calls.length
    lastHandlers().error(new Error('permission-denied'))
    expect(useApp.getState().sync.error).toBe('permission-denied')

    setPinned('a', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.backend.write).toHaveBeenCalledTimes(1)
    expect(selectSyncStatus(useApp.getState())).toBe('error')
    expect(useApp.getState().sync.error).toBe('permission-denied')

    await vi.advanceTimersByTimeAsync(9_000)
    expect(fake.backend.subscribe).toHaveBeenCalledTimes(subscriptions)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.backend.subscribe).toHaveBeenCalledTimes(subscriptions + 1)

    lastHandlers().notes([note('a')], meta)
    expect(useApp.getState().sync.error).toBeNull()
    expect(selectSyncStatus(useApp.getState())).toBe('synced')
  })

  it('does not subscribe again after signing out', async () => {
    vi.useFakeTimers()
    const subscriptions = fake.backend.subscribe.mock.calls.length
    lastHandlers().error(new Error('permission-denied'))
    fake.state.auth?.(null)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fake.backend.subscribe).toHaveBeenCalledTimes(subscriptions)
  })
})

describe('attachment uploads', () => {
  const pdf = (size = 9) => {
    const file = new File(['contenido'], 'billete.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }
  const failure = (code: string) => Object.assign(new Error(code), { code })

  it('a network failure is not a sync error (the file waits in the device queue); a refused file is', async () => {
    fake.backend.uploadFile.mockRejectedValueOnce(failure('storage/retry-limit-exceeded'))
    await expect(uploadAttachment('n1', pdf())).rejects.toThrow()
    expect(useApp.getState().sync.error).toBeNull()

    fake.backend.uploadFile.mockRejectedValueOnce(failure('storage/unauthorized'))
    await expect(uploadAttachment('n1', pdf())).rejects.toThrow()
    expect(useApp.getState().sync.error).toBe('storage/unauthorized')
  })

  it('refuses a file of 100 MB or more as a permanent failure, without uploading it', async () => {
    const error = await uploadAttachment('n1', pdf(MAX_UPLOAD_BYTES)).catch((e: unknown) => e)
    expect(isPermanentUploadError(error)).toBe(true)
    expect(isPermanentUploadError(failure('storage/retry-limit-exceeded'))).toBe(false)
    expect(isPermanentUploadError(failure('offline'))).toBe(false)
    expect(fake.backend.uploadFile).not.toHaveBeenCalled()
  })

  it('leaving the page asks only while a file is not yet safe on this device', () => {
    const leavingAsks = () => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    markDirty(`${QUEUED_UPLOAD_KEY}a1`)
    expect(leavingAsks()).toBe(false)
    markDirty(`${UPLOAD_KEY}a2`)
    expect(leavingAsks()).toBe(true)
  })

  it('files waiting in the device queue show as syncing, or offline without connection', () => {
    markDirty(`${QUEUED_UPLOAD_KEY}a1`)
    expect(selectSyncStatus(useApp.getState())).toBe('syncing')
    useApp.setState((s) => ({ sync: { ...s.sync, online: false } }))
    expect(selectSyncStatus(useApp.getState())).toBe('offline')
  })
})

describe('text the cloud rejects', () => {
  const denied = () => new Error('Missing or insufficient permissions.')
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<undefined>((r) => (resolve = () => r(undefined)))
    return { promise, resolve }
  }

  it('keeps the rejected text on the device, marks the note and shows an error', async () => {
    setNotes(note('n1', { content: doc(text('a')) }))
    fake.backend.write.mockRejectedValueOnce(denied())
    updateNote('n1', { title: 'Plan', content: doc(text('b')) })
    await settle()
    expect(rejectedVersion('n1')).toMatchObject({ title: 'Plan', content: doc(text('b')), reason: denied().message })
    expect(useApp.getState().sync.rejected).toHaveProperty('n1')
    expect(selectSyncStatus(useApp.getState())).toBe('error')
  })

  it('a later save of the note clears it, but an earlier save confirmed after the rejection does not', async () => {
    setNotes(note('n1'))
    const earlier = deferred()
    fake.backend.write.mockImplementationOnce(() => earlier.promise)
    fake.backend.write.mockRejectedValueOnce(denied())
    updateNote('n1', { content: doc(text('b')) })
    updateNote('n1', { content: doc(text('c')) })
    await settle()
    earlier.resolve()
    await settle()
    expect(rejectedVersion('n1')?.content).toBe(doc(text('c')))

    updateNote('n1', { content: doc(text('d')) })
    await settle()
    expect(rejectedVersion('n1')).toBeNull()
    expect(useApp.getState().sync.rejected).toEqual({})
    expect(useApp.getState().sync.error).toBeNull()
  })

  it('is still there after signing in again (e.g. a reload), and discarding it forgets it', async () => {
    setNotes(note('n1'))
    fake.backend.write.mockRejectedValueOnce(denied())
    updateNote('n1', { content: doc(text('b')) })
    await settle()
    fake.state.auth?.(null)
    fake.state.auth?.(user)
    expect(useApp.getState().sync.rejected).toHaveProperty('n1')
    expect(selectSyncStatus(useApp.getState())).toBe('error')
    discardRejected('n1')
    expect(rejectedVersion('n1')).toBeNull()
    expect(useApp.getState().sync.rejected).toEqual({})
  })

  it('keeps nothing for rejected changes that carry no text (pin, color)', async () => {
    setNotes(note('n1'))
    fake.backend.write.mockRejectedValueOnce(denied())
    setPinned('n1', true)
    await settle()
    expect(useApp.getState().sync.rejected).toEqual({})
  })

  it('the cloud undoing a rejected change is not taken for another device overwriting it', async () => {
    setNotes(note('n1', { rev: 5, device: 'other-device' }))
    fake.backend.write.mockRejectedValueOnce(denied())
    updateNote('n1', { content: doc(text('b')) })
    await settle()
    fake.backend.write.mockClear()
    // Vuelve la versión del servidor, de otro dispositivo y con una base anterior a la de aquí.
    lastHandlers().notes([note('n1', { rev: 5, baseRev: 3, device: 'other-device' })], meta)
    await settle()
    expect(writtenOps()).toEqual([])
  })
})

describe('signing out', () => {
  it('reports changes not synced while the cloud has not confirmed every write', async () => {
    expect(await hasUnsyncedChanges()).toBe(false)
    fake.backend.waitForSync.mockResolvedValueOnce(false)
    expect(await hasUnsyncedChanges()).toBe(true)
  })
})

describe('signing out with text rejected in another tab', () => {
  it('counts rejected text another tab of this device kept, not only this tab', async () => {
    localStorage.setItem(
      'kaze:rejected:u1:n9',
      JSON.stringify({ content: doc(text('de otra pestaña')), reason: 'denied', page: 'other-tab', seq: 1 }),
    )
    expect(useApp.getState().sync.rejected).toEqual({})
    expect(await hasUnsyncedChanges()).toBe(true)
  })
})

describe('signing out with changes kept only in this tab', () => {
  it('counts rejected text that could only be kept in memory, and notes too large to save', async () => {
    useApp.setState((s) => ({ sync: { ...s.sync, rejected: { n1: 1 } } }))
    expect(await hasUnsyncedChanges()).toBe(true)
    useApp.setState((s) => ({ sync: { ...s.sync, rejected: {}, tooLarge: ['n2'] } }))
    expect(await hasUnsyncedChanges()).toBe(true)
  })
})

describe('a rejection that arrives while signing out', () => {
  it('does not keep the text on the device again', async () => {
    setNotes(note('n1'))
    let reject!: (error: Error) => void
    fake.backend.write.mockImplementationOnce(() => new Promise((_, r) => (reject = r)))
    updateNote('n1', { content: doc(text('b')) })
    let finish!: () => void
    fake.backend.signOut.mockImplementationOnce(() => new Promise<undefined>((r) => (finish = () => r(undefined))))
    const leaving = signOut()
    await settle()
    reject(new Error('Missing or insufficient permissions.'))
    await settle()
    expect(Object.keys(localStorage).filter((key) => key.startsWith('kaze:rejected:'))).toEqual([])
    finish()
    await leaving
  })
})

describe('notes shared with me', () => {
  const shared = (id: string, patch: Partial<Note> = {}) =>
    note(id, { ownerUid: 'u2', ownerEmail: 'bob@example.com', members: ['ana@example.com'], ...patch })

  it('lists them next to my own notes, keeps them over my own snapshots and hides the ones their owner trashed', () => {
    lastHandlers().notes([note('mine')], meta)
    sharedHandlers().notes([shared('s1'), shared('s2', { trashed: true })], meta)
    expect(Object.keys(useApp.getState().notes).sort()).toEqual(['mine', 's1'])
    lastHandlers().notes([note('mine'), note('mine2')], meta)
    expect(Object.keys(useApp.getState().notes).sort()).toEqual(['mine', 'mine2', 's1'])
  })

  it("sends my edits to the owner's note: text and color on the note, folder, order, pin and lock under my email", async () => {
    lastHandlers().folders([{ id: 'f', name: 'F', parentId: null, order: 'a0', createdAt: 1, updatedAt: 1 }], meta)
    sharedHandlers().notes([shared('s1')], meta)
    updateNote('s1', { title: 'New' })
    setPinned('s1', true)
    setColor('s1', 'sky')
    moveNote('s1', 'f', 'a3')
    await settle()
    expect(writtenOps()).toEqual([
      { type: 'setSharedNote', owner: 'u2', id: 's1', data: expect.objectContaining({ title: 'New', rev: 1, baseRev: 0 }) },
      { type: 'setSharedNote', owner: 'u2', id: 's1', data: { prefs: { 'ana@example.com': { pinned: true } } } },
      { type: 'setSharedNote', owner: 'u2', id: 's1', data: { color: 'sky' } },
      { type: 'setSharedNote', owner: 'u2', id: 's1', data: { prefs: { 'ana@example.com': { folderId: 'f', order: 'a3' } } } },
    ])
    expect(useApp.getState().notes.s1).toMatchObject({ title: 'New', pinned: true, color: 'sky', folderId: 'f', ownerUid: 'u2' })
  })

  it('never trashes or deletes a note shared with me; deleting my folder moves it to the root and trashes my own notes', async () => {
    lastHandlers().folders([{ id: 'f', name: 'F', parentId: null, order: 'a0', createdAt: 1, updatedAt: 1 }], meta)
    lastHandlers().notes([note('mine', { folderId: 'f' })], meta)
    sharedHandlers().notes([shared('s1', { folderId: 'f' })], meta)
    trashNote('s1')
    deleteNoteForever('s1')
    deleteFolder('f')
    await settle()
    // Lo mío y lo de la nota compartida se envían por separado: si se rechaza esto último, lo mío no cuenta como rechazado.
    expect(fake.backend.write.mock.calls.map(([, ops]) => ops)).toEqual([
      [{ type: 'setNote', id: 'mine', data: expect.objectContaining({ trashed: true }) }, { type: 'deleteFolder', id: 'f' }],
      [{ type: 'setSharedNote', owner: 'u2', id: 's1', data: { prefs: { 'ana@example.com': { folderId: null } } } }],
    ])
    expect(fake.backend.deleteNoteFiles).not.toHaveBeenCalled()
    expect(useApp.getState().notes.s1).toMatchObject({ trashed: false, folderId: null })
  })

  it('closing an empty note that is shared (mine or not) keeps it', async () => {
    const empty = { title: '', content: '' }
    lastHandlers().notes([note('mine', { ...empty, members: ['bob@example.com'] })], meta)
    sharedHandlers().notes([shared('s1', empty)], meta)
    openNote('s1')
    openNote('mine')
    closeNote()
    await settle()
    expect(writtenOps()).toEqual([])
  })

  it('removing an attachment uploaded by another account leaves its file alone', async () => {
    sharedHandlers().notes([shared('s1')], meta)
    await deleteAttachmentFile('users/u2/notes/s1/x.pdf', 's1')
    expect(fake.backend.deleteFile).not.toHaveBeenCalled()
  })

  it('leaving a shared note removes me from it, closes it and hides it at once', () => {
    sharedHandlers().notes([shared('s1')], meta)
    openNote('s1')
    leaveSharedNote('s1')
    expect(fake.backend.removeShare).toHaveBeenCalledWith('u2', 's1', 'ana@example.com')
    expect(useApp.getState().view.kind).toBe('notes')
    expect(useApp.getState().notes.s1).toBeUndefined()
  })

  it("a shared snapshot never brings back an older version of my own notes (no spurious conflict copy)", async () => {
    lastHandlers().notes([note('a', { device: 'other', rev: 1, baseRev: 0 })], meta)
    updateNote('a', { title: 'mine' })
    sharedHandlers().notes([shared('s1')], meta)
    await settle()
    expect(useApp.getState().notes.a).toMatchObject({ title: 'mine', rev: 2 })
    expect(writtenOps().map((op) => op.id)).toEqual(['a'])
  })

  it('keeps text the cloud refused for a note that is no longer shared with me as a new note of mine', async () => {
    sharedHandlers().notes([shared('s1', { title: 'Plan' })], meta)
    fake.backend.write.mockRejectedValueOnce(new Error('permission-denied'))
    updateNote('s1', { title: 'Plan', content: doc(text('my late edit')) })
    await settle()
    expect(useApp.getState().sync.rejected).toHaveProperty('s1')
    lastHandlers().notes([], meta)
    lastHandlers().folders([], meta)
    sharedHandlers().notes([], meta)
    await settle()
    const copies = Object.values(useApp.getState().notes)
    expect(copies).toEqual([expect.objectContaining({ title: 'Plan (conflict)', content: doc(text('my late edit')), folderId: null })])
    expect(copies[0].ownerUid).toBeUndefined()
    expect(useApp.getState().sync.rejected).toEqual({})
    expect(rejectedVersion('s1')).toBeNull()
  })

  it('a failing shared listener shows an error and only that listener subscribes again after 10 s', async () => {
    vi.useFakeTimers()
    const own = fake.backend.subscribe.mock.calls.length
    const sharedCount = fake.backend.subscribeShared.mock.calls.length
    sharedHandlers().error(new Error('index missing'))
    expect(useApp.getState().sync.error).toBe('index missing')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.backend.subscribeShared).toHaveBeenCalledTimes(sharedCount + 1)
    expect(fake.backend.subscribe).toHaveBeenCalledTimes(own)
  })
})

describe('sharing my notes', () => {
  it('invites a trimmed lowercase email', () => {
    lastHandlers().notes([note('n1')], meta)
    expect(shareNote('n1', ' Bob@Example.com ')).toBeNull()
    expect(fake.backend.share).toHaveBeenCalledWith('u1', 'n1', 'ana@example.com', 'bob@example.com')
  })

  it('refuses an invalid email, my own email and someone already invited or a member', () => {
    lastHandlers().notes([note('n1', { invited: ['c@example.com'], members: ['d@example.com'] })], meta)
    for (const email of ['nope', 'ANA@example.com', 'c@example.com', 'd@example.com']) expect(shareNote('n1', email)).toEqual(expect.any(String))
    expect(fake.backend.share).not.toHaveBeenCalled()
  })

  it('only the owner adds people', () => {
    sharedHandlers().notes([note('s1', { ownerUid: 'u2', members: ['ana@example.com'] })], meta)
    expect(shareNote('s1', 'e@example.com')).toEqual(expect.any(String))
    expect(fake.backend.share).not.toHaveBeenCalled()
  })

  it('deleting a note forever, or emptying the trash, withdraws its pending invitations', async () => {
    lastHandlers().notes(
      [note('n1', { invited: ['bob@example.com'], trashed: true }), note('n2', { invited: ['c@example.com'], trashed: true })],
      meta,
    )
    deleteNoteForever('n1')
    expect(fake.backend.removeShare).toHaveBeenCalledWith('u1', 'n1', 'bob@example.com')
    emptyTrash()
    expect(fake.backend.removeShare).toHaveBeenCalledWith('u1', 'n2', 'c@example.com')
    await settle()
    expect(writtenOps()).toEqual([
      { type: 'deleteNote', id: 'n1' },
      { type: 'deleteNote', id: 'n2' },
    ])
  })

  it('stops sharing with one person', () => {
    lastHandlers().notes([note('n1', { members: ['bob@example.com'] })], meta)
    stopSharing('n1', 'bob@example.com')
    expect(fake.backend.removeShare).toHaveBeenCalledWith('u1', 'n1', 'bob@example.com')
  })

  it('shows an error when the cloud refuses a sharing change', async () => {
    lastHandlers().notes([note('n1')], meta)
    fake.backend.share.mockRejectedValueOnce(new Error('permission-denied'))
    shareNote('n1', 'bob@example.com')
    await settle()
    expect(useApp.getState().sync.error).toBe('permission-denied')
  })
})

describe('invitations', () => {
  const invite: Invite = { noteId: 's1', ownerUid: 'u2', ownerEmail: 'bob@example.com' }

  it('accepting adds me to the note first in All notes, without folder, pin or lock, and clears the invitation', () => {
    lastHandlers().notes([note('mine', { order: 'a5' })], meta)
    sharedHandlers().invites([invite])
    expect(useApp.getState().invites).toEqual([invite])
    acceptInvite(invite)
    const [ownerUid, noteId, email, prefs] = fake.backend.acceptShare.mock.calls[0]
    expect([ownerUid, noteId, email]).toEqual(['u2', 's1', 'ana@example.com'])
    expect(prefs).toEqual({ folderId: null, order: expect.any(String), pinned: false, locked: false })
    expect((prefs as { order: string }).order < 'a5').toBe(true)
    expect(useApp.getState().invites).toEqual([])
  })

  it('brings the invitation back if the cloud refuses accepting or rejecting it', async () => {
    sharedHandlers().invites([invite])
    fake.backend.acceptShare.mockRejectedValueOnce(new Error('unavailable'))
    acceptInvite(invite)
    expect(useApp.getState().invites).toEqual([])
    await settle()
    expect(useApp.getState().invites).toEqual([invite])
    expect(useApp.getState().sync.error).toBe('unavailable')
    fake.backend.removeShare.mockRejectedValueOnce(new Error('unavailable'))
    rejectInvite(invite)
    await settle()
    expect(useApp.getState().invites).toEqual([invite])
  })

  it('rejecting removes me from the note and clears the invitation', () => {
    sharedHandlers().invites([invite])
    rejectInvite(invite)
    expect(fake.backend.removeShare).toHaveBeenCalledWith('u2', 's1', 'ana@example.com')
    expect(useApp.getState().invites).toEqual([])
  })
})
