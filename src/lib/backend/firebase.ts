import { initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'firebase/auth'
import {
  clearIndexedDbPersistence,
  collection,
  doc,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  waitForPendingWrites,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore'
import { deleteObject, getDownloadURL, getStorage, listAll, ref, uploadBytesResumable } from 'firebase/storage'
import type { Folder, Note, NoteColorId } from '../types'
import { uploadPath } from './paths'
import type { Backend, WriteOp } from './types'

const env = import.meta.env

export function readFirebaseConfig() {
  const config = {
    apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
    projectId: env.VITE_FIREBASE_PROJECT_ID as string | undefined,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
    appId: env.VITE_FIREBASE_APP_ID as string | undefined,
  }
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  return { config, missing }
}

function toNote(id: string, d: DocumentData): Note {
  const note: Note = {
    id,
    title: typeof d.title === 'string' ? d.title : '',
    content: typeof d.content === 'string' ? d.content : '',
    preview: typeof d.preview === 'string' ? d.preview : '',
    folderId: typeof d.folderId === 'string' ? d.folderId : null,
    order: typeof d.order === 'string' ? d.order : 'a0',
    pinned: d.pinned === true,
    locked: d.locked === true,
    color: typeof d.color === 'string' ? (d.color as NoteColorId) : null,
    trashed: d.trashed === true,
    trashedAt: typeof d.trashedAt === 'number' ? d.trashedAt : null,
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
  }
  // Marca de revisión: solo con el tipo correcto (las notas antiguas no la tienen).
  if (typeof d.rev === 'number') note.rev = d.rev
  if (typeof d.baseRev === 'number') note.baseRev = d.baseRev
  if (typeof d.device === 'string') note.device = d.device
  return note
}

function toFolder(id: string, d: DocumentData): Folder {
  return {
    id,
    name: typeof d.name === 'string' ? d.name : '',
    parentId: typeof d.parentId === 'string' ? d.parentId : null,
    order: typeof d.order === 'string' ? d.order : 'a0',
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
  }
}


// Firestore admite como máximo 500 operaciones por lote.
const BATCH_LIMIT = 450
// Al cerrar sesión se reintenta borrar la caché local mientras las demás pestañas la sueltan.
const CLEAR_ATTEMPTS = 6
const CLEAR_RETRY_MS = 500

export function createFirebaseBackend(): Backend {
  const { config, missing } = readFirebaseConfig()
  if (missing.length) throw new Error(`Missing Firebase config: ${missing.join(', ')}`)

  const app = initializeApp(config)
  const auth = getAuth(app)
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  })
  const storage = getStorage(app)
  // Esta pestaña está cerrando la sesión (no se recarga al verla cerrada: borra antes la caché).
  let signingOut = false

  const userCol = (uid: string, name: 'notes' | 'folders') => collection(db, 'users', uid, name)

  return {
    kind: 'firebase',

    onAuthChange(cb) {
      let signedIn = false
      return onAuthStateChanged(auth, (u) => {
        // Sesión cerrada en otra pestaña: se recarga para soltar la caché local, que esa pestaña borra.
        if (signedIn && !u && !signingOut) {
          window.location.reload()
          return
        }
        signedIn = Boolean(u)
        cb(u ? { uid: u.uid, name: u.displayName, email: u.email, photoURL: u.photoURL } : null)
      })
    },

    async signIn() {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      try {
        await signInWithPopup(auth, provider)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return
        // Si el navegador bloquea la ventana emergente, se usa la redirección.
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          await signInWithRedirect(auth, provider)
          return
        }
        throw error
      }
    },

    async signOut() {
      // Lo que quede sin enviar ya lo ha aceptado perder quien cierra la sesión (la app pregunta antes).
      signingOut = true
      await signOut(auth)
      // Que no queden notas en este dispositivo. Las demás pestañas se recargan al ver la sesión cerrada
      // y dejan libre la caché: se reintenta mientras tanto.
      await terminate(db).catch(() => undefined)
      for (let attempt = 0; attempt < CLEAR_ATTEMPTS; attempt++) {
        try {
          await clearIndexedDbPersistence(db)
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, CLEAR_RETRY_MS))
        }
      }
      window.location.reload()
    },

    waitForSync(timeoutMs) {
      return Promise.race([
        waitForPendingWrites(db).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ])
    },

    subscribe(uid, handlers) {
      const onError = (error: Error) => handlers.error(error)
      const unsubNotes = onSnapshot(
        userCol(uid, 'notes'),
        { includeMetadataChanges: true },
        (snap) =>
          handlers.notes(
            snap.docs.map((d) => toNote(d.id, d.data())),
            { pendingWrites: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache },
          ),
        onError,
      )
      const unsubFolders = onSnapshot(
        userCol(uid, 'folders'),
        { includeMetadataChanges: true },
        (snap) =>
          handlers.folders(
            snap.docs.map((d) => toFolder(d.id, d.data())),
            { pendingWrites: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache },
          ),
        onError,
      )
      return () => {
        unsubNotes()
        unsubFolders()
      }
    },

    newId() {
      return doc(collection(db, '_ids')).id
    },

    async write(uid, ops: WriteOp[]) {
      // Todos los lotes se envían a la vez: sin conexión quedan todos en cola, no solo el primero.
      const commits: Promise<void>[] = []
      for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
        const batch = writeBatch(db)
        for (const op of ops.slice(i, i + BATCH_LIMIT)) {
          const col = op.type === 'setNote' || op.type === 'deleteNote' ? 'notes' : 'folders'
          const target = doc(userCol(uid, col), op.id)
          if (op.type === 'setNote' || op.type === 'setFolder') batch.set(target, op.data, { merge: true })
          else batch.delete(target)
        }
        commits.push(batch.commit())
      }
      await Promise.all(commits)
    },

    uploadFile(uid, noteId, file, onProgress) {
      // Sin conexión falla al momento en vez de reintentar durante minutos: el fichero espera en la cola.
      if (!navigator.onLine) return Promise.reject(Object.assign(new Error('Offline'), { code: 'offline' }))
      const path = uploadPath(uid, noteId, file.name)
      const task = uploadBytesResumable(ref(storage, path), file, {
        contentType: file.type || 'application/octet-stream',
        contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      })
      // Si se pierde la conexión a mitad, se cancela y se reintenta al volver.
      const cancel = () => task.cancel()
      window.addEventListener('offline', cancel)
      return new Promise<{ url: string; path: string }>((resolve, reject) => {
        task.on(
          'state_changed',
          (s) => onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
          reject,
          async () => {
            try {
              resolve({ url: await getDownloadURL(task.snapshot.ref), path })
            } catch (error) {
              reject(error)
            }
          },
        )
      }).finally(() => window.removeEventListener('offline', cancel))
    },

    async deleteNoteFiles(uid, noteId, keep) {
      try {
        const list = await listAll(ref(storage, `users/${uid}/notes/${noteId}`))
        await Promise.all(list.items.filter((item) => !keep.has(item.fullPath)).map((item) => deleteObject(item)))
      } catch {
        // Los adjuntos huérfanos no bloquean el borrado de la nota.
      }
    },

    async deleteFile(uid, path) {
      if (!path.startsWith(`users/${uid}/`)) throw new Error(`Refusing to delete a file outside users/${uid}/`)
      try {
        await deleteObject(ref(storage, path))
      } catch (error) {
        if ((error as { code?: string }).code !== 'storage/object-not-found') throw error
      }
    },
  }
}
