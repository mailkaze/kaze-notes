import { sharedView, type Invite, type SharedNoteData, type SharePrefs } from '../sharing'
import type { AppUser, Folder, Note } from '../types'
import { uploadPath } from './paths'
import type { Backend, SnapshotMeta, WriteOp } from './types'

/**
 * Backend local sin Firebase (modo `--mode memory`): datos en localStorage de este navegador.
 * Simula la latencia del servidor para que el indicador de sincronización sea observable en pruebas.
 * Para probar con varias cuentas, `?as=nombre` entra en esa pestaña como `nombre@local`; las pestañas del mismo
 * navegador comparten los datos y se avisan de los cambios.
 */
const STORAGE_KEY = 'kaze:memory-db'
const USER_KEY = 'kaze:memory-user'
const AS_KEY = 'kaze:memory-as'
const LATENCY_MS = 350
const DEMO_UID = 'local'

// Las notas y carpetas se guardan por su id; las que no son de la cuenta de demostración llevan su dueño.
type StoredNote = Note & { owner?: string; prefs?: Record<string, SharePrefs> }
type StoredFolder = Folder & { owner?: string }

interface Db {
  notes: Record<string, StoredNote>
  folders: Record<string, StoredFolder>
}

function parse(raw: string | null): Db | null {
  try {
    if (raw) return JSON.parse(raw) as Db
  } catch {
    // Datos corruptos: se ignoran.
  }
  return null
}

function load(): Db {
  try {
    const db = parse(localStorage.getItem(STORAGE_KEY))
    if (db) return { notes: db.notes ?? {}, folders: db.folders ?? {} }
  } catch {
    // Sin acceso: se empieza vacío.
  }
  return { notes: {}, folders: {} }
}

function persist(db: Db) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // Sin almacenamiento disponible: los datos viven solo en memoria.
  }
}

const demoUser: AppUser = { uid: DEMO_UID, name: 'Demo', email: 'demo@local', photoURL: null }

/** Cuenta con la que entra esta pestaña: la de `?as=nombre` (recordada en la pestaña) o la de demostración. */
function tabUser(): AppUser {
  let name: string | null = null
  try {
    name = new URLSearchParams(location.search).get('as')
    if (name && /^[a-z0-9]+$/i.test(name)) sessionStorage.setItem(AS_KEY, name)
    else name = sessionStorage.getItem(AS_KEY)
  } catch {
    // Sin almacenamiento de sesión: cuenta de demostración.
  }
  return name ? { uid: name, name, email: `${name}@local`, photoURL: null } : demoUser
}

const ownerOf = (item: { owner?: string }) => item.owner ?? DEMO_UID

/** La nota tal y como la ve su dueño (sin los datos internos del almacén). */
function plainNote(stored: StoredNote): Note {
  const { owner: _owner, prefs: _prefs, ...note } = stored
  return note
}

function plainFolder(stored: StoredFolder): Folder {
  const { owner: _owner, ...folder } = stored
  return folder
}

const without = (list: string[] | undefined, email: string) => (list ?? []).filter((e) => e !== email)

export function createMemoryBackend(): Backend {
  const db = load()
  const account = tabUser()
  let user: AppUser | null = null
  try {
    user = localStorage.getItem(USER_KEY) ? account : null
  } catch {
    user = null
  }
  const authListeners = new Set<(u: AppUser | null) => void>()
  const dataListeners = new Set<(meta: SnapshotMeta) => void>()
  let inFlight = 0

  const emit = () => dataListeners.forEach((fn) => fn({ pendingWrites: inFlight > 0, fromCache: false }))
  const setUser = (u: AppUser | null) => {
    user = u
    try {
      if (u) localStorage.setItem(USER_KEY, '1')
      else localStorage.removeItem(USER_KEY)
    } catch {
      // Ignorado: la sesión solo dura esta pestaña.
    }
    authListeners.forEach((fn) => fn(u))
  }

  // Cambios hechos en otra pestaña (p. ej. otra cuenta con `?as=`).
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return
      const next = parse(event.newValue) ?? { notes: {}, folders: {} }
      db.notes = next.notes ?? {}
      db.folders = next.folders ?? {}
      emit()
    })
  }

  /** Aplica un cambio, lo guarda y lo "confirma" tras la latencia simulada. */
  const change = (apply: () => void): Promise<void> => {
    apply()
    persist(db)
    inFlight += 1
    emit()
    return new Promise((resolve) =>
      setTimeout(() => {
        inFlight -= 1
        emit()
        resolve()
      }, LATENCY_MS),
    )
  }

  /** Nota de `ownerUid` (null si no existe o es de otra cuenta). */
  const noteOf = (ownerUid: string, id: string): StoredNote | null => {
    const note = db.notes[id]
    return note && ownerOf(note) === ownerUid ? note : null
  }

  const setNote = (uid: string, id: string, data: Partial<Note>) => {
    const old = db.notes[id]
    db.notes[id] = { ...old, ...data, id, ...(uid !== DEMO_UID && { owner: uid }) } as StoredNote
  }

  const setSharedNote = (owner: string, id: string, data: SharedNoteData) => {
    const old = noteOf(owner, id)
    // Igual que Firestore: un invitado no puede crear la nota si ya no existe.
    if (!old) return
    const { prefs, ...rest } = data
    const merged = { ...old.prefs }
    for (const [email, value] of Object.entries(prefs ?? {})) merged[email] = { ...merged[email], ...value }
    db.notes[id] = { ...old, ...rest, ...(prefs && { prefs: merged }) }
  }

  return {
    kind: 'memory',

    onAuthChange(cb) {
      authListeners.add(cb)
      queueMicrotask(() => cb(user))
      return () => authListeners.delete(cb)
    },

    async signIn() {
      setUser(account)
    },

    async signOut() {
      setUser(null)
    },

    async waitForSync(timeoutMs) {
      const end = Date.now() + timeoutMs
      while (inFlight > 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50))
      return inFlight === 0
    },

    subscribe(uid, handlers) {
      const listener = (meta: SnapshotMeta) => {
        handlers.notes(
          Object.values(db.notes)
            .filter((n) => ownerOf(n) === uid)
            .map(plainNote),
          meta,
        )
        handlers.folders(
          Object.values(db.folders)
            .filter((f) => ownerOf(f) === uid)
            .map(plainFolder),
          meta,
        )
      }
      dataListeners.add(listener)
      queueMicrotask(() => listener({ pendingWrites: false, fromCache: false }))
      return () => dataListeners.delete(listener)
    },

    subscribeShared(uid, email, handlers) {
      const listener = (meta: SnapshotMeta) => {
        const notes: Note[] = []
        const invites: Invite[] = []
        for (const stored of Object.values(db.notes)) {
          const owner = ownerOf(stored)
          if (owner === uid) continue
          if (stored.members?.includes(email)) notes.push(sharedView(plainNote(stored), owner, stored.prefs?.[email]))
          if (stored.invited?.includes(email) && !stored.trashed) {
            invites.push({ noteId: stored.id, ownerUid: owner, ownerEmail: stored.ownerEmail ?? '' })
          }
        }
        handlers.notes(notes, meta)
        handlers.invites(invites)
      }
      dataListeners.add(listener)
      queueMicrotask(() => listener({ pendingWrites: false, fromCache: false }))
      return () => dataListeners.delete(listener)
    },

    share(uid, noteId, ownerEmail, email) {
      return change(() => {
        const note = noteOf(uid, noteId)
        if (note) db.notes[noteId] = { ...note, ownerEmail, invited: [...without(note.invited, email), email] }
      })
    },

    acceptShare(ownerUid, noteId, email, prefs) {
      return change(() => {
        const note = noteOf(ownerUid, noteId)
        if (!note?.invited?.includes(email)) return
        db.notes[noteId] = {
          ...note,
          invited: without(note.invited, email),
          members: [...without(note.members, email), email],
          prefs: { ...note.prefs, [email]: prefs },
        }
      })
    },

    removeShare(ownerUid, noteId, email) {
      return change(() => {
        const note = noteOf(ownerUid, noteId)
        if (!note) return
        const { [email]: _, ...prefs } = note.prefs ?? {}
        db.notes[noteId] = { ...note, invited: without(note.invited, email), members: without(note.members, email), prefs }
      })
    },

    newId() {
      // crypto.randomUUID solo existe con HTTPS o localhost; getRandomValues también funciona por HTTP en la red local.
      return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, '0')).join('')
    },

    write(uid, ops: WriteOp[]) {
      return change(() => {
        for (const op of ops) {
          if (op.type === 'setNote') setNote(uid, op.id, op.data)
          else if (op.type === 'setSharedNote') setSharedNote(op.owner, op.id, op.data)
          else if (op.type === 'deleteNote') delete db.notes[op.id]
          else if (op.type === 'setFolder') {
            db.folders[op.id] = { ...db.folders[op.id], ...op.data, id: op.id, ...(uid !== DEMO_UID && { owner: uid }) } as StoredFolder
          } else delete db.folders[op.id]
        }
      })
    },

    uploadFile(uid, noteId, file, onProgress) {
      return new Promise((resolve) => {
        let progress = 0
        const timer = setInterval(() => {
          progress = Math.min(1, progress + 0.25)
          onProgress?.(progress)
          if (progress >= 1) {
            clearInterval(timer)
            // Misma ruta que en Firebase: así un adjunto copiado a otra nota se reconoce como propio.
            resolve({ url: URL.createObjectURL(file), path: uploadPath(uid, noteId, file.name) })
          }
        }, 120)
      })
    },

    async deleteNoteFiles() {
      // No hay ficheros remotos que borrar.
    },

    async deleteFile() {
      // No hay ficheros remotos que borrar.
    },
  }
}
