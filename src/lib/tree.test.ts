import { describe, expect, it } from 'vitest'
import { childFolders, descendantFolderIds, folderPath, folderPathLabel, isInsideFolder, parentFolderId } from './tree'
import type { Folder } from './types'

function folder(id: string, parentId: string | null, order = 'a0'): Folder {
  return { id, name: id.toUpperCase(), parentId, order, createdAt: 0, updatedAt: 0 }
}

const ids = (list: Folder[]) => list.map((f) => f.id)

describe('folder nesting', () => {
  // Dos dispositivos movieron x dentro de y e y dentro de x; z cuelga de x.
  const cyclic: Record<string, Folder> = {
    top: folder('top', null, 'a0'),
    x: folder('x', 'y', 'a1'),
    y: folder('y', 'x', 'a2'),
    z: folder('z', 'x'),
    self: folder('self', 'self', 'a3'),
    orphan: folder('orphan', 'missing', 'a4'),
  }

  it('shows folders whose parent chain loops, or whose parent is gone, at the top level', () => {
    expect(parentFolderId(cyclic, 'x')).toBeNull()
    expect(parentFolderId(cyclic, 'y')).toBeNull()
    expect(parentFolderId(cyclic, 'self')).toBeNull()
    expect(parentFolderId(cyclic, 'orphan')).toBeNull()
    expect(parentFolderId(cyclic, 'z')).toBe('x')
    expect(ids(childFolders(cyclic, null))).toEqual(['top', 'x', 'y', 'self', 'orphan'])
    expect(ids(childFolders(cyclic, 'x'))).toEqual(['z'])
    expect(ids(childFolders(cyclic, 'y'))).toEqual([])
  })

  it('computes paths, containment and descendants from the same nesting', () => {
    expect(ids(folderPath(cyclic, 'x'))).toEqual(['x'])
    expect(ids(folderPath(cyclic, 'z'))).toEqual(['x', 'z'])
    expect(folderPathLabel(cyclic, 'z')).toBe('X / Z')
    expect(isInsideFolder(cyclic, 'z', 'x')).toBe(true)
    expect(isInsideFolder(cyclic, 'y', 'x')).toBe(false)
    expect(isInsideFolder(cyclic, 'x', 'y')).toBe(false)
    expect(descendantFolderIds(cyclic, 'x').sort()).toEqual(['x', 'z'])
    expect(descendantFolderIds(cyclic, 'y')).toEqual(['y'])
  })

  it('keeps normal nesting as it was', () => {
    const tree = { a: folder('a', null), b: folder('b', 'a'), c: folder('c', 'b') }
    expect(parentFolderId(tree, 'c')).toBe('b')
    expect(ids(childFolders(tree, null))).toEqual(['a'])
    expect(ids(childFolders(tree, 'a'))).toEqual(['b'])
    expect(ids(folderPath(tree, 'c'))).toEqual(['a', 'b', 'c'])
    expect(isInsideFolder(tree, 'c', 'a')).toBe(true)
    expect(descendantFolderIds(tree, 'a').sort()).toEqual(['a', 'b', 'c'])
    expect(folderPath(tree, null)).toEqual([])
  })
})
