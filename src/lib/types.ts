export const NOTE_COLOR_IDS = [
  'coral',
  'tangerine',
  'sunshine',
  'lime',
  'mint',
  'aqua',
  'sky',
  'periwinkle',
  'grape',
  'bubblegum',
] as const

export type NoteColorId = (typeof NOTE_COLOR_IDS)[number]

export interface Note {
  id: string
  title: string
  /** Documento TipTap serializado como JSON (cadena vacía = nota vacía). */
  content: string
  /** Primeras líneas en texto plano, para la barra lateral y las tarjetas. */
  preview: string
  folderId: string | null
  /** Clave de índice fraccional: orden global de las notas (ascendente). */
  order: string
  pinned: boolean
  /** Protegida: para verla hay que verificarse en el dispositivo (huella, Face ID, PIN…). Opcional en notas antiguas. */
  locked?: boolean
  color: NoteColorId | null
  trashed: boolean
  trashedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  /** Clave de índice fraccional: orden entre carpetas hermanas. */
  order: string
  createdAt: number
  updatedAt: number
}

export interface AppUser {
  uid: string
  name: string | null
  email: string | null
  photoURL: string | null
}

export type View =
  | { kind: 'notes'; folderId: string | null }
  | { kind: 'note'; noteId: string }
  | { kind: 'trash' }

export type LayoutMode = 'grid' | 'list'
export type ThemePref = 'system' | 'light' | 'dark'
