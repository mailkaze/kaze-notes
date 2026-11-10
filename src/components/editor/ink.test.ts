import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { hasContent, previewFromDoc } from '../../lib/docText'
import { createExtensions } from './extensions'
import { INK_DEFAULT_HEIGHT, inkHeightFor, inkTarget, type BlockBox } from './ink'

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
