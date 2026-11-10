import { ArrowLeft, FingerprintPattern } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { noteBg } from '../../lib/colors'
import { DeviceAuthError } from '../../lib/deviceAuth'
import { t } from '../../lib/i18n'
import { closeNote, unlockNote, useApp } from '../../state/store'
import { SidebarToggle } from '../ui/controls'
import { SyncIndicator } from '../ui/SyncIndicator'
import { FolderPicker } from './NoteHeader'

/** Pantalla de una nota protegida: solo el título hasta que el dispositivo verifica al usuario. */
export function LockedNote({ noteId }: { noteId: string }) {
  const note = useApp((s) => s.notes[noteId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tras un intento fallido se ofrece registrar el dispositivo de nuevo (p. ej. si se borró la llave de acceso).
  const [failed, setFailed] = useState(false)

  const unlock = useCallback(
    async (manual: boolean, reregister = false) => {
      setBusy(true)
      setError(null)
      try {
        await unlockNote(noteId, { reregister })
      } catch (e) {
        // El intento automático puede fallar sin que el usuario haya hecho nada (Safari exige pulsar un botón).
        if (!manual) return
        setFailed(true)
        if (!(e instanceof DeviceAuthError && e.cancelled)) setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [noteId],
  )

  // Al abrir la nota se pide la verificación directamente.
  useEffect(() => {
    void unlock(false)
  }, [unlock])

  if (!note) return null
  const title = note.title.trim()
  return (
    <div className="note-editor note-locked" data-colored={note.color ? 'true' : 'false'} style={{ background: noteBg(note.color) }}>
      <header className="screen-header note-header">
        <SidebarToggle />
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Back to notes', 'Volver a las notas')}
          title={t('Back to notes', 'Volver a las notas')}
          onClick={closeNote}
        >
          <ArrowLeft size={18} />
        </button>
        <FolderPicker note={note} />
        <SyncIndicator />
      </header>
      <div className="note-locked-body">
        <FingerprintPattern size={56} strokeWidth={1.5} className="note-locked-icon" aria-hidden />
        {title && <h1 className="note-locked-title">{title}</h1>}
        <p className="note-locked-text">{t('This note is protected.', 'Esta nota está protegida.')}</p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void unlock(true)}>
          <FingerprintPattern size={18} aria-hidden />
          {t('Unlock', 'Desbloquear')}
        </button>
        {error && (
          <p className="note-locked-error" role="alert">
            {error}
          </p>
        )}
        {failed && (
          <button type="button" className="btn btn-ghost note-locked-reset" disabled={busy} onClick={() => void unlock(true, true)}>
            {t('Not working? Register this device again', '¿No funciona? Registrar este dispositivo de nuevo')}
          </button>
        )}
      </div>
    </div>
  )
}
