import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotMeta, WriteOp } from '../lib/backend'
import type { AppUser, Folder, Note } from '../lib/types'

// Backend falso: registra escrituras, suscripciones y borrados de ficheros.
const fake = vi.hoisted(() => {
  type Handlers = {
    notes: (notes: Note[], meta: SnapshotMeta) => void
    folders: (folders: Folder[], meta: SnapshotMeta) => void
    error: (error: Error) => void
  }
  let seq = 0
  const state = {
    auth: null as ((user: AppUser | null) => void) | null,
    handlers: [] as Handlers[],
  }
  const backend = {
    kind: 'memory' as const,
    onAuthChange: (cb: (user: AppUser | null) => void) => {
      state.auth = cb
      return () => undefined
    },
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    subscribe: vi.fn((_uid: string, handlers: Handlers) => {
      state.handlers.push(handlers)
      return () => undefined
    }),
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
  closeNote,
  createConflictCopy,
  deleteAttachmentFile,
  deleteNoteForever,
  emptyTrash,
  initApp,
  referencedPaths,
  registerFlush,
  selectSyncStatus,
  setPinned,
  signIn,
  updateNote,
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
const lastHandlers = () => fake.state.handlers[fake.state.handlers.length - 1]

beforeAll(() => initApp())

beforeEach(() => {
  vi.clearAllMocks()
  fake.state.auth?.(user)
  useApp.setState({
    notes: {},
    folders: {},
    view: { kind: 'notes', folderId: null },
    sync: { online: true, serverPending: false, fromCache: false, dirty: [], error: null, listenerError: null, tooLarge: [] },
  })
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
