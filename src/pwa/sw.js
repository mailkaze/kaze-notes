// Service worker de Kaze Notes. Es una plantilla: el build (vite.config.ts) la escribe en `sw.js`
// con la versión y la lista de ficheros de la app.

const VERSION = '__SW_VERSION__'
const PRECACHE = ['__SW_PRECACHE__']

// Mismos nombres que en registerServiceWorker.ts.
const SHELL_PREFIX = 'kaze-shell-'
const SHELL_CACHE = SHELL_PREFIX + VERSION
const FILES_CACHE = 'kaze-files'
// Las descargas de <img> son opacas y el navegador cuenta cada una como varios MB de cuota,
// compartida con las notas guardadas sin conexión: se guardan solo las últimas.
const MAX_FILES = 100
// Por encima de esta parte de la cuota no se guardan más ficheros: el espacio queda para las notas y los adjuntos
// que aún esperan subirse.
const MAX_QUOTA_SHARE = 0.5

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      try {
        // Sin la caché HTTP: un index.html viejo dejaría una copia que no casa con su código.
        await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'no-cache' })))
      } catch (error) {
        // Una copia a medias no puede contar como versión anterior.
        await caches.delete(SHELL_CACHE)
        throw error
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Se conserva la versión anterior (la última creada): una página que aún la ejecuta
      // puede seguir cargando su código a demanda, también sin conexión.
      const old = (await caches.keys()).filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
      await Promise.all(old.slice(0, -1).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

/** Busca en la copia de la versión actual y después en la anterior. */
async function fromShell(request) {
  const old = (await caches.keys()).filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
  for (const cacheName of [SHELL_CACHE, ...old.reverse()]) {
    // Sin Vary: el navegador pide los módulos con cabecera Origin y la copia se guardó sin ella.
    const cached = await caches.match(request, { cacheName, ignoreVary: true })
    if (cached) return cached
  }
  return undefined
}

function isStorageFile(url) {
  return (
    url.hostname === 'firebasestorage.googleapis.com' &&
    /^\/v0\/b\/[^/]+\/o\//.test(url.pathname) &&
    url.searchParams.get('alt') === 'media'
  )
}

async function storageFile(event) {
  const cache = await caches.open(FILES_CACHE)
  const cached = await cache.match(event.request)
  if (cached) return cached
  const response = await fetch(event.request)
  // Nunca se guarda un error conocido: se serviría siempre. Las respuestas opacas (de <img>) no dicen si lo son: un
  // fallo así sale de la caché con los 100 ficheros siguientes o al cerrar sesión.
  if (response.ok || response.type === 'opaque') event.waitUntil(keepFile(cache, event.request, response.clone()))
  return response
}

async function hasRoom() {
  try {
    const { usage, quota } = await self.navigator.storage.estimate()
    return !quota || usage / quota < MAX_QUOTA_SHARE
  } catch {
    return true
  }
}

async function keepFile(cache, request, response) {
  // Las claves salen en orden de inserción: se borran las más antiguas.
  const keys = await cache.keys()
  if (!(await hasRoom())) {
    // Sin sitio: se libera la mitad más antigua y este fichero no se guarda.
    await Promise.all(keys.slice(0, Math.ceil(keys.length / 2)).map((key) => cache.delete(key)))
    return
  }
  await cache.put(request, response)
  await Promise.all(keys.slice(0, Math.max(0, keys.length + 1 - MAX_FILES)).map((key) => cache.delete(key)))
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin === self.location.origin) {
    // /__/ es de Firebase (inicio de sesión, configuración): siempre a la red.
    if (url.pathname.startsWith('/__/') || url.pathname === '/sw.js') return
    if (request.mode === 'navigate') {
      // La app guardada aunque haya conexión (mala o no); la red solo si no hay copia.
      event.respondWith(fromShell('/index.html').then((cached) => cached ?? fetch(request)))
    } else {
      event.respondWith(fromShell(request).then((cached) => cached ?? fetch(request)))
    }
  } else if (isStorageFile(url) && !request.headers.has('range')) {
    event.respondWith(storageFile(event))
  }
  // Lo demás (Firestore, Auth, otros dominios) no se toca.
})
