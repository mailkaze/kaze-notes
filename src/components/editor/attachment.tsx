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
import { deleteUpload, getUpload, listUploads, saveUpload, type OutboxEntry } from '../../lib/outbox'
import {
  deleteAttachmentFile,
  isPermanentUploadError,
  markClean,
  markDirty,
  MAX_UPLOAD_BYTES,
  QUEUED_UPLOAD_KEY,
  updateNote,
  UPLOAD_KEY,
  uploadAttachment,
  useApp,
} from '../../state/store'
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

/** Marca el adjunto como en subida en esta pestaña (o lo desmarca) y avisa a su vista. */
function setUploading(id: string, active: boolean) {
  if (active) uploading.add(id)
  else uploading.delete(id)
  setProgress(id, active ? (progress.get(id) ?? 0) : null)
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

// Los mismos protocolos que el enlace de TipTap admite por defecto: nunca "javascript:" ni "data:".
const LINK_PROTOCOLS = ['https:', 'http:', 'ftp:', 'ftps:', 'mailto:', 'tel:', 'callto:', 'sms:', 'cid:', 'xmpp:']

/** Enlaces del texto que se pueden abrir: web, correo, teléfono… */
export function canOpenLink(url: string): boolean {
  try {
    return LINK_PROTOCOLS.includes(new URL(url).protocol)
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

/** true si `url` es la dirección de `path` en el almacenamiento de la app (o un fichero local de esta pestaña). */
function isOwnFileUrl(url: string, path: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'blob:') return parsed.origin === window.location.origin
    const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined
    return (
      Boolean(bucket) &&
      parsed.origin === 'https://firebasestorage.googleapis.com' &&
      decodeURIComponent(parsed.pathname) === `/v0/b/${bucket}/o/${path}`
    )
  } catch {
    return false
  }
}

/**
 * Fichero de un adjunto pegado o soltado como HTML. Solo se fía de los ficheros de la cuenta abierta:
 * un adjunto falso copiado de una web no carga imágenes remotas ni abre enlaces ajenos.
 */
function pastedFile(element: HTMLElement): Pick<AttachmentAttrs, 'url' | 'path' | 'status'> {
  const uid = useApp.getState().user?.uid
  const path = element.getAttribute('data-path')
  const url = element.getAttribute('data-url') ?? ''
  if (!uid || !path?.startsWith(`users/${uid}/`)) return { url: '', path: null, status: 'error' }
  if (!isOwnFileUrl(url, path)) return { url: '', path, status: 'error' }
  return { url, path, status: (element.getAttribute('data-status') as AttachmentStatus | null) || 'done' }
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
      url: { default: '', ...dataAttr('url'), parseHTML: (element: HTMLElement) => pastedFile(element).url },
      path: { default: null, ...dataAttr('path'), parseHTML: (element: HTMLElement) => pastedFile(element).path },
      name: { default: '', ...dataAttr('name') },
      mime: { default: '', ...dataAttr('mime') },
      size: { default: 0, ...dataAttr('size', (v) => Number(v) || 0) },
      status: { default: 'done', ...dataAttr('status'), parseHTML: (element: HTMLElement) => pastedFile(element).status },
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
  // Un fichero que esperaba en la cola de este dispositivo ya no se sube.
  if (attrs.status === 'uploading') void deleteUpload(attrs.id).then(() => forget(attrs.id))
  // Un error deja el aviso en el indicador de sincronización.
  await deleteAttachmentFile(attrs.path ?? '', noteId).catch(() => undefined)
}

function AttachmentView({ node, selected, editor }: ReactNodeViewProps) {
  const attrs = node.attrs as AttachmentAttrs
  const { id, url, name, mime, size, status } = attrs
  const [broken, setBroken] = useState(false)
  // -1 si esta pestaña no lo está subiendo.
  const fraction = useSyncExternalStore(subscribeProgress, () => (uploading.has(id) ? (progress.get(id) ?? 0) : -1))
  // El fichero espera en la cola de este dispositivo.
  const local = useApp(
    (s) => status === 'uploading' && s.sync.dirty.some((key) => key === `${UPLOAD_KEY}${id}` || key === `${QUEUED_UPLOAD_KEY}${id}`),
  )
  const active = status === 'uploading' && fraction >= 0
  const failed = status === 'error'
  const src = status === 'done' && url ? url : previews.get(id)
  const showImage = mime.startsWith('image/') && Boolean(src) && !broken
  const Icon = fileIcon(mime, name)
  // Sin copia aquí ni subida en curso: puede estar en la cola de otro dispositivo.
  const state = failed ? 'error' : active ? 'uploading' : status !== 'uploading' ? 'done' : local ? 'waiting' : 'pending'
  const notice = {
    error: t('Upload failed', 'Error al subir'),
    uploading: t('Uploading…', 'Subiendo…'),
    waiting: t('Waiting for connection', 'Esperando conexión'),
    pending: t('Pending upload', 'Pendiente de subir'),
    done: t('Open in a new tab', 'Abrir en una pestaña nueva'),
  }[state]
  const title = `${name} — ${state === 'error' ? t('Upload failed', 'No se ha podido subir') : notice}`

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
            <span className="attachment-meta attachment-error">{notice}</span>
          ) : state === 'waiting' || state === 'pending' ? (
            <span className="attachment-meta">{notice}</span>
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

/** Olvida el fichero local de un adjunto: ya subido, fallido o descartado. */
function forget(id: string) {
  markClean(`${UPLOAD_KEY}${id}`)
  markClean(`${QUEUED_UPLOAD_KEY}${id}`)
  const blob = previews.get(id)
  previews.delete(id)
  if (blob) URL.revokeObjectURL(blob)
}

/**
 * Sube el fichero y aplica el resultado al adjunto. `stored` es la escritura en la cola del dispositivo (null si
 * no está en ella): un fallo de red lo deja en la cola para reintentarlo; uno definitivo lo marca como fallido.
 */
async function upload(noteId: string, id: string, file: File, stored: Promise<unknown> | null) {
  setUploading(id, true)
  try {
    const { url, path } = await uploadAttachment(noteId, file, (fraction) => setProgress(id, fraction))
    if (previews.has(id)) await preload(url)
    patchAttachment(noteId, id, { url, path, status: 'done' })
  } catch (error) {
    if (stored && !isPermanentUploadError(error)) {
      if (useApp.getState().sync.online) retryLater()
      return
    }
    patchAttachment(noteId, id, { status: 'error' })
  } finally {
    setUploading(id, false)
  }
  // Se borra de la cola después de haberse guardado en ella.
  if (stored) await stored.then(() => deleteUpload(id))
  forget(id)
}

/** Ejecuta `fn` salvo que otra pestaña ya esté subiendo ese fichero. */
function exclusive(id: string, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return fn()
  return locks.request(`kaze-upload:${id}`, { ifAvailable: true }, (lock) => (lock ? fn() : undefined))
}

/** Guarda el fichero en la cola del dispositivo y lo sube si hay conexión. */
function queueUpload(noteId: string, id: string, file: File) {
  const uid = useApp.getState().user?.uid
  // Sin sesión o demasiado grande no se guarda: la subida falla al momento y lo marca como fallido.
  if (!uid || file.size >= MAX_UPLOAD_BYTES) {
    void upload(noteId, id, file, null)
    return
  }
  markDirty(`${UPLOAD_KEY}${id}`)
  const entry = { id, uid, noteId, blob: file, name: file.name, type: file.type, size: file.size, createdAt: Date.now() }
  const stored = saveUpload(entry).then((safe) => {
    // Ya a salvo en el dispositivo: salir de la página no lo pierde.
    if (safe && useApp.getState().sync.dirty.includes(`${UPLOAD_KEY}${id}`)) {
      markClean(`${UPLOAD_KEY}${id}`)
      markDirty(`${QUEUED_UPLOAD_KEY}${id}`)
    }
  })
  if (!useApp.getState().sync.online) return
  // Sin esperar a la cola: así empieza antes.
  setUploading(id, true)
  void exclusive(id, () => upload(noteId, id, file, stored)).finally(() => setUploading(id, false))
}

// ---------- Cola de subidas ----------

// Tras un fallo de red con conexión se reintenta pasado este tiempo.
const RETRY_MS = 30_000
let retryTimer: ReturnType<typeof setTimeout> | undefined
let running: Promise<void> | null = null
let runAgain = false

function retryLater() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    resumeUploads()
  }, RETRY_MS)
}

/** Estado guardado de un adjunto (en el editor abierto o en la nota). null si ya no está o la nota no existe. */
function attachmentStatus(noteId: string, id: string): AttachmentStatus | null {
  const editor = liveEditors.get(noteId)
  if (editor && !editor.isDestroyed) return (findAttachment(editor.view, id)?.node.attrs.status as AttachmentStatus) ?? null
  const note = useApp.getState().notes[noteId]
  const doc = note ? parseContent(note.content) : null
  let status: AttachmentStatus | null = null
  const walk = (node: JSONContent) => {
    if (node.type === 'attachment' && node.attrs?.id === id) status = node.attrs.status as AttachmentStatus
    node.content?.forEach(walk)
  }
  if (doc) walk(doc)
  return status
}

/** Recuerda un fichero de la cola: pendiente en la sincronización y con su vista previa. */
function remember(entry: OutboxEntry) {
  if (entry.type.startsWith('image/') && !previews.has(entry.id)) previews.set(entry.id, URL.createObjectURL(entry.blob))
  if (!useApp.getState().sync.dirty.includes(`${UPLOAD_KEY}${entry.id}`)) markDirty(`${QUEUED_UPLOAD_KEY}${entry.id}`)
}

async function sendQueued(entry: OutboxEntry) {
  // Otra pestaña puede haberlo subido ya, y el adjunto puede ya no estar en su nota (o la nota no existir).
  const current = await getUpload(entry.id)
  const status = attachmentStatus(entry.noteId, entry.id)
  // Con datos aún sin confirmar por el servidor, que falte la nota no basta para descartar el fichero.
  if (current && status === null && useApp.getState().sync.fromCache) {
    retryLater()
    return
  }
  if (!current || status !== 'uploading') {
    await deleteUpload(entry.id)
    forget(entry.id)
    return
  }
  // `File` aquí es el icono: se usa el constructor global.
  const file = new globalThis.File([current.blob], current.name, { type: current.type })
  await upload(current.noteId, current.id, file, Promise.resolve())
}

async function runQueue() {
  const uid = useApp.getState().user?.uid
  if (!uid) return
  const entries = await listUploads(uid)
  // También sin conexión: así se ven como pendientes, con su vista previa.
  entries.forEach(remember)
  const canUpload = () => {
    const { user, dataReady, sync } = useApp.getState()
    return user?.uid === uid && dataReady && sync.online
  }
  if (!canUpload()) return
  // De uno en uno; los que esperan turno ya se muestran subiendo.
  const turn = entries.filter((entry) => !uploading.has(entry.id))
  turn.forEach((entry) => setUploading(entry.id, true))
  for (const entry of turn) {
    try {
      if (canUpload()) await exclusive(entry.id, () => sendQueued(entry))
    } finally {
      setUploading(entry.id, false)
    }
  }
}

/** Sube los ficheros en cola de este dispositivo para el usuario actual. Nunca hay dos pasadas a la vez. */
export function resumeUploads() {
  if (running) {
    runAgain = true
    return
  }
  running = runQueue()
    .catch(() => undefined)
    .finally(() => {
      running = null
      if (runAgain) {
        runAgain = false
        resumeUploads()
      }
    })
}

/**
 * Inserta los ficheros como adjuntos en `pos` (punto donde se soltaron) o en la selección,
 * los guarda en la cola del dispositivo y los sube a la nube.
 */
export function insertFiles(view: EditorView, noteId: string, files: File[], pos?: number) {
  const type = view.state.schema.nodes.attachment
  if (!type || files.length === 0) return
  const items = files.map((file) => {
    const id = newId()
    const mime = file.type
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
  items.forEach(({ id, file }) => queueUpload(noteId, id, file))
}
