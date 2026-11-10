import { createContext, useContext } from 'react'
import type { Folder, Note } from '../../lib/types'
import type { DropResult, DropTarget, DropZone } from './treeDrop'

/** Lo que se ve mientras se arrastra: fila bajo el puntero, zona y resultado (null = no permitido). */
export interface DropState {
  overId: string
  target: DropTarget
  zone: DropZone
  result: DropResult
}

export interface TreeUI {
  foldersByParent: Map<string | null, Folder[]>
  /** Notas visibles en el árbol por contenedor (las fijadas solo salen en su sección). */
  notesByFolder: Map<string | null, Note[]>
  /** Notas activas directamente dentro de cada carpeta. */
  counts: Map<string, number>
  expanded: ReadonlySet<string>
  toggle: (folderId: string) => void
  expand: (folderIds: string[]) => void
  renamingId: string | null
  setRenamingId: (folderId: string | null) => void
  openNoteId: string | null
  openFolderId: string | null
  drop: DropState | null
}

export const TreeContext = createContext<TreeUI | null>(null)

export function useTree(): TreeUI {
  const ui = useContext(TreeContext)
  if (!ui) throw new Error('useTree must be used inside TreeContext')
  return ui
}

/** Primeras dos líneas con texto de la vista previa. */
export function previewLines(preview: string, max = 2): string {
  return preview
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, max)
    .join('\n')
}
