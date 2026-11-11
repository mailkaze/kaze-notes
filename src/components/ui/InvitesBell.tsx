import { Bell } from 'lucide-react'
import { useCallback, useState } from 'react'
import { isSpanish, t } from '../../lib/i18n'
import type { Invite } from '../../lib/sharing'
import { acceptInvite, rejectInvite, useApp } from '../../state/store'
import { Popover } from './Popover'

/** Aviso en la cabecera mientras haya invitaciones a notas de otros usuarios; al tocarlo se aceptan o rechazan. */
export function InvitesBell() {
  const invites = useApp((s) => s.invites)
  // Sin invitaciones se desmonta: la siguiente que llegue no aparece con el panel ya abierto.
  return invites.length > 0 ? <InvitesPanel invites={invites} /> : null
}

function InvitesPanel({ invites }: { invites: Invite[] }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  const label =
    invites.length === 1
      ? t('1 shared note invitation', '1 invitación a una nota compartida')
      : t(`${invites.length} shared note invitations`, `${invites.length} invitaciones a notas compartidas`)

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="icon-btn invites-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={20} />
        <span className="invites-badge" aria-hidden>
          {invites.length}
        </span>
      </button>
      <Popover anchor={anchor} open={open} onClose={close} placement="bottom-end" className="invites-pop">
        <ul className="invites-list">
          {invites.map((invite) => (
            <li key={`${invite.ownerUid}/${invite.noteId}`} className="invite">
              <p className="invite-text">
                {isSpanish ? (
                  <>
                    El usuario <strong>{invite.ownerEmail}</strong> quiere compartir una nota contigo
                  </>
                ) : (
                  <>
                    The user <strong>{invite.ownerEmail}</strong> wants to share a note with you
                  </>
                )}
              </p>
              <div className="invite-actions">
                <button type="button" className="btn btn-ghost" onClick={() => rejectInvite(invite)}>
                  {t('Reject', 'Rechazar')}
                </button>
                <button type="button" className="btn btn-primary" onClick={() => acceptInvite(invite)}>
                  {t('Accept', 'Aceptar')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  )
}
