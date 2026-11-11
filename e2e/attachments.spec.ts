import { expect, test, type Page } from '@playwright/test'

// Adjuntos, enlaces y carpetas contra el backend en memoria (datos en localStorage de cada contexto).

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

type StoredNote = { id: string; title: string; content: string }
type StoredAttachment = { id: string; url: string; path: string | null; status: string; name: string }

async function storedNote(page: Page, title: string): Promise<StoredNote | undefined> {
  const notes: StoredNote[] = await page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{}}').notes),
  )
  return notes.find((n) => n.title === title)
}

function attachmentsOf(note: StoredNote | undefined): StoredAttachment[] {
  const found: StoredAttachment[] = []
  const walk = (node: { type?: string; attrs?: StoredAttachment; content?: unknown[] }) => {
    if (node.type === 'attachment' && node.attrs) found.push(node.attrs)
    node.content?.forEach((child) => walk(child as typeof node))
  }
  if (note?.content) walk(JSON.parse(note.content))
  return found
}

/** Suelta varios ficheros a la vez al final del primer párrafo de la nota abierta. */
async function dropFiles(page: Page, files: { name: string; type: string }[]) {
  const editor = page.locator('.ProseMirror')
  const box = await editor.locator('p').first().boundingBox()
  if (!box) throw new Error('missing paragraph')
  await editor.evaluate(
    (el, { x, y, files }) => {
      const dt = new DataTransfer()
      files.forEach((f, i) => dt.items.add(new File([`contenido ${i}`], f.name, { type: f.type })))
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
    },
    { x: box.x + box.width - 2, y: box.y + box.height / 2, files },
  )
}

/** Pega en la nota abierta como lo haría el portapapeles. */
async function paste(page: Page, html: string, text: string) {
  await page.evaluate(
    ({ html, text }) => {
      const dt = new DataTransfer()
      dt.setData('text/html', html)
      dt.setData('text/plain', text)
      const pm = document.querySelector('.ProseMirror') as HTMLElement
      pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { html, text },
  )
}

/** Guarda notas y carpetas en el backend en memoria y recarga la app con ellas. */
async function seed(page: Page, data: { notes?: Record<string, unknown>[]; folders?: Record<string, unknown>[] }) {
  await page.evaluate((data) => {
    const db = JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{},"folders":{}}')
    const now = Date.now()
    for (const n of data.notes ?? []) {
      db.notes[n.id as string] = {
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
        ...n,
      }
    }
    db.folders ??= {}
    for (const f of data.folders ?? []) db.folders[f.id as string] = { createdAt: now, updatedAt: now, ...f }
    localStorage.setItem('kaze:memory-db', JSON.stringify(db))
  }, data)
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
}

/** Sustituye `window.open` y devuelve las direcciones que se intentan abrir. */
async function recordOpens(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] }
    w.__opened = []
    window.open = (url?: string | URL) => {
      w.__opened.push(String(url))
      return null
    }
  })
  return () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('two files with the same name dropped at once are both kept, each in its own file', async ({ page }) => {
  await newNote(page, 'Fotos', 'fotos ')
  // Como al pegar varias imágenes en iOS: todas se llaman "image.png".
  await dropFiles(page, [
    { name: 'image.png', type: 'image/png' },
    { name: 'image.png', type: 'image/png' },
  ])
  await expect(page.locator('.ProseMirror .attachment[data-state="done"]')).toHaveCount(2)
  await backToNotes(page)

  await expect.poll(async () => attachmentsOf(await storedNote(page, 'Fotos')).map((a) => a.status)).toEqual(['done', 'done'])
  const note = await storedNote(page, 'Fotos')
  const [a, b] = attachmentsOf(note)
  expect(a.path).not.toBe(b.path)
  expect(a.url).not.toBe(b.url)
  for (const { path } of [a, b]) expect(path).toMatch(new RegExp(`^users/local/notes/${note!.id}/.+-image\\.png$`))
})

test('a copied attachment pasted in another note keeps its file; a fake one from a web page loads and opens nothing', async ({
  page,
}) => {
  await newNote(page, 'Origen', 'texto ')
  await dropFiles(page, [{ name: 'compartido.pdf', type: 'application/pdf' }])
  await expect(page.locator('.ProseMirror .attachment[data-state="done"]')).toBeVisible()
  // Copia con el serializador real del editor (como Cmd+C).
  const clip = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    pm.focus()
    window.getSelection()!.selectAllChildren(pm)
    document.dispatchEvent(new Event('selectionchange'))
    const dt = new DataTransfer()
    pm.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
    return { html: dt.getData('text/html'), text: dt.getData('text/plain') }
  })
  await backToNotes(page)

  await newNote(page, 'Copia', '')
  await page.locator('.ProseMirror').click()
  await paste(page, clip.html, clip.text)
  await expect(page.locator('.ProseMirror .attachment[data-state="done"]')).toHaveCount(1)

  // Adjunto falso: imagen remota (píxel de seguimiento) que abriría otra web.
  const tracked: string[] = []
  await page.route('https://tracker.example/**', (route) => {
    tracked.push(route.request().url())
    return route.fulfill({ status: 404 })
  })
  const opened = await recordOpens(page)
  await page.keyboard.press('End')
  await paste(
    page,
    '<p><span data-attachment data-url="https://tracker.example/pixel.png" data-path="users/otro/notes/n/foto.png"' +
      ' data-name="foto.png" data-mime="image/png" data-size="10" data-status="done">📎 foto.png</span></p>',
    '📎 foto.png',
  )
  const fake = page.locator('.ProseMirror .attachment').filter({ hasText: 'foto.png' })
  await expect(fake).toHaveAttribute('data-state', 'error')
  await expect(fake.locator('img')).toHaveCount(0)
  await fake.locator('.attachment-chip').click()
  await page.waitForTimeout(300)
  expect(tracked).toEqual([])
  expect(await opened()).toEqual([])
  await backToNotes(page)

  await expect.poll(async () => attachmentsOf(await storedNote(page, 'Copia')).length).toBe(2)
  const [source] = attachmentsOf(await storedNote(page, 'Origen'))
  const [copied, foreign] = attachmentsOf(await storedNote(page, 'Copia'))
  expect(copied).toMatchObject({ path: source.path, url: source.url, status: 'done' })
  expect(foreign).toMatchObject({ url: '', path: null, status: 'error' })
})

test('the toolbar opens web links but not script links', async ({ page }) => {
  const link = (text: string, href: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
  const content = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [link('web', 'https://example.com/')] },
      { type: 'paragraph', content: [link('script', 'javascript:alert(1)')] },
    ],
  }
  await seed(page, { notes: [{ id: 'links', title: 'Enlaces', content: JSON.stringify(content) }] })
  await page.getByTestId('tree-note').filter({ hasText: 'Enlaces' }).click()
  const opened = await recordOpens(page)
  const openLink = page.getByRole('button', { name: 'Abrir enlace' })

  await page.locator('.ProseMirror a', { hasText: 'web' }).click()
  await expect(openLink).toBeVisible()
  await openLink.click()
  expect(await opened()).toEqual(['https://example.com/'])

  await page.locator('.ProseMirror a', { hasText: 'script' }).click()
  await expect(page.locator('.ProseMirror a', { hasText: 'script' })).toBeVisible()
  await page.waitForTimeout(200)
  await expect(openLink).toHaveCount(0)
  expect(await opened()).toEqual(['https://example.com/'])
})

test('two folders moved into each other from two devices stay in the sidebar, at the top level', async ({ page }) => {
  await seed(page, {
    folders: [
      { id: 'fx', name: 'Equis', parentId: 'fy', order: 'a0' },
      { id: 'fy', name: 'Ye', parentId: 'fx', order: 'a1' },
      { id: 'fz', name: 'Zeta', parentId: 'fx', order: 'a0' },
    ],
  })
  const folders = page.getByTestId('tree-folder')
  await expect(folders.filter({ hasText: 'Equis' })).toBeVisible()
  await expect(folders.filter({ hasText: 'Ye' })).toBeVisible()
  // La subcarpeta sigue dentro de la suya.
  await folders.filter({ hasText: 'Equis' }).getByRole('button', { name: 'Desplegar carpeta' }).click()
  await expect(folders.filter({ hasText: 'Zeta' })).toBeVisible()
})
