import { expect, test, type Page } from '@playwright/test'

// Adjuntos sin conexión: la cola del dispositivo, contra el backend en memoria.

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Google/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

/** Crea una nota en la raíz desde la barra lateral y escribe título y cuerpo. */
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

type StoredNote = { id: string; title: string; content: string }
type StoredAttachment = { id: string; url: string; path: string | null; status: string; name: string }

async function storedNote(page: Page, title: string): Promise<StoredNote | undefined> {
  const notes: StoredNote[] = await page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{}}').notes),
  )
  return notes.find((n) => n.title === title)
}

async function storedAttachments(page: Page, title: string): Promise<StoredAttachment[]> {
  const note = await storedNote(page, title)
  const found: StoredAttachment[] = []
  const walk = (node: { type?: string; attrs?: StoredAttachment; content?: unknown[] }) => {
    if (node.type === 'attachment' && node.attrs) found.push(node.attrs)
    node.content?.forEach((child) => walk(child as typeof node))
  }
  if (note?.content) walk(JSON.parse(note.content))
  return found
}

const statuses = async (page: Page, title: string) => (await storedAttachments(page, title)).map((a) => a.status)

// PNG de 1×1 píxel: la vista previa local se puede ver.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Suelta un fichero al final del primer párrafo de la nota abierta. */
async function dropFile(page: Page, name: string, type: string) {
  const editor = page.locator('.ProseMirror')
  const box = await editor.locator('p').first().boundingBox()
  if (!box) throw new Error('missing paragraph')
  await editor.evaluate(
    (el, { x, y, name, type, png }) => {
      const bytes = type === 'image/png' ? Uint8Array.from(atob(png), (c) => c.charCodeAt(0)) : new TextEncoder().encode('contenido')
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], name, { type }))
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
    },
    { x: box.x + box.width - 2, y: box.y + box.height / 2, name, type, png: PNG },
  )
}

/**
 * Sustituye la subida del backend: `fail` decide qué hace cada intento (undefined = la subida normal).
 * Devuelve cuántas subidas se han intentado.
 */
async function patchUploads(page: Page, fail: 'hang' | 'network-once' | 'refused' | 'none') {
  await page.evaluate(async (fail) => {
    const url = '/src/lib/backend/index.ts'
    const { backend } = await import(/* @vite-ignore */ url)
    const w = window as unknown as { __uploads: number }
    w.__uploads = 0
    const original = backend.uploadFile
    backend.uploadFile = (...args: unknown[]) => {
      w.__uploads += 1
      if (fail === 'hang') return new Promise(() => undefined)
      if (fail === 'refused') return Promise.reject(Object.assign(new Error('refused'), { code: 'storage/unauthorized' }))
      if (fail === 'network-once' && w.__uploads === 1) {
        return Promise.reject(Object.assign(new Error('network'), { code: 'storage/retry-limit-exceeded' }))
      }
      return original(...args)
    }
  }, fail)
  return () => page.evaluate(() => (window as unknown as { __uploads: number }).__uploads)
}

/** true si salir de la página ahora preguntaría antes (hay algo que se perdería). */
function leavingAsks(page: Page) {
  return page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('a file whose upload cannot finish is kept on the device and uploaded after reloading the page', async ({ page }) => {
  await newNote(page, 'Billetes', 'tren ')
  // La subida nunca termina, como con una conexión que se cae a mitad.
  await patchUploads(page, 'hang')
  await dropFile(page, 'billete.pdf', 'application/pdf')
  await expect.poll(() => statuses(page, 'Billetes')).toEqual(['uploading'])
  // Ya está a salvo en el dispositivo: salir de la página no pregunta.
  await expect.poll(() => leavingAsks(page)).toBe(false)

  page.on('dialog', (dialog) => dialog.accept())
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect.poll(() => statuses(page, 'Billetes')).toEqual(['done'])
  const [stored] = await storedAttachments(page, 'Billetes')
  expect(stored.path).toMatch(/^users\/local\/notes\/.+-billete\.pdf$/)
  await page.getByTestId('tree-note').filter({ hasText: 'Billetes' }).click()
  await expect(page.locator('.ProseMirror .attachment')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-status', 'synced')
})

test('a file added offline shows its preview waiting for the connection and uploads once when it comes back', async ({
  page,
  context,
}) => {
  await newNote(page, 'Playa', 'fotos ')
  const uploads = await patchUploads(page, 'none')
  await context.setOffline(true)
  await dropFile(page, 'playa.png', 'image/png')
  const chip = page.locator('.ProseMirror .attachment')
  await expect(chip).toHaveAttribute('data-state', 'waiting')
  await expect(chip).toContainText('Esperando conexión')
  await expect(chip.locator('img')).toHaveAttribute('src', /^blob:/)
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-status', 'offline')
  // En la nota se guarda el adjunto pendiente, nunca la dirección local de la vista previa.
  await expect.poll(async () => (await storedAttachments(page, 'Playa')).map((a) => [a.status, a.url])).toEqual([['uploading', '']])
  expect(await uploads()).toBe(0)

  await context.setOffline(false)
  // Un segundo aviso de conexión no sube el fichero otra vez.
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(chip).toHaveAttribute('data-state', 'done')
  await expect.poll(() => statuses(page, 'Playa')).toEqual(['done'])
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-status', 'synced')
  expect(await uploads()).toBe(1)
})

test('a file whose upload fails for the network waits, without a sync error, and uploads when the connection comes back', async ({
  page,
}) => {
  await newNote(page, 'Red', 'informe ')
  const uploads = await patchUploads(page, 'network-once')
  await dropFile(page, 'informe.pdf', 'application/pdf')
  const chip = page.locator('.ProseMirror .attachment')
  await expect(chip).toHaveAttribute('data-state', 'waiting')
  await expect(chip).toContainText('Esperando conexión')
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-status', 'syncing')

  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(chip).toHaveAttribute('data-state', 'done')
  await expect.poll(() => statuses(page, 'Red')).toEqual(['done'])
  expect(await uploads()).toBe(2)
})

test('a file the cloud refuses ends as failed and is not tried again after reloading', async ({ page }) => {
  await newNote(page, 'Rechazo', 'contrato ')
  await patchUploads(page, 'refused')
  await dropFile(page, 'contrato.pdf', 'application/pdf')
  const chip = page.locator('.ProseMirror .attachment')
  await expect(chip).toHaveAttribute('data-state', 'error')
  await expect(chip).toContainText('Error al subir')
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-status', 'error')
  await backToNotes(page)
  await expect.poll(() => statuses(page, 'Rechazo')).toEqual(['error'])

  // Tras recargar la subida normal funcionaría: si siguiera en la cola, acabaría subida.
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.waitForTimeout(1500)
  expect(await statuses(page, 'Rechazo')).toEqual(['error'])
})

test('a queued file whose note was deleted on another device is dropped without uploading it', async ({ page, context }) => {
  await newNote(page, 'Borrador', 'nota ')
  const uploads = await patchUploads(page, 'none')
  await context.setOffline(true)
  await dropFile(page, 'borrador.pdf', 'application/pdf')
  await expect(page.locator('.ProseMirror .attachment')).toHaveAttribute('data-state', 'waiting')
  await backToNotes(page)
  await expect.poll(() => statuses(page, 'Borrador')).toEqual(['uploading'])
  const id = (await storedNote(page, 'Borrador'))!.id
  await page.evaluate(async (id) => {
    const url = '/src/lib/backend/index.ts'
    const { backend } = await import(/* @vite-ignore */ url)
    await backend.write('local', [{ type: 'deleteNote', id }])
  }, id)
  await expect(page.getByTestId('tree-note').filter({ hasText: 'Borrador' })).toHaveCount(0)

  await context.setOffline(false)
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-status', 'synced')
  expect(await uploads()).toBe(0)
})

test('an upload left pending on another device shows as pending, not as failed', async ({ page }) => {
  const content = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'ver ' },
          {
            type: 'attachment',
            attrs: { id: 'x1', url: '', path: null, name: 'escaneo.pdf', mime: 'application/pdf', size: 10, status: 'uploading' },
          },
        ],
      },
    ],
  }
  await page.evaluate((content) => {
    const db = JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{},"folders":{}}')
    const now = Date.now()
    db.notes.pendiente = {
      id: 'pendiente',
      title: 'Escaneos',
      content: JSON.stringify(content),
      preview: '',
      folderId: null,
      order: 'a0',
      pinned: false,
      locked: false,
      color: null,
      trashed: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    localStorage.setItem('kaze:memory-db', JSON.stringify(db))
  }, content)
  await page.reload()
  await page.getByTestId('tree-note').filter({ hasText: 'Escaneos' }).click()
  const chip = page.locator('.ProseMirror .attachment')
  await expect(chip).toHaveAttribute('data-state', 'pending')
  await expect(chip).toContainText('Pendiente de subir')
  await expect(chip).not.toContainText('Error al subir')
})
