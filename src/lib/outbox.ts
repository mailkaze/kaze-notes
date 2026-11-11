/**
 * Cola de ficheros pendientes de subir en este dispositivo (IndexedDB): sobrevive a recargas y a la falta de
 * conexión. Si IndexedDB no está disponible o no admite el fichero, se guarda en memoria y dura lo que la pestaña.
 */
export interface OutboxEntry {
  /** Id del adjunto en la nota. */
  id: string
  uid: string
  noteId: string
  blob: Blob
  name: string
  type: string
  size: number
  createdAt: number
}

const DB_NAME = 'kaze-outbox'
const STORE = 'uploads'

const memory = new Map<string, OutboxEntry>()
let opening: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
      request.onsuccess = () => {
        const db = request.result
        // Si el navegador o una versión nueva de la app la cierra, se vuelve a abrir en el siguiente uso.
        db.onversionchange = () => {
          db.close()
          opening = null
        }
        db.onclose = () => {
          opening = null
        }
        resolve(db)
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opening
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        if (!db) throw new Error('IndexedDB unavailable')
        const tx = db.transaction(STORE, mode)
        const request = fn(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(request.result)
        tx.onerror = tx.onabort = () => reject(tx.error ?? request.error ?? new Error('IndexedDB error'))
      }),
  )
}

// Registro guardado: el fichero o, si el navegador no admite ficheros en IndexedDB, sus bytes.
type StoredEntry = Omit<OutboxEntry, 'blob'> & { blob: Blob | ArrayBuffer }

function toEntry(stored: StoredEntry): OutboxEntry {
  return stored.blob instanceof Blob ? (stored as OutboxEntry) : { ...stored, blob: new Blob([stored.blob], { type: stored.type }) }
}

async function allEntries(): Promise<OutboxEntry[]> {
  const stored = await run<StoredEntry[]>('readonly', (store) => store.getAll()).catch(() => [])
  return [...stored.map(toEntry), ...memory.values()]
}

/** Guarda el fichero en la cola. Devuelve true si queda a salvo en el dispositivo (sobrevive a una recarga). */
export async function saveUpload(entry: OutboxEntry): Promise<boolean> {
  try {
    await run('readwrite', (store) => store.put(entry))
    return true
  } catch {
    // Safari en navegación privada no guarda ficheros en IndexedDB, pero sí sus bytes.
    try {
      const bytes = await entry.blob.arrayBuffer()
      await run('readwrite', (store) => store.put({ ...entry, blob: bytes }))
      return true
    } catch {
      memory.set(entry.id, entry)
      return false
    }
  }
}

export async function getUpload(id: string): Promise<OutboxEntry | undefined> {
  const stored = memory.get(id) ?? (await run<StoredEntry | undefined>('readonly', (store) => store.get(id)).catch(() => undefined))
  return stored && toEntry(stored)
}

/** Ficheros en cola de un usuario, del más antiguo al más reciente. */
export async function listUploads(uid: string): Promise<OutboxEntry[]> {
  return (await allEntries()).filter((entry) => entry.uid === uid).sort((a, b) => a.createdAt - b.createdAt)
}

// Avisa a las demás pestañas de que un fichero ha salido de la cola (subido o descartado).
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('kaze-outbox')

export async function deleteUpload(id: string): Promise<void> {
  memory.delete(id)
  await run('readwrite', (store) => store.delete(id)).catch(() => undefined)
  channel?.postMessage({ removed: id })
}

/** Llama a `listener` cuando otra pestaña saca un fichero de la cola. Devuelve cómo dejar de escuchar. */
export function onUploadRemoved(listener: (id: string) => void): () => void {
  const handle = (event: MessageEvent) => {
    const id = (event.data as { removed?: unknown } | null)?.removed
    if (typeof id === 'string') listener(id)
  }
  channel?.addEventListener('message', handle)
  return () => channel?.removeEventListener('message', handle)
}

/** Ficheros sin subir de un usuario (o de todos). */
export async function pendingUploadCount(uid?: string): Promise<number> {
  return (await allEntries()).filter((entry) => uid === undefined || entry.uid === uid).length
}

/** Vacía la cola de todos los usuarios. */
export async function clearOutbox(): Promise<void> {
  memory.clear()
  await run('readwrite', (store) => store.clear()).catch(() => undefined)
}
