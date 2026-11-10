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
  signOut(): Promise<void>
  subscribe(
    uid: string,
    handlers: {
      notes: (notes: Note[], meta: SnapshotMeta) => void
      folders: (folders: Folder[], meta: SnapshotMeta) => void
      error: (error: Error) => void
    },
  ): () => void
  newId(): string
  /** Aplica las operaciones de forma atómica (los `set*` fusionan campos). */
  write(uid: string, ops: WriteOp[]): Promise<void>
  uploadFile(uid: string, noteId: string, file: File, onProgress?: (fraction: number) => void): Promise<UploadResult>
  /** Borra los ficheros de la nota salvo los de `keep` (rutas completas que otras notas siguen usando). */
  deleteNoteFiles(uid: string, noteId: string, keep: Set<string>): Promise<void>
  /** Borra un fichero concreto (ruta devuelta por `uploadFile`). No falla si ya no existe. */
  deleteFile(uid: string, path: string): Promise<void>
}
