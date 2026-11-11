// Mismos nombres que en sw.js.
const CACHE_PREFIX = 'kaze-'
const FILES_CACHE = 'kaze-files'
const UPDATE_CHECK_INTERVAL = 60_000

let updateReady = false
const listeners = new Set<() => void>()

/** Hay una versión nueva de la app controlando la página: falta recargar para usarla. */
export function isUpdateReady(): boolean {
  return updateReady
}

export function onUpdateReady(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function watchForUpdates(registration: ServiceWorkerRegistration) {
  let lastCheck = Date.now()
  const check = () => {
    lastCheck = Date.now()
    registration.update().catch(() => {
      // Sin conexión o sin servidor: se vuelve a mirar en la próxima ocasión.
    })
  }
  // Al recuperar la conexión siempre; al volver a la pestaña, como mucho una vez por minuto.
  window.addEventListener('online', check)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck >= UPDATE_CHECK_INTERVAL) check()
  })
}

/** Registra el service worker que guarda la app para usarla sin conexión (solo en producción). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return
  // Sin esto el navegador puede borrar los datos locales si le falta espacio, también cambios aún sin enviar.
  navigator.storage?.persist?.().catch(() => {})
  const container = navigator.serviceWorker
  // Si la página ya estaba controlada, el siguiente que tome el control es una versión nueva.
  let controlled = container.controller !== null
  container.addEventListener('controllerchange', () => {
    if (controlled) {
      updateReady = true
      listeners.forEach((fn) => fn())
    }
    controlled = true
  })
  const register = () => {
    container.register('/sw.js').then(watchForUpdates, () => {
      // Sin service worker la app sigue funcionando con conexión.
    })
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

/** Borra la copia local de los adjuntos descargados. */
export async function clearCachedFiles() {
  if (typeof caches === 'undefined') return
  await caches.delete(FILES_CACHE)
}

/** Borra todas las cachés de la app (código y adjuntos): sin conexión no abrirá hasta la próxima versión. */
export async function clearAllCaches() {
  if (typeof caches === 'undefined') return
  const names = await caches.keys()
  await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)))
}
