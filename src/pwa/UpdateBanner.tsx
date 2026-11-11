import { useSyncExternalStore } from 'react'
import { t } from '../lib/i18n'
import { flushAll } from '../state/store'
import { isUpdateReady, onUpdateReady } from './registerServiceWorker'
import './UpdateBanner.css'

async function reload() {
  // Lo pendiente del editor se guarda antes de recargar.
  await flushAll()
  location.reload()
}

/** Aviso, sin bloquear nada, de que hay una versión nueva de la app lista. */
export function UpdateBanner() {
  const ready = useSyncExternalStore(onUpdateReady, isUpdateReady)
  if (!ready) return null
  return (
    <div className="update-banner" role="status">
      <span>{t('A new version is available', 'Hay una versión nueva')}</span>
      <button type="button" className="btn btn-primary" onClick={() => void reload()}>
        {t('Reload', 'Recargar')}
      </button>
    </div>
  )
}
