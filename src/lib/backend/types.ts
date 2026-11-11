import type { Invite, SharedNoteData, SharePrefs } from '../sharing'
import type { AppUser, Folder, Note } from '../types'

export interface SnapshotMeta {
  /** Hay escrituras locales que el servidor aún no ha confirmado. */
  pendingWrites: boolean
  /** Los datos vienen de la caché local (sin confirmar con el servidor). */
  fromCache: boolean
}

export type WriteOp =
  | { type: 'setNote'; id: string; data: Partial<Omit<Note, 'id'>> }
  | { type: 'deleteNote'; id: string }
  /** Cambio de un invitado en la nota de `owner` (fusiona también `prefs`). */
  | { type: 'setSharedNote'; owner: string; id: string; data: SharedNoteData }
  | { type: 'setFolder'; id: string; data: Partial<Omit<Folder, 'id'>> }
  | { type: 'deleteFolder'; id: string }

export interface UploadResult {
  url: string
  path: string
}

export interface Backend {
  readonly kind: 'firebase' | 'memory'
  onAuthChange(cb: (user: AppUser | null) => void): () => void
  signIn(): Promise<void>
  /** Cierra la sesión y borra de este dispositivo la copia local de los datos. */
  signOut(): Promise<void>
  /** Espera como mucho `timeoutMs` a que la nube confirme las escrituras pendientes; false si quedan. */
  waitForSync(timeoutMs: number): Promise<boolean>
  subscribe(
    uid: string,
    handlers: {
      notes: (notes: Note[], meta: SnapshotMeta) => void
      folders: (folders: Folder[], meta: SnapshotMeta) => void
      error: (error: Error) => void
    },
  ): () => void
  /** Escucha las notas de otros usuarios compartidas con `email` y las invitaciones pendientes a su nombre. */
  subscribeShared(
    uid: string,
    email: string,
    handlers: {
      notes: (notes: Note[], meta: SnapshotMeta) => void
      invites: (invites: Invite[]) => void
      error: (error: Error) => void
    },
  ): () => void
  /** El dueño `uid` invita a `email` a su nota. */
  share(uid: string, noteId: string, ownerEmail: string, email: string): Promise<void>
  /** `email` acepta la invitación: pasa a miembro y guarda sus preferencias de la nota. */
  acceptShare(ownerUid: string, noteId: string, email: string, prefs: SharePrefs): Promise<void>
  /** Quita a `email` de la nota (rechaza, la deja o el dueño deja de compartirla) y borra sus preferencias. */
  removeShare(ownerUid: string, noteId: string, email: string): Promise<void>
  newId(): string
  /** Aplica las operaciones de forma atómica (los `set*` fusionan campos). */
  write(uid: string, ops: WriteOp[]): Promise<void>
  uploadFile(uid: string, noteId: string, file: File, onProgress?: (fraction: number) => void): Promise<UploadResult>
  /** Borra los ficheros de la nota salvo los de `keep` (rutas completas que otras notas siguen usando). */
  deleteNoteFiles(uid: string, noteId: string, keep: Set<string>): Promise<void>
  /** Borra un fichero concreto (ruta devuelta por `uploadFile`). No falla si ya no existe. */
  deleteFile(uid: string, path: string): Promise<void>
}
