import { expect, test, type Page } from '@playwright/test'

// Sincronización con otros dispositivos y seguridad del editor, contra el backend en memoria.

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Google/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

/** Crea una nota en la raíz desde la barra lateral y escribe título y cuerpo. */
async function newNote(page: Page, title: string, body = '') {
  await page.locator('.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
  if (title) await page.getByPlaceholder('Título').fill(title)
  if (body) {
    await page.locator('.ProseMirror').click()
    await page.keyboard.type(body)
  }
}

async function backToNotes(page: Page) {
  await page.getByRole('button', { name: 'Volver a las notas' }).click()
  await expect(page.locator('.ProseMirror')).toHaveCount(0)
}

type StoredNote = { id: string; title: string; content: string; trashed: boolean; order: string; rev?: number }

function storedNotes(page: Page): Promise<StoredNote[]> {
  return page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{}}').notes))
}

async function storedNote(page: Page, title: string): Promise<StoredNote | undefined> {
  return (await storedNotes(page)).find((n) => n.title === title)
}

async function noteById(page: Page, id: string): Promise<StoredNote | undefined> {
  return (await storedNotes(page)).find((n) => n.id === id)
}

/** Contenido de TipTap con un párrafo de texto. */
const paragraph = (text: string) =>
  JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

/** Cambio de una nota hecho en otro dispositivo (llega a esta pestaña como un snapshot más). */
async function remoteChange(page: Page, id: string, data: Record<string, unknown>) {
  await page.evaluate(
    async ({ id, data }) => {
      const url = '/src/lib/backend/index.ts'
      const { backend } = await import(/* @vite-ignore */ url)
      await backend.write('local', [{ type: 'setNote', id, data: { ...data, updatedAt: Date.now() } }])
    },
    { id, data },
  )
}

/** Edición de otro dispositivo (p. ej. hecha sin conexión) que partió de la revisión `baseRev` de la nota. */
function otherDeviceEdit(page: Page, id: string, baseRev: number, text: string) {
  return remoteChange(page, id, {
    content: paragraph(text),
    preview: text,
    rev: baseRev + 1,
    baseRev,
    device: 'other-device',
  })
}

/** Escribe con pausas para que el cambio remoto llegue mientras hay cambios locales sin guardar. */
async function typeWhileRemoteArrives(page: Page, text: string, arrive: () => Promise<void>) {
  const typing = page.keyboard.type(text, { delay: 40 })
  await page.waitForTimeout(150)
  await arrive()
  await typing
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('a note moved to the trash on another device while open here closes, and what was typed goes with it to the trash', async ({
  page,
}) => {
  await newNote(page, 'Viaje', 'billetes')
  await expect.poll(async () => (await storedNote(page, 'Viaje'))?.content ?? '').toContain('billetes')
  const id = (await storedNote(page, 'Viaje'))!.id

  // Lo último escrito aún no se ha guardado (el guardado espera a que se deje de escribir).
  await page.keyboard.type(' y hotel')
  await remoteChange(page, id, { trashed: true, trashedAt: Date.now() })

  await expect(page.locator('.ProseMirror')).toHaveCount(0)
  await expect(page.getByTestId('note-card')).toHaveCount(0)
  await expect
    .poll(async () => {
      const note = await noteById(page, id)
      return [note?.trashed, note?.content.includes('billetes y hotel')]
    })
    .toEqual([true, true])
  await page.locator('.sidebar').getByText('Papelera').click()
  await expect(page.getByTestId('trash-item')).toHaveCount(1)
  await expect(page.getByTestId('trash-item')).toContainText('Viaje')
})

test('a title changed here and a text changed on another device are both kept, with no conflict copy', async ({ page }) => {
  await newNote(page, 'Compra', 'leche')
  await expect.poll(async () => (await storedNote(page, 'Compra'))?.content ?? '').toContain('leche')
  const id = (await storedNote(page, 'Compra'))!.id

  await page.getByPlaceholder('Título').click()
  await page.keyboard.press('End')
  await typeWhileRemoteArrives(page, ' semanal', () =>
    remoteChange(page, id, { content: paragraph('leche y pan'), preview: 'leche y pan' }),
  )

  await expect.poll(async () => (await noteById(page, id))?.title).toBe('Compra semanal')
  await expect(page.locator('.ProseMirror')).toHaveText('leche y pan')
  await expect(page.getByPlaceholder('Título')).toHaveValue('Compra semanal')
  expect((await noteById(page, id))?.content).toContain('leche y pan')

  // Lo siguiente que se escribe parte de la versión unida: tampoco crea copias.
  await page.locator('.ProseMirror').click()
  await page.keyboard.press(`${mod}+End`)
  await page.keyboard.type(' y huevos')
  await expect.poll(async () => (await noteById(page, id))?.content ?? '').toContain('leche y pan y huevos')
  expect((await storedNotes(page)).map((n) => n.title)).toEqual(['Compra semanal'])
})

test('a text changed here and a title changed on another device are both kept, with no conflict copy', async ({ page }) => {
  await newNote(page, 'Ideas', 'primera')
  await expect.poll(async () => (await storedNote(page, 'Ideas'))?.content ?? '').toContain('primera')
  const id = (await storedNote(page, 'Ideas'))!.id

  await typeWhileRemoteArrives(page, ' y segunda', () => remoteChange(page, id, { title: 'Ideas buenas' }))

  await expect.poll(async () => (await noteById(page, id))?.content ?? '').toContain('primera y segunda')
  await expect(page.getByPlaceholder('Título')).toHaveValue('Ideas buenas')
  await expect(page.locator('.ProseMirror')).toHaveText('primera y segunda')
  expect((await noteById(page, id))?.title).toBe('Ideas buenas')
  expect((await storedNotes(page)).map((n) => n.title)).toEqual(['Ideas buenas'])
})

test('an edit from another device that started before the last save here keeps this version as a conflict copy next to the note', async ({
  page,
}) => {
  await newNote(page, 'Plan', 'version de aqui')
  await expect.poll(async () => (await storedNote(page, 'Plan'))?.content ?? '').toContain('version de aqui')
  const id = (await storedNote(page, 'Plan'))!.id
  await backToNotes(page)

  // El iPad editó sin conexión la nota recién creada, sin la versión guardada aquí, y ahora se sincroniza.
  await otherDeviceEdit(page, id, 0, 'version del ipad')

  await expect(page.locator('.note-card-title')).toHaveText(['Plan', 'Plan (conflicto)'])
  await expect(page.getByTestId('note-card').first()).toContainText('version del ipad')
  await expect(page.getByTestId('note-card').last()).toContainText('version de aqui')
  const original = (await noteById(page, id))!
  const copy = (await storedNote(page, 'Plan (conflicto)'))!
  expect(original.content).toContain('version del ipad')
  expect(copy.content).toContain('version de aqui')
  expect(copy).toMatchObject({ trashed: false })
  expect(original.order < copy.order).toBe(true)
})

test('a note open here but idle, replaced by another device that started from an older version, shows the new version and keeps this one as a copy', async ({
  page,
}) => {
  await newNote(page, 'Plan', 'version de aqui')
  await expect.poll(async () => (await storedNote(page, 'Plan'))?.content ?? '').toContain('version de aqui')
  const id = (await storedNote(page, 'Plan'))!.id

  await otherDeviceEdit(page, id, 0, 'version del ipad')

  await expect(page.locator('.ProseMirror')).toHaveText('version del ipad')
  await expect(page.getByPlaceholder('Título')).toHaveValue('Plan')
  await expect(page.getByTestId('tree-note').filter({ hasText: 'Plan (conflicto)' })).toBeVisible()
  expect((await storedNote(page, 'Plan (conflicto)'))?.content).toContain('version de aqui')
  expect((await noteById(page, id))?.content).toContain('version del ipad')
  expect((await storedNotes(page)).map((n) => n.title).sort()).toEqual(['Plan', 'Plan (conflicto)'])
})

test('while the title is being typed here, another device replacing the text from an older version keeps the text saved here as a copy', async ({
  page,
}) => {
  await newNote(page, 'Plan', 'version de aqui')
  await expect.poll(async () => (await storedNote(page, 'Plan'))?.content ?? '').toContain('version de aqui')
  const id = (await storedNote(page, 'Plan'))!.id

  await page.getByPlaceholder('Título').click()
  await page.keyboard.press('End')
  await typeWhileRemoteArrives(page, ' nuevo', () => otherDeviceEdit(page, id, 0, 'version del ipad'))

  await expect.poll(async () => (await noteById(page, id))?.title).toBe('Plan nuevo')
  expect((await noteById(page, id))?.content).toContain('version del ipad')
  await expect
    .poll(async () => (await storedNotes(page)).filter((n) => n.id !== id && n.content.includes('version de aqui')).length)
    .toBe(1)
})

test('an edit from another device that started from the last version saved here just replaces it, with no conflict copy', async ({
  page,
}) => {
  await newNote(page, 'Plan', 'version de aqui')
  await expect.poll(async () => (await storedNote(page, 'Plan'))?.content ?? '').toContain('version de aqui')
  const { id, rev } = (await storedNote(page, 'Plan'))!
  expect(rev).toBeGreaterThan(0)
  await backToNotes(page)

  await otherDeviceEdit(page, id, rev!, 'version del ipad')

  await expect(page.getByTestId('note-card')).toContainText('version del ipad')
  await expect(page.locator('.note-card-title')).toHaveText(['Plan'])
  expect((await storedNotes(page)).map((n) => n.title)).toEqual(['Plan'])
})

/** Sustituye la subida de ficheros por una que tarda `ms` milisegundos. */
async function slowUploads(page: Page, ms: number) {
  await page.evaluate(async (ms) => {
    const url = '/src/lib/backend/index.ts'
    const { backend } = await import(/* @vite-ignore */ url)
    backend.uploadFile = (uid: string, noteId: string, file: File, onProgress?: (fraction: number) => void) =>
      new Promise((resolve) =>
        setTimeout(() => {
          onProgress?.(1)
          resolve({ url: `https://files.example/${encodeURIComponent(file.name)}`, path: `users/${uid}/notes/${noteId}/${file.name}` })
        }, ms),
      )
  }, ms)
}

test('closing the tab during an upload asks first; pending text alone does not ask and is saved', async ({ page }) => {
  await slowUploads(page, 3000)
  await newNote(page, 'Planos', 'casa ')
  await page.locator('.note-editor input[type="file"]').setInputFiles({
    name: 'plano.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
  })
  const attachment = page.locator('.ProseMirror .attachment')
  await expect(attachment).toHaveAttribute('data-state', 'uploading')

  const asked = page.waitForEvent('dialog')
  await page.close({ runBeforeUnload: true })
  const dialog = await asked
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()

  // Sin subidas en curso, cerrar no pregunta aunque haya texto sin guardar, que se guarda al salir.
  await expect(attachment).toHaveAttribute('data-state', 'done')
  await page.locator('.ProseMirror').click()
  await page.keyboard.press(`${mod}+End`)
  await page.keyboard.type(' y garaje')
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.type())
    void d.accept()
  })
  const closed = page.waitForEvent('close')
  await page.close({ runBeforeUnload: true })
  await closed
  expect(dialogs).toEqual([])

  const other = await page.context().newPage()
  await other.goto('/')
  expect((await storedNote(other, 'Planos'))?.content).toContain('y garaje')
})

test('if the editor code cannot load (e.g. after a deploy), the page reloads once and then explains instead of going blank', async ({
  page,
}) => {
  await newNote(page, 'Receta', 'tortilla')
  await expect.poll(async () => (await storedNote(page, 'Receta'))?.content ?? '').toContain('tortilla')
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.route('**/src/components/editor/NoteEditor.tsx*', (route) => route.abort())
  let loads = 0
  page.on('load', () => loads++)

  await page.getByTestId('note-card').filter({ hasText: 'Receta' }).getByRole('button').first().click()
  await expect.poll(() => loads).toBe(1)
  await expect(page.locator('.sidebar')).toBeVisible()

  // Si vuelve a fallar tras recargar, no se recarga en bucle: se explica y se ofrece recargar.
  await page.getByTestId('note-card').filter({ hasText: 'Receta' }).getByRole('button').first().click()
  const message = page.getByRole('alert').filter({ hasText: 'No se ha podido abrir la nota' })
  await expect(message).toBeVisible()
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.waitForTimeout(500)
  expect(loads).toBe(1)

  await page.unroute('**/src/components/editor/NoteEditor.tsx*')
  await message.getByRole('button', { name: 'Recargar' }).click()
  await expect.poll(() => loads).toBe(2)
  await page.getByTestId('note-card').filter({ hasText: 'Receta' }).getByRole('button').first().click()
  await expect(page.locator('.ProseMirror')).toHaveText('tortilla')
})

test('Cmd/Ctrl+click opens web, mail, phone and FTP links from a note, as before', async ({ page }) => {
  await newNote(page, 'Enlaces', 'x')
  await expect.poll(async () => (await storedNote(page, 'Enlaces'))?.content ?? '').toContain('x')
  const id = (await storedNote(page, 'Enlaces'))!.id
  const link = (text: string, href: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
  const content = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [link('servidor', 'ftp://example.com/archivo')] },
      { type: 'paragraph', content: [link('correo', 'mailto:ana@example.com')] },
      { type: 'paragraph', content: [link('telefono', 'tel:+34600000000')] },
      { type: 'paragraph', content: [link('web', 'https://example.com/')] },
    ],
  })
  await remoteChange(page, id, { content, preview: 'servidor web' })
  await expect(page.locator('.ProseMirror a')).toHaveCount(4)
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] }
    w.__opened = []
    window.open = (url?: string | URL) => {
      w.__opened.push(String(url))
      return null
    }
  })
  const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)

  for (const text of ['servidor', 'correo', 'telefono', 'web']) {
    await page.locator('.ProseMirror a', { hasText: text }).click({ modifiers: [mod] })
  }
  await expect
    .poll(opened)
    .toEqual(['ftp://example.com/archivo', 'mailto:ana@example.com', 'tel:+34600000000', 'https://example.com/'])
})
