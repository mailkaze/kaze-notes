import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedWrite, type Invite } from '../sharing'
import type { AppUser, Folder, Note } from '../types'
import { createMemoryBackend } from './memory'

afterEach(() => {
  vi.unstubAllGlobals()
})

const fullNote = (title: string): Omit<Note, 'id'> => ({
  title,
  content: '',
  preview: '',
  folderId: null,
  order: 'a0',
  pinned: false,
  locked: false,
  color: null,
  trashed: false,
  trashedAt: null,
  createdAt: 1,
  updatedAt: 1,
})

describe('memory backend sharing between two accounts', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  // La cuenta recordada con ?as= y la sesión no pasan a otras pruebas.
  afterEach(() => {
    window.history.replaceState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
  })

  function watch(backend: ReturnType<typeof createMemoryBackend>, uid: string, email: string) {
    const seen = { own: [] as Note[], folders: [] as Folder[], shared: [] as Note[], invites: [] as Invite[] }
    backend.subscribe(uid, {
      notes: (list) => (seen.own = list),
      folders: (list) => (seen.folders = list),
      error: () => undefined,
    })
    backend.subscribeShared(uid, email, {
      notes: (list) => (seen.shared = list),
      invites: (list) => (seen.invites = list),
      error: () => undefined,
    })
    return seen
  }

  it('invites, accepts, syncs shared fields, keeps personal ones apart and unshares', async () => {
    const backend = createMemoryBackend()
    const ana = watch(backend, 'local', 'demo@local')
    const bob = watch(backend, 'bob', 'bob@local')
    await Promise.resolve()

    void backend.write('local', [{ type: 'setNote', id: 'n1', data: fullNote('Groceries') }])
    void backend.write('bob', [{ type: 'setNote', id: 'b1', data: fullNote('Bob only') }])
    expect(ana.own.map((n) => n.title)).toEqual(['Groceries'])
    expect(bob.own.map((n) => n.title)).toEqual(['Bob only'])

    void backend.share('local', 'n1', 'demo@local', 'bob@local')
    expect(bob.invites).toEqual([{ noteId: 'n1', ownerUid: 'local', ownerEmail: 'demo@local' }])
    expect(bob.shared).toEqual([])

    void backend.acceptShare('local', 'n1', 'bob@local', { folderId: 'bf', order: 'a1', pinned: false, locked: false })
    expect(bob.invites).toEqual([])
    expect(bob.shared).toMatchObject([{ id: 'n1', ownerUid: 'local', title: 'Groceries', folderId: 'bf' }])
    expect(ana.own[0]).toMatchObject({ members: ['bob@local'], invited: [] })

    const data = sharedWrite({ title: 'Groceries!', color: 'sky', pinned: true }, 'bob@local')
    void backend.write('bob', [{ type: 'setSharedNote', owner: 'local', id: 'n1', data }])
    expect(ana.own[0]).toMatchObject({ title: 'Groceries!', color: 'sky', pinned: false, folderId: null })
    expect(bob.shared[0]).toMatchObject({ title: 'Groceries!', color: 'sky', pinned: true, folderId: 'bf' })
    expect(ana.own[0]).not.toHaveProperty('prefs')

    void backend.removeShare('local', 'n1', 'bob@local')
    expect(bob.shared).toEqual([])
    expect(ana.own[0]).toMatchObject({ title: 'Groceries!', members: [] })
    const stored = JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{}')
    // Las notas de la cuenta de demostración siguen guardadas por su id, como antes.
    expect(stored.notes.n1.prefs).toEqual({})
  })

  it("refuses, like the rules, a shared write from someone who is not a member, while the writer's own changes still apply", async () => {
    const backend = createMemoryBackend()
    const ana = watch(backend, 'local', 'demo@local')
    const bob = watch(backend, 'bob', 'bob@local')
    await Promise.resolve()
    void backend.write('local', [{ type: 'setNote', id: 'n1', data: fullNote('Groceries') }])
    const write = backend.write('bob', [
      { type: 'setNote', id: 'b1', data: fullNote('Bob only') },
      { type: 'setSharedNote', owner: 'local', id: 'n1', data: { title: 'Hijacked' } },
      { type: 'setSharedNote', owner: 'local', id: 'gone', data: { title: 'Ghost' } },
    ])
    await expect(write).rejects.toThrow(/permission/i)
    expect(ana.own.map((n) => n.title)).toEqual(['Groceries'])
    expect(bob.own.map((n) => n.title)).toEqual(['Bob only'])
  })

  it("never lets one account overwrite or delete another account's note or folder through its own writes", async () => {
    const backend = createMemoryBackend()
    const ana = watch(backend, 'local', 'demo@local')
    await Promise.resolve()
    void backend.write('local', [
      { type: 'setNote', id: 'n1', data: fullNote('Groceries') },
      { type: 'setFolder', id: 'f1', data: { name: 'Home', parentId: null, order: 'a0', createdAt: 1, updatedAt: 1 } },
    ])
    void backend.write('bob', [
      { type: 'setNote', id: 'n1', data: { title: 'Taken' } },
      { type: 'setFolder', id: 'f1', data: { name: 'Taken' } },
    ])
    void backend.write('bob', [
      { type: 'deleteNote', id: 'n1' },
      { type: 'deleteFolder', id: 'f1' },
    ])
    expect(ana.own.map((n) => n.title)).toEqual(['Groceries'])
    expect(ana.folders.map((f) => f.name)).toEqual(['Home'])
  })

  it('signs in as another account with ?as=name and keeps it on reload of the same tab', async () => {
    window.history.replaceState({}, '', '/?as=bob')
    const users: (AppUser | null)[] = []
    const backend = createMemoryBackend()
    backend.onAuthChange((u) => users.push(u))
    await backend.signIn()
    expect(users.at(-1)).toMatchObject({ uid: 'bob', email: 'bob@local' })
    window.history.replaceState({}, '', '/')
    const again: (AppUser | null)[] = []
    createMemoryBackend().onAuthChange((u) => again.push(u))
    await Promise.resolve()
    expect(again.at(-1)).toMatchObject({ uid: 'bob', email: 'bob@local' })
  })
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
