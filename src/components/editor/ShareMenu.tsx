import { LogOut, UserPlus, Users, X } from 'lucide-react'
import { useCallback, useState, type FormEvent } from 'react'
import { t } from '../../lib/i18n'
import type { Note } from '../../lib/types'
import { leaveSharedNote, shareNote, stopSharing, useApp } from '../../state/store'
import { confirmDialog } from '../ui/confirm'
import { Popover } from '../ui/Popover'

/** Personas con las que está compartida (aceptadas y pendientes). */
function peopleOf(note: Note): string[] {
  return [...(note.members ?? []), ...(note.invited ?? [])]
}

async function confirmStop(note: Note, email: string) {
  const ok = await confirmDialog({
    title: t(`Stop sharing with ${email}?`, `¿Dejar de compartir con ${email}?`),
    message: t('They will no longer see this note.', 'Dejará de ver esta nota.'),
    confirmLabel: t('Stop sharing', 'Dejar de compartir'),
    danger: true,
  })
  if (ok) stopSharing(note.id, email)
}

async function confirmLeave(note: Note) {
  const owner = note.ownerEmail || t('its owner', 'quien la creó')
  const ok = await confirmDialog({
    title: t('Stop sharing this note?', '¿Dejar de compartir esta nota?'),
    message: t(`You will no longer see it; it stays with ${owner}.`, `Dejarás de verla; seguirá siendo de ${owner}.`),
    confirmLabel: t('Stop sharing', 'Dejar de compartir'),
    danger: true,
  })
  if (ok) leaveSharedNote(note.id)
}

function SharePanel({ note, onClose }: { note: Note; onClose: () => void }) {
  const me = useApp((s) => s.user?.email ?? '')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const invitee = Boolean(note.ownerUid)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = shareNote(note.id, email)
    setError(problem)
    if (!problem) setEmail('')
  }

  // El invitado ve al dueño y al resto de personas; el dueño, a quienes ha invitado (y si aún no han aceptado).
  const rows = invitee
    ? [note.ownerEmail ?? '', ...(note.members ?? []).filter((e) => e !== me)].filter(Boolean)
    : peopleOf(note)

  return (
    <div className="share-panel">
      <p className="share-title">
        {invitee
          ? t(`Shared with you by ${note.ownerEmail ?? ''}`, `Compartida contigo por ${note.ownerEmail ?? ''}`)
          : rows.length > 0
            ? t('Shared with', 'Compartida con')
            : t('Share note', 'Compartir nota')}
      </p>
      {rows.length > 0 && (
        <ul className="share-people" aria-label={t('People', 'Personas')}>
          {rows.map((person) => {
            const pending = !invitee && note.invited?.includes(person)
            const isOwner = invitee && person === note.ownerEmail
            return (
              <li key={person} className="share-person">
                <span className="share-email" title={person}>
                  {person}
                </span>
                {pending && <span className="share-tag">{t('Pending', 'Pendiente')}</span>}
                {isOwner && <span className="share-tag">{t('Owner', 'Propietario')}</span>}
                {!invitee && (
                  <button
                    type="button"
                    className="icon-btn share-remove"
                    aria-label={t(`Stop sharing with ${person}`, `Dejar de compartir con ${person}`)}
                    title={t(`Stop sharing with ${person}`, `Dejar de compartir con ${person}`)}
                    onClick={() => {
                      onClose()
                      void confirmStop(note, person)
                    }}
                  >
                    <X size={16} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {invitee ? (
        <button
          type="button"
          className="menu-item danger"
          onClick={() => {
            onClose()
            void confirmLeave(note)
          }}
        >
          <LogOut size={16} />
          {t('Stop sharing', 'Dejar de compartir')}
        </button>
      ) : (
        <form className="share-form" onSubmit={submit}>
          <input
            className="share-input"
            type="email"
            value={email}
            autoFocus
            required
            aria-label={t("Other user's email", 'Correo del otro usuario')}
            placeholder={t("Other user's email", 'Correo del otro usuario')}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setEmail(e.target.value)
              setError(null)
            }}
          />
          <button type="submit" className="btn btn-primary">
            {rows.length > 0 ? t('Add', 'Añadir') : t('Share', 'Compartir')}
          </button>
          {error && (
            <p className="share-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  )
}

/** Botón de compartir: muestra si la nota está compartida y con quién, y abre el panel para gestionarlo. */
export function ShareButton({ note }: { note: Note }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const people = peopleOf(note)
  const shared = Boolean(note.ownerUid) || people.length > 0
  const label = note.ownerUid
    ? t(`Shared with you by ${note.ownerEmail ?? ''}`, `Compartida contigo por ${note.ownerEmail ?? ''}`)
    : shared
      ? t(`Shared with ${people.join(', ')}`, `Compartida con ${people.join(', ')}`)
      : t('Share', 'Compartir')

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="icon-btn share-btn"
        data-active={shared}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {shared ? <Users size={21} /> : <UserPlus size={21} />}
        {people.length > 0 && <span className="share-count">{people.length}</span>}
      </button>
      <Popover anchor={anchor} open={open} onClose={close} placement="bottom-end" className="share-pop">
        <SharePanel note={note} onClose={close} />
      </Popover>
    </>
  )
}
