import { createHash } from 'node:crypto'

// Solo para el build (vite.config.ts) y sus pruebas: usa Node, la app no lo importa.

/** Fichero de la carpeta de salida del build, con su ruta relativa separada por `/`. */
export interface BuiltFile {
  path: string
  content: string | Uint8Array
}

export interface ShellManifest {
  urls: string[]
  version: string
}

const VERSION_TOKEN = "'__SW_VERSION__'"
const PRECACHE_TOKEN = "['__SW_PRECACHE__']"

// Fuera quedan los mapas de código, los ficheros ocultos (Hosting no los sirve) y el propio service worker.
function isShellFile(path: string): boolean {
  return !path.endsWith('.map') && path !== 'sw.js' && !path.split('/').some((part) => part.startsWith('.'))
}

/** URLs de todo lo que la app necesita sin conexión y una versión que cambia si cambia cualquier fichero. */
export function shellManifest(files: BuiltFile[]): ShellManifest {
  const shell = files.filter((file) => isShellFile(file.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash('sha256')
  for (const file of shell) hash.update(file.path).update('\0').update(file.content).update('\0')
  return { urls: shell.map((file) => `/${file.path}`), version: hash.digest('hex').slice(0, 16) }
}

/** Rellena la plantilla `src/pwa/sw.js` con la versión y la lista de ficheros. */
export function renderServiceWorker(template: string, manifest: ShellManifest): string {
  if (!template.includes(VERSION_TOKEN) || !template.includes(PRECACHE_TOKEN)) {
    throw new Error('sw.js: faltan los marcadores de versión o de ficheros')
  }
  return template
    .replace(VERSION_TOKEN, () => JSON.stringify(manifest.version))
    .replace(PRECACHE_TOKEN, () => JSON.stringify(manifest.urls))
}
