import { keyForIndex } from '../../lib/order'
import type { Note } from '../../lib/types'

/** Separa fijadas y no fijadas conservando el orden. */
export function splitPinned(list: readonly Note[]): { pinned: Note[]; others: Note[] } {
  return { pinned: list.filter((n) => n.pinned), others: list.filter((n) => !n.pinned) }
}

/**
 * Nueva clave de orden al soltar `activeId` sobre `overId` dentro de una sección ordenada
 * (mismo resultado que `arrayMove`). null si no cambia nada.
 */
export function reorderKey(section: readonly Note[], activeId: string, overId: string): string | null {
  const from = section.findIndex((n) => n.id === activeId)
  const to = section.findIndex((n) => n.id === overId)
  if (from < 0 || to < 0 || from === to) return null
  return keyForIndex(
    section.filter((n) => n.id !== activeId),
    to,
  )
}
