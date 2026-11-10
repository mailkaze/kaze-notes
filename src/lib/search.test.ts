import { describe, expect, it } from 'vitest'
import { editDistance, normalize, searchNotes } from './search'
import type { Note } from './types'

function doc(...paragraphs: string[]): string {
  return JSON.stringify({
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })),
  })
}

let seq = 0
function note(title: string, ...paragraphs: string[]): Note {
  seq += 1
  return {
    id: `n${seq}`,
    title,
    content: doc(...paragraphs),
    preview: '',
    folderId: null,
    order: `a${seq}`,
    pinned: false,
    color: null,
    trashed: false,
    trashedAt: null,
    createdAt: seq,
    updatedAt: seq,
  }
}

const shopping = note('Lista de la compra', 'Comprar manzanas y plátanos', 'Leche')
const song = note('Canción favorita', 'La letra de la canción')
const travel = note('', 'Viaje a Japón en primavera')
const all = [shopping, song, travel]
const ids = (notes: Note[]) => notes.map((n) => n.id)

describe('normalize', () => {
  it('lowercases and removes accents', () => {
    expect(normalize('Canción ÁRBOL Pingüino')).toBe('cancion arbol pinguino')
  })
})

describe('editDistance', () => {
  it('counts a transposition as one edit', () => {
    expect(editDistance('comrpar', 'comprar', 2)).toBe(1)
  })
  it('stops early beyond the limit', () => {
    expect(editDistance('abcdef', 'zzzzzz', 1)).toBe(2)
  })
})

describe('searchNotes', () => {
  it('matches partial text in the title', () => {
    expect(ids(searchNotes(all, 'compr'))).toEqual([shopping.id])
  })

  it('matches partial text in the content', () => {
    expect(ids(searchNotes(all, 'manza'))).toEqual([shopping.id])
  })

  it('is case-insensitive', () => {
    expect(ids(searchNotes(all, 'LECHE'))).toEqual([shopping.id])
  })

  it('ignores missing accents in the query', () => {
    expect(ids(searchNotes(all, 'cancion'))).toEqual([song.id])
    expect(ids(searchNotes(all, 'japon'))).toEqual([travel.id])
  })

  it('ignores extra accents in the query', () => {
    expect(ids(searchNotes(all, 'léche'))).toEqual([shopping.id])
  })

  it('tolerates small typos', () => {
    expect(ids(searchNotes(all, 'manznas'))).toEqual([shopping.id])
    expect(ids(searchNotes(all, 'primavrea'))).toEqual([travel.id])
  })

  it('finds typos at the start of a word in every note that repeats it', () => {
    const a = note('', 'Presupuesto trimestral')
    const b = note('', 'el presupuesto anual')
    const both = [a.id, b.id].sort()
    expect(ids(searchNotes([a, b], 'rpesupuesto')).sort()).toEqual(both)
    expect(ids(searchNotes([a, b], 'bresupuesto')).sort()).toEqual(both)
    expect(ids(searchNotes([a, b], 'trimestarl'))).toEqual([a.id])
    expect(ids(searchNotes([a, b], 'bresupuestx')).sort()).toEqual(both)
    expect(searchNotes([a, b], 'bxesupuestx')).toEqual([])
  })

  it('tolerates a typo in a partial word', () => {
    expect(ids(searchNotes(all, 'platnos'))).toEqual([shopping.id])
  })

  it('requires every term to match', () => {
    expect(ids(searchNotes(all, 'canción leche'))).toEqual([])
  })

  it('does not match unrelated text', () => {
    expect(ids(searchNotes(all, 'ordenador'))).toEqual([])
  })

  it('ranks title matches above content matches', () => {
    const inBody = note('Otra', 'cosas de la canción')
    expect(ids(searchNotes([inBody, song], 'cancion'))[0]).toBe(song.id)
  })

  it('returns nothing for an empty query', () => {
    expect(searchNotes(all, '   ')).toEqual([])
  })
})
