import { DndContext, DragOverlay, type CollisionDetection, type DragStartEvent } from '@dnd-kit/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../lib/i18n'
import { byOrder } from '../../lib/order'
import { activeNotes, folderPath } from '../../lib/tree'
import type { Folder, Note } from '../../lib/types'
import { moveFolder, moveNote, readPref, useApp, writePref } from '../../state/store'
import { dragEnded, dragStarted, useDragSensors } from './dnd'
import { dropFolderId, useExternalDrop } from './externalDrop'
import { TreeContext, type DropState, type TreeUI } from './treeContext'
import { dropZone, resolveTreeDrop, type DragItem, type DropTarget } from './treeDrop'
import { DragPreview, NoteRow, RootHeading, RootZone, TreeLevel } from './TreeRows'

const EXPANDED_PREF = 'expandedFolders'
const EXPAND_ON_HOVER_MS = 600

function readExpanded(): Set<string> {
  const list = readPref<unknown>(EXPANDED_PREF, [])
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [])
}

interface Hit {
  id: string
  target: DropTarget
  /** Posición vertical del puntero dentro de la fila (0 arriba, 1 abajo). */
  ratio: number
}

/** Agrupa carpetas y notas por contenedor. Lo que apunta a una carpeta inexistente se muestra en la raíz. */
function buildTree(notes: Record<string, Note>, folders: Record<string, Folder>) {
  const foldersByParent = new Map<string | null, Folder[]>()
  const notesByFolder = new Map<string | null, Note[]>()
  const counts = new Map<string, number>()
  const pinned: Note[] = []
  const push = <T,>(map: Map<string | null, T[]>, key: string | null, value: T) => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  for (const folder of Object.values(folders).sort(byOrder)) {
    push(foldersByParent, folder.parentId && folders[folder.parentId] ? folder.parentId : null, folder)
  }
  for (const note of activeNotes(notes)) {
    const folderId = note.folderId && folders[note.folderId] ? note.folderId : null
    if (folderId) counts.set(folderId, (counts.get(folderId) ?? 0) + 1)
    if (note.pinned) pinned.push(note)
    else push(notesByFolder, folderId, note)
  }
  return { foldersByParent, notesByFolder, counts, pinned }
}

export function SidebarTree({
  renamingId,
  setRenamingId,
}: {
  renamingId: string | null
  setRenamingId: (id: string | null) => void
}) {
  const notes = useApp((s) => s.notes)
  const folders = useApp((s) => s.folders)
  const view = useApp((s) => s.view)
  const tree = useMemo(() => buildTree(notes, folders), [notes, folders])
  const [expanded, setExpanded] = useState(readExpanded)

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      writePref(EXPANDED_PREF, [...next])
      return next
    })
  }, [])

  const expand = useCallback((ids: string[]) => {
    setExpanded((prev) => {
      if (ids.every((id) => prev.has(id))) return prev
      const next = new Set([...prev, ...ids])
      writePref(EXPANDED_PREF, [...next])
      return next
    })
  }, [])

  // Al abrir una nota o carpeta se despliegan sus carpetas contenedoras para verla resaltada.
  useEffect(() => {
    const s = useApp.getState()
    const folderId =
      view.kind === 'note'
        ? (s.notes[view.noteId]?.folderId ?? null)
        : view.kind === 'notes' && view.folderId
          ? (s.folders[view.folderId]?.parentId ?? null)
          : null
    const ids = folderPath(s.folders, folderId).map((f) => f.id)
    if (ids.length > 0) expand(ids)
  }, [view, expand])

  // ---------- Arrastrar y soltar ----------
  const sensors = useDragSensors()
  const [dragItem, setDragItem] = useState<DragItem | null>(null)
  const [drop, setDrop] = useState<DropState | null>(null)
  const itemRef = useRef<DragItem | null>(null)
  const hitRef = useRef<Hit | null>(null)
  const dropRef = useRef<DropState | null>(null)

  // Destino = fila real bajo el puntero (con su rectángulo actual, válido aunque la lista haga scroll).
  const collisionDetection = useCallback<CollisionDetection>(({ droppableContainers, pointerCoordinates }) => {
    hitRef.current = null
    if (!pointerCoordinates) return []
    const { x, y } = pointerCoordinates
    const el = document
      .elementsFromPoint(x, y)
      .find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.dropId !== undefined)
    const container = el ? droppableContainers.find((c) => c.id === el.dataset.dropId) : undefined
    const target = container?.data.current?.target as DropTarget | undefined
    if (!el || !container || !target) return []
    const rect = el.getBoundingClientRect()
    hitRef.current = { id: String(container.id), target, ratio: rect.height > 0 ? (y - rect.top) / rect.height : 0.5 }
    return [{ id: container.id, data: { droppableContainer: container, value: 0 } }]
  }, [])

  const updateDrop = useCallback(() => {
    const item = itemRef.current
    const hit = hitRef.current
    let next: DropState | null = null
    if (item && hit && hit.id !== `${item.kind}:${item.id}`) {
      const zone = dropZone(item.kind, hit.target, hit.ratio)
      const { notes: n, folders: f } = useApp.getState()
      next = { overId: hit.id, target: hit.target, zone, result: resolveTreeDrop(item, hit.target, zone, n, f) }
    }
    const prev = dropRef.current
    dropRef.current = next
    if (prev?.overId !== next?.overId || prev?.zone !== next?.zone || Boolean(prev?.result) !== Boolean(next?.result)) {
      setDrop(next)
    }
  }, [])

  const finishDrag = () => {
    dragEnded()
    itemRef.current = null
    hitRef.current = null
    dropRef.current = null
    setDrop(null)
    setDragItem(null)
  }

  const onDragStart = (event: DragStartEvent) => {
    const item = event.active.data.current?.item as DragItem | undefined
    if (!item) return
    dragStarted()
    itemRef.current = item
    setDragItem(item)
  }

  const onDragEnd = () => {
    const state = dropRef.current
    finishDrag()
    const result = state?.result
    if (!state || !result) return
    if (result.kind === 'note') moveNote(result.id, result.folderId, result.order)
    else moveFolder(result.id, result.parentId, result.order)
    if (state.zone === 'into' && state.target.kind === 'folder') expand([state.target.id])
  }

  // Tarjeta de la pantalla de notas arrastrada sobre la barra lateral.
  const externalDragging = useExternalDrop((s) => s.dragging)
  const externalOver = useExternalDrop((s) => s.overId)
  const dragging = Boolean(dragItem) || externalDragging

  // Mantener el puntero sobre una carpeta cerrada la despliega.
  const hoverFolder =
    drop?.result && drop.zone === 'into' && drop.target.kind === 'folder'
      ? drop.target.id
      : externalOver
        ? dropFolderId(externalOver)
        : null
  useEffect(() => {
    if (!hoverFolder || expanded.has(hoverFolder)) return
    const timer = setTimeout(() => expand([hoverFolder]), EXPAND_ON_HOVER_MS)
    return () => clearTimeout(timer)
  }, [hoverFolder, expanded, expand])

  const ui: TreeUI = {
    foldersByParent: tree.foldersByParent,
    notesByFolder: tree.notesByFolder,
    counts: tree.counts,
    expanded,
    toggle,
    expand,
    renamingId,
    setRenamingId,
    openNoteId: view.kind === 'note' ? view.noteId : null,
    openFolderId: view.kind === 'notes' ? view.folderId : null,
    drop,
  }

  const isEmpty = tree.pinned.length === 0 && tree.foldersByParent.size === 0 && tree.notesByFolder.size === 0

  return (
    <TreeContext.Provider value={ui}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragMove={updateDrop}
        onDragOver={updateDrop}
        onDragEnd={onDragEnd}
        onDragCancel={finishDrag}
      >
        <div className="sb-tree" data-dragging={dragging ? true : undefined}>
          {tree.pinned.length > 0 && (
            <section className="sb-section" aria-label={t('Pinned', 'Fijadas')}>
              <h2 className="sb-section-title">{t('Pinned', 'Fijadas')}</h2>
              {tree.pinned.map((note) => (
                <NoteRow key={note.id} note={note} depth={0} section="pinned" />
              ))}
            </section>
          )}
          <section className="sb-section sb-section-tree" aria-label={t('Folders and notes', 'Carpetas y notas')}>
            <RootHeading dragging={dragging} />
            <TreeLevel parentId={null} depth={0} />
            {isEmpty && <p className="sb-empty">{t('No notes yet', 'Todavía no hay notas')}</p>}
          </section>
          <RootZone dragging={dragging} />
        </div>
        {createPortal(
          <DragOverlay
            dropAnimation={null}
            className="tree-drag-overlay"
            style={{ cursor: drop && !drop.result ? 'not-allowed' : 'grabbing' }}
          >
            {dragItem && (
              <div data-invalid={drop && !drop.result ? true : undefined} className="tree-drag-wrap">
                <DragPreview item={dragItem} />
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </TreeContext.Provider>
  )
}
