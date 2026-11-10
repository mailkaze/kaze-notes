import { expect, test, type CDPSession, type Page } from '@playwright/test'

// Notas protegidas con la verificación del dispositivo (WebAuthn), usando el autenticador virtual de Chromium.

test.skip(({ browserName }) => browserName !== 'chromium', 'El autenticador virtual solo existe en Chromium')

interface Authenticator {
  cdp: CDPSession
  id: string
}

/** Autenticador del propio dispositivo (como Touch ID o la huella) que verifica al usuario sin intervención. */
async function addDeviceAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, id: authenticatorId }
}

/** Simula que la huella (o la cara) se reconoce o no. */
async function setVerified(auth: Authenticator, isUserVerified: boolean) {
  await auth.cdp.send('WebAuthn.setUserVerified', { authenticatorId: auth.id, isUserVerified })
}

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Google/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
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
  await expect(page.locator('.note-editor')).toHaveCount(0)
}

function storedLocked(page: Page, title: string): Promise<boolean | undefined> {
  return page.evaluate((t) => {
    const notes = Object.values(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{}}').notes) as {
      title: string
      locked?: boolean
    }[]
    return notes.find((n) => n.title === t)?.locked
  }, title)
}

const card = (page: Page, title: string) => page.getByTestId('note-card').filter({ hasText: title })

test('a protected note hides its content until the device verifies the user, and locks again on leaving', async ({ page }) => {
  const auth = await addDeviceAuthenticator(page)
  await signIn(page)
  await newNote(page, 'Banco', 'pin secreto 4321')

  await page.getByRole('button', { name: 'Proteger nota' }).click()
  await expect(page.getByRole('button', { name: 'Quitar protección' })).toHaveAttribute('aria-pressed', 'true')
  // Sigue abierta mientras no se salga de ella.
  await expect(page.locator('.ProseMirror')).toContainText('pin secreto 4321')
  await expect.poll(() => storedLocked(page, 'Banco')).toBe(true)

  await backToNotes(page)
  await expect(card(page, 'Banco')).toContainText('Protegida')
  await expect(card(page, 'Banco')).not.toContainText('secreto')
  const row = page.getByTestId('tree-note').filter({ hasText: 'Banco' })
  await expect(row).toContainText('Protegida')
  await expect(row).not.toContainText('secreto')

  // La búsqueda solo mira el título de las notas protegidas.
  const search = page.getByRole('searchbox', { name: 'Buscar notas' })
  await search.fill('secreto')
  await expect(page.getByTestId('note-card')).toHaveCount(0)
  await search.fill('banco')
  await expect(card(page, 'Banco')).toHaveCount(1)
  await search.fill('')

  // Sin verificación no se ve el contenido.
  await setVerified(auth, false)
  await card(page, 'Banco').getByRole('button').first().click()
  await expect(page.getByText('Esta nota está protegida.')).toBeVisible()
  await page.getByRole('button', { name: 'Desbloquear' }).click()
  await expect(page.getByRole('button', { name: /Registrar este dispositivo de nuevo/ })).toBeVisible()
  await expect(page.locator('.ProseMirror')).toHaveCount(0)
  await expect(page.locator('.note-editor')).not.toContainText('secreto')

  // Con la huella reconocida se abre.
  await setVerified(auth, true)
  await page.getByRole('button', { name: 'Desbloquear' }).click()
  await expect(page.locator('.ProseMirror')).toContainText('pin secreto 4321')

  // Al salir y volver a entrar, hay que verificarse otra vez.
  await backToNotes(page)
  await setVerified(auth, false)
  await card(page, 'Banco').getByRole('button').first().click()
  await expect(page.getByText('Esta nota está protegida.')).toBeVisible()
  await expect(page.locator('.ProseMirror')).toHaveCount(0)
})

test('removing the protection shows the note again without verification', async ({ page }) => {
  const auth = await addDeviceAuthenticator(page)
  await signIn(page)
  await newNote(page, 'Recados', 'recoger paquete')
  await page.getByRole('button', { name: 'Proteger nota' }).click()
  await expect.poll(() => storedLocked(page, 'Recados')).toBe(true)

  await page.getByRole('button', { name: 'Quitar protección' }).click()
  await expect(page.getByRole('button', { name: 'Proteger nota' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => storedLocked(page, 'Recados')).toBe(false)

  await backToNotes(page)
  await expect(card(page, 'Recados')).toContainText('recoger paquete')
  await setVerified(auth, false)
  await card(page, 'Recados').getByRole('button').first().click()
  await expect(page.locator('.ProseMirror')).toContainText('recoger paquete')
})

test('a note is not protected when the device does not verify the user', async ({ page }) => {
  const auth = await addDeviceAuthenticator(page)
  await signIn(page)
  await newNote(page, 'Diario', 'hoy llueve')
  await setVerified(auth, false)

  await page.getByRole('button', { name: 'Proteger nota' }).click()
  // El propio sistema ya ha mostrado el fallo: la app no añade ningún aviso.
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Proteger nota' })).toHaveAttribute('aria-pressed', 'false')
  expect(await storedLocked(page, 'Diario')).toBeFalsy()

  await setVerified(auth, true)
  await page.getByRole('button', { name: 'Proteger nota' }).click()
  await expect.poll(() => storedLocked(page, 'Diario')).toBe(true)
})
