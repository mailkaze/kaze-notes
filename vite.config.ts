import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { renderServiceWorker, shellManifest } from './src/pwa/swBuild'

/** Escribe `sw.js` en la salida del build con todos sus ficheros (también los de public/) y su versión. */
function serviceWorker(): Plugin {
  return {
    name: 'kaze-service-worker',
    apply: 'build',
    writeBundle(options) {
      const outDir = options.dir!
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const file = join(entry.parentPath, entry.name)
          return { path: relative(outDir, file).split(sep).join('/'), content: readFileSync(file) }
        })
      const template = readFileSync(new URL('./src/pwa/sw.js', import.meta.url), 'utf8')
      // Las cabeceras de Hosting entran en la versión: un cambio solo de la CSP también llega a los dispositivos.
      const headers = JSON.stringify(readFirebaseConfig().hosting.headers)
      writeFileSync(join(outDir, 'sw.js'), renderServiceWorker(template, shellManifest(files, headers)))
    },
  }
}

type HostingHeaders = { source: string; headers: { key: string; value: string }[] }[]

function readFirebaseConfig(): { hosting: { headers: HostingHeaders } } {
  return JSON.parse(readFileSync(new URL('./firebase.json', import.meta.url), 'utf8'))
}

/** Cabeceras que Firebase Hosting envía con la página de la app (firebase.json): `vite preview` las imita. */
function appPageHeaders(): Record<string, string> {
  const rule = readFirebaseConfig().hosting.headers.find((r) => r.source === '/')!
  return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]))
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  // Las pruebas sin conexión (build servido con `vite preview`) se ejecutan con la CSP de producción.
  preview: { headers: appPageHeaders() },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
