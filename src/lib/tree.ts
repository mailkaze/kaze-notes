import { byOrder } from './order'
import type { Folder, Note } from './types'

type Folders = Record<string, Folder>
type Notes = Record<string, Note>

/**
 * Carpeta en la que se muestra `folderId` (null = raíz). Va a la raíz si su carpeta madre ya no existe
 * o si está en un ciclo (p. ej. dos dispositivos movieron cada una dentro de la otra), para que no desaparezca.
 */
export function parentFolderId(folders: Folders, folderId: string): string | null {
  const parentId = folders[folderId]?.parentId
  if (!parentId || !folders[parentId]) return null
  const seen = new Set<string>()
  for (let id: string | null = parentId; id && folders[id] && !seen.has(id); id = folders[id].parentId) {
    if (id === folderId) return null
    seen.add(id)
  }
  return parentId
}

/** Ruta de carpetas desde la raíz hasta `folderId` (incluida). Vacía si es la raíz. */
export function folderPath(folders: Folders, folderId: string | null): Folder[] {
  const path: Folder[] = []
  let current = folderId ? folders[folderId] : undefined
  while (current) {
    path.unshift(current)
    const parentId = parentFolderId(folders, current.id)
    current = parentId ? folders[parentId] : undefined
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
    .filter((f) => parentFolderId(folders, f.id) === parentId)
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
