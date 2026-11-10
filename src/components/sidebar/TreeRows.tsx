import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ChevronRight, Ellipsis, Folder as FolderIcon, FolderOpen, FolderPlus, Pencil, SquarePen, Trash } from 'lucide-react'
import { Fragment, useCallback, useRef, useState, type CSSProperties } from 'react'
import { noteBg } from '../../lib/colors'
import { t } from '../../lib/i18n'
import type { Folder, Note } from '../../lib/types'
import { createFolder, createNote, deleteFolder, openFolder, openNote, renameFolder, useApp } from '../../state/store'
import { confirmDialog } from '../ui/confirm'
import { Popover } from '../ui/Popover'
import { justDragged } from './dnd'
import { useExternalDrop } from './externalDrop'
import { previewLines, useTree, type DropState } from './treeContext'
import type { DragItem, DropTarget } from './treeDrop'

/** Cada fila es a la vez arrastrable y destino; `data-drop-id` permite localizarla bajo el puntero. */
function useTreeDnd(item: DragItem, target: DropTarget, disabled = false) {
  const id = `${item.kind}:${item.id}`
  const drag = useDraggable({ id, data: { item }, disabled })
  const drop = useDroppable({ id, data: { target } })
  const { setNodeRef: setDragRef } = drag
  const { setNodeRef: setDropRef } = drop
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el)
      setDropRef(el)
    },
    [setDragRef, setDropRef],
  )
  return { id, setRef, listeners: drag.listeners, isDragging: drag.isDragging }
}

function dropAttr(drop: DropState | null, id: string): string | undefined {
  if (drop?.overId !== id) return undefined
  return drop.result ? drop.zone : 'invalid'
}

/** Resaltado de un destino: arrastre dentro del árbol o tarjeta de la pantalla de notas encima. */
function useDropAttr(id: string): string | undefined {
  const { drop } = useTree()
  const external = useExternalDrop((s) => s.overId === id)
  return external ? 'into' : dropAttr(drop, id)
}

const depthStyle = (depth: number) => ({ '--depth': depth }) as CSSProperties

export function NoteRow({ note, depth, section }: { note: Note; depth: number; section: 'tree' | 'pinned' }) {
  const { openNoteId, drop } = useTree()
  const { id, setRef, listeners, isDragging } = useTreeDnd(
    { kind: 'note', id: note.id },
    { kind: 'note', id: note.id, section },
  )
  const title = note.title.trim()
  const lines = previewLines(note.preview)
  return (
    <button
      ref={setRef}
      type="button"
      className="tree-row tree-note"
      data-drop-id={id}
      data-testid="tree-note"
      data-active={openNoteId === note.id}
      data-dragging={isDragging || undefined}
      data-drop={dropAttr(drop, id)}
      data-colored={note.color ? true : undefined}
      style={{ ...depthStyle(depth), '--card-bg': note.color ? noteBg(note.color) : undefined } as CSSProperties}
      onClick={() => {
        if (!justDragged()) openNote(note.id)
      }}
      {...listeners}
    >
      <span className="tree-note-text">
        {title && <span className="tree-note-title">{title}</span>}
        {lines ? (
          <span className="tree-note-preview">{lines}</span>
        ) : (
          !title && <span className="tree-note-empty">{t('Empty note', 'Nota vacía')}</span>
        )}
      </span>
    </button>
  )
}

/** Campo de renombrado: Enter o perder el foco guardan, Esc cancela. Nunca guarda un nombre vacío. */
function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    const name = value.trim()
    onDone(save && name ? name : null)
  }
  return (
    <input
      className="tree-rename"
      value={value}
      autoFocus
      maxLength={120}
      aria-label={t('Folder name', 'Nombre de la carpeta')}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(false)
        }
      }}
    />
  )
}

async function confirmDeleteFolder(folder: Folder) {
  const ok = await confirmDialog({
    title: t('Delete folder?', '¿Eliminar carpeta?'),
    message: t(
      `"${folder.name}" and its subfolders will be deleted. Their notes will be moved to the trash.`,
      `Se eliminarán «${folder.name}» y sus subcarpetas. Sus notas se moverán a la papelera.`,
    ),
    confirmLabel: t('Delete', 'Eliminar'),
    danger: true,
  })
  if (ok) deleteFolder(folder.id)
}

function FolderMenu({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const { expand, setRenamingId } = useTree()
  const run = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <div role="menu" aria-label={folder.name}>
      <button type="button" role="menuitem" className="menu-item" onClick={run(() => createNote(folder.id))}>
        <SquarePen size={16} />
        {t('New note here', 'Nueva nota aquí')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        onClick={run(() => {
          const id = createFolder(folder.id, t('New folder', 'Nueva carpeta'))
          expand([folder.id])
          if (id) setRenamingId(id)
        })}
      >
        <FolderPlus size={16} />
        {t('New subfolder', 'Nueva subcarpeta')}
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={run(() => setRenamingId(folder.id))}>
        <Pencil size={16} />
        {t('Rename', 'Cambiar nombre')}
      </button>
      <div className="menu-sep" role="separator" />
      <button type="button" role="menuitem" className="menu-item danger" onClick={run(() => void confirmDeleteFolder(folder))}>
        <Trash size={16} />
        {t('Delete folder', 'Eliminar carpeta')}
      </button>
    </div>
  )
}

export function FolderRow({ folder, depth }: { folder: Folder; depth: number }) {
  const ui = useTree()
  const renaming = ui.renamingId === folder.id
  const { id, setRef, listeners, isDragging } = useTreeDnd(
    { kind: 'folder', id: folder.id },
    { kind: 'folder', id: folder.id },
    renaming,
  )
  const dropState = useDropAttr(id)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const closeMenu = useCallback(() => setMenuAnchor(null), [])
  const expanded = ui.expanded.has(folder.id)
  const count = ui.counts.get(folder.id) ?? 0
  const Icon = expanded ? FolderOpen : FolderIcon

  return (
    <>
      <div
        ref={setRef}
        className="tree-row tree-folder"
        data-drop-id={id}
        data-testid="tree-folder"
        data-active={ui.openFolderId === folder.id}
        data-dragging={isDragging || undefined}
        data-drop={dropState}
        data-menu-open={menuAnchor ? true : undefined}
        style={depthStyle(depth)}
        {...listeners}
      >
        <button
          type="button"
          className="tree-chevron"
          data-expanded={expanded}
          aria-expanded={expanded}
          aria-label={expanded ? t('Collapse folder', 'Contraer carpeta') : t('Expand folder', 'Desplegar carpeta')}
          onClick={() => ui.toggle(folder.id)}
        >
          <ChevronRight size={14} />
        </button>
        {renaming ? (
          <RenameInput
            initial={folder.name}
            onDone={(name) => {
              ui.setRenamingId(null)
              if (name && name !== folder.name) renameFolder(folder.id, name)
            }}
          />
        ) : (
          <button
            type="button"
            className="tree-main"
            title={folder.name}
            onClick={() => {
              if (!justDragged()) openFolder(folder.id)
            }}
            onDoubleClick={() => ui.setRenamingId(folder.id)}
          >
            <Icon size={16} className="tree-folder-icon" aria-hidden />
            <span className="tree-name">{folder.name}</span>
            {count > 0 && <span className="tree-count">{count}</span>}
          </button>
        )}
        <button
          type="button"
          className="icon-btn tree-menu-btn"
          aria-label={t('Folder options', 'Opciones de la carpeta')}
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAnchor)}
          onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
        >
          <Ellipsis size={16} />
        </button>
      </div>
      {/* Fuera de la fila para que los eventos del menú no lleguen a los manejadores de arrastre. */}
      <Popover anchor={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu} placement="bottom-end">
        <FolderMenu folder={folder} onClose={closeMenu} />
      </Popover>
    </>
  )
}

export function TreeLevel({ parentId, depth }: { parentId: string | null; depth: number }) {
  const ui = useTree()
  return (
    <>
      {(ui.foldersByParent.get(parentId) ?? []).map((folder) => (
        <Fragment key={folder.id}>
          <FolderRow folder={folder} depth={depth} />
          {ui.expanded.has(folder.id) && <TreeLevel parentId={folder.id} depth={depth + 1} />}
        </Fragment>
      ))}
      {(ui.notesByFolder.get(parentId) ?? []).map((note) => (
        <NoteRow key={note.id} note={note} depth={depth} section="tree" />
      ))}
    </>
  )
}

/** Zona al final del árbol: soltar aquí lleva notas y carpetas a la raíz. */
export function RootZone({ dragging }: { dragging: boolean }) {
  const dropState = useDropAttr('root')
  const { setNodeRef } = useDroppable({ id: 'root', data: { target: { kind: 'root' } satisfies DropTarget } })
  return (
    <div ref={setNodeRef} className="tree-root-zone" data-drop-id="root" data-drop={dropState}>
      {dragging && <span>{t('Move to top level', 'Mover al nivel principal')}</span>}
    </div>
  )
}

/** Encabezado "Notas": mientras se arrastra también saca notas y carpetas a la raíz (siempre visible arriba). */
export function RootHeading({ dragging }: { dragging: boolean }) {
  const dropState = useDropAttr('root-top')
  const { setNodeRef } = useDroppable({ id: 'root-top', data: { target: { kind: 'root' } satisfies DropTarget } })
  return (
    <h2
      ref={setNodeRef}
      className="sb-section-title tree-root-heading"
      data-drop-id="root-top"
      data-drop={dropState}
      data-dragging={dragging ? true : undefined}
    >
      {dragging ? t('Drop here to move out of folders', 'Suelta aquí para sacar de la carpeta') : t('Notes', 'Notas')}
    </h2>
  )
}

/** Fila compacta que sigue al puntero mientras se arrastra. */
export function DragPreview({ item }: { item: DragItem }) {
  const label = useApp((s) => {
    if (item.kind === 'folder') return s.folders[item.id]?.name ?? ''
    const note = s.notes[item.id]
    return note ? note.title.trim() || previewLines(note.preview, 1) : ''
  })
  const color = useApp((s) => (item.kind === 'note' ? s.notes[item.id]?.color ?? null : null))
  return (
    <div className="tree-drag-preview">
      {item.kind === 'folder' ? (
        <FolderIcon size={16} aria-hidden />
      ) : (
        <span className="tree-color" style={{ background: noteBg(color) }} aria-hidden />
      )}
      <span className="tree-name">{label || t('Empty note', 'Nota vacía')}</span>
    </div>
  )
}
