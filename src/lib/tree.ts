import { byOrder } from './order'
import type { Folder, Note } from './types'

type Folders = Record<string, Folder>
type Notes = Record<string, Note>

/** Ruta de carpetas desde la raíz hasta `folderId` (incluida). Vacía si es la raíz. */
export function folderPath(folders: Folders, folderId: string | null): Folder[] {
  const path: Folder[] = []
  const seen = new Set<string>()
  let current = folderId ? folders[folderId] : undefined
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId ? folders[current.parentId] : undefined
  }
  return path
}

/** Texto de la ruta, p. ej. "Carpeta 1 / Carpeta 2". */
export function folderPathLabel(folders: Folders, folderId: string | null): string {
  return folderPath(folders, folderId)
    .map((f) => f.name)
    .join(' / ')
}

export function childFolders(folders: Folders, parentId: string | null): Folder[] {
  return Object.values(folders)
    .filter((f) => f.parentId === parentId)
    .sort(byOrder)
}

/** true si `folderId` es `ancestorId` o está dentro de él a cualquier profundidad. */
export function isInsideFolder(folders: Folders, folderId: string | null, ancestorId: string): boolean {
  return folderPath(folders, folderId).some((f) => f.id === ancestorId)
}

/** Ids de la carpeta y de todas sus subcarpetas. */
export function descendantFolderIds(folders: Folders, folderId: string): string[] {
  return Object.values(folders)
    .filter((f) => isInsideFolder(folders, f.id, folderId))
    .map((f) => f.id)
}

/** Notas activas (no en la papelera), ordenadas por su orden global. */
export function activeNotes(notes: Notes): Note[] {
  return Object.values(notes)
    .filter((n) => !n.trashed)
    .sort(byOrder)
}

/** Notas activas que están directamente en `folderId` (null = raíz). */
export function notesInFolder(notes: Notes, folderId: string | null): Note[] {
  return activeNotes(notes).filter((n) => n.folderId === folderId)
}

export function trashedNotes(notes: Notes): Note[] {
  return Object.values(notes)
    .filter((n) => n.trashed)
    .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
}
