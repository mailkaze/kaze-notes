import { keyBetween } from '../../lib/order'
import { activeNotes, childFolders, isInsideFolder, notesInFolder } from '../../lib/tree'
import type { Folder, Note } from '../../lib/types'

type Notes = Record<string, Note>
type Folders = Record<string, Folder>

export type DragKind = 'note' | 'folder'
export interface DragItem {
  kind: DragKind
  id: string
}

/** Fila sobre la que se suelta: nota (del árbol o de "Fijadas"), carpeta o la zona raíz del final. */
export type DropTarget =
  | { kind: 'note'; id: string; section: 'tree' | 'pinned' }
  | { kind: 'folder'; id: string }
  | { kind: 'root' }

export type DropZone = 'before' | 'after' | 'into'

export type DropResult =
  | { kind: 'note'; id: string; folderId: string | null; order: string }
  | { kind: 'folder'; id: string; parentId: string | null; order: string }
  | null

/** Notas que el árbol muestra en un contenedor: activas y no fijadas (las fijadas van en su sección). */
export function treeNotes(notes: Notes, folderId: string | null): Note[] {
  return notesInFolder(notes, folderId).filter((n) => !n.pinned)
}

export function pinnedNotes(notes: Notes): Note[] {
  return activeNotes(notes).filter((n) => n.pinned)
}

/** Zona según la posición vertical relativa (0 = arriba, 1 = abajo) del puntero en la fila. */
export function dropZone(dragKind: DragKind, target: DropTarget, ratio: number): DropZone {
  if (target.kind === 'root') return 'into'
  if (target.kind === 'note') return ratio < 0.5 ? 'before' : 'after'
  if (dragKind === 'note') return 'into'
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'into'
}

/** Clave para colocar un elemento antes o después de `targetId` dentro de `list` (sin el elemento movido). */
function keyNextTo<T extends { id: string; order: string }>(list: T[], targetId: string, zone: DropZone): string | null {
  const i = list.findIndex((item) => item.id === targetId)
  if (i < 0 || zone === 'into') return null
  return zone === 'before' ? keyBetween(list[i - 1]?.order, list[i].order) : keyBetween(list[i].order, list[i + 1]?.order)
}

function resolveNote(note: Note, target: DropTarget, zone: DropZone, notes: Notes, folders: Folders): DropResult {
  const others = (list: Note[]) => list.filter((n) => n.id !== note.id)
  if (target.kind === 'note') {
    const targetNote = notes[target.id]
    if (target.id === note.id || !targetNote || targetNote.trashed) return null
    if (target.section === 'pinned') {
      if (!note.pinned) return null
      const order = keyNextTo(others(pinnedNotes(notes)), target.id, zone)
      return order ? { kind: 'note', id: note.id, folderId: note.folderId, order } : null
    }
    const order = keyNextTo(others(treeNotes(notes, targetNote.folderId)), target.id, zone)
    return order ? { kind: 'note', id: note.id, folderId: targetNote.folderId, order } : null
  }
  if (target.kind === 'folder') {
    if (!folders[target.id]) return null
    // Arriba del todo de las notas de la carpeta; si está vacía conserva su orden.
    const first = others(treeNotes(notes, target.id))[0]
    return { kind: 'note', id: note.id, folderId: target.id, order: first ? keyBetween(null, first.order) : note.order }
  }
  // Zona raíz (al final del árbol): al final de las notas de la raíz.
  const list = others(treeNotes(notes, null))
  const last = list[list.length - 1]
  return { kind: 'note', id: note.id, folderId: null, order: last ? keyBetween(last.order, null) : note.order }
}

function resolveFolder(folder: Folder, target: DropTarget, zone: DropZone, notes: Notes, folders: Folders): DropResult {
  const atEndOf = (parentId: string | null): DropResult => {
    if (parentId && isInsideFolder(folders, parentId, folder.id)) return null
    const siblings = childFolders(folders, parentId).filter((f) => f.id !== folder.id)
    const order = keyBetween(siblings[siblings.length - 1]?.order, null)
    return { kind: 'folder', id: folder.id, parentId, order }
  }
  if (target.kind === 'root') return atEndOf(null)
  if (target.kind === 'note') {
    const targetNote = notes[target.id]
    if (target.section === 'pinned' || !targetNote || targetNote.trashed) return null
    return atEndOf(targetNote.folderId)
  }
  const targetFolder = folders[target.id]
  if (!targetFolder || target.id === folder.id) return null
  if (zone === 'into') return atEndOf(target.id)
  const parentId = targetFolder.parentId
  if (parentId && isInsideFolder(folders, parentId, folder.id)) return null
  const siblings = childFolders(folders, parentId).filter((f) => f.id !== folder.id)
  const order = keyNextTo(siblings, target.id, zone)
  return order ? { kind: 'folder', id: folder.id, parentId, order } : null
}

/**
 * Decide qué hace soltar `item` en `target`/`zone`: nueva carpeta y orden de la nota,
 * o nuevo padre y orden de la carpeta. null si no está permitido.
 */
export function resolveTreeDrop(item: DragItem, target: DropTarget, zone: DropZone, notes: Notes, folders: Folders): DropResult {
  if (item.kind === 'note') {
    const note = notes[item.id]
    return note && !note.trashed ? resolveNote(note, target, zone, notes, folders) : null
  }
  const folder = folders[item.id]
  return folder ? resolveFolder(folder, target, zone, notes, folders) : null
}
