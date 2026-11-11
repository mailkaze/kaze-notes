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
// Tiempo máximo que se esperan las escrituras pendientes antes de cerrar sesión.
const SIGN_OUT_WAIT_MS = 5000

export function createFirebaseBackend(): Backend {
  const { config, missing } = readFirebaseConfig()
  if (missing.length) throw new Error(`Missing Firebase config: ${missing.join(', ')}`)

  const app = initializeApp(config)
  const auth = getAuth(app)
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  })
  const storage = getStorage(app)

  const userCol = (uid: string, name: 'notes' | 'folders') => collection(db, 'users', uid, name)

  return {
    kind: 'firebase',

    onAuthChange(cb) {
      return onAuthStateChanged(auth, (u) =>
        cb(u ? { uid: u.uid, name: u.displayName, email: u.email, photoURL: u.photoURL } : null),
      )
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
      // Se espera un poco a que se envíen las escrituras pendientes.
      const synced = await Promise.race([
        waitForPendingWrites(db).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SIGN_OUT_WAIT_MS)),
      ])
      await signOut(auth)
      // Que no queden notas en este dispositivo, salvo si hay cambios sin subir: entonces se conserva
      // la caché para que se envíen al volver a entrar, en lugar de perderlos.
      if (synced) {
        try {
          await terminate(db)
          await clearIndexedDbPersistence(db)
        } catch {
          // Ignorado (p. ej. otra pestaña sigue usando la caché).
        }
      }
      window.location.reload()
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
      const path = uploadPath(uid, noteId, file.name)
      const task = uploadBytesResumable(ref(storage, path), file, {
        contentType: file.type || 'application/octet-stream',
        contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      })
      return new Promise((resolve, reject) => {
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
      })
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
