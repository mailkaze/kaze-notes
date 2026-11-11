import type { JSONContent } from '@tiptap/react'
import { create } from 'zustand'
import { backend } from '../lib/backend'
import type { SnapshotMeta, UploadResult, WriteOp } from '../lib/backend'
import { verifyDeviceUser } from '../lib/deviceAuth'
import { hasContent, parseContent, previewFromDoc } from '../lib/docText'
import { t } from '../lib/i18n'
import { keyBetween } from '../lib/order'
import { deleteUpload, listUploads, pendingUploadCount } from '../lib/outbox'
import { isShared, isValidEmail, normalizeEmail, sharedWrite, type Invite } from '../lib/sharing'
import { activeNotes, childFolders, descendantFolderIds, isInsideFolder, trashedNotes } from '../lib/tree'
import type { AppUser, Folder, LayoutMode, Note, NoteColorId, ThemePref, View } from '../lib/types'
import { clearCachedFiles } from '../pwa/registerServiceWorker'

export interface SyncState {
  online: boolean
  /** Escrituras locales pendientes de confirmar por el servidor (metadatos de los snapshots). */
  serverPending: boolean
  /** Los datos actuales vienen de caché (todavía no confirmados con el servidor). */
  fromCache: boolean
  /** Cambios aún no enviados: ediciones con debounce, subidas de ficheros… */
  dirty: string[]
  /** Error que se muestra. Los transitorios se borran con la siguiente escritura correcta. */
  error: string | null
  /** La escucha de datos ha fallado (persiste hasta que vuelva a llegar un snapshot). */
  listenerError: string | null
  /** Notas que no se han guardado por superar el tamaño máximo (persiste hasta que quepan). */
  tooLarge: string[]
  /** Notas con texto que la nube rechazó, guardado en el dispositivo (id → número de la escritura rechazada). */
  rejected: Record<string, number>
}

export interface AppState {
  authReady: boolean
  user: AppUser | null
  dataReady: boolean
  notes: Record<string, Note>
  folders: Record<string, Folder>
  view: View
  /** Carpeta a la que se vuelve al cerrar una nota. */
  lastFolderId: string | null
  layout: LayoutMode
  fullscreen: boolean
  /** Cajón lateral abierto (pantallas estrechas). */
  sidebarOpen: boolean
  /** Barra lateral oculta (pantallas anchas). */
  sidebarCollapsed: boolean
  sidebarWidth: number
  theme: ThemePref
  search: string
  /** Nota protegida desbloqueada mientras está abierta (se vuelve a bloquear al salir de ella). */
  unlockedNoteId: string | null
  /** Invitaciones pendientes a notas de otros usuarios. */
  invites: Invite[]
  sync: SyncState
}

// ---------- Preferencias locales ----------

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`kaze:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`kaze:${key}`, JSON.stringify(value))
  } catch {
    // Sin almacenamiento: la preferencia solo dura esta sesión.
  }
}

function readTheme(): ThemePref {
  try {
    const raw = localStorage.getItem('kaze:theme')
    return raw === 'light' || raw === 'dark' ? raw : 'system'
  } catch {
    return 'system'
  }
}

export const useApp = create<AppState>(() => ({
  authReady: false,
  user: null,
  dataReady: false,
  notes: {},
  folders: {},
  view: { kind: 'notes', folderId: null },
  lastFolderId: null,
  layout: readPref<LayoutMode>('layout', 'grid'),
  fullscreen: false,
  sidebarOpen: false,
  sidebarCollapsed: readPref('sidebarCollapsed', false),
  sidebarWidth: readPref('sidebarWidth', 290),
  theme: readTheme(),
  search: '',
  unlockedNoteId: null,
  invites: [],
  sync: {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    serverPending: false,
    fromCache: false,
    dirty: [],
    error: null,
    listenerError: null,
    tooLarge: [],
    rejected: {},
  },
}))

const get = useApp.getState
const set = useApp.setState

function setSync(patch: Partial<SyncState>) {
  set((s) => ({ sync: { ...s.sync, ...patch } }))
}

const tooLargeMessage = () =>
  t('This note is too large to save (max 1 MB)', 'La nota es demasiado grande para guardarse (máx. 1 MB)')

const rejectedMessage = () =>
  t(
    'The cloud did not accept some changes; they are kept on this device',
    'La nube no ha aceptado algunos cambios; se conservan en este dispositivo',
  )

type LastingErrors = Pick<SyncState, 'listenerError' | 'tooLarge' | 'rejected'>

/** Error que sigue visible aunque otras escrituras salgan bien. */
function lastingError(sync: LastingErrors): string | null {
  if (sync.listenerError) return sync.listenerError
  if (sync.tooLarge.length > 0) return tooLargeMessage()
  return Object.keys(sync.rejected).length > 0 ? rejectedMessage() : null
}

/** Cambia los errores persistentes: se muestra el nuevo, salvo que haya otro error transitorio a la vista. */
function setLasting(patch: Partial<LastingErrors>) {
  const { sync } = get()
  const was = lastingError(sync)
  const now = lastingError({ ...sync, ...patch })
  const error = now !== was && (now !== null || sync.error === was) ? now : sync.error
  setSync({ ...patch, error })
}

/** Tras una escritura correcta solo queda a la vista el error persistente, si lo hay. */
function clearTransientError() {
  const { sync } = get()
  const error = lastingError(sync)
  if (sync.error !== error) setSync({ error })
}

// ---------- Estado de sincronización ----------

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error'

export function selectSyncStatus(s: AppState): SyncStatus {
  if (s.sync.error || lastingError(s.sync)) return 'error'
  if (!s.sync.online) return 'offline'
  if (s.sync.dirty.length > 0 || s.sync.serverPending || s.sync.fromCache) return 'syncing'
  return 'synced'
}

/** Marca un cambio local aún no enviado (p. ej. `note:<id>` mientras dura el debounce). */
export function markDirty(key: string) {
  const { dirty } = get().sync
  if (!dirty.includes(key)) setSync({ dirty: [...dirty, key] })
}

export function markClean(key: string) {
  const { dirty } = get().sync
  if (dirty.includes(key)) setSync({ dirty: dirty.filter((k) => k !== key) })
}

const flushers = new Set<() => void>()

/** Registra una función que envía cambios pendientes (el editor la usa para su debounce). */
export function registerFlush(fn: () => void): () => void {
  flushers.add(fn)
  return () => flushers.delete(fn)
}

export function flushAll() {
  flushers.forEach((fn) => fn())
}

// ---------- Escrituras ----------

/** Identifica esta carga de la página en los guardados de texto: lo escrito aquí nunca se toma por un conflicto. */
const deviceId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')

function applyLocal(ops: WriteOp[]) {
  set((s) => {
    const notes = { ...s.notes }
    const folders = { ...s.folders }
    for (const op of ops) {
      if (op.type === 'setNote') notes[op.id] = { ...notes[op.id], ...op.data, id: op.id } as Note
      else if (op.type === 'deleteNote') delete notes[op.id]
      else if (op.type === 'setFolder') folders[op.id] = { ...folders[op.id], ...op.data, id: op.id } as Folder
      else delete folders[op.id]
    }
    return { notes, folders }
  })
}

/** Un cambio parcial de algo que ya no existe (borrado en otro dispositivo) crearía un registro incompleto. */
function isStale(op: WriteOp): boolean {
  if (op.type !== 'setNote' && op.type !== 'setFolder') return false
  // Las creaciones llevan el registro completo.
  if ('createdAt' in op.data) return false
  const { notes, folders } = get()
  return op.type === 'setNote' ? !notes[op.id] : !folders[op.id]
}

/** Dueño de una nota compartida conmigo (undefined si es mía). */
const foreignOwner = (id: string) => get().notes[id]?.ownerUid

/**
 * Cambio tal y como se envía: el de una nota compartida conmigo va a la nota de su dueño, con lo personal en mis
 * preferencias y sin lo que no puedo cambiar.
 */
function toSend(op: WriteOp, email: string): WriteOp {
  if (op.type !== 'setNote') return op
  const owner = foreignOwner(op.id)
  return owner ? { type: 'setSharedNote', owner, id: op.id, data: sharedWrite(op.data, email) } : op
}

/** Aplica los cambios en local al instante (optimista) y los envía a la nube. */
function commit(allOps: WriteOp[]) {
  const user = get().user
  // Una nota compartida conmigo solo la borra su dueño.
  const ops = allOps.filter((op) => !isStale(op) && !(op.type === 'deleteNote' && foreignOwner(op.id)))
  if (!user || !backend || ops.length === 0) return
  // Se calcula antes de aplicar en local: el dueño de cada nota sale del estado actual.
  const send = ops.map((op) => toSend(op, user.email ?? ''))
  applyLocal(ops)
  const seq = ++writeSeq
  backend.write(user.uid, send).then(
    () => {
      clearTransientError()
      settleRejected(user.uid, ops, seq, null)
    },
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      setSync({ error: reason })
      settleRejected(user.uid, ops, seq, reason)
    },
  )
}

// ---------- Texto rechazado por la nube ----------
// Firestore deshace en su caché una escritura que el servidor rechaza (p. ej. sin permiso), también una hecha sin
// conexión que se envía más tarde. Lo escrito se guarda en el dispositivo, vuelve al editor y se reenvía con la
// siguiente edición de la nota.

const REJECTED_PREFIX = 'kaze:rejected:'

export interface RejectedVersion {
  title?: string
  content?: string
  reason: string
  /** Carga de la página y número de la escritura rechazada: solo la deja sin efecto un guardado posterior. */
  page: string
  seq: number
}

let writeSeq = 0
// Por si el almacenamiento local no está disponible o está lleno.
const rejectedInMemory = new Map<string, RejectedVersion>()

const rejectedKey = (uid: string, id: string) => `${REJECTED_PREFIX}${uid}:${id}`

function readRejected(uid: string, id: string): RejectedVersion | null {
  const key = rejectedKey(uid, id)
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as RejectedVersion
  } catch {
    // Ilegible o sin almacenamiento: vale la copia en memoria.
  }
  return rejectedInMemory.get(key) ?? null
}

function writeRejected(uid: string, id: string, version: RejectedVersion | null) {
  const key = rejectedKey(uid, id)
  rejectedInMemory.delete(key)
  try {
    if (version) localStorage.setItem(key, JSON.stringify(version))
    else localStorage.removeItem(key)
  } catch {
    if (version) rejectedInMemory.set(key, version)
  }
  if (get().user?.uid !== uid) return
  const { [id]: _, ...rest } = get().sync.rejected
  setLasting({ rejected: version ? { ...rest, [id]: version.seq } : rest })
}

/** Notas de `uid` con texto rechazado guardado en el dispositivo. */
function storedRejected(uid: string): Record<string, number> {
  const prefix = rejectedKey(uid, '')
  const keys = new Set(rejectedInMemory.keys())
  try {
    for (let i = 0; i < localStorage.length; i++) keys.add(localStorage.key(i) ?? '')
  } catch {
    // Sin almacenamiento local.
  }
  const found: Record<string, number> = {}
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const id = key.slice(prefix.length)
    const version = readRejected(uid, id)
    if (version) found[id] = version.seq
  }
  return found
}

/** Texto que guarda una escritura de una nota que ya existía (lo único que se conserva si se rechaza). */
function textOf(op: WriteOp): Pick<RejectedVersion, 'title' | 'content'> | null {
  if (op.type !== 'setNote' || 'createdAt' in op.data) return null
  const { title, content } = op.data
  if (title === undefined && content === undefined) return null
  return { ...(title !== undefined && { title }), ...(content !== undefined && { content }) }
}

/** Tras una escritura: conserva el texto rechazado o, si salió bien, olvida lo rechazado antes. */
function settleRejected(uid: string, ops: WriteOp[], seq: number, reason: string | null) {
  // Un rechazo que llega mientras se cierra la sesión no vuelve a dejar en el dispositivo lo que se está borrando.
  if (signingOut || get().user?.uid !== uid) return
  for (const op of ops) {
    const text = textOf(op)
    if (!text) continue
    const old = readRejected(uid, op.id)
    if (reason !== null) writeRejected(uid, op.id, { ...old, ...text, reason, page: deviceId, seq })
    // Un guardado anterior al rechazado puede confirmarse después: ese no lo deja sin efecto.
    else if (old && (old.page !== deviceId || old.seq < seq)) writeRejected(uid, op.id, null)
  }
}

/** Texto de la nota que la nube rechazó y se conserva en este dispositivo (null si no hay). */
export function rejectedVersion(id: string): RejectedVersion | null {
  const uid = get().user?.uid
  return uid ? readRejected(uid, id) : null
}

/** Descarta el texto rechazado de una nota: vuelve a valer la versión de la nube. */
export function discardRejected(id: string) {
  const uid = get().user?.uid
  if (uid) writeRejected(uid, id, null)
}

// ---------- Suscripción a datos ----------

function sameNote(a: Note, b: Note) {
  return (
    a.updatedAt === b.updatedAt &&
    a.order === b.order &&
    a.folderId === b.folderId &&
    a.pinned === b.pinned &&
    a.locked === b.locked &&
    a.color === b.color &&
    a.trashed === b.trashed &&
    a.title === b.title &&
    a.content === b.content &&
    a.rev === b.rev &&
    a.ownerUid === b.ownerUid &&
    a.ownerEmail === b.ownerEmail &&
    String(a.members) === String(b.members) &&
    String(a.invited) === String(b.invited)
  )
}

/** Resumen corto (FNV-1a de 32 bits) para distinguir versiones en ids deterministas. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Otro dispositivo que editó partiendo de una revisión anterior (p. ej. sin conexión) ha sustituido la versión
 * que había aquí: se guarda como copia de conflicto junto a la nota. El id sale de la versión sustituida, así
 * que todos los dispositivos que la vieron escriben la misma copia.
 */
function keepOverwritten(prev: Record<string, Note>, list: Note[]) {
  for (const note of list) {
    const old = prev[note.id]
    if (!old || !note.device || note.device === deviceId || note.baseRev === undefined) continue
    // La nube deshizo un cambio rechazado de aquí: no es otra versión, y lo escrito ya se conserva aparte.
    if (get().sync.rejected[note.id] !== undefined) continue
    // El mismo dispositivo sustituye su propia versión (o la marca no cambió: versión antigua de la app o
    // cambio solo de metadatos).
    if (note.device === old.device) continue
    if (note.baseRev >= (old.rev ?? 0)) continue
    if (note.title === old.title && note.content === old.content) continue
    // También con cambios sin guardar en el editor: su `flush` solo conserva los campos editados aquí.
    createConflictCopy(note.id, old, `${note.id}-conflict-${old.rev ?? 0}-${shortHash(`${old.title}\n${old.content}`)}`)
  }
}

function sameFolder(a: Folder, b: Folder) {
  return a.name === b.name && a.parentId === b.parentId && a.order === b.order && a.updatedAt === b.updatedAt
}

/** Reutiliza los objetos que no cambian (y el registro entero si nada cambia) para evitar renders innecesarios. */
function mergeRecord<T extends { id: string }>(prev: Record<string, T>, list: T[], same: (a: T, b: T) => boolean) {
  const next: Record<string, T> = {}
  let changed = list.length !== Object.keys(prev).length
  for (const item of list) {
    const old = prev[item.id]
    const reused = old !== undefined && same(old, item)
    next[item.id] = reused ? old : item
    if (!reused) changed = true
  }
  return changed ? next : prev
}

// Tras un error de la escucha de datos se vuelve a escuchar pasado este tiempo.
const RESUBSCRIBE_MS = 10_000

// Tiempo oculta tras el que una nota protegida desbloqueada se vuelve a bloquear.
const RELOCK_AFTER_HIDDEN_MS = 60_000

let unsubscribeData: (() => void) | null = null
let resubscribeTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeShared: (() => void) | null = null
let resubscribeSharedTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false

// Últimas listas recibidas: mis notas y las de otros compartidas conmigo (se muestran juntas).
let ownNotes: Note[] = []
let sharedNotes: Note[] = []

function refreshNotes() {
  const prev = get().notes
  const mine = new Set(ownNotes.map((n) => n.id))
  const list = [...ownNotes, ...sharedNotes.filter((n) => !mine.has(n.id))]
  set((s) => ({ notes: mergeRecord(s.notes, list, sameNote) }))
  keepOverwritten(prev, list)
}

const sameInvites = (a: Invite[], b: Invite[]) => JSON.stringify(a) === JSON.stringify(b)

export function initApp() {
  if (initialized) return
  initialized = true

  window.addEventListener('online', () => {
    setSync({ online: true })
    resumeQueuedUploads()
  })
  window.addEventListener('offline', () => setSync({ online: false }))
  window.addEventListener('pagehide', flushAll)
  // Al cerrar la pestaña solo se pregunta si hay un fichero que aún no está a salvo en el dispositivo: el texto
  // pendiente se guarda ya y los ficheros en cola se suben al volver.
  window.addEventListener('beforeunload', (event) => {
    flushAll()
    if (!get().sync.dirty.some((key) => key.startsWith(UPLOAD_KEY))) return
    event.preventDefault()
    // Para navegadores que aún no atienden a preventDefault aquí.
    event.returnValue = true
  })
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      flushAll()
      return
    }
    // Tras un rato fuera (otra app, la pantalla bloqueada) la nota protegida se vuelve a bloquear;
    // no tras una ausencia corta, como el selector de ficheros o la cámara al adjuntar.
    if (hiddenAt && Date.now() - hiddenAt >= RELOCK_AFTER_HIDDEN_MS) set({ unlockedNoteId: null })
    hiddenAt = 0
  })

  if (!backend) {
    set({ authReady: true })
    return
  }
  const api = backend
  api.onAuthChange((user) => {
    unsubscribeData?.()
    unsubscribeData = null
    clearTimeout(resubscribeTimer)
    resubscribeTimer = undefined
    unsubscribeShared?.()
    unsubscribeShared = null
    clearTimeout(resubscribeSharedTimer)
    resubscribeSharedTimer = undefined
    ownNotes = []
    sharedNotes = []
    // Los errores eran de la sesión anterior o del inicio de sesión que ahora sí ha funcionado.
    set((s) => ({
      user,
      authReady: true,
      dataReady: false,
      notes: {},
      folders: {},
      unlockedNoteId: null,
      invites: [],
      sync: (() => {
        const rejected = user ? storedRejected(user.uid) : {}
        const error = Object.keys(rejected).length > 0 ? rejectedMessage() : null
        return { ...s.sync, error, listenerError: null, tooLarge: [], rejected }
      })(),
    }))
    if (!user) return

    let notesMeta: SnapshotMeta | null = null
    let foldersMeta: SnapshotMeta | null = null
    let sharedMeta: SnapshotMeta | null = null
    const updateMeta = () => {
      setSync({
        serverPending: Boolean(notesMeta?.pendingWrites || foldersMeta?.pendingWrites || sharedMeta?.pendingWrites),
        fromCache: Boolean(notesMeta?.fromCache || foldersMeta?.fromCache || sharedMeta?.fromCache),
      })
      if (notesMeta && foldersMeta && !get().dataReady) {
        set({ dataReady: true })
        resumeQueuedUploads()
      }
    }
    const received = () => {
      if (get().sync.listenerError) setLasting({ listenerError: null })
    }
    const subscribe = () => {
      unsubscribeData = api.subscribe(user.uid, {
        notes: (list, meta) => {
          notesMeta = meta
          received()
          ownNotes = list
          refreshNotes()
          updateMeta()
        },
        folders: (list, meta) => {
          foldersMeta = meta
          received()
          set((s) => ({ folders: mergeRecord(s.folders, list, sameFolder) }))
          updateMeta()
        },
        error: (error) => {
          setLasting({ listenerError: error.message })
          if (resubscribeTimer) return
          unsubscribeData?.()
          unsubscribeData = null
          resubscribeTimer = setTimeout(() => {
            resubscribeTimer = undefined
            subscribe()
          }, RESUBSCRIBE_MS)
        },
      })
    }
    subscribe()

    // Notas compartidas conmigo e invitaciones: con su propia escucha, para que un fallo aquí (p. ej. un índice que
    // aún se está creando) no corte la de mis datos.
    const email = user.email
    const subscribeShared = () => {
      if (!email) return
      unsubscribeShared = api.subscribeShared(user.uid, email, {
        notes: (list, meta) => {
          sharedMeta = meta
          // La que su dueño manda a la papelera deja de verse.
          sharedNotes = list.filter((n) => !n.trashed)
          refreshNotes()
          updateMeta()
        },
        invites: (list) => {
          if (!sameInvites(get().invites, list)) set({ invites: list })
        },
        error: (error) => {
          setSync({ error: error.message })
          if (resubscribeSharedTimer) return
          unsubscribeShared?.()
          unsubscribeShared = null
          resubscribeSharedTimer = setTimeout(() => {
            resubscribeSharedTimer = undefined
            subscribeShared()
          }, RESUBSCRIBE_MS)
        },
      })
    }
    subscribeShared()
  })
}

// ---------- Sesión ----------

export async function signIn() {
  if (!backend) return
  try {
    await backend.signIn()
  } catch (error) {
    setSync({ error: error instanceof Error ? error.message : String(error) })
  }
}

// Tiempo máximo que se espera a que la nube confirme lo pendiente antes de cerrar sesión.
const SIGN_OUT_WAIT_MS = 5000

/**
 * Envía lo pendiente y espera un poco a la nube. true si aún queda algo sin sincronizar en este dispositivo
 * (escrituras sin confirmar, ficheros en cola o texto rechazado): cerrar sesión lo borraría.
 */
export async function hasUnsyncedChanges(): Promise<boolean> {
  flushAll()
  const { user } = get()
  if (!user || !backend) return false
  const synced = await backend.waitForSync(SIGN_OUT_WAIT_MS)
  const queued = await pendingUploadCount(user.uid).catch(() => 0)
  const { sync } = get()
  // Lo rechazado puede estar guardado por otra pestaña, o solo en la memoria de esta si no cupo en el dispositivo.
  const rejected = Object.keys({ ...storedRejected(user.uid), ...sync.rejected }).length
  // Una nota demasiado grande tiene en el editor cambios que nunca se guardaron.
  const notSaved = sync.tooLarge.length + sync.dirty.filter((key) => key.startsWith(UPLOAD_KEY)).length
  return !synced || queued > 0 || rejected > 0 || notSaved > 0
}

// Cerrando la sesión: lo que llegue de escrituras anteriores ya no se guarda en el dispositivo.
let signingOut = false

/** Cierra la sesión y borra de este dispositivo los datos de la cuenta; las preferencias de la interfaz se quedan. */
export async function signOut() {
  flushAll()
  signingOut = true
  const { user } = get()
  if (user) {
    const uploads = await listUploads(user.uid).catch(() => [])
    await Promise.all(uploads.map((entry) => deleteUpload(entry.id).catch(() => undefined)))
    for (const id of Object.keys(storedRejected(user.uid))) writeRejected(user.uid, id, null)
    await clearCachedFiles().catch(() => undefined)
    try {
      localStorage.removeItem('kaze:expandedFolders')
    } catch {
      // Sin almacenamiento local.
    }
  }
  try {
    await backend?.signOut()
  } finally {
    // Sin sesión, lo que llegue después ya se descarta por no ser del usuario actual.
    signingOut = false
  }
}

// ---------- Navegación ----------

/** Al salir de una nota: envía lo pendiente y descarta la nota si quedó vacía. */
function leaveCurrentNote() {
  const { view } = get()
  if (view.kind !== 'note') return
  flushAll()
  set({ unlockedNoteId: null })
  const { notes, sync } = get()
  const note = notes[view.noteId]
  // Una nota cuyo guardado se rechazó por grande no está vacía aunque lo parezca aquí.
  const refused = sync.tooLarge.includes(view.noteId)
  // Una nota compartida no se descarta: puede que la otra persona la esté usando.
  const empty = note && !note.title.trim() && !hasContent(parseContent(note.content))
  if (note && empty && !note.trashed && !refused && !note.ownerUid && !isShared(note)) {
    // También se borran los ficheros que subió y ya no usa (p. ej. un adjunto quitado con retroceso).
    deleteNoteForever(note.id)
  }
}

export function openNote(noteId: string) {
  if (get().view.kind === 'note' && (get().view as { noteId: string }).noteId === noteId) return
  leaveCurrentNote()
  set({ view: { kind: 'note', noteId }, sidebarOpen: false })
}

export function closeNote() {
  leaveCurrentNote()
  set((s) => ({ view: { kind: 'notes', folderId: s.lastFolderId }, fullscreen: false }))
}

export function openFolder(folderId: string | null) {
  leaveCurrentNote()
  set({ view: { kind: 'notes', folderId }, lastFolderId: folderId, sidebarOpen: false, fullscreen: false, search: '' })
}

export function openTrash() {
  leaveCurrentNote()
  set({ view: { kind: 'trash' }, sidebarOpen: false, fullscreen: false, search: '' })
}

// ---------- Preferencias de interfaz ----------

export function setLayout(layout: LayoutMode) {
  writePref('layout', layout)
  set({ layout })
}

export function setFullscreen(fullscreen: boolean) {
  set({ fullscreen })
}

export function toggleFullscreen() {
  set((s) => ({ fullscreen: !s.fullscreen }))
}

export function setSidebarOpen(sidebarOpen: boolean) {
  set({ sidebarOpen })
}

export function setSidebarCollapsed(sidebarCollapsed: boolean) {
  writePref('sidebarCollapsed', sidebarCollapsed)
  set({ sidebarCollapsed })
}

export function setSidebarWidth(width: number) {
  const sidebarWidth = Math.round(Math.max(220, Math.min(480, width)))
  writePref('sidebarWidth', sidebarWidth)
  set({ sidebarWidth })
}

export function setTheme(theme: ThemePref) {
  try {
    localStorage.setItem('kaze:theme', theme)
  } catch {
    // Ignorado.
  }
  set({ theme })
}

export function setSearch(search: string) {
  set({ search })
}

// ---------- Notas ----------

/** Crea una nota al principio del orden global y la abre. Devuelve su id. */
export function createNote(folderId: string | null = get().lastFolderId, open = true): string {
  if (!backend) return ''
  const id = backend.newId()
  const first = activeNotes(get().notes)[0]
  const now = Date.now()
  commit([
    {
      type: 'setNote',
      id,
      data: {
        title: '',
        content: '',
        preview: '',
        folderId: folderId && get().folders[folderId] ? folderId : null,
        order: keyBetween(null, first?.order),
        pinned: false,
        locked: false,
        color: null,
        trashed: false,
        trashedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    },
  ])
  if (open) openNote(id)
  return id
}

// Firestore admite documentos de hasta 1 MiB: se deja margen para el resto de campos.
const MAX_NOTE_BYTES = 900 * 1024

function tooLargeToSave(content: string): boolean {
  // Cada unidad UTF-16 ocupa como mucho 3 bytes en UTF-8: solo se mide si puede pasarse.
  return content.length * 3 > MAX_NOTE_BYTES && new TextEncoder().encode(content).length > MAX_NOTE_BYTES
}

/** Guarda cambios de una nota. Devuelve false si no se ha guardado (no existe o es demasiado grande). */
export function updateNote(id: string, patch: Partial<Pick<Note, 'title' | 'content' | 'preview'>>): boolean {
  const note = get().notes[id]
  if (!note) return false
  if (patch.content !== undefined) {
    const tooLarge = tooLargeToSave(patch.content)
    const list = get().sync.tooLarge
    if (tooLarge !== list.includes(id)) setLasting({ tooLarge: tooLarge ? [...list, id] : list.filter((n) => n !== id) })
    if (tooLarge) return false
  }
  // La revisión de la que parte permite a los demás dispositivos ver si este guardado pisa uno que no conocía.
  // Es la última versión vista de otro dispositivo, igual en todos los guardados seguidos de esta página
  // (también sin conexión): así no importa cuántas veces se guardó en cada lado.
  const baseRev = note.device === deviceId ? (note.baseRev ?? 0) : (note.rev ?? 0)
  const rev = (note.rev ?? 0) + 1
  commit([{ type: 'setNote', id, data: { ...patch, baseRev, rev, device: deviceId, updatedAt: Date.now() } }])
  return true
}

/**
 * Guarda como nota nueva otra versión de `id` (p. ej. la llegada de otro dispositivo mientras se editaba aquí),
 * justo después de la original en el orden global, sin abrirla ni fijarla. Devuelve su id.
 * Con `copyId` no se reescribe una copia que ya existe (otro dispositivo la guardó y quizá ya se ha editado).
 */
export function createConflictCopy(id: string, version: Pick<Note, 'title' | 'content'>, copyId?: string): string {
  const note = get().notes[id]
  if (!note || !backend) return ''
  if (copyId && get().notes[copyId]) return copyId
  copyId ??= backend.newId()
  const list = activeNotes(get().notes)
  const next = list[list.findIndex((n) => n.id === id) + 1]
  const base = version.title.trim()
  const now = Date.now()
  commit([
    {
      type: 'setNote',
      id: copyId,
      data: {
        title: base ? t(`${base} (conflict)`, `${base} (conflicto)`) : t('(conflict)', '(conflicto)'),
        content: version.content,
        preview: previewFromDoc(parseContent(version.content)),
        folderId: note.folderId,
        order: keyBetween(note.order, next?.order),
        pinned: false,
        // La copia de una nota protegida también lo está.
        locked: Boolean(note.locked),
        color: note.color,
        trashed: false,
        trashedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    },
  ])
  return copyId
}

/** Cambia el orden global de una nota (la clave se calcula con `keyForIndex`/`keyBetween`). */
export function setNoteOrder(id: string, order: string) {
  commit([{ type: 'setNote', id, data: { order } }])
}

/** Mueve una nota a otra carpeta (null = raíz) y, opcionalmente, a otra posición. */
export function moveNote(id: string, folderId: string | null, order?: string) {
  commit([{ type: 'setNote', id, data: order ? { folderId, order } : { folderId } }])
}

export function setPinned(id: string, pinned: boolean) {
  commit([{ type: 'setNote', id, data: { pinned } }])
}

export function setColor(id: string, color: NoteColorId | null) {
  commit([{ type: 'setNote', id, data: { color } }])
}

const isViewing = (id: string) => {
  const { view } = get()
  return view.kind === 'note' && view.noteId === id
}

/** Desbloquea una nota protegida mientras siga abierta. Lanza DeviceAuthError si no se verifica al usuario. */
export async function unlockNote(id: string, options: { reregister?: boolean } = {}) {
  const { user } = get()
  if (!user) return
  await verifyDeviceUser(user, options)
  // Si se ha salido de la nota durante la verificación, sigue bloqueada.
  if (isViewing(id)) set({ unlockedNoteId: id })
}

/**
 * Protege una nota. Antes se verifica al usuario (y se registra el dispositivo si hace falta) para no bloquear
 * una nota que luego no se pueda abrir aquí. Lanza DeviceAuthError si no se verifica.
 */
export async function lockNote(id: string) {
  const { user } = get()
  if (!user) return
  await verifyDeviceUser(user)
  commit([{ type: 'setNote', id, data: { locked: true } }])
  if (isViewing(id)) set({ unlockedNoteId: id })
}

/** Quita la protección. Solo se ofrece con la nota abierta, es decir, ya desbloqueada. */
export function removeNoteLock(id: string) {
  commit([{ type: 'setNote', id, data: { locked: false } }])
}

/** Si la nota está abierta, envía lo pendiente y vuelve a la lista. */
function leaveIfViewing(id: string) {
  if (!isViewing(id)) return
  flushAll()
  set((s) => ({ view: { kind: 'notes', folderId: s.lastFolderId }, fullscreen: false, unlockedNoteId: null }))
}

export function trashNote(id: string) {
  // Una nota compartida conmigo no va a mi papelera: se deja de compartir.
  if (foreignOwner(id)) return
  leaveIfViewing(id)
  commit([{ type: 'setNote', id, data: { trashed: true, trashedAt: Date.now() } }])
}

export function restoreNote(id: string) {
  const note = get().notes[id]
  if (!note) return
  const folderId = note.folderId && get().folders[note.folderId] ? note.folderId : null
  commit([{ type: 'setNote', id, data: { trashed: false, trashedAt: null, folderId } }])
}

/** Rutas de Storage de los adjuntos de una nota (añadidas a `into`). */
function notePaths(note: Note | undefined, into = new Set<string>()): Set<string> {
  // Sin adjuntos no hace falta analizar el documento.
  if (!note?.content.includes('"attachment"')) return into
  const walk = (node: JSONContent) => {
    const path = node.type === 'attachment' ? node.attrs?.path : null
    if (typeof path === 'string' && path) into.add(path)
    node.content?.forEach(walk)
  }
  const doc = parseContent(note.content)
  if (doc) walk(doc)
  return into
}

/** Rutas de Storage que usan los adjuntos de todas las notas (papelera incluida), salvo la indicada. */
export function referencedPaths(excludeNoteId?: string): Set<string> {
  const paths = new Set<string>()
  for (const note of Object.values(get().notes)) if (note.id !== excludeNoteId) notePaths(note, paths)
  return paths
}

/** Olvida el error de tamaño de notas que ya no existen. */
function forgetTooLarge(ids: string[]) {
  const list = get().sync.tooLarge
  if (ids.some((id) => list.includes(id))) setLasting({ tooLarge: list.filter((id) => !ids.includes(id)) })
}

/** Borra la nota y sus ficheros, salvo los que otras notas siguen usando (adjuntos copiados). */
export function deleteNoteForever(id: string) {
  // Solo su dueño borra una nota compartida (y sus ficheros, que están en la cuenta de quien los subió).
  if (foreignOwner(id)) return
  const user = get().user
  const keep = referencedPaths(id)
  commit([{ type: 'deleteNote', id }])
  forgetTooLarge([id])
  if (user && backend) void backend.deleteNoteFiles(user.uid, id, keep)
}

export function emptyTrash() {
  const user = get().user
  const ids = trashedNotes(get().notes).map((n) => n.id)
  commit(ids.map((id) => ({ type: 'deleteNote' as const, id })))
  forgetTooLarge(ids)
  // Ya sin las notas borradas: solo se conservan los ficheros que usan las que quedan.
  const keep = referencedPaths()
  if (user && backend) ids.forEach((id) => void backend!.deleteNoteFiles(user.uid, id, keep))
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

// Claves de `sync.dirty` de los adjuntos sin subir (`<prefijo><id del adjunto>`). Con `upload:` el fichero aún
// no está a salvo en el dispositivo (salir de la página lo perdería); con `queued:` espera en la cola del dispositivo.
export const UPLOAD_KEY = 'upload:'
export const QUEUED_UPLOAD_KEY = 'queued:'

// Fallos que no se arreglan reintentando: el adjunto queda como fallido.
const PERMANENT_UPLOAD_ERRORS = new Set([
  'too-large',
  'storage/unauthorized',
  'storage/quota-exceeded',
  'storage/invalid-argument',
  'storage/invalid-format',
  'storage/invalid-checksum',
  'storage/server-file-wrong-size',
  'storage/cannot-slice-blob',
  'storage/no-default-bucket',
  'storage/bucket-not-found',
  'storage/project-not-found',
])

/** true si la subida no saldrá bien aunque se reintente (los fallos de red y sin conexión sí se reintentan). */
export function isPermanentUploadError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && PERMANENT_UPLOAD_ERRORS.has(code)
}

/** Sube un adjunto. Solo un fallo definitivo se muestra como error: los de red esperan en la cola del dispositivo. */
export async function uploadAttachment(
  noteId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const user = get().user
  if (!user || !backend) throw new Error('Not signed in')
  // Mismo límite que storage.rules.
  if (file.size >= MAX_UPLOAD_BYTES) {
    const message = t(`"${file.name}" is larger than 100 MB`, `"${file.name}" pesa más de 100 MB`)
    throw Object.assign(new Error(message), { code: 'too-large' })
  }
  try {
    return await backend.uploadFile(user.uid, noteId, file, onProgress)
  } catch (error) {
    if (isPermanentUploadError(error)) setSync({ error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/**
 * Reanuda las subidas en cola de este dispositivo (al tener los datos del usuario y al volver la conexión).
 * El módulo de adjuntos va con el editor: solo se carga si hay algo que subir.
 */
function resumeQueuedUploads() {
  const { user, dataReady } = get()
  if (!user || !dataReady) return
  pendingUploadCount(user.uid)
    .then(async (count) => {
      if (count === 0) return
      const { resumeUploads } = await import('../components/editor/attachment')
      resumeUploads()
    })
    .catch(() => undefined)
}

/**
 * Borra definitivamente un adjunto de la nube (no se puede deshacer) si ya no lo usa ninguna nota.
 * `path` es el devuelto por `uploadAttachment`; `noteId`, la nota de la que se ha quitado.
 */
export async function deleteAttachmentFile(path: string, noteId: string): Promise<void> {
  const user = get().user
  // Un adjunto que subió otra cuenta (en una nota compartida) es suyo: se queda en su almacenamiento.
  if (!user || !backend || !path || !path.startsWith(`users/${user.uid}/`)) return
  // Se guarda antes la nota abierta para que su contenido ya no incluya el adjunto quitado.
  flushAll()
  if (notePaths(get().notes[noteId]).has(path) || referencedPaths(noteId).has(path)) return
  const key = `delete:${backend.newId()}`
  markDirty(key)
  try {
    await backend.deleteFile(user.uid, path)
  } catch (error) {
    setSync({ error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    markClean(key)
  }
}

// ---------- Carpetas ----------

/** Crea una carpeta al final de sus hermanas. Devuelve su id. */
export function createFolder(parentId: string | null, name: string): string {
  if (!backend) return ''
  const id = backend.newId()
  const siblings = childFolders(get().folders, parentId)
  const now = Date.now()
  commit([
    {
      type: 'setFolder',
      id,
      data: {
        name,
        parentId,
        order: keyBetween(siblings[siblings.length - 1]?.order, null),
        createdAt: now,
        updatedAt: now,
      },
    },
  ])
  return id
}

export function renameFolder(id: string, name: string) {
  commit([{ type: 'setFolder', id, data: { name, updatedAt: Date.now() } }])
}

/** Mueve una carpeta. Devuelve false si el destino está dentro de ella misma. */
export function moveFolder(id: string, parentId: string | null, order: string): boolean {
  if (parentId && isInsideFolder(get().folders, parentId, id)) return false
  commit([{ type: 'setFolder', id, data: { parentId, order, updatedAt: Date.now() } }])
  return true
}

/** Borra la carpeta y sus subcarpetas; sus notas van a la papelera (las compartidas conmigo, a la raíz). */
export function deleteFolder(id: string) {
  const { folders, notes, view, lastFolderId } = get()
  const ids = descendantFolderIds(folders, id)
  const now = Date.now()
  const ops: WriteOp[] = [
    ...activeNotes(notes)
      .filter((n) => n.folderId && ids.includes(n.folderId))
      .map((n) => ({
        type: 'setNote' as const,
        id: n.id,
        data: n.ownerUid ? { folderId: null } : { trashed: true, trashedAt: now },
      })),
    ...ids.map((fid) => ({ type: 'deleteFolder' as const, id: fid })),
  ]
  if (lastFolderId && ids.includes(lastFolderId)) set({ lastFolderId: null })
  const openNoteFolder = view.kind === 'note' ? notes[view.noteId]?.folderId : null
  const viewInside =
    (view.kind === 'notes' && view.folderId && ids.includes(view.folderId)) ||
    (openNoteFolder && ids.includes(openNoteFolder))
  if (viewInside) {
    flushAll()
    set({ view: { kind: 'notes', folderId: null }, fullscreen: false })
  }
  commit(ops)
}

// ---------- Compartir ----------

/** Envía un cambio de compartir; si la nube lo rechaza, se muestra el error. */
function sendShare(change: Promise<void>) {
  change.then(clearTransientError, (error: unknown) => setSync({ error: error instanceof Error ? error.message : String(error) }))
}

/** Invita a `rawEmail` a una nota mía. Devuelve el motivo si no se puede, o null si se ha enviado. */
export function shareNote(id: string, rawEmail: string): string | null {
  const { user, notes } = get()
  const note = notes[id]
  if (!user?.email || !backend || !note) return t("The note couldn't be shared", 'No se ha podido compartir la nota')
  if (note.ownerUid) return t('Only the owner of the note can add people', 'Solo quien creó la nota puede añadir a más gente')
  const email = normalizeEmail(rawEmail)
  if (!isValidEmail(email)) return t('Enter a valid email', 'Escribe un correo válido')
  if (email === normalizeEmail(user.email)) return t("That's your own email", 'Ese es tu propio correo')
  if (note.members?.includes(email) || note.invited?.includes(email)) {
    return t('The note is already shared with this person', 'La nota ya está compartida con esta persona')
  }
  sendShare(backend.share(user.uid, id, user.email, email))
  return null
}

/** El dueño deja de compartir la nota con `email` (aceptado o pendiente). */
export function stopSharing(id: string, email: string) {
  const { user, notes } = get()
  if (!user || !backend || !notes[id] || notes[id].ownerUid) return
  sendShare(backend.removeShare(user.uid, id, email))
}

/** Deja de ver una nota compartida conmigo: vuelve a ser solo de su dueño. */
export function leaveSharedNote(id: string) {
  const { user } = get()
  const owner = foreignOwner(id)
  if (!user?.email || !backend || !owner) return
  // Lo pendiente del editor se envía antes de salir de la nota.
  leaveIfViewing(id)
  sendShare(backend.removeShare(owner, id, user.email))
  sharedNotes = sharedNotes.filter((n) => n.id !== id)
  refreshNotes()
}

const dropInvite = (invite: Invite) =>
  set((s) => ({ invites: s.invites.filter((i) => i.noteId !== invite.noteId || i.ownerUid !== invite.ownerUid) }))

/** Acepta una invitación: la nota aparece la primera en "Todas las notas", sin carpeta, sin fijar y sin proteger. */
export function acceptInvite(invite: Invite) {
  const { user } = get()
  if (!user?.email || !backend) return
  const first = activeNotes(get().notes)[0]
  const prefs = { folderId: null, order: keyBetween(null, first?.order), pinned: false, locked: false }
  sendShare(backend.acceptShare(invite.ownerUid, invite.noteId, user.email, prefs))
  dropInvite(invite)
}

export function rejectInvite(invite: Invite) {
  const { user } = get()
  if (!user?.email || !backend) return
  sendShare(backend.removeShare(invite.ownerUid, invite.noteId, user.email))
  dropInvite(invite)
}
