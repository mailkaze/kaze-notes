import type { DraggableSyntheticListeners } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Folder as FolderIcon, Pin, Trash } from 'lucide-react'
import type { CSSProperties, Ref } from 'react'
import { noteBg } from '../../lib/colors'
import { t } from '../../lib/i18n'
import type { LayoutMode, Note } from '../../lib/types'
import { openNote, setPinned, trashNote } from '../../state/store'
import { justDragged } from '../sidebar/dnd'

interface NoteCardProps {
  note: Note
  layout: LayoutMode
  /** Ruta de carpetas, solo en "Todas las notas" y en la búsqueda. */
  path?: string
  /** Copia que sigue al puntero al arrastrar. */
  overlay?: boolean
  dragging?: boolean
  ref?: Ref<HTMLElement>
  style?: CSSProperties
  dragListeners?: DraggableSyntheticListeners
}

export function NoteCard({ note, layout, path, overlay, dragging, ref, style, dragListeners }: NoteCardProps) {
  const title = note.title.trim()
  const preview = note.preview.trim()
  return (
    <article
      ref={ref}
      className="note-card"
      data-layout={layout}
      data-colored={note.color ? true : undefined}
      data-dragging={dragging || undefined}
      data-overlay={overlay || undefined}
      data-testid="note-card"
      style={{ ...style, background: noteBg(note.color) }}
      {...dragListeners}
    >
      <button
        type="button"
        className="note-card-open"
        tabIndex={overlay ? -1 : undefined}
        onClick={() => {
          if (!justDragged()) openNote(note.id)
        }}
      >
        {title && <span className="note-card-title">{title}</span>}
        {preview ? (
          <span className="note-card-preview">{preview}</span>
        ) : (
          !title && <span className="note-card-empty">{t('Empty note', 'Nota vacía')}</span>
        )}
        {/* Pie: ruta de la carpeta y hueco para las acciones (que no tapan el texto). */}
        <span className="note-card-foot">
          {path && (
            <span className="note-card-path">
              <FolderIcon size={12} aria-hidden />
              <span>{path}</span>
            </span>
          )}
        </span>
      </button>
      <div className="note-card-actions">
        <button
          type="button"
          className="icon-btn note-card-trash"
          aria-label={t('Move to trash', 'Mover a la papelera')}
          title={t('Move to trash', 'Mover a la papelera')}
          onClick={() => trashNote(note.id)}
        >
          <Trash size={15} />
        </button>
        <button
          type="button"
          className="icon-btn note-card-pin"
          data-pinned={note.pinned}
          aria-pressed={note.pinned}
          aria-label={note.pinned ? t('Unpin', 'Desfijar') : t('Pin', 'Fijar')}
          title={note.pinned ? t('Unpin', 'Desfijar') : t('Pin', 'Fijar')}
          onClick={() => setPinned(note.id, !note.pinned)}
        >
          <Pin size={15} />
        </button>
      </div>
    </article>
  )
}

export function SortableNoteCard(props: { note: Note; layout: LayoutMode; path?: string }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.note.id })
  return (
    <NoteCard
      {...props}
      ref={setNodeRef}
      dragListeners={listeners}
      dragging={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    />
  )
}
