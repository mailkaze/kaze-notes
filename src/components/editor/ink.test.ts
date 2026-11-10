import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { hasContent, previewFromDoc } from '../../lib/docText'
import { createExtensions } from './extensions'
import {
  INK_DEFAULT_HEIGHT,
  INK_MAX_CANVAS_PIXELS,
  INK_MAX_HEIGHT,
  inkCanvasRatio,
  inkHeightFor,
  inkTarget,
  simplifyStroke,
  type BlockBox,
} from './ink'

const editors: Editor[] = []

afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
})

function makeEditor(content: string | object): Editor {
  const editor = new Editor({ element: null, extensions: createExtensions(), content })
  editors.push(editor)
  return editor
}

const text = (top: number, bottom: number): BlockBox => ({ top, bottom, emptyParagraph: false })
const empty = (top: number, bottom: number): BlockBox => ({ top, bottom, emptyParagraph: true })

describe('inkTarget', () => {
  const blocks = [text(0, 30), text(40, 100), empty(110, 140), text(150, 180)]

  it('goes before a block when the pencil lands on its upper half', () => {
    expect(inkTarget(blocks, 50)).toEqual({ index: 1, replace: false })
  })

  it('goes after a block when the pencil lands on its lower half', () => {
    expect(inkTarget(blocks, 90)).toEqual({ index: 2, replace: false })
  })

  it('goes before the next block when the pencil lands in the gap between two blocks', () => {
    expect(inkTarget(blocks, 35)).toEqual({ index: 1, replace: false })
  })

  it('replaces an empty paragraph under the pencil', () => {
    expect(inkTarget(blocks, 120)).toEqual({ index: 2, replace: true })
  })

  it('goes at the end when the pencil lands below all the text', () => {
    expect(inkTarget(blocks, 400)).toEqual({ index: 4, replace: false })
  })

  it('replaces the last empty paragraph when the pencil lands below it', () => {
    expect(inkTarget([text(0, 30), empty(40, 70)], 400)).toEqual({ index: 1, replace: true })
  })
})

describe('inkHeightFor', () => {
  it('keeps the height while the stroke stays clear of the bottom', () => {
    expect(inkHeightFor(INK_DEFAULT_HEIGHT, 100)).toBe(INK_DEFAULT_HEIGHT)
  })

  it('grows when the stroke gets close to the bottom', () => {
    expect(inkHeightFor(INK_DEFAULT_HEIGHT, 450)).toBeGreaterThan(450 + 300)
  })

  it('never grows past the maximum height', () => {
    expect(inkHeightFor(INK_MAX_HEIGHT, INK_MAX_HEIGHT)).toBe(INK_MAX_HEIGHT)
  })
})

describe('handwriting as note content', () => {
  const withInk = (strokes: number[][]) => ({
    type: 'doc',
    content: [{ type: 'paragraph' }, { type: 'ink', attrs: { strokes, height: INK_DEFAULT_HEIGHT } }],
  })

  it('a note with only handwriting is not empty, and its preview shows a pencil', () => {
    expect(hasContent(withInk([[1, 2, 50]]))).toBe(true)
    expect(previewFromDoc(withInk([[1, 2, 50]]))).toBe('✏️')
  })

  it('a handwriting block without strokes leaves the note empty', () => {
    expect(hasContent(withInk([]))).toBe(false)
  })
})

describe('ink node', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Antes' }] },
      { type: 'ink', attrs: { strokes: [[10, 20, 50, 30, 40, 60]], height: 900 } },
      { type: 'paragraph', content: [{ type: 'text', text: 'Después' }] },
    ],
  }

  it('keeps its strokes and height in the saved JSON', () => {
    expect(makeEditor(doc).getJSON()).toEqual(doc)
  })

  it('keeps its strokes and height through HTML (copy and paste inside the app)', () => {
    const html = makeEditor(doc).getHTML()
    expect(makeEditor(html).getJSON()).toEqual(doc)
  })
})

describe('handwriting pasted from elsewhere', () => {
  const pasted = (attrs: string) =>
    makeEditor(`<div data-type="ink" ${attrs}></div>`)
      .getJSON()
      .content?.find((n) => n.type === 'ink')?.attrs

  it('caps a huge height, so the block cannot ask for a canvas larger than the device can hold', () => {
    expect(pasted('data-height="1000000000"')?.height).toBe(INK_MAX_HEIGHT)
  })

  it('uses the default height when the pasted one is not a positive number', () => {
    for (const height of ['-50', '0', 'abc', 'Infinity']) {
      expect(pasted(`data-height="${height}"`)?.height).toBe(INK_DEFAULT_HEIGHT)
    }
  })

  it('drops strokes that are not whole [x, y, pressure] points', () => {
    expect(pasted('data-strokes="[[1,2,3],[1,2],[],[1,2,3,4,5,6]]"')?.strokes).toEqual([
      [1, 2, 3],
      [1, 2, 3, 4, 5, 6],
    ])
  })
})

describe('inkCanvasRatio', () => {
  it('draws at the screen density for ordinary blocks', () => {
    expect(inkCanvasRatio(800, 240, 2)).toBe(2)
  })

  it('lowers the density of very tall blocks to stay within the canvas size iPad Safari can draw', () => {
    const ratio = inkCanvasRatio(800, 16000, 2)
    expect(ratio).toBeLessThan(2)
    expect(800 * ratio * 16000 * ratio).toBeLessThanOrEqual(INK_MAX_CANVAS_PIXELS)
  })
})

describe('simplifyStroke', () => {
  const xs = (s: number[]) => s.filter((_, i) => i % 3 === 0)

  it('drops points that lie on a straight line, keeping both ends', () => {
    const line = Array.from({ length: 50 }, (_, i) => [i * 2, 100, 50]).flat()
    expect(simplifyStroke(line)).toEqual([0, 100, 50, 98, 100, 50])
  })

  it('keeps the corners of a zigzag', () => {
    const zigzag = Array.from({ length: 12 }, (_, i) => [i * 30, (i % 2) * 35, 60]).flat()
    expect(simplifyStroke(zigzag)).toEqual(zigzag)
  })

  it('keeps a point where the pressure changes, so the line width stays the same', () => {
    const press = [0, 0, 20, 10, 0, 20, 20, 0, 90, 30, 0, 90, 40, 0, 20]
    expect(xs(simplifyStroke(press))).toEqual([0, 10, 20, 30, 40])
  })

  it('keeps a single point and a two-point stroke as they are', () => {
    expect(simplifyStroke([5, 6, 50])).toEqual([5, 6, 50])
    expect(simplifyStroke([5, 6, 50, 7, 8, 50])).toEqual([5, 6, 50, 7, 8, 50])
  })

  it('makes a slow, densely sampled curve much smaller without moving it more than a pixel', () => {
    const curve = Array.from({ length: 400 }, (_, i) => {
      const a = (i / 400) * Math.PI
      return [Math.round(1000 + 300 * Math.cos(a)), Math.round(400 + 300 * Math.sin(a)), 50]
    }).flat()
    const simple = simplifyStroke(curve)
    expect(simple.length).toBeLessThan(curve.length / 4)
    expect(simple.slice(0, 3)).toEqual(curve.slice(0, 3))
    expect(simple.slice(-3)).toEqual(curve.slice(-3))
  })
})
