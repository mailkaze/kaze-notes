import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

// La app sin conexión sobre un build de producción con el backend en memoria (datos en localStorage de cada contexto).

const SW_FILE = new URL('../dist-e2e/sw.js', import.meta.url)
const lineEnd = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Google/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

/** Desde que el service worker controla la página, la app está guardada para abrirla sin conexión. */
async function waitForOfflineReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 20_000 })
    .toBe(true)
}

async function newNote(page: Page, title: string, body: string) {
  await page.locator('.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await page.getByPlaceholder('Título').fill(title)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type(body)
}

async function backToNotes(page: Page) {
  await page.getByRole('button', { name: 'Volver a las notas' }).click()
  await expect(page.locator('.ProseMirror')).toHaveCount(0)
}

function storedContent(page: Page, title: string): Promise<string | undefined> {
  return page.evaluate((t) => {
    const notes = Object.values(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{}}').notes)
    return (notes as { title: string; content: string }[]).find((n) => n.title === t)?.content
  }, title)
}

test('opens, lists and edits notes offline after the first visit (S1)', async ({ page, context }) => {
  await signIn(page)
  await newNote(page, 'Sin conexión', 'Escrito con red')
  await backToNotes(page)
  await waitForOfflineReady(page)

  await context.setOffline(true)
  const response = await page.reload()
  expect(response?.fromServiceWorker()).toBe(true)
  const row = page.getByTestId('tree-note').filter({ hasText: 'Sin conexión' })
  await expect(row).toContainText('Escrito con red')

  // El editor se carga a demanda: su código también sale de la copia guardada.
  await row.click()
  await expect(page.locator('.ProseMirror')).toContainText('Escrito con red')
  await page.locator('.ProseMirror').click()
  await page.keyboard.press(lineEnd)
  await page.keyboard.type(' y sin red')
  await backToNotes(page)
  await expect(row).toContainText('Escrito con red y sin red')

  await page.reload()
  await expect(row).toContainText('Escrito con red y sin red')
})

test('Firebase reserved paths are never answered with the app (S1)', async ({ page, context }) => {
  await page.goto('/')
  await waitForOfflineReady(page)
  await context.setOffline(true)

  // Cualquier otra dirección abre la app guardada...
  await page.goto('/otra/ruta')
  await expect(page.getByRole('button', { name: /Google/ })).toBeVisible()
  // ...pero /__/ (inicio de sesión y configuración de Firebase) va siempre a la red.
  await expect(page.goto('/__/auth/handler')).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/)
})

test('offers the new version after reconnecting and keeps what was being typed (S1)', async ({ page, context }) => {
  await signIn(page)
  await waitForOfflineReady(page)
  const banner = page.getByRole('status').filter({ hasText: 'Hay una versión nueva' })

  await context.setOffline(true)
  // Un despliegue nuevo mientras no hay conexión.
  const original = readFileSync(SW_FILE, 'utf8')
  writeFileSync(SW_FILE, `${original}\n// e2e: versión nueva\n`)
  try {
    await expect(banner).toHaveCount(0)
    await context.setOffline(false)
    await expect(banner).toBeVisible({ timeout: 20_000 })

    // El aviso no bloquea: se puede seguir escribiendo y lo escrito sobrevive a la recarga.
    await newNote(page, 'Antes de recargar', 'Texto recién escrito')
    await Promise.all([page.waitForEvent('load'), banner.getByRole('button', { name: 'Recargar' }).click()])
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(banner).toHaveCount(0)
    expect(await storedContent(page, 'Antes de recargar')).toContain('Texto recién escrito')
  } finally {
    writeFileSync(SW_FILE, original)
  }
})

test('the app works under the production Content-Security-Policy (firebase.json)', async ({ page }) => {
  // Se recogen las infracciones de la CSP desde antes de cargar la app.
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { cspViolations: string[] }).cspViolations = seen
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  const response = await page.goto('/')
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'")
  await page.getByRole('button', { name: /Google/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await newNote(page, 'Con CSP', 'texto en negrita')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+B')
  await expect(page.locator('.ProseMirror strong')).toHaveText('texto en negrita')
  // Imagen adjunta: vista previa local (blob:) mientras se sube.
  await page.locator('.note-editor input[type="file"]').setInputFiles({
    name: 'punto.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
  })
  await expect(page.locator('.ProseMirror .attachment img')).toBeVisible()
  await backToNotes(page)
  await waitForOfflineReady(page)
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([])
})
