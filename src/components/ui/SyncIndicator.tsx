import { AlertTriangle, CloudCheck, CloudOff, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t } from '../../lib/i18n'
import { selectSyncStatus, useApp } from '../../state/store'

// Si lleva tanto tiempo "sincronizando", se considera que no está sincronizado.
const STALLED_MS = 20_000

type Shown = 'synced' | 'syncing' | 'offline' | 'error' | 'stalled'

const LABELS: Record<Shown, { label: string; hint: string }> = {
  synced: {
    label: t('Synced', 'Sincronizado'),
    hint: t('All changes are saved in the cloud', 'Todos los cambios están guardados en la nube'),
  },
  syncing: {
    label: t('Syncing…', 'Sincronizando…'),
    hint: t('Saving changes to the cloud', 'Guardando cambios en la nube'),
  },
  offline: {
    label: t('Offline', 'Sin conexión'),
    hint: t(
      'Not synced: changes are kept on this device and will upload when you are back online',
      'Sin sincronizar: los cambios se guardan en este dispositivo y se subirán al recuperar la conexión',
    ),
  },
  stalled: {
    label: t('Not synced', 'Sin sincronizar'),
    hint: t('Cannot reach the cloud. Changes are kept on this device', 'No se puede conectar con la nube. Los cambios se guardan en este dispositivo'),
  },
  error: {
    label: t('Sync error', 'Error al sincronizar'),
    hint: t('Some changes could not be saved', 'Algunos cambios no se han podido guardar'),
  },
}

/** Estado de sincronización siempre visible. `compact` muestra solo el icono. */
export function SyncIndicator({ compact = false }: { compact?: boolean }) {
  const status = useApp(selectSyncStatus)
  const error = useApp((s) => s.sync.error)
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    setStalled(false)
    if (status !== 'syncing') return
    const timer = setTimeout(() => setStalled(true), STALLED_MS)
    return () => clearTimeout(timer)
  }, [status])

  const shown: Shown = status === 'syncing' && stalled ? 'stalled' : status
  const { label, hint } = LABELS[shown]
  const Icon = shown === 'synced' ? CloudCheck : shown === 'syncing' ? RefreshCw : shown === 'error' ? AlertTriangle : CloudOff
  const title = shown === 'error' && error ? `${hint}: ${error}` : hint

  return (
    <span
      className={`sync-indicator sync-${shown}${compact ? ' sync-compact' : ''}`}
      role="status"
      aria-live="polite"
      title={title}
      data-testid="sync-indicator"
      data-status={shown}
    >
      <Icon size={17} strokeWidth={2.2} className={shown === 'syncing' ? 'spin' : undefined} aria-hidden />
      <span className={compact ? 'visually-hidden' : 'sync-label'}>{label}</span>
    </span>
  )
}
