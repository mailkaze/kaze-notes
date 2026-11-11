import { byOrder } from '../../lib/order'
import { parentFolderId } from '../../lib/tree'
import { normalize } from '../../lib/search'
import type { Folder } from '../../lib/types'

export interface FolderOption {
  id: string
  name: string
  /** Ruta completa, p. ej. "Trabajo / Ideas". */
  path: string
  depth: number
}

export type PickerOption =
  | { kind: 'root' }
  | ({ kind: 'folder' } & FolderOption)
  | { kind: 'create'; name: string }

/** Todas las carpetas en orden de árbol (cada padre antes que sus hijas). Las huérfanas o en un ciclo cuelgan de la raíz. */
export function folderTree(folders: Record<string, Folder>): FolderOption[] {
  const byParent = new Map<string | null, Folder[]>()
  for (const folder of Object.values(folders).sort(byOrder)) {
    const parent = parentFolderId(folders, folder.id)
    byParent.set(parent, [...(byParent.get(parent) ?? []), folder])
  }
  const out: FolderOption[] = []
  const seen = new Set<string>()
  const walk = (parentId: string | null, depth: number, prefix: string) => {
    for (const folder of byParent.get(parentId) ?? []) {
      if (seen.has(folder.id)) continue
      seen.add(folder.id)
      const path = prefix ? `${prefix} / ${folder.name}` : folder.name
      out.push({ id: folder.id, name: folder.name, path, depth })
      walk(folder.id, depth + 1, path)
    }
  }
  walk(null, 0, '')
  return out
}

/** Sin tildes ni mayúsculas y sin espacios alrededor de "/" ("Trabajo / Ideas" → "trabajo/ideas"). */
const key = (text: string) => normalize(text.trim()).replace(/\s*\/\s*/g, '/')

/**
 * Opciones del selector de carpeta: sin texto, "Sin carpeta" y todas las carpetas; con texto, las carpetas
 * cuyo nombre o ruta lo contienen y, si ninguna se llama exactamente así, la opción de crearla.
 */
export function pickerOptions(folders: Record<string, Folder>, query: string): PickerOption[] {
  const tree = folderTree(folders)
  const name = query.trim()
  if (!name) return [{ kind: 'root' }, ...tree.map((f) => ({ kind: 'folder' as const, ...f }))]
  const q = key(name)
  const options: PickerOption[] = tree
    .filter((f) => key(f.path).includes(q))
    .map((f) => ({ kind: 'folder' as const, ...f }))
  if (!tree.some((f) => key(f.name) === q)) options.push({ kind: 'create', name })
  return options
}
