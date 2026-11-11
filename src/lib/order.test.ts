import { generateKeyBetween } from 'fractional-indexing'
import { describe, expect, it } from 'vitest'
import { byOrder, keyBetween, keyForIndex } from './order'

const item = (id: string, order: string) => ({ id, order })

/** Ids de la lista tras colocar `moved` con su nueva clave. */
const placed = (list: { id: string; order: string }[], order: string) =>
  [...list, item('moved', order)].sort(byOrder).map((n) => n.id)

describe('keyForIndex', () => {
  it('places an item between notes with distinct keys exactly where it was dropped', () => {
    const list = [item('a', 'a0'), item('b', 'a1'), item('c', 'a2')]
    expect(keyForIndex(list, 1)).toBe(generateKeyBetween('a0', 'a1'))
    expect(placed(list, keyForIndex(list, 0))).toEqual(['moved', 'a', 'b', 'c'])
    expect(placed(list, keyForIndex(list, 2))).toEqual(['a', 'b', 'moved', 'c'])
    expect(placed(list, keyForIndex(list, 3))).toEqual(['a', 'b', 'c', 'moved'])
  })

  it('a drop between notes with the same key lands right after them, never tied with or past the next note', () => {
    // Dos dispositivos crearon x e y a la vez con la misma clave.
    const list = [item('a', 'a0'), item('x', 'a1'), item('y', 'a1'), item('n', 'a2'), item('m', 'a3')]
    const key = keyForIndex(list, 2)
    expect(key > 'a1' && key < 'a2').toBe(true)
    expect(placed(list, key)).toEqual(['a', 'x', 'y', 'moved', 'n', 'm'])
    // Con la siguiente nota muy cerca tampoco la alcanza.
    const close = [item('x', 'a1'), item('y', 'a1'), item('n', 'a1V')]
    expect(placed(close, keyForIndex(close, 1))).toEqual(['x', 'y', 'moved', 'n'])
    // Repetidas al final de la lista.
    const last = [item('x', 'a1'), item('y', 'a1')]
    expect(placed(last, keyForIndex(last, 1))).toEqual(['x', 'y', 'moved'])
  })
})

describe('keyBetween', () => {
  it('keeps its keys for distinct and missing neighbours', () => {
    expect(keyBetween('a0', 'a2')).toBe(generateKeyBetween('a0', 'a2'))
    expect(keyBetween(null, 'a0')).toBe(generateKeyBetween(null, 'a0'))
    expect(keyBetween('a0', undefined)).toBe(generateKeyBetween('a0', null))
    expect(keyBetween('a3', 'a1')).toBe(generateKeyBetween('a3', null))
  })
})
