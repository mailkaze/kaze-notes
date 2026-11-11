import { defineConfig, devices } from '@playwright/test'

const PORT = 5183

/**
 * La app sin conexión. El service worker solo se registra en producción: build de producción con el backend
 * en memoria en `dist-e2e` (nunca en `dist`, que es lo que se despliega) servido con `vite preview`.
 */
export default defineConfig({
  testDir: 'e2e-offline',
  outputDir: 'test-results-offline',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Una prueba cambia dist-e2e/sw.js para simular un despliegue: nada en paralelo.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'es-ES',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite build --mode memory --outDir dist-e2e --emptyOutDir && npx vite preview --mode memory --outDir dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
