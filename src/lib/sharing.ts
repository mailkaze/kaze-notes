import type { Note } from './types'

// Una nota compartida sigue en la cuenta de quien la creó. Título, contenido (con sus adjuntos) y color son de
// todos; carpeta, orden, fijado y protección los decide cada invitado y se guardan en `prefs.<su correo>`.

/** Campos que cada invitado decide por su cuenta. */
export const PERSONAL_FIELDS = ['folderId', 'order', 'pinned', 'locked'] as const

/** Campos comunes que un invitado puede cambiar (las reglas de Firestore permiten los mismos). */
export const SHARED_FIELDS = ['title', 'content', 'preview', 'color', 'rev', 'baseRev', 'device', 'updatedAt'] as const

type PersonalField = (typeof PERSONAL_FIELDS)[number]
type SharedField = (typeof SHARED_FIELDS)[number]

export type SharePrefs = Partial<Pick<Note, PersonalField>>

/** Cambio de una nota ajena tal y como se guarda en la nota del dueño. */
export type SharedNoteData = Partial<Pick<Note, SharedField>> & { prefs?: Record<string, SharePrefs> }

/** Invitación pendiente a una nota de otro usuario. */
export interface Invite {
  noteId: string
  ownerUid: string
  ownerEmail: string
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** La nota está compartida con alguien (aceptado o pendiente). */
export function isShared(note: Note): boolean {
  return Boolean(note.members?.length || note.invited?.length)
}

/** Preferencias guardadas de un invitado; lo que no tenga el tipo correcto se ignora. */
function readPrefs(raw: unknown): SharePrefs {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const prefs: SharePrefs = {}
  if (typeof p.folderId === 'string') prefs.folderId = p.folderId
  if (typeof p.order === 'string') prefs.order = p.order
  if (typeof p.pinned === 'boolean') prefs.pinned = p.pinned
  if (typeof p.locked === 'boolean') prefs.locked = p.locked
  return prefs
}

/** Nota de otro usuario vista por un invitado: lo personal sale de sus preferencias, nunca de las del dueño. */
export function sharedView(note: Note, ownerUid: string, prefs: unknown): Note {
  const p = readPrefs(prefs)
  return {
    ...note,
    ownerUid,
    folderId: p.folderId ?? null,
    order: p.order ?? note.order,
    pinned: p.pinned ?? false,
    locked: p.locked ?? false,
  }
}

/** Cambio de un invitado en una nota ajena: lo personal va a `prefs.<email>` y se descarta lo que no puede tocar. */
export function sharedWrite(data: Partial<Omit<Note, 'id'>>, email: string): SharedNoteData {
  const out: Record<string, unknown> = {}
  const personal: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if ((PERSONAL_FIELDS as readonly string[]).includes(key)) personal[key] = value
    else if ((SHARED_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  if (Object.keys(personal).length > 0) out.prefs = { [email]: personal }
  return out as SharedNoteData
}
