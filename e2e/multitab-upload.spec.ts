import { expect, test, type Page } from '@playwright/test'

// Una segunda pestaña que ve un fichero que otra está subiendo no se queda "sincronizando" cuando se sube.

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Google/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

async function dirtyKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const url = '/src/state/store.ts'
    const { useApp } = await import(/* @vite-ignore */ url)
    return useApp.getState().sync.dirty as string[]
  })
}

async function outboxSize(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const url = '/src/lib/outbox.ts'
    const { pendingUploadCount } = await import(/* @vite-ignore */ url)
    return pendingUploadCount()
  })
}

test('a tab that saw a file another tab was uploading does not stay syncing after the upload ends', async ({ page, context }) => {
  test.skip(test.info().project.name !== 'chromium', 'Web Locks + shared IndexedDB, one engine is enough')
  await signIn(page)
  await page.locator('.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  await page.getByPlaceholder('Título').fill('Video')
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('clip ')
  // Tab A: the upload waits until the test releases it (a big file on a slow connection).
  await page.evaluate(async () => {
    const url = '/src/lib/backend/index.ts'
    const { backend } = await import(/* @vite-ignore */ url)
    const w = window as unknown as { __release: () => void }
    const gate = new Promise<void>((resolve) => (w.__release = resolve))
    const original = backend.uploadFile
    backend.uploadFile = async (...args: unknown[]) => {
      await gate
      return original(...args)
    }
  })
  const editor = page.locator('.ProseMirror')
  await editor.evaluate((el) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new TextEncoder().encode('contenido')], 'clip.pdf', { type: 'application/pdf' }))
    const box = el.querySelector('p')!.getBoundingClientRect()
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: box.right - 2, clientY: box.top + box.height / 2, dataTransfer: dt }))
  })
  await expect.poll(() => outboxSize(page)).toBe(1)

  // Tab B opens while A is uploading.
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.locator('.sidebar')).toBeVisible()
  await expect.poll(async () => (await dirtyKeys(other)).some((k) => k.startsWith('queued:'))).toBe(true)

  // A finishes: the file leaves the device queue.
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release())
  await expect(page.locator('.ProseMirror .attachment')).toHaveAttribute('data-state', 'done')
  await expect.poll(() => outboxSize(page)).toBe(0)

  // B must not keep a pending mark for a file that is no longer queued anywhere.
  await expect.poll(() => dirtyKeys(other)).toEqual([])
})

test('a file waiting in the queue is uploaded by the tab that has its note open, not by another tab', async ({ page, context }) => {
  test.skip(test.info().project.name !== 'chromium', 'Web Locks + shared IndexedDB, one engine is enough')
  await signIn(page)
  await page.locator('.sidebar').getByRole('button', { name: 'Nueva nota' }).click()
  await page.getByPlaceholder('Título').fill('Informe')
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('anexo ')
  // Pestaña A: la primera subida falla por la red y el fichero se queda en la cola.
  await page.evaluate(async () => {
    const url = '/src/lib/backend/index.ts'
    const { backend } = await import(/* @vite-ignore */ url)
    const original = backend.uploadFile
    let first = true
    backend.uploadFile = (...args: unknown[]) => {
      if (first) {
        first = false
        return Promise.reject(Object.assign(new Error('network'), { code: 'storage/retry-limit-exceeded' }))
      }
      return original(...args)
    }
  })
  await page.locator('.ProseMirror').evaluate((el) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new TextEncoder().encode('contenido')], 'anexo.pdf', { type: 'application/pdf' }))
    const box = el.querySelector('p')!.getBoundingClientRect()
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: box.right - 2, clientY: box.top + box.height / 2, dataTransfer: dt }))
  })
  const chip = page.locator('.ProseMirror .attachment')
  await expect(chip).toHaveAttribute('data-state', 'waiting')

  // Pestaña B: al abrir encuentra el fichero en la cola, pero la nota está abierta en A.
  const other = await context.newPage()
  // Se cuentan las subidas de B desde que carga: la pasada al abrir puede empezar antes que cualquier evaluate.
  await other.route('**/src/lib/backend/memory.ts*', async (route) => {
    const response = await route.fetch()
    const body = (await response.text()).replace(
      'uploadFile(uid, noteId, file, onProgress) {',
      'uploadFile(uid, noteId, file, onProgress) { window.uploadsHere = (window.uploadsHere ?? 0) + 1;',
    )
    if (!body.includes('window.uploadsHere')) throw new Error('memory backend uploadFile not found')
    await route.fulfill({ response, body })
  })
  await other.goto('/')
  await expect(other.locator('.sidebar')).toBeVisible()
  await expect.poll(async () => (await dirtyKeys(other)).some((k) => k.startsWith('queued:'))).toBe(true)

  // A recupera la conexión y lo sube en su editor.
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(chip).toHaveAttribute('data-state', 'done')
  await expect.poll(() => outboxSize(page)).toBe(0)
  await expect.poll(() => dirtyKeys(other)).toEqual([])
  expect(await other.evaluate(() => (window as unknown as { uploadsHere?: number }).uploadsHere ?? 0)).toBe(0)
})
