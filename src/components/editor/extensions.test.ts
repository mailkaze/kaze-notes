import { Editor } from '@tiptap/core'
import type { JSONContent } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { Slice } from '@tiptap/pm/model'
import { afterEach, describe, expect, it } from 'vitest'
import { docToWhatsApp, whatsAppToHtml } from '../../lib/whatsapp'
import { createExtensions } from './extensions'

const editors: Editor[] = []

function makeEditor(content: string, mounted = false): Editor {
  const editor = new Editor({
    element: mounted ? document.createElement('div') : null,
    extensions: createExtensions(),
    content,
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
})

function jsonFrom(html: string): JSONContent {
  return makeEditor(html).getJSON()
}

function roundTrip(html: string) {
  const original = jsonFrom(html)
  const text = docToWhatsApp(original)
  return { original, text, back: jsonFrom(whatsAppToHtml(text)) }
}

/** Simula que el usuario escribe `value` carácter a carácter (pasa por las reglas de entrada). */
function type(editor: Editor, value: string) {
  for (const ch of value) {
    const { view } = editor
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}

function paste(editor: Editor, text: string, html = '') {
  const { view } = editor
  const event = {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : ''), files: [] },
  } as unknown as ClipboardEvent
  return view.someProp('handlePaste', (f) => f(view, event, Slice.empty))
}

describe('WhatsApp round trip through the editor schema', () => {
  it('keeps bold, italic and strike', () => {
    const { original, text, back } = roundTrip('<p>Hola <strong>negrita</strong>, <em>cursiva</em> y <s>tachado</s></p>')
    expect(text).toBe('Hola *negrita*, _cursiva_ y ~tachado~')
    expect(back).toEqual(original)
  })

  it('keeps nested marks', () => {
    const { original, back } = roundTrip(
      '<p><strong><em>ambos</em></strong> y <strong>a <em><s>tres</s></em></strong> fin</p>',
    )
    expect(back).toEqual(original)
  })

  it('keeps bullets, nested bullets, task items and interleaved paragraphs', () => {
    const { original, text, back } = roundTrip(
      '<p>Lista</p><ul><li><p>uno</p><ul><li><p>dos</p></li></ul></li><li><p><strong>tres</strong></p></li></ul><p></p>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>hecho</p></li>' +
        '<li data-type="taskItem" data-checked="false"><p>pendiente</p></li></ul><p>fin</p>',
    )
    expect(text).toBe('Lista\n- uno\n  - dos\n- *tres*\n\n☑ hecho\n☐ pendiente\nfin')
    expect(back).toEqual(original)
  })

  it('keeps links', () => {
    const { original, back } = roundTrip('<p>web <a href="https://example.com/a_b">https://example.com/a_b</a> ok</p>')
    expect(back).toEqual(original)
    expect(JSON.stringify(back)).toContain('"type":"link"')
  })
})

describe('WhatsApp typing rules', () => {
  it('turns *x* into bold, _x_ into italic and ~x~ into strike', () => {
    const editor = makeEditor('<p></p>', true)
    editor.commands.focus('end')
    type(editor, 'a *b* _c_ ~d~')
    expect(editor.getJSON().content?.[0].content).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'c', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'd', marks: [{ type: 'strike' }] },
    ])
  })

  it('keeps the punctuation before the opening marker', () => {
    const editor = makeEditor('<p></p>', true)
    editor.commands.focus('end')
    type(editor, '(*hola*)')
    expect(editor.getJSON().content?.[0].content).toEqual([
      { type: 'text', text: '(' },
      { type: 'text', text: 'hola', marks: [{ type: 'bold' }] },
      { type: 'text', text: ')' },
    ])
  })

  it('does not apply markers inside words', () => {
    const editor = makeEditor('<p></p>', true)
    editor.commands.focus('end')
    type(editor, 'a*b* x_y_')
    expect(editor.getText()).toBe('a*b* x_y_')
  })
})

describe('toolbar commands', () => {
  it('with an empty selection, a format applies to the next typed text', () => {
    const editor = makeEditor('<p>a</p>', true)
    editor.commands.focus('end')
    editor.commands.toggleBold()
    expect(editor.isActive('bold')).toBe(true)
    editor.view.dispatch(editor.state.tr.insertText('b'))
    expect(editor.getJSON().content?.[0].content?.[1]).toEqual({ type: 'text', text: 'b', marks: [{ type: 'bold' }] })
  })

  it('the checkbox button turns a bullet item into a task item and back', () => {
    const editor = makeEditor('<ul><li><p>a</p></li></ul>', true)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)))
    editor.commands.toggleTaskList()
    expect(editor.getJSON().content?.[0].type).toBe('taskList')
    editor.commands.toggleTaskList()
    expect(editor.getJSON().content?.[0].type).toBe('paragraph')
  })
})

describe('clipboard', () => {
  it('copies as WhatsApp text', () => {
    const editor = makeEditor('<ul><li><p>uno <strong>dos</strong></p></li></ul><p><u>tres</u></p>', true)
    const { view } = editor
    const all = view.state.doc.slice(0, view.state.doc.content.size)
    expect(view.someProp('clipboardTextSerializer', (f) => f(all, view))).toBe('- uno *dos*\ntres')
  })

  it('copying part of a single item does not add the bullet', () => {
    const editor = makeEditor('<ul><li><p>uno <strong>dos</strong></p></li></ul>', true)
    const { view } = editor
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7, 10)))
    const slice = view.state.selection.content()
    expect(view.someProp('clipboardTextSerializer', (f) => f(slice, view))).toBe('*dos*')
  })

  it('pastes WhatsApp text with its formats, bullets and checkboxes', () => {
    const editor = makeEditor('<p></p>', true)
    expect(paste(editor, 'Hola *mundo*\n- a\n☑ b')).toBe(true)
    // TrailingNode añade un párrafo vacío al final, tras la lista.
    expect(docToWhatsApp(editor.getJSON())).toBe('Hola *mundo*\n- a\n☑ b\n')
    expect(editor.getJSON().content?.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'taskList', 'paragraph'])
  })

  it('leaves formatted HTML and plain text to the default paste', () => {
    const editor = makeEditor('<p></p>', true)
    expect(paste(editor, 'Hola *mundo*', '<p>Hola <b>mundo</b></p>')).toBeFalsy()
    expect(paste(editor, 'texto normal')).toBeFalsy()
  })
})
