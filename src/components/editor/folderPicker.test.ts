import { describe, expect, it } from 'vitest'
import type { Folder } from '../../lib/types'
import { folderTree, pickerOptions } from './folderPicker'

function folder(id: string, name: string, parentId: string | null, order: string): Folder {
  return { id, name, parentId, order, createdAt: 0, updatedAt: 0 }
}

const folders: Record<string, Folder> = {
  w: folder('w', 'Trabajo', null, 'a1'),
  h: folder('h', 'Casa', null, 'a0'),
  i: folder('i', 'Ideas', 'w', 'a0'),
  s: folder('s', 'Canción nueva', 'i', 'a0'),
  r: folder('r', 'Reuniones', 'w', 'a1'),
  o: folder('o', 'Huérfana', 'missing', 'a2'),
}

const labels = (options: ReturnType<typeof pickerOptions>) =>
  options.map((o) => (o.kind === 'root' ? '(root)' : o.kind === 'create' ? `+${o.name}` : o.path))

describe('folderTree', () => {
  it('lists folders in tree order with depth and full path; orphans go to the top level', () => {
    expect(folderTree(folders).map((f) => [f.id, f.depth, f.path])).toEqual([
      ['h', 0, 'Casa'],
      ['w', 0, 'Trabajo'],
      ['i', 1, 'Trabajo / Ideas'],
      ['s', 2, 'Trabajo / Ideas / Canción nueva'],
      ['r', 1, 'Trabajo / Reuniones'],
      ['o', 0, 'Huérfana'],
    ])
  })

  it('shows folders in a parent cycle at the top level, with their subfolders below', () => {
    const cyclic = { a: folder('a', 'A', 'b', 'a0'), b: folder('b', 'B', 'a', 'a1'), c: folder('c', 'C', 'a', 'a0') }
    expect(folderTree(cyclic).map((f) => [f.id, f.depth, f.path])).toEqual([
      ['a', 0, 'A'],
      ['c', 1, 'A / C'],
      ['b', 0, 'B'],
    ])
  })
})

describe('pickerOptions', () => {
  it('without a query offers "no folder" first and every folder, and no create option', () => {
    expect(labels(pickerOptions(folders, ''))).toEqual([
      '(root)',
      'Casa',
      'Trabajo',
      'Trabajo / Ideas',
      'Trabajo / Ideas / Canción nueva',
      'Trabajo / Reuniones',
      'Huérfana',
    ])
    expect(labels(pickerOptions(folders, '   '))[0]).toBe('(root)')
  })

  it('filters by name ignoring accents and case', () => {
    expect(labels(pickerOptions(folders, 'CANCION'))).toEqual(['Trabajo / Ideas / Canción nueva', '+CANCION'])
    expect(labels(pickerOptions(folders, 'huerf'))).toEqual(['Huérfana', '+huerf'])
  })

  it('filters by full path, with or without spaces around the slash', () => {
    expect(labels(pickerOptions(folders, 'trabajo / reu'))).toEqual(['Trabajo / Reuniones', '+trabajo / reu'])
    expect(labels(pickerOptions(folders, 'trabajo/ideas'))).toEqual([
      'Trabajo / Ideas',
      'Trabajo / Ideas / Canción nueva',
      '+trabajo/ideas',
    ])
  })

  it('offers to create the typed folder (trimmed) when no folder has exactly that name', () => {
    expect(labels(pickerOptions(folders, '  Viajes  '))).toEqual(['+Viajes'])
  })

  it('does not offer to create a folder whose name already exists, ignoring accents and case', () => {
    expect(labels(pickerOptions(folders, 'ideas'))).toEqual(['Trabajo / Ideas', 'Trabajo / Ideas / Canción nueva'])
    expect(labels(pickerOptions(folders, 'huerfana'))).toEqual(['Huérfana'])
  })
})
