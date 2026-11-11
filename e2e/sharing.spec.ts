import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Dos cuentas en el backend en memoria: la de demostración (demo@local.test) y `?as=bob` (bob@local.test), en dos pestañas del
// mismo contexto, que comparten los datos y se avisan de los cambios.

type Stored = {
  id: string
  title: string
  content: string
  color: string | null
  pinned: boolean
  invited?: string[]
  members?: string[]
  prefs?: Record<string, { pinned?: boolean }>
}

async function signInAsDemo(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Google/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

/** Abre la segunda cuenta en otra pestaña (la sesión iniciada en la primera ya vale para esta). */
async function openBob(context: BrowserContext): Promise<Page> {
  const bob = await context.newPage()
  await bob.goto('/?as=bob')
  await expect(bob.locator('.sidebar')).toBeVisible()
  return bob
}

async function newNote(page: Page, title: string, body: string) {
  await page.locator('.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  await page.getByPlaceholder('Título').fill(title)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type(body)
}

function stored(page: Page, title: string): Promise<Stored | undefined> {
  return page.evaluate(
    (t) =>
      (Object.values(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{}}').notes) as Stored[]).find(
        (n) => n.title === t,
      ),
    title,
  )
}

async function shareWith(page: Page, email: string) {
  await page.locator('.share-btn').click()
  await page.getByPlaceholder('Correo del otro usuario').fill(email)
  await page.locator('.share-form').getByRole('button').click()
}

const card = (page: Page, title: string) => page.locator('.notes-screen').getByText(title, { exact: true })

test('the owner shares by email, the other user accepts from the header, both edit and the owner stops sharing', async ({
  page,
  context,
}) => {
  await signInAsDemo(page)
  await newNote(page, 'Groceries', 'milk')

  // No se comparte con uno mismo ni con un correo mal escrito.
  await shareWith(page, 'demo@local.test')
  await expect(page.locator('.share-error')).toHaveText('Ese es tu propio correo')
  await page.getByPlaceholder('Correo del otro usuario').fill('bob@local.test')
  await page.locator('.share-form').getByRole('button').click()
  await expect(page.locator('.share-person')).toContainText(['bob@local.test'])
  await expect(page.locator('.share-person .share-tag')).toHaveText('Pendiente')
  await page.keyboard.press('Escape')
  await expect(page.locator('.share-btn')).toHaveAttribute('aria-label', 'Compartida con bob@local.test')

  const bob = await openBob(context)
  await expect(card(bob, 'Groceries')).toHaveCount(0)
  const bell = bob.getByRole('button', { name: '1 invitación a una nota compartida' })
  await bell.click()
  await expect(bob.locator('.invite-text')).toHaveText('El usuario demo@local.test quiere compartir una nota contigo')
  await bob.getByRole('button', { name: 'Aceptar' }).click()
  await expect(bell).toHaveCount(0)
  await expect(card(bob, 'Groceries')).toBeVisible()
  await expect(page.locator('.share-person .share-tag')).toHaveCount(0)

  // El invitado edita: el texto y el color llegan al dueño; el fijado es solo suyo.
  await card(bob, 'Groceries').click()
  await expect(bob.locator('.share-btn')).toHaveAttribute('aria-label', 'Compartida contigo por demo@local.test')
  await expect(bob.getByRole('button', { name: 'Mover a la papelera' })).toHaveCount(0)
  await bob.locator('.ProseMirror').click()
  await bob.keyboard.press('End')
  await bob.keyboard.type(' and eggs')
  await expect(page.locator('.ProseMirror')).toContainText('milk and eggs')
  await bob.getByRole('button', { name: 'Fijar arriba' }).click()
  await bob.getByRole('button', { name: 'Color de la nota' }).click()
  await bob.getByRole('button', { name: 'Menta' }).click()
  await expect.poll(async () => (await stored(page, 'Groceries'))?.color).toBe('mint')
  const note = await stored(page, 'Groceries')
  expect(note?.pinned).toBe(false)
  expect(note?.prefs?.['bob@local.test']?.pinned).toBe(true)
  await expect(page.getByRole('button', { name: 'Fijar arriba' })).toHaveAttribute('aria-pressed', 'false')

  // Y el dueño también edita: le llega al invitado.
  await page.locator('.ProseMirror').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and bread')
  await expect(bob.locator('.ProseMirror')).toContainText('milk and eggs and bread')

  // El dueño deja de compartir: el invitado deja de verla (estaba abierta: vuelve a la lista).
  await page.locator('.share-btn').click()
  await page.getByRole('button', { name: 'Dejar de compartir con bob@local.test' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Dejar de compartir' }).click()
  await expect(bob.locator('.ProseMirror')).toHaveCount(0)
  await expect(card(bob, 'Groceries')).toHaveCount(0)
  await expect(page.locator('.share-btn')).toHaveAttribute('aria-label', 'Compartir')
  expect((await stored(page, 'Groceries'))?.content).toContain('milk and eggs and bread')
})

test('the other user can reject an invitation, or accept and later stop sharing; the note stays with its owner', async ({
  page,
  context,
}) => {
  await signInAsDemo(page)
  await newNote(page, 'Plans', 'trip')
  await shareWith(page, 'bob@local.test')
  await page.keyboard.press('Escape')

  const bob = await openBob(context)
  await bob.getByRole('button', { name: '1 invitación a una nota compartida' }).click()
  await bob.getByRole('button', { name: 'Rechazar' }).click()
  await expect(bob.locator('.invites-btn')).toHaveCount(0)
  await expect(card(bob, 'Plans')).toHaveCount(0)
  await expect.poll(async () => (await stored(page, 'Plans'))?.invited).toEqual([])

  await shareWith(page, 'bob@local.test')
  await page.keyboard.press('Escape')
  await bob.getByRole('button', { name: '1 invitación a una nota compartida' }).click()
  await bob.getByRole('button', { name: 'Aceptar' }).click()
  await card(bob, 'Plans').click()
  await bob.locator('.share-btn').click()
  await expect(bob.locator('.share-person')).toContainText(['demo@local.test'])
  await bob.getByRole('button', { name: 'Dejar de compartir' }).click()
  await bob.getByRole('alertdialog').getByRole('button', { name: 'Dejar de compartir' }).click()
  await expect(bob.locator('.ProseMirror')).toHaveCount(0)
  await expect(card(bob, 'Plans')).toHaveCount(0)

  await expect.poll(async () => (await stored(page, 'Plans'))?.members).toEqual([])
  await expect(page.locator('.share-btn')).toHaveAttribute('aria-label', 'Compartir')
  await expect(page.locator('.ProseMirror')).toContainText('trip')
})
