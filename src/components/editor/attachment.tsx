import { mergeAttributes, Node, type Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { dropPoint } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import type { JSONContent } from '@tiptap/react'
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState, useSyncExternalStore, type MouseEvent } from 'react'
import { parseContent } from '../../lib/docText'
import { t } from '../../lib/i18n'
import { deleteAttachmentFile, updateNote, uploadAttachment, useApp } from '../../state/store'
import { confirmDialog } from '../ui/confirm'

export type AttachmentStatus = 'uploading' | 'done' | 'error'

export interface AttachmentAttrs {
  id: string
  url: string
  /** Ruta en Storage (para borrar el fichero). */
  path: string | null
  name: string
  mime: string
  size: number
  status: AttachmentStatus
}

// Estado local de las subidas de esta pestaña (no se guarda en el documento).
const uploading = new Set<string>()
const previews = new Map<string, string>()

// Progreso de cada subida: fuera del documento para que no provoque guardados.
const progress = new Map<string, number>()
const progressListeners = new Set<() => void>()

function setProgress(id: string, fraction: number | null) {
  if (fraction === null) progress.delete(id)
  else progress.set(id, fraction)
  progressListeners.forEach((fn) => fn())
}

function subscribeProgress(fn: () => void) {
  progressListeners.add(fn)
  return () => {
    progressListeners.delete(fn)
  }
}

// Editor abierto de cada nota: una subida que acaba tras cerrar y reabrir la nota actualiza el editor vivo.
const liveEditors = new Map<string, Editor>()

/** Registra el editor abierto de una nota. Devuelve la función que lo da de baja. */
export function registerLiveEditor(noteId: string, editor: Editor): () => void {
  liveEditors.set(noteId, editor)
  return () => {
    if (liveEditors.get(noteId) === editor) liveEditors.delete(noteId)
  }
}

/** Solo se abren enlaces web o ficheros locales de esta pestaña. */
export function canOpenUrl(url: string): boolean {
  try {
    return ['https:', 'http:', 'blob:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

function dataAttr(name: string, parse: (value: string | null) => unknown = (v) => v ?? '') {
  return {
    parseHTML: (element: HTMLElement) => parse(element.getAttribute(`data-${name}`)),
    renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: attrs[name] }),
  }
}

/** Adjunto en línea: se queda en el punto del texto donde se soltó. */
export const Attachment = Node.create({
  name: 'attachment',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      // Un adjunto pegado o soltado como HTML es otra copia: id nuevo, mismo fichero.
      id: { default: '', parseHTML: () => newId(), renderHTML: (attrs) => ({ 'data-id': attrs.id }) },
      url: { default: '', ...dataAttr('url') },
      path: { default: null, ...dataAttr('path', (v) => v || null) },
      name: { default: '', ...dataAttr('name') },
      mime: { default: '', ...dataAttr('mime') },
      size: { default: 0, ...dataAttr('size', (v) => Number(v) || 0) },
      status: { default: 'done', ...dataAttr('status', (v) => v || 'done') },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-attachment]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-attachment': '' }), `📎 ${String(node.attrs.name)}`]
  },

  renderText({ node }) {
    return `📎 ${String(node.attrs.name)}`
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView, { as: 'span', className: 'attachment-node' })
  },
})

// ---------- Vista ----------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i
const ARCHIVE = /zip|compressed|x-tar|x-7z|x-rar|gzip|\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i
const SHEET = /spreadsheet|excel|csv|\.(xlsx?|csv|ods|numbers|tsv)$/i
const CODE = /json|javascript|typescript|xml|x-sh|x-python|\.(jsx?|tsx?|json|html?|css|scss|py|java|kt|swift|c|cc|cpp|h|go|rs|rb|php|sh|ya?ml|toml|sql|xml)$/i
const DOC = /pdf|^text\/|msword|wordprocessing|opendocument\.text|rtf|presentation|powerpoint|\.(pdf|txt|md|docx?|odt|rtf|pages|pptx?|key|odp)$/i

export function fileIcon(mime: string, name: string): LucideIcon {
  const both = `${mime} ${name}`
  if (mime.startsWith('image/') || IMAGE_EXT.test(name)) return FileImage
  if (mime.startsWith('video/')) return FilePlay
  if (mime.startsWith('audio/')) return FileMusic
  if (ARCHIVE.test(both)) return FileArchive
  if (SHEET.test(both)) return FileSpreadsheet
  if (CODE.test(both)) return FileCode
  if (DOC.test(both)) return FileText
  return File
}

export function formatSize(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function noteIdOf(view: EditorView): string {
  for (const [noteId, editor] of liveEditors) if (!editor.isDestroyed && editor.view === view) return noteId
  return ''
}

/**
 * Quita el adjunto del documento (sin deshacer: el fichero ya no existe) y lo borra de la nube
 * si ninguna nota lo sigue usando.
 */
export async function deleteAttachment(view: EditorView, attrs: AttachmentAttrs) {
  const noteId = noteIdOf(view)
  if (attrs.path) {
    const ok = await confirmDialog({
      title: t('Delete file permanently?', '¿Eliminar el archivo definitivamente?'),
      message: t(
        `"${attrs.name}" will be deleted from the cloud. This cannot be undone.`,
        `"${attrs.name}" se borrará de la nube. No se puede deshacer.`,
      ),
      confirmLabel: t('Delete', 'Eliminar'),
      danger: true,
    })
    if (!ok) return
  }
  if (!view.isDestroyed) {
    const found = findAttachment(view, attrs.id)
    if (found) view.dispatch(view.state.tr.delete(found.pos, found.pos + found.node.nodeSize).setMeta('addToHistory', false))
  }
  // Un error deja el aviso en el indicador de sincronización.
  await deleteAttachmentFile(attrs.path ?? '', noteId).catch(() => undefined)
}

function AttachmentView({ node, selected, editor }: ReactNodeViewProps) {
  const attrs = node.attrs as AttachmentAttrs
  const { id, url, name, mime, size, status } = attrs
  const [broken, setBroken] = useState(false)
  const fraction = useSyncExternalStore(subscribeProgress, () => progress.get(id) ?? 0)
  // Una subida interrumpida (p. ej. se recargó la página) se muestra como error.
  const active = status === 'uploading' && uploading.has(id)
  const failed = status === 'error' || (status === 'uploading' && !active)
  const src = status === 'done' && url ? url : previews.get(id)
  const showImage = mime.startsWith('image/') && Boolean(src) && !broken
  const Icon = fileIcon(mime, name)
  const state = failed ? 'error' : active ? 'uploading' : 'done'
  const title = failed
    ? `${name} — ${t('Upload failed', 'No se ha podido subir')}`
    : active
      ? `${name} — ${t('Uploading…', 'Subiendo…')}`
      : `${name} — ${t('Open in a new tab', 'Abrir en una pestaña nueva')}`

  const open = (event: MouseEvent) => {
    event.preventDefault()
    if (state === 'done' && canOpenUrl(url)) window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`attachment${showImage ? ' attachment-image' : ''}`}
      data-state={state}
      data-selected={selected}
    >
      <span className="attachment-chip" role="link" title={title} aria-label={title} onClick={open} data-drag-handle>
        {showImage ? (
          <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <Icon className="attachment-icon" size={20} aria-hidden />
        )}
        <span className="attachment-text">
          <span className="attachment-name">{name}</span>
          {failed ? (
            <span className="attachment-meta attachment-error">{t('Upload failed', 'Error al subir')}</span>
          ) : (
            !showImage && size > 0 && <span className="attachment-meta">{formatSize(size)}</span>
          )}
        </span>
        {active && (
          <span className="attachment-progress" aria-hidden>
            <span style={{ width: `${Math.max(4, Math.round(fraction * 100))}%` }} />
          </span>
        )}
      </span>
      {!active && editor.isEditable && (
        <button
          type="button"
          className="attachment-delete"
          aria-label={t('Delete file permanently', 'Eliminar archivo definitivamente')}
          title={t('Delete file permanently', 'Eliminar archivo definitivamente')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void deleteAttachment(editor.view, attrs)
          }}
        >
          <X size={13} strokeWidth={2.6} aria-hidden />
        </button>
      )}
    </NodeViewWrapper>
  )
}

// ---------- Inserción y subida ----------

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function findAttachment(view: EditorView, id: string) {
  let found: { node: ProseMirrorNode; pos: number } | null = null
  view.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'attachment' && node.attrs.id === id) found = { node, pos }
  })
  return found as { node: ProseMirrorNode; pos: number } | null
}

/** Actualiza los atributos de un adjunto en el editor abierto de la nota o, si está cerrada, en la nota guardada. */
function patchAttachment(noteId: string, id: string, attrs: Partial<AttachmentAttrs>) {
  const editor = liveEditors.get(noteId)
  if (editor && !editor.isDestroyed) {
    const { view } = editor
    const found = findAttachment(view, id)
    if (found) {
      const tr = view.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, ...attrs })
      view.dispatch(tr.setMeta('addToHistory', false))
    }
    return
  }
  const note = useApp.getState().notes[noteId]
  const doc = note ? parseContent(note.content) : null
  if (!doc) return
  let changed = false
  const walk = (node: JSONContent) => {
    if (node.type === 'attachment' && node.attrs?.id === id) {
      node.attrs = { ...node.attrs, ...attrs }
      changed = true
    }
    node.content?.forEach(walk)
  }
  walk(doc)
  if (changed) updateNote(noteId, { content: JSON.stringify(doc) })
}

function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = img.onerror = () => resolve()
    img.src = url
  })
}

async function upload(noteId: string, id: string, file: File) {
  try {
    const { url, path } = await uploadAttachment(noteId, file, (fraction) => setProgress(id, fraction))
    if (previews.has(id)) await preload(url)
    uploading.delete(id)
    patchAttachment(noteId, id, { url, path, status: 'done' })
  } catch {
    uploading.delete(id)
    patchAttachment(noteId, id, { status: 'error' })
  } finally {
    setProgress(id, null)
    const blob = previews.get(id)
    previews.delete(id)
    if (blob) URL.revokeObjectURL(blob)
  }
}

/**
 * Inserta los ficheros como adjuntos en `pos` (punto donde se soltaron) o en la selección,
 * y los sube a la nube.
 */
export function insertFiles(view: EditorView, noteId: string, files: File[], pos?: number) {
  const type = view.state.schema.nodes.attachment
  if (!type || files.length === 0) return
  const items = files.map((file) => {
    const id = newId()
    const mime = file.type
    uploading.add(id)
    if (mime.startsWith('image/')) previews.set(id, URL.createObjectURL(file))
    const attrs: AttachmentAttrs = { id, url: '', path: null, name: file.name, mime, size: file.size, status: 'uploading' }
    return { id, file, node: type.create(attrs) }
  })
  const slice = new Slice(Fragment.fromArray(items.map((i) => i.node)), 0, 0)
  const tr = view.state.tr
  if (pos === undefined) {
    tr.replaceSelection(slice)
  } else {
    const at = dropPoint(tr.doc, pos, slice) ?? pos
    tr.replace(at, at, slice)
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(at, 1))))
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
  items.forEach(({ id, file }) => void upload(noteId, id, file))
}
