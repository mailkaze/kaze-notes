import { defineConfig, devices } from '@playwright/test'

const PORT = 5179

/** Pruebas e2e contra el backend en memoria (`vite --mode memory`), sin Firebase. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'es-ES',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], permissions: ['clipboard-read', 'clipboard-write'] },
    },
    // Motor de Safari: las pruebas que leen el portapapeles se omiten aquí.
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `npx vite --mode memory --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Siempre un servidor nuevo: uno viejo con módulos recargados en caliente rompe los tests que importan módulos de la app.
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
