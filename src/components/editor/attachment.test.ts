import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmDialog } from '../ui/confirm'
import { deleteAttachmentFile, updateNote, uploadAttachment, useApp } from '../../state/store'
import type { UploadResult } from '../../lib/backend'
import {
  canOpenUrl,
  deleteAttachment,
  linkTarget,
  fileIcon,
  formatSize,
  insertFiles,
  registerLiveEditor,
  type AttachmentAttrs,
} from './attachment'
import { createExtensions } from './extensions'

vi.mock('../ui/confirm', () => ({ confirmDialog: vi.fn() }))
vi.mock('../../state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state/store')>()),
  deleteAttachmentFile: vi.fn(() => Promise.resolve()),
  updateNote: vi.fn(() => true),
  uploadAttachment: vi.fn(),
}))

const BUCKET = 'kaze-test.appspot.com'
const storageUrl = (path: string, bucket = BUCKET) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=t1`

const attrs: AttachmentAttrs = {
  id: 'a1',
  url: storageUrl('users/u/notes/n/informe.pdf'),
  path: 'users/u/notes/n/informe.pdf',
  name: 'informe.pdf',
  mime: 'application/pdf',
  size: 2048,
  status: 'done',
}

const withChip: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ver ' }, { type: 'attachment', attrs }] }],
}

function makeEditor(content: JSONContent | string = withChip) {
  return new Editor({ element: document.createElement('div'), extensions: createExtensions(), content })
}

let editor: Editor
let unregister: () => void

beforeEach(() => {
  vi.mocked(confirmDialog).mockReset()
  vi.mocked(deleteAttachmentFile).mockClear()
  vi.mocked(updateNote).mockClear()
  vi.mocked(uploadAttachment).mockReset()
  editor = makeEditor()
  unregister = registerLiveEditor('n1', editor)
})

afterEach(() => {
  unregister()
  editor.destroy()
})

function chips(e: Editor): AttachmentAttrs[] {
  const found: AttachmentAttrs[] = []
  e.state.doc.descendants((node) => {
    if (node.type.name === 'attachment') found.push(node.attrs as AttachmentAttrs)
  })
  return found
}

const attachmentCount = () => chips(editor).length

describe('deleting an attachment permanently', () => {
  it('asks first, then removes the chip and deletes the file from the cloud', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true)
    await deleteAttachment(editor.view, attrs)
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(vi.mocked(confirmDialog).mock.calls[0][0].message).toContain('informe.pdf')
    expect(attachmentCount()).toBe(0)
    expect(deleteAttachmentFile).toHaveBeenCalledWith('users/u/notes/n/informe.pdf', 'n1')
    // Sin deshacer: el fichero ya no existe.
    editor.commands.undo()
    expect(attachmentCount()).toBe(0)
  })

  it('does nothing when the warning is cancelled', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false)
    await deleteAttachment(editor.view, attrs)
    expect(attachmentCount()).toBe(1)
    expect(deleteAttachmentFile).not.toHaveBeenCalled()
  })

  it('removing the chip while editing (backspace) keeps the file, so undo still works', () => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.deleteRange({ from: 5, to: 6 })
    expect(attachmentCount()).toBe(0)
    expect(deleteAttachmentFile).not.toHaveBeenCalled()
    editor.commands.undo()
    expect(attachmentCount()).toBe(1)
  })
})

describe('copying attachments', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_FIREBASE_STORAGE_BUCKET', BUCKET)
    useApp.setState({ user: { uid: 'u', name: 'U', email: 'u@example.com', photoURL: null } })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    useApp.setState({ user: null })
  })

  function pasteChip(data: Record<string, string>): AttachmentAttrs {
    const attributes = Object.entries({ name: 'foto.png', mime: 'image/png', size: '10', status: 'done', ...data })
      .map(([key, value]) => ` data-${key}="${value}"`)
      .join('')
    const other = makeEditor('<p></p>')
    other.view.pasteHTML(`<p><span data-attachment${attributes}>📎 foto.png</span></p>`, new Event('paste') as ClipboardEvent)
    const [pasted] = chips(other)
    other.destroy()
    return pasted
  }

  it('a chip pasted from elsewhere neither loads nor opens a file outside this account', () => {
    const failed = { url: '', path: null, status: 'error', name: 'foto.png' }
    // Imagen remota (p. ej. un píxel de seguimiento) y ruta de otra cuenta.
    expect(pasteChip({ url: 'https://tracker.example/pixel.png', path: 'users/other/notes/n/foto.png' })).toMatchObject(failed)
    expect(pasteChip({ url: 'https://tracker.example/pixel.png' })).toMatchObject(failed)
    // Ruta propia con un enlace ajeno: el fichero se conserva, el enlace no.
    const own = 'users/u/notes/n/foto.png'
    const noLink = { ...failed, path: own }
    expect(pasteChip({ url: 'https://tracker.example/pixel.png', path: own })).toMatchObject(noLink)
    expect(pasteChip({ url: storageUrl(own, 'other-bucket'), path: own })).toMatchObject(noLink)
    expect(pasteChip({ url: storageUrl('users/u/notes/n/otra.png'), path: own })).toMatchObject(noLink)
    expect(pasteChip({ url: 'blob:https://evil.example/123', path: own })).toMatchObject(noLink)
    expect(pasteChip({ url: 'javascript:alert(1)', path: own })).toMatchObject(noLink)
  })

  it('a chip copied inside the app keeps its file, in the cloud or in the local backend', () => {
    const own = 'users/u/notes/n/foto.png'
    expect(pasteChip({ url: storageUrl(own), path: own })).toMatchObject({ url: storageUrl(own), path: own, status: 'done' })
    const local = `blob:${window.location.origin}/123`
    expect(pasteChip({ url: local, path: own })).toMatchObject({ url: local, path: own, status: 'done' })
  })

  it('a pasted attachment gets a new id but points to the same file', () => {
    const html = editor.getHTML()
    const other = makeEditor('<p></p>')
    // jsdom no tiene ClipboardEvent.
    other.view.pasteHTML(html, new Event('paste') as ClipboardEvent)
    const [pasted] = chips(other)
    expect(pasted.id).toBeTruthy()
    expect(pasted.id).not.toBe('a1')
    expect(pasted).toMatchObject({ path: attrs.path, url: attrs.url, name: attrs.name, mime: attrs.mime, status: 'done' })
    other.destroy()
  })

  it('content loaded from JSON keeps its ids', () => {
    expect(chips(editor).map((c) => c.id)).toEqual(['a1'])
  })
})

describe('uploads', () => {
  const pdf = () => new File(['contenido'], 'billete.pdf', { type: 'application/pdf' })
  const done: UploadResult = { url: 'https://files/billete.pdf', path: 'users/u/notes/n1/1-billete.pdf' }

  function controlledUpload() {
    const control = { progress: (_: number) => {}, finish: (_: UploadResult) => {} }
    vi.mocked(uploadAttachment).mockImplementation(
      (_noteId, _file, onProgress) =>
        new Promise((resolve) => {
          control.progress = (fraction) => onProgress?.(fraction)
          control.finish = resolve
        }),
    )
    return control
  }

  it('progress does not change the saved document', () => {
    const upload = controlledUpload()
    insertFiles(editor.view, 'n1', [pdf()])
    const before = JSON.stringify(editor.getJSON())
    const onUpdate = vi.fn()
    editor.on('update', onUpdate)
    upload.progress(0.3)
    upload.progress(0.8)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(JSON.stringify(editor.getJSON())).toBe(before)
  })

  it('an upload that ends after the note was closed and reopened updates the reopened editor', async () => {
    const upload = controlledUpload()
    insertFiles(editor.view, 'n1', [pdf()])
    const saved = editor.getJSON()
    unregister()
    editor.destroy()
    editor = makeEditor(saved)
    unregister = registerLiveEditor('n1', editor)

    upload.finish(done)
    await vi.waitFor(() => expect(chips(editor).find((c) => c.name === 'billete.pdf')?.status).toBe('done'))
    expect(chips(editor).find((c) => c.name === 'billete.pdf')).toMatchObject({ url: done.url, path: done.path })
    expect(updateNote).not.toHaveBeenCalled()
  })

  it('an upload that ends while the note is closed updates the stored note', async () => {
    const upload = controlledUpload()
    insertFiles(editor.view, 'n1', [pdf()])
    const saved = JSON.stringify(editor.getJSON())
    unregister()
    const base = { title: '', preview: '', folderId: null, order: 'a0', pinned: false, color: null, trashed: false }
    useApp.setState({ notes: { n1: { ...base, id: 'n1', content: saved, trashedAt: null, createdAt: 1, updatedAt: 1 } } })

    upload.finish(done)
    await vi.waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1))
    const [noteId, patch] = vi.mocked(updateNote).mock.calls[0]
    expect(noteId).toBe('n1')
    const stored = JSON.stringify(patch.content)
    expect(stored).toContain('billete.pdf')
    expect(JSON.parse(patch.content!).content[0].content.find((n: JSONContent) => n.attrs?.name === 'billete.pdf').attrs).toMatchObject({
      status: 'done',
      url: done.url,
      path: done.path,
    })
    useApp.setState({ notes: {} })
  })
})

describe('attachment chip helpers', () => {
  it('opens only web and local file URLs', () => {
    expect(canOpenUrl('https://firebasestorage.googleapis.com/x')).toBe(true)
    expect(canOpenUrl('http://localhost/x')).toBe(true)
    expect(canOpenUrl('blob:http://localhost/123')).toBe(true)
    expect(canOpenUrl('javascript:alert(1)')).toBe(false)
    expect(canOpenUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(canOpenUrl('')).toBe(false)
  })

  it('opens text links: web, mail, phone… and web addresses typed without https, never javascript: or data:', () => {
    expect(linkTarget('https://example.com/a')).toBe('https://example.com/a')
    expect(linkTarget('mailto:ana@example.com')).toBe('mailto:ana@example.com')
    expect(linkTarget('tel:+34600000000')).toBe('tel:+34600000000')
    expect(linkTarget('example.com')).toBe('https://example.com')
    expect(linkTarget('www.example.es/ruta?q=1')).toBe('https://www.example.es/ruta?q=1')
    expect(linkTarget('example.com:8080/x')).toBe('https://example.com:8080/x')
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,x', 'notas', '/ruta/relativa', '']) {
      expect(linkTarget(unsafe)).toBeNull()
    }
  })

  it('maps file types to icons and formats sizes', () => {
    expect(fileIcon('image/png', 'a.png').displayName).toBe(fileIcon('', 'b.JPG').displayName)
    expect(fileIcon('application/pdf', 'a.pdf')).not.toBe(fileIcon('application/zip', 'a.zip'))
    expect(formatSize(5)).toBe('5 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(2.4 * 1024 * 1024)).toBe('2.4 MB')
  })
})
