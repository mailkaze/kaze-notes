import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { t } from '../../lib/i18n'

interface ConfirmRequest {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  /** Solo informa: sin botón de cancelar. */
  notice?: boolean
  resolve: (ok: boolean) => void
}

const useConfirm = create<{ request: ConfirmRequest | null }>(() => ({ request: null }))

/** Muestra un diálogo de confirmación y resuelve true si se acepta. */
export function confirmDialog(options: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ request: { ...options, resolve } }))
}

/** true mientras hay un diálogo de confirmación abierto. */
export function isConfirmOpen(): boolean {
  return useConfirm.getState().request !== null
}

function close(ok: boolean) {
  const { request } = useConfirm.getState()
  useConfirm.setState({ request: null })
  request?.resolve(ok)
}

export function ConfirmHost() {
  const request = useConfirm((s) => s.request)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!request) return
    // Al cerrarse, el foco vuelve a donde estaba (p. ej. el texto de la nota).
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [request])

  if (!request) return null
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title" className="dialog-title">
          {request.title}
        </h2>
        {request.message && <p className="dialog-message">{request.message}</p>}
        <div className="dialog-actions">
          {!request.notice && (
            <button type="button" className="btn" onClick={() => close(false)}>
              {t('Cancel', 'Cancelar')}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={request.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => close(true)}
          >
            {request.confirmLabel ?? t('Confirm', 'Aceptar')}
          </button>
        </div>
      </div>
    </div>
  )
}
