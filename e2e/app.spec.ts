import { expect, test, type Locator, type Page } from '@playwright/test'

// Pruebas e2e contra el backend en memoria (datos en localStorage de cada contexto).

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

type StoredNote = {
  id: string
  title: string
  content: string
  folderId: string | null
  trashed: boolean
  order: string
  pinned: boolean
}

function storedNotes(page: Page): Promise<StoredNote[]> {
  return page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"notes":{}}').notes))
}

type StoredFolder = { id: string; name: string; parentId: string | null }

function storedFolders(page: Page): Promise<StoredFolder[]> {
  return page.evaluate(() =>
    Object.entries(JSON.parse(localStorage.getItem('kaze:memory-db') ?? '{"folders":{}}').folders ?? {}).map(
      ([id, f]) => ({ ...(f as object), id }) as StoredFolder,
    ),
  )
}

async function folderId(page: Page, name: string): Promise<string | undefined> {
  return (await storedFolders(page)).find((f) => f.name === name)?.id
}

/** Arrastra con el ratón desde el centro de `from` hasta el centro de `to`; `beforeDrop` mira el estado sin soltar. */
async function dragTo(page: Page, from: Locator, to: Locator, beforeDrop?: () => Promise<void>) {
  const a = await from.boundingBox()
  if (!a) throw new Error('missing source')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 4 })
  const b = await to.boundingBox()
  if (!b) throw new Error('missing target')
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 })
  await beforeDrop?.()
  await page.mouse.up()
}

async function storedNote(page: Page, title: string): Promise<StoredNote | undefined> {
  return (await storedNotes(page)).find((n) => n.title === title)
}

type StoredAttachment = { id: string; path: string | null; status: string; name: string }

function attachmentsOf(note: StoredNote | undefined): StoredAttachment[] {
  const found: StoredAttachment[] = []
  const walk = (node: { type?: string; attrs?: StoredAttachment; content?: unknown[] }) => {
    if (node.type === 'attachment' && node.attrs) found.push(node.attrs)
    node.content?.forEach((child) => walk(child as typeof node))
  }
  if (note?.content) walk(JSON.parse(note.content))
  return found
}

/**
 * Sustituye la subida y el borrado de ficheros del backend de la app por una simulación que sigue a firebase.ts
 * (una carpeta por nota) y cuenta las escrituras de notas. Los ficheros guardados quedan en `window.__objects`.
 */
async function fakeStorage(page: Page, uploadMs: number) {
  await page.evaluate(async (uploadMs) => {
    const url = '/src/lib/backend/index.ts'
    const { backend } = await import(/* @vite-ignore */ url)
    const objects = new Set<string>()
    const w = window as unknown as { __objects: Set<string>; __noteWrites: string[] }
    w.__objects = objects
    w.__noteWrites = []
    const write = backend.write
    backend.write = (uid: string, ops: { type: string; id: string }[]) => {
      ops.forEach((op) => op.type === 'setNote' && w.__noteWrites.push(op.id))
      return write(uid, ops)
    }
    backend.uploadFile = (uid: string, noteId: string, file: File, onProgress?: (fraction: number) => void) =>
      new Promise((resolve) => {
        const path = `users/${uid}/notes/${noteId}/${Date.now()}-${file.name}`
        let fraction = 0
        const timer = setInterval(() => {
          fraction = Math.min(1, fraction + 0.1)
          onProgress?.(fraction)
          if (fraction < 1) return
          clearInterval(timer)
          objects.add(path)
          resolve({ url: `https://files.example/${encodeURIComponent(file.name)}`, path })
        }, uploadMs / 10)
      })
    backend.deleteFile = async (_uid: string, path: string) => {
      objects.delete(path)
    }
    backend.deleteNoteFiles = async (uid: string, noteId: string, keep?: Set<string>) => {
      for (const path of [...objects]) {
        if (path.startsWith(`users/${uid}/notes/${noteId}/`) && !keep?.has(path)) objects.delete(path)
      }
    }
  }, uploadMs)
}

const storageObjects = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __objects: Set<string> }).__objects])

const noteWrites = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as { __noteWrites: string[] }).__noteWrites.filter((n) => n === id).length, id)

/** Suelta un fichero al final del primer párrafo de la nota abierta. */
async function dropFile(page: Page, name: string) {
  const editor = page.locator('.ProseMirror')
  const box = await editor.locator('p').first().boundingBox()
  if (!box) throw new Error('missing paragraph')
  await editor.evaluate(
    (el, { x, y, name }) => {
      const dt = new DataTransfer()
      dt.items.add(new File([`contenido de ${name}`], name, { type: 'application/pdf' }))
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
    },
    { x: box.x + box.width - 2, y: box.y + box.height / 2, name },
  )
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('formats typed with WhatsApp markers and shows title plus two lines in the sidebar (S2, S4)', async ({ page }) => {
  await newNote(page, 'Compra', 'Leche *entera* y _pan_ y ~huevos~ ')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Segunda línea')
  const editor = page.locator('.ProseMirror')
  await expect(editor.locator('strong')).toHaveText('entera')
  await expect(editor.locator('em')).toHaveText('pan')
  await expect(editor.locator('s')).toHaveText('huevos')
  await backToNotes(page)
  const row = page.getByTestId('tree-note').filter({ hasText: 'Compra' })
  await expect(row).toContainText('Leche entera y pan y huevos')
  await expect(row).toContainText('Segunda línea')
})

test('toolbar format with no selection applies to the next typed text (S10)', async ({ page }) => {
  await newNote(page, '')
  await page.locator('.ProseMirror').click()
  await page.getByRole('button', { name: 'Negrita' }).click()
  await page.keyboard.type('fuerte')
  await expect(page.locator('.ProseMirror strong')).toHaveText('fuerte')
})

test('copies WhatsApp text and pastes WhatsApp text back with formats (S4)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only available in Chromium')
  await newNote(page, '', 'Hola *mundo* ')
  await page.keyboard.press(`${mod}+A`)
  await page.keyboard.press(`${mod}+C`)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Hola *mundo*')

  await page.keyboard.press('ArrowRight')
  // ProseMirror lee la selección del DOM de forma asíncrona: pausa como la de una persona.
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await page.evaluate(() => navigator.clipboard.writeText('- uno\n- dos\n☐ tarea\n☑ hecha\n_cursiva_'))
  await page.keyboard.press(`${mod}+V`)
  const editor = page.locator('.ProseMirror')
  await expect(editor.locator('ul:not([data-type="taskList"]) > li')).toHaveCount(2)
  await expect(editor.locator('ul[data-type="taskList"] > li')).toHaveCount(2)
  await expect(editor.locator('em')).toHaveText('cursiva')
})

test('checkboxes interleave with text and reorder by dragging the grip (S5)', async ({ page }) => {
  await newNote(page, 'Tareas')
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Texto normal')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Casilla de verificación' }).click()
  for (const item of ['uno', 'dos', 'tres']) {
    await page.keyboard.type(item)
    await page.keyboard.press('Enter')
  }
  const items = page.locator('.ProseMirror ul[data-type="taskList"] > li')
  await expect(items).toHaveCount(4)
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Texto normal')

  const grip = items.nth(2).locator('.task-grip')
  await items.nth(2).hover()
  const from = await grip.boundingBox()
  const to = await items.nth(0).boundingBox()
  if (!from || !to) throw new Error('missing boxes')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, to.y + 2, { steps: 12 })
  await page.mouse.up()
  await expect(items.nth(0).locator('p')).toHaveText('tres')
  await expect(items.nth(1).locator('p')).toHaveText('uno')
})

test('typed and pasted links become plain links (S15)', async ({ page }) => {
  await newNote(page, '', 'Mira https://example.com ')
  const link = page.locator('.ProseMirror a[href="https://example.com"]')
  await expect(link).toHaveText('https://example.com')
})

test('emoji shortcode :ok inserts a thumbs up (S20)', async ({ page }) => {
  await newNote(page, '', 'Vale :ok')
  await expect(page.locator('.emoji-menu')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.ProseMirror')).toContainText('Vale 👍')
})

test('fullscreen button toggles and Esc exits (S9)', async ({ page }) => {
  await newNote(page, 'Grande', 'texto')
  await page.getByRole('button', { name: 'Pantalla completa' }).click()
  await expect(page.locator('.app')).toHaveAttribute('data-fullscreen', 'true')
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.locator('.app')).toHaveAttribute('data-fullscreen', 'false')
  await expect(page.locator('.sidebar')).toBeVisible()
})

test('dropped file stays at the drop point inside the text (S6)', async ({ page }) => {
  await newNote(page, '', 'antes despues')
  const editor = page.locator('.ProseMirror')
  const point = await editor.locator('p').first().evaluate((p) => {
    // Coordenadas justo después de "antes ".
    const range = document.createRange()
    range.setStart(p.firstChild!, 6)
    range.setEnd(p.firstChild!, 6)
    const r = range.getBoundingClientRect()
    return { x: r.left + 1, y: r.top + r.height / 2 }
  })
  await editor.evaluate((el, { x, y }) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['hola'], 'informe.pdf', { type: 'application/pdf' }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
  }, point)
  const chip = editor.locator('.attachment')
  await expect(chip).toContainText('informe.pdf')
  const text = await editor.locator('p').first().evaluate((p) =>
    Array.from(p.childNodes)
      .map((n) => (n.nodeType === Node.TEXT_NODE ? n.textContent : '[FILE]'))
      .join(''),
  )
  expect(text.replace(/\s+/g, ' ')).toMatch(/^antes \[FILE\] ?despues/)
})

test('folder path header, top-level creation and dragging a note out of a folder (S18, S22)', async ({ page }) => {
  await page.getByRole('button', { name: 'Nueva carpeta' }).first().click()
  await page.keyboard.type('Carpeta 1')
  await page.keyboard.press('Enter')
  await page.locator('.sidebar').getByText('Carpeta 1').click()
  await page.locator('.main').getByRole('button', { name: 'Nueva nota' }).first().click()
  await page.getByPlaceholder('Título').fill('Dentro')
  await expect(page.locator('.main')).toContainText('Carpeta 1')
  // El botón de la barra lateral crea fuera de carpetas aunque estemos en una.
  await page.locator('.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  await page.getByPlaceholder('Título').fill('Fuera')
  await backToNotes(page)
  const notes = await storedNotes(page)
  expect(notes.find((n) => n.title === 'Fuera')?.folderId).toBeNull()
  expect(notes.find((n) => n.title === 'Dentro')?.folderId).not.toBeNull()

  const row = page.getByTestId('tree-note').filter({ hasText: 'Dentro' })
  const box = await row.boundingBox()
  if (!box) throw new Error('missing row')
  await page.mouse.move(box.x + 30, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 40, box.y + 40, { steps: 5 })
  const heading = await page.locator('.tree-root-heading').boundingBox()
  if (!heading) throw new Error('missing heading')
  await page.mouse.move(heading.x + 40, heading.y + heading.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await storedNotes(page)).find((n) => n.title === 'Dentro')?.folderId).toBeNull()
})

test('notes screen reorder in list layout changes the sidebar order (S12)', async ({ page }) => {
  for (const title of ['C', 'B', 'A']) {
    await newNote(page, title, 'x')
    await backToNotes(page)
  }
  await page.locator('.sidebar').getByText('Todas las notas').click()
  await page.getByRole('button', { name: 'Lista' }).click()
  const cards = page.getByTestId('note-card')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('A')
  const from = await cards.nth(0).boundingBox()
  const to = await cards.nth(2).boundingBox()
  if (!from || !to) throw new Error('missing boxes')
  await page.mouse.move(from.x + 40, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y + 20, { steps: 4 })
  await page.mouse.move(to.x + 40, to.y + to.height - 4, { steps: 15 })
  await page.mouse.up()
  await expect(cards.nth(2)).toContainText('A')
  const sidebarOrder = await page.getByTestId('tree-note').allTextContents()
  expect(sidebarOrder.map((t) => t.trim()[0])).toEqual(['B', 'C', 'A'])
})

test('dragging a notes-screen card onto a sidebar folder moves it there, and onto "Notas" to the top level (S31)', async ({ page }) => {
  await page.getByRole('button', { name: 'Nueva carpeta' }).first().click()
  await page.keyboard.type('Destino')
  await page.keyboard.press('Enter')
  await newNote(page, 'Viajera', 'x')
  await backToNotes(page)
  await page.locator('.sidebar').getByText('Todas las notas').click()
  const card = page.getByTestId('note-card').filter({ hasText: 'Viajera' })
  const folderRow = page.getByTestId('tree-folder').filter({ hasText: 'Destino' })

  await dragTo(page, card, folderRow, async () => {
    await expect(folderRow).toHaveAttribute('data-drop', 'into')
  })
  const destino = await folderId(page, 'Destino')
  expect(destino).toBeTruthy()
  await expect.poll(async () => (await storedNotes(page)).find((n) => n.title === 'Viajera')?.folderId).toBe(destino)
  await expect(folderRow).not.toHaveAttribute('data-drop', /.*/)

  // Las notas fijadas también se mueven; "Notas" las saca a la raíz.
  // dnd-kit descarta los clics durante 50 ms tras soltar: pausa como la de una persona.
  await page.waitForTimeout(150)
  await card.getByRole('button', { name: 'Fijar' }).click()
  await expect(card.getByRole('button', { name: 'Desfijar' })).toBeVisible()
  const heading = page.locator('.tree-root-heading')
  await dragTo(page, card, heading, async () => {
    await expect(heading).toHaveAttribute('data-drop', 'into')
  })
  await expect.poll(async () => (await storedNotes(page)).find((n) => n.title === 'Viajera')?.folderId).toBeNull()
  expect((await storedNotes(page)).find((n) => n.title === 'Viajera')?.pinned).toBe(true)
})

/** Datos como los importados: notas sueltas y las carpetas Trabajo, Personal (con `perFolder` notas) y Archivadas vacía. */
async function seedFolders(page: Page, perFolder: number) {
  await page.evaluate((perFolder) => {
    const now = Date.now()
    const notes: Record<string, unknown> = {}
    const folders: Record<string, unknown> = {}
    let order = 0
    const add = (id: string, title: string, folderId: string | null) => {
      const content = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] })
      notes[id] = { id, title, content, preview: 'x', folderId, order: `a${order++}`, pinned: false, color: null }
      Object.assign(notes[id] as object, { trashed: false, trashedAt: null, createdAt: now, updatedAt: now })
    }
    ;['Trabajo', 'Personal', 'Archivadas'].forEach((name, i) => {
      folders[name] = { id: name, name, parentId: null, order: `a${i}`, createdAt: now, updatedAt: now }
    })
    for (let i = 0; i < 2; i++) add(`loose${i}`, `Suelta ${i}`, null)
    for (let i = 0; i < perFolder; i++) add(`work${i}`, `Trabajo ${i}`, 'Trabajo')
    for (let i = 0; i < perFolder; i++) add(`home${i}`, `Personal ${i}`, 'Personal')
    localStorage.setItem('kaze:memory-db', JSON.stringify({ notes, folders }))
  }, perFolder)
  await page.reload()
  await page.locator('.sidebar').getByText('Todas las notas').click()
}

/** Empieza a arrastrar la tarjeta de la pantalla de notas con ese título. */
async function grabCard(page: Page, title: string) {
  const a = await page.getByTestId('note-card').filter({ hasText: title }).boundingBox()
  if (!a) throw new Error('missing card')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 4 })
}

async function hover(page: Page, target: Locator) {
  const b = await target.boundingBox()
  if (!b) throw new Error('missing target')
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 })
}

const folderOf = async (page: Page, id: string) => (await storedNotes(page)).find((n) => n.id === id)?.folderId

test('a card passing over a folder of notes on its way to the next folder still reaches it (S31)', async ({ page }) => {
  await seedFolders(page, 12)
  const trabajo = page.getByTestId('tree-folder').filter({ hasText: 'Trabajo' })
  const personal = page.getByTestId('tree-folder').filter({ hasText: 'Personal' })
  await grabCard(page, 'Suelta 0')
  await hover(page, trabajo)
  await page.waitForTimeout(900)
  // Abrirla no sirve para soltar la tarjeta y empujaría hacia abajo las carpetas siguientes.
  await expect(trabajo.locator('.tree-chevron')).toHaveAttribute('data-expanded', 'false')
  await hover(page, personal)
  await expect(personal).toHaveAttribute('data-drop', 'into')
  await page.mouse.up()
  await expect.poll(() => folderOf(page, 'loose0')).toBe('Personal')
})

test('a dragged card shrinks to a small chip next to the pointer over the sidebar and grows back outside it', async ({
  page,
}) => {
  await seedFolders(page, 3)
  const overlayCard = page.locator('.note-card[data-overlay]')
  const chip = page.locator('.notes-drag-chip')
  await grabCard(page, 'Suelta 0')
  await expect(overlayCard).toBeVisible()
  await expect(chip).toHaveCount(0)

  const personal = page.getByTestId('tree-folder').filter({ hasText: 'Personal' })
  await hover(page, personal)
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('Suelta 0')
  await expect(overlayCard).toHaveCount(0)
  const row = await personal.boundingBox()
  const box = await chip.boundingBox()
  if (!row || !box) throw new Error('missing boxes')
  // Pequeña y junto al puntero (en el centro de la fila), sin tapar la fila de destino.
  expect(box.width).toBeLessThanOrEqual(230)
  expect(box.height).toBeLessThan(50)
  const pointer = { x: row.x + row.width / 2, y: row.y + row.height / 2 }
  expect(box.x - pointer.x).toBeGreaterThanOrEqual(0)
  expect(box.x - pointer.x).toBeLessThan(30)
  expect(box.y - pointer.y).toBeGreaterThanOrEqual(0)
  expect(box.y - pointer.y).toBeLessThan(30)

  await hover(page, page.getByTestId('note-card').filter({ hasText: 'Suelta 1' }).first())
  await expect(overlayCard).toBeVisible()
  await expect(chip).toHaveCount(0)

  await hover(page, personal)
  await expect(chip).toBeVisible()
  await page.mouse.up()
  await expect.poll(() => folderOf(page, 'loose0')).toBe('Personal')
  await expect(chip).toHaveCount(0)
})

test('a card dropped on a note inside an open sidebar folder moves into that folder (S31)', async ({ page }) => {
  await seedFolders(page, 3)
  const personal = page.getByTestId('tree-folder').filter({ hasText: 'Personal' })
  await personal.getByRole('button', { name: 'Desplegar carpeta' }).click()
  await grabCard(page, 'Suelta 0')
  await hover(page, page.getByTestId('tree-note').filter({ hasText: 'Personal 1' }))
  await expect(personal).toHaveAttribute('data-drop', 'into')
  await page.mouse.up()
  await expect.poll(() => folderOf(page, 'loose0')).toBe('Personal')
})

test('dragging a card to the edge of the sidebar scrolls it to reach folders below (S31)', async ({ page }) => {
  await seedFolders(page, 12)
  for (const name of ['Trabajo', 'Personal']) {
    await page.getByTestId('tree-folder').filter({ hasText: name }).getByRole('button', { name: 'Desplegar carpeta' }).click()
  }
  const scroller = page.locator('.sb-scroll')
  const archivadas = page.getByTestId('tree-folder').filter({ hasText: 'Archivadas' })
  await expect(archivadas).not.toBeInViewport()
  await grabCard(page, 'Suelta 0')
  const box = await scroller.boundingBox()
  if (!box) throw new Error('missing sidebar')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8, { steps: 10 })
  await expect(archivadas).toBeInViewport({ ratio: 1 })
  // Fuera del borde se detiene el desplazamiento y la carpeta deja de moverse.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  await hover(page, archivadas)
  await expect(archivadas).toHaveAttribute('data-drop', 'into')
  await page.mouse.up()
  await expect.poll(() => folderOf(page, 'loose0')).toBe('Archivadas')
})

test('note header folder picker moves to a folder, to no folder and into a new folder (S31)', async ({ page }) => {
  await page.getByRole('button', { name: 'Nueva carpeta' }).first().click()
  await page.keyboard.type('Trabajo')
  await page.keyboard.press('Enter')
  const trabajo = page.getByTestId('tree-folder').filter({ hasText: 'Trabajo' })
  await trabajo.getByRole('button', { name: 'Opciones de la carpeta' }).click()
  await page.getByRole('menuitem', { name: 'Nueva subcarpeta' }).click()
  await page.keyboard.type('Ideas')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tree-folder').filter({ hasText: 'Ideas' })).toBeVisible()

  await newNote(page, 'Plan', 'x')
  const pickerButton = page.getByRole('button', { name: /Mover a carpeta/ })
  await expect(pickerButton).toContainText('Sin carpeta')
  const titleOf = async () => (await storedNotes(page)).find((n) => n.title === 'Plan')?.folderId

  // Filtrar sin tildes ni mayúsculas y elegir con el teclado.
  await pickerButton.click()
  const search = page.getByPlaceholder('Buscar o crear carpeta…')
  await expect(search).toBeFocused()
  await search.fill('IDEA')
  await expect(page.getByRole('option')).toHaveText([/Trabajo \/ Ideas/, /Crear carpeta «IDEA»/])
  await page.keyboard.press('Enter')
  await expect(search).toBeHidden()
  const ideas = await folderId(page, 'Ideas')
  await expect.poll(titleOf).toBe(ideas)
  await expect(pickerButton).toContainText('Trabajo / Ideas')

  // La carpeta actual sale marcada y resaltada; ↑/↓ mueven el resaltado de forma circular.
  await pickerButton.click()
  await expect(page.getByRole('option', { selected: true })).toContainText('Ideas')
  await expect(page.getByRole('option', { name: /Ideas/ })).toHaveAttribute('data-current', 'true')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('option', { selected: true })).toContainText('Trabajo')
  await page.getByRole('option', { name: 'Sin carpeta' }).click()
  await expect.poll(titleOf).toBeNull()
  await expect(pickerButton).toContainText('Sin carpeta')

  // Crear una carpeta nueva desde el texto escrito y mover la nota allí.
  await pickerButton.click()
  await page.getByPlaceholder('Buscar o crear carpeta…').fill('Viajes')
  await page.getByRole('option', { name: /Crear carpeta «Viajes»/ }).click()
  await expect.poll(() => folderId(page, 'Viajes')).toBeTruthy()
  const viajes = (await storedFolders(page)).find((f) => f.name === 'Viajes')
  expect(viajes?.parentId).toBeNull()
  await expect.poll(titleOf).toBe(viajes?.id)
  await expect(page.getByTestId('tree-folder').filter({ hasText: 'Viajes' })).toBeVisible()

  // Esc cierra el selector sin salir de pantalla completa.
  await page.getByRole('button', { name: 'Pantalla completa' }).click()
  await pickerButton.click()
  await expect(page.getByPlaceholder('Buscar o crear carpeta…')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByPlaceholder('Buscar o crear carpeta…')).toBeHidden()
  await expect(page.locator('.app')).toHaveAttribute('data-fullscreen', 'true')

  // Abrir la carpeta de la nota desde el selector.
  await pickerButton.click()
  await page.getByRole('button', { name: 'Abrir carpeta' }).click()
  await expect(page.locator('.notes-title')).toContainText('Viajes')
})

test('pin, trash, restore, delete forever and empty trash (S13, S14, S22)', async ({ page }) => {
  await newNote(page, 'Importante', 'x')
  await page.getByRole('button', { name: /Fijar/ }).first().click()
  await backToNotes(page)
  await expect(page.locator('.sidebar')).toContainText('Fijadas')

  await newNote(page, 'Borrable', 'x')
  await page.getByRole('button', { name: 'Mover a la papelera' }).first().click()
  await page.locator('.sidebar').getByText('Papelera').click()
  await expect(page.getByTestId('trash-item')).toHaveCount(1)
  await page.getByRole('button', { name: 'Restaurar' }).click()
  await expect(page.getByTestId('trash-item')).toHaveCount(0)
  expect((await storedNotes(page)).find((n) => n.title === 'Borrable')?.trashed).toBe(false)

  await page.getByTestId('tree-note').filter({ hasText: 'Borrable' }).click()
  await page.getByRole('button', { name: 'Mover a la papelera' }).first().click()
  await page.locator('.sidebar').getByText('Papelera').click()
  await page.getByRole('button', { name: 'Vaciar papelera' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /Vaciar|Eliminar/ }).click()
  await expect(page.getByTestId('trash-item')).toHaveCount(0)
  expect((await storedNotes(page)).map((n) => n.title)).toEqual(['Importante'])
})

test('search ignores accents, case and small typos (S19)', async ({ page }) => {
  await newNote(page, 'Reunión de equipo', 'Presupuesto trimestral')
  await backToNotes(page)
  await newNote(page, 'Recetas', 'Tortilla de patatas')
  await backToNotes(page)
  const search = page.getByTestId('search-input')
  await search.fill('REUNION')
  await expect(page.getByTestId('note-card')).toHaveCount(1)
  await search.fill('presupusto')
  await expect(page.getByTestId('note-card')).toContainText('Reunión de equipo')
  await search.fill('tortila')
  await expect(page.getByTestId('note-card')).toContainText('Recetas')
})

test('a change from another device while typing is kept as a conflict copy next to the note', async ({ page }) => {
  await newNote(page, 'Otra', 'x')
  await backToNotes(page)
  await newNote(page, 'Lista', 'version inicial')
  await expect.poll(async () => (await storedNote(page, 'Lista'))?.content ?? '').toContain('version inicial')
  const id = (await storedNote(page, 'Lista'))!.id

  // Se sigue escribiendo aquí mientras llega la versión de otro dispositivo.
  const typing = page.keyboard.type(' y una frase local', { delay: 40 })
  await page.waitForTimeout(250)
  await page.evaluate(async (id) => {
    const url = '/src/lib/backend/index.ts'
    const { backend } = await import(/* @vite-ignore */ url)
    const text = 'TEXTO ESCRITO EN EL MOVIL'
    const content = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
    await backend.write('local', [{ type: 'setNote', id, data: { content, preview: text, updatedAt: Date.now() } }])
  }, id)
  await typing

  await expect.poll(async () => (await storedNotes(page)).length).toBe(3)
  await expect(page.locator('.ProseMirror')).toHaveText('version inicial y una frase local')
  await expect(page.getByPlaceholder('Título')).toHaveValue('Lista')
  await expect.poll(async () => (await storedNote(page, 'Lista'))?.content ?? '').toContain('y una frase local')
  const notes = await storedNotes(page)
  const original = notes.find((n) => n.title === 'Lista')!
  const copy = notes.find((n) => n.title === 'Lista (conflicto)')
  const other = notes.find((n) => n.title === 'Otra')!
  expect(original.content).not.toContain('MOVIL')
  expect(copy?.content).toContain('TEXTO ESCRITO EN EL MOVIL')
  expect(copy).toMatchObject({ folderId: null, pinned: false, trashed: false })
  expect(original.order < copy!.order && copy!.order < other.order).toBe(true)
  await expect(page.getByTestId('tree-note').filter({ hasText: 'Lista (conflicto)' })).toBeVisible()
})

test('a copied attachment keeps its file when the note that uploaded it is deleted forever', async ({ page }) => {
  await fakeStorage(page, 300)
  await newNote(page, 'Origen', 'texto ')
  await dropFile(page, 'compartido.pdf')
  await expect(page.locator('.ProseMirror .attachment[data-state="done"]')).toBeVisible()

  // Copia con el serializador real del editor (como Cmd+C) y pegado en otra nota.
  const clip = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    pm.focus()
    window.getSelection()!.selectAllChildren(pm)
    document.dispatchEvent(new Event('selectionchange'))
    const dt = new DataTransfer()
    pm.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
    return { html: dt.getData('text/html'), text: dt.getData('text/plain') }
  })
  expect(clip.html).toContain('data-path')
  await backToNotes(page)
  await newNote(page, 'Copia', '')
  await page.locator('.ProseMirror').click()
  await page.evaluate(({ html, text }) => {
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    dt.setData('text/plain', text)
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, clip)
  await expect(page.locator('.ProseMirror .attachment')).toHaveCount(1)
  await backToNotes(page)

  await expect.poll(async () => attachmentsOf(await storedNote(page, 'Copia')).length).toBe(1)
  const [source] = attachmentsOf(await storedNote(page, 'Origen'))
  const [copied] = attachmentsOf(await storedNote(page, 'Copia'))
  expect(copied.path).toBe(source.path)
  expect(copied.id).not.toBe(source.id)
  expect(await storageObjects(page)).toEqual([source.path])

  // Borrar para siempre la nota que subió el fichero no lo borra: la copia lo sigue usando.
  await page.getByTestId('tree-note').filter({ hasText: 'Origen' }).click()
  await page.getByRole('button', { name: 'Mover a la papelera' }).first().click()
  await page.locator('.sidebar').getByText('Papelera').click()
  await page.getByRole('button', { name: 'Eliminar definitivamente' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar definitivamente' }).click()
  await expect(page.getByTestId('trash-item')).toHaveCount(0)
  await expect.poll(async () => (await storedNote(page, 'Origen')) === undefined).toBe(true)
  expect(await storageObjects(page)).toEqual([source.path])

  // Al quitar el último adjunto que lo usa, el fichero sí se borra.
  await page.getByTestId('tree-note').filter({ hasText: 'Copia' }).click()
  await page.locator('.ProseMirror .attachment').hover()
  await page.locator('.attachment-delete').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click()
  await expect(page.locator('.ProseMirror .attachment')).toHaveCount(0)
  await expect.poll(() => storageObjects(page)).toEqual([])
})

test('an upload that ends after closing and reopening the note is kept, without saving on each progress tick', async ({
  page,
}) => {
  // Subida lenta: el progreso avanza cada 700 ms, más que la espera del guardado.
  await fakeStorage(page, 7000)
  const editor = page.locator('.ProseMirror')
  await newNote(page, 'Subida', 'inicio ')
  await expect.poll(async () => (await storedNote(page, 'Subida'))?.content ?? '').toContain('inicio')
  const id = (await storedNote(page, 'Subida'))!.id
  await dropFile(page, 'grande.pdf')
  await expect(editor.locator('.attachment[data-state="uploading"]')).toBeVisible()
  // Con la nota abierta y sin escribir, el progreso de la subida no reescribe la nota.
  await expect.poll(async () => (await storedNote(page, 'Subida'))?.content ?? '').toContain('grande.pdf')
  const writesBefore = await noteWrites(page, id)
  await page.waitForTimeout(2500)
  expect(await noteWrites(page, id)).toBe(writesBefore)
  expect((await storedNote(page, 'Subida'))?.content).not.toContain('"progress"')

  await backToNotes(page)
  await page.getByTestId('tree-note').filter({ hasText: 'Subida' }).click()
  await editor.click()
  await page.keyboard.press(`${mod}+End`)
  // Se sigue escribiendo hasta después de que acabe la subida.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.type('x')
    await page.waitForTimeout(100)
  }
  await expect(editor.locator('.attachment')).toHaveAttribute('data-state', 'done')
  await expect.poll(async () => attachmentsOf(await storedNote(page, 'Subida')).map((a) => a.status)).toEqual(['done'])
  const [stored] = attachmentsOf(await storedNote(page, 'Subida'))
  expect(stored.path).toMatch(/^users\/local\/notes\/.+-grande\.pdf$/)
  expect(await storageObjects(page)).toEqual([stored.path])
  await expect.poll(async () => (await storedNote(page, 'Subida'))?.content ?? '').toContain('x'.repeat(40))
})

test('shortcuts do nothing while a confirm dialog is open, and focus returns to the note', async ({ page }) => {
  await newNote(page, 'Atajos', 'texto ')
  const editor = page.locator('.ProseMirror')
  await dropFile(page, 'k.pdf')
  const chip = editor.locator('.attachment[data-state="done"]')
  await expect(chip).toBeVisible()
  const dialog = page.getByRole('alertdialog')

  await chip.hover()
  await page.locator('.attachment-delete').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press(`${mod}+K`)
  await expect(dialog).toBeVisible()
  await expect(editor).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(chip).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror'))).toBe(true)

  await chip.hover()
  await page.locator('.attachment-delete').click()
  await page.keyboard.press(`${mod}+K`)
  await dialog.getByRole('button', { name: 'Eliminar' }).click()
  await expect(editor.locator('.attachment')).toHaveCount(0)
  await expect.poll(async () => attachmentsOf(await storedNote(page, 'Atajos')).length).toBe(0)
})

const SIZES = [
  [320, 568],
  [375, 667],
  [390, 844],
  [600, 900],
  [768, 1024],
  [1024, 640],
  [1280, 800],
  [1440, 420],
  [1920, 1080],
  [2560, 1200],
] as const

test('installing the app has an icon: PNG apple-touch-icon for iOS and manifest icons for Chrome', async ({ page }) => {
  const pngSize = async (href: string) => {
    const res = await page.request.get(href)
    expect(res.status(), href).toBe(200)
    const bytes = await res.body()
    // Firma PNG y dimensiones de la cabecera IHDR.
    expect(bytes.subarray(1, 4).toString(), href).toBe('PNG')
    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`
  }
  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  expect(await pngSize(touchIcon ?? '')).toBe('180x180')

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  const manifest = await (await page.request.get(manifestHref ?? '')).json()
  expect(manifest.icons.length).toBeGreaterThan(0)
  for (const icon of manifest.icons as { src: string; sizes: string }[]) {
    expect(await pngSize(icon.src)).toBe(icon.sizes)
  }
})

test('no horizontal overflow on any window size, light and dark (S17)', async ({ page }) => {
  await newNote(page, 'Una nota con un título bastante largo para comprobar el recorte', 'Texto '.repeat(60))
  const overflow = () =>
    page.evaluate(() => {
      const root = document.documentElement
      const main = document.querySelector('.main')
      return root.scrollWidth > window.innerWidth + 1 || (main ? main.scrollWidth > main.clientWidth + 1 : false)
    })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height })
      await expect(page.locator('.ProseMirror')).toBeVisible()
      expect(await overflow(), `editor ${width}x${height} ${scheme}`).toBe(false)
    }
  }
  await backToNotes(page)
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height })
    expect(await overflow(), `notes ${width}x${height}`).toBe(false)
  }
})
