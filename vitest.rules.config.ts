import { defineConfig } from 'vitest/config'

// Pruebas de las reglas de Firestore: necesitan el emulador (npm run test:rules lo arranca).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['rules-tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
