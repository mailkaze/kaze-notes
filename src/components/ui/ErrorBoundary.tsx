import { Component, type ReactNode } from 'react'
import { t } from '../../lib/i18n'

// Marca de que ya se ha recargado por un fallo al cargar código (evita recargar en bucle).
const RELOAD_KEY = 'kaze:chunk-reload'

/** Tras un despliegue, el código que se carga a demanda de la versión anterior ya no está en el servidor. */
function isChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|importing a module script failed|unable to preload/i.test(message)
}

function reloadedBefore(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_KEY) !== null
  } catch {
    return true
  }
}

/** El código cargado a demanda ha llegado bien: si otro despliegue lo rompe, se puede volver a recargar. */
export function chunkLoaded() {
  try {
    sessionStorage.removeItem(RELOAD_KEY)
  } catch {
    // Sin almacenamiento: no se recarga sola.
  }
}

interface State {
  failed: boolean
  reloading: boolean
}

/**
 * Si falla lo que contiene, muestra `message` con un botón para recargar en vez de dejar la pantalla en blanco.
 * Si lo que falla es la carga del código, recarga la página una vez (con la versión nueva de la app).
 */
export class ErrorBoundary extends Component<{ message: string; children: ReactNode }, State> {
  state: State = { failed: false, reloading: false }

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, reloading: isChunkError(error) && !reloadedBefore() }
  }

  componentDidCatch() {
    if (!this.state.reloading) return
    try {
      sessionStorage.setItem(RELOAD_KEY, '1')
    } catch {
      this.setState({ reloading: false })
      return
    }
    location.reload()
  }

  render() {
    if (!this.state.failed) return this.props.children
    if (this.state.reloading) return null
    return (
      <div className="center-screen">
        <div className="login-card" role="alert">
          <p>{this.props.message}</p>
          <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
            {t('Reload', 'Recargar')}
          </button>
        </div>
      </div>
    )
  }
}
