import { RotateCcw, Trash } from 'lucide-react'
import { useMemo } from 'react'
import { noteBg } from '../../lib/colors'
import { isSpanish, t } from '../../lib/i18n'
import { trashedNotes } from '../../lib/tree'
import type { Note } from '../../lib/types'
import { deleteNoteForever, emptyTrash, restoreNote, useApp } from '../../state/store'
import { confirmDialog } from '../ui/confirm'
import { SidebarToggle } from '../ui/controls'
import { SyncIndicator } from '../ui/SyncIndicator'
import { previewLines } from '../sidebar/treeContext'
import { useNarrow } from './useNarrow'
import './notes.css'

const LOCALE = isSpanish ? 'es' : 'en'

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** "hace 3 días", "ayer", "ahora"… en el idioma de la interfaz. */
function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = (timestamp - now) / 1000
  const format = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, 'second')
}

function TrashItem({ note }: { note: Note }) {
  const title = note.title.trim()
  const lines = previewLines(note.preview)

  const onDelete = async () => {
    const ok = await confirmDialog({
      title: t('Delete forever?', '¿Eliminar definitivamente?'),
      message: t('This note will be deleted forever. This cannot be undone.', 'Esta nota se eliminará para siempre. No se puede deshacer.'),
      confirmLabel: t('Delete forever', 'Eliminar definitivamente'),
      danger: true,
    })
    if (ok) deleteNoteForever(note.id)
  }

  return (
    <li className="trash-item" data-testid="trash-item">
      {note.color && <span className="trash-swatch" style={{ background: noteBg(note.color) }} aria-hidden />}
      <div className="trash-text">
        {title && <span className="trash-title">{title}</span>}
        {lines ? (
          <span className="trash-preview">{lines}</span>
        ) : (
          !title && <span className="trash-empty-note">{t('Empty note', 'Nota vacía')}</span>
        )}
        {note.trashedAt && (
          <time
            className="trash-date"
            dateTime={new Date(note.trashedAt).toISOString()}
            title={new Date(note.trashedAt).toLocaleString(LOCALE)}
          >
            {t('Deleted', 'Eliminada')} {relativeTime(note.trashedAt)}
          </time>
        )}
      </div>
      <div className="trash-actions">
        <button
          type="button"
          className="btn btn-ghost"
          aria-label={t('Restore', 'Restaurar')}
          title={t('Restore', 'Restaurar')}
          onClick={() => restoreNote(note.id)}
        >
          <RotateCcw size={16} />
          <span className="trash-btn-label">{t('Restore', 'Restaurar')}</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost trash-danger"
          aria-label={t('Delete forever', 'Eliminar definitivamente')}
          title={t('Delete forever', 'Eliminar definitivamente')}
          onClick={() => void onDelete()}
        >
          <Trash size={16} />
          <span className="trash-btn-label">{t('Delete forever', 'Eliminar definitivamente')}</span>
        </button>
      </div>
    </li>
  )
}

export function TrashScreen() {
  const notes = useApp((s) => s.notes)
  const trashed = useMemo(() => trashedNotes(notes), [notes])
  const narrow = useNarrow()

  const onEmpty = async () => {
    const count = trashed.length
    const ok = await confirmDialog({
      title: t('Empty trash?', '¿Vaciar la papelera?'),
      message:
        count === 1
          ? t('1 note will be deleted forever. This cannot be undone.', 'Se eliminará 1 nota para siempre. No se puede deshacer.')
          : t(
              `${count} notes will be deleted forever. This cannot be undone.`,
              `Se eliminarán ${count} notas para siempre. No se puede deshacer.`,
            ),
      confirmLabel: t('Empty trash', 'Vaciar papelera'),
      danger: true,
    })
    if (ok) emptyTrash()
  }

  return (
    <div className="notes-screen">
      <header className="screen-header">
        <SidebarToggle />
        <h1 className="screen-title">{t('Trash', 'Papelera')}</h1>
        <button
          type="button"
          className="btn btn-ghost trash-danger trash-empty-all"
          disabled={trashed.length === 0}
          aria-label={t('Empty trash', 'Vaciar papelera')}
          title={t('Empty trash', 'Vaciar papelera')}
          onClick={() => void onEmpty()}
        >
          <Trash size={16} />
          <span className="trash-btn-label">{t('Empty trash', 'Vaciar papelera')}</span>
        </button>
        <SyncIndicator compact={narrow} />
      </header>
      <div className="screen-body">
        {trashed.length === 0 ? (
          <div className="empty-state">
            <Trash size={34} strokeWidth={1.5} aria-hidden />
            <p>{t('The trash is empty', 'La papelera está vacía')}</p>
          </div>
        ) : (
          <ul className="trash-list">
            {trashed.map((note) => (
              <TrashItem key={note.id} note={note} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
