import type { AppUser, Folder, Note } from '../types'
import { uploadPath } from './paths'
import type { Backend, SnapshotMeta, WriteOp } from './types'

/**
 * Backend local sin Firebase (modo `--mode memory`): datos en localStorage de este navegador.
 * Simula la latencia del servidor para que el indicador de sincronización sea observable en pruebas.
 */
const STORAGE_KEY = 'kaze:memory-db'
const USER_KEY = 'kaze:memory-user'
const LATENCY_MS = 350

interface Db {
  notes: Record<string, Note>
  folders: Record<string, Folder>
}

function load(): Db {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Db
  } catch {
    // Datos corruptos o sin acceso: se empieza vacío.
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

const demoUser: AppUser = { uid: 'local', name: 'Demo', email: 'demo@local', photoURL: null }

export function createMemoryBackend(): Backend {
  const db = load()
  let user: AppUser | null = null
  try {
    user = localStorage.getItem(USER_KEY) ? demoUser : null
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

  return {
    kind: 'memory',

    onAuthChange(cb) {
      authListeners.add(cb)
      queueMicrotask(() => cb(user))
      return () => authListeners.delete(cb)
    },

    async signIn() {
      setUser(demoUser)
    },

    async signOut() {
      setUser(null)
    },

    subscribe(_uid, handlers) {
      const listener = (meta: SnapshotMeta) => {
        handlers.notes(Object.values(db.notes), meta)
        handlers.folders(Object.values(db.folders), meta)
      }
      dataListeners.add(listener)
      queueMicrotask(() => listener({ pendingWrites: false, fromCache: false }))
      return () => dataListeners.delete(listener)
    },

    newId() {
      // crypto.randomUUID solo existe con HTTPS o localhost; getRandomValues también funciona por HTTP en la red local.
      return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, '0')).join('')
    },

    write(_uid, ops: WriteOp[]) {
      for (const op of ops) {
        if (op.type === 'setNote') db.notes[op.id] = { ...db.notes[op.id], ...op.data, id: op.id } as Note
        else if (op.type === 'deleteNote') delete db.notes[op.id]
        else if (op.type === 'setFolder') db.folders[op.id] = { ...db.folders[op.id], ...op.data, id: op.id } as Folder
        else delete db.folders[op.id]
      }
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
