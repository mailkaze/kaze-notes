import { generateKeyBetween } from 'fractional-indexing'

interface Ordered {
  id: string
  order: string
}

/** Comparador por clave fraccional (desempate por id para que el orden sea estable). */
export function byOrder(a: Ordered, b: Ordered): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Clave entre `before` y `after` (null = extremo). Tolera claves repetidas o desordenadas. */
export function keyBetween(before: string | null | undefined, after: string | null | undefined): string {
  const a = before ?? null
  const b = after ?? null
  if (a !== null && b !== null && a >= b) return generateKeyBetween(a, null)
  return generateKeyBetween(a, b)
}

/**
 * Clave para colocar un elemento en la posición `index` de `list`.
 * `list` debe estar ordenada y NO contener el elemento que se mueve.
 */
export function keyForIndex(list: readonly Ordered[], index: number): string {
  const i = Math.max(0, Math.min(index, list.length))
  return keyBetween(list[i - 1]?.order, list[i]?.order)
}
