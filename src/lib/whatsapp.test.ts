import type { JSONContent } from '@tiptap/react'
import { describe, expect, it } from 'vitest'
import { docToWhatsApp, hasFormattingHtml, looksLikeWhatsApp, whatsAppToHtml } from './whatsapp'

type Mark = 'bold' | 'italic' | 'strike' | 'underline'

function text(value: string, ...marks: Mark[]): JSONContent {
  return marks.length ? { type: 'text', text: value, marks: marks.map((type) => ({ type })) } : { type: 'text', text: value }
}

function link(value: string, href: string, ...marks: Mark[]): JSONContent {
  return { type: 'text', text: value, marks: [...marks.map((type) => ({ type })), { type: 'link', attrs: { href } }] }
}

function p(...content: JSONContent[]): JSONContent {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function doc(...content: JSONContent[]): JSONContent {
  return { type: 'doc', content }
}

function bullets(...items: JSONContent[][]): JSONContent {
  return { type: 'bulletList', content: items.map((content) => ({ type: 'listItem', content })) }
}

function tasks(...items: [boolean, JSONContent[]][]): JSONContent {
  return {
    type: 'taskList',
    content: items.map(([checked, content]) => ({ type: 'taskItem', attrs: { checked }, content })),
  }
}

const br: JSONContent = { type: 'hardBreak' }

describe('docToWhatsApp', () => {
  it('writes one line per paragraph, keeping empty lines', () => {
    expect(docToWhatsApp(doc(p(text('Hola')), p(), p(text('mundo'))))).toBe('Hola\n\nmundo')
  })

  it('wraps bold, italic and strike with WhatsApp markers', () => {
    expect(docToWhatsApp(doc(p(text('Hola '), text('mundo', 'bold'))))).toBe('Hola *mundo*')
    expect(docToWhatsApp(doc(p(text('a', 'italic'), text(' y '), text('b', 'strike'))))).toBe('_a_ y ~b~')
  })

  it('nests markers as bold > italic > strike', () => {
    expect(docToWhatsApp(doc(p(text('x', 'strike', 'italic', 'bold'))))).toBe('*_~x~_*')
    expect(docToWhatsApp(doc(p(text('a ', 'bold'), text('b', 'bold', 'italic'))))).toBe('*a _b_*')
    expect(docToWhatsApp(doc(p(text('a', 'italic'), text('b', 'bold', 'italic'))))).toBe('_a_*_b_*')
  })

  it('moves leading and trailing whitespace outside the markers', () => {
    expect(docToWhatsApp(doc(p(text('Hola ', 'bold'), text('mundo'))))).toBe('*Hola* mundo')
    expect(docToWhatsApp(doc(p(text('a'), text(' b ', 'italic'), text('c'))))).toBe('a _b_ c')
    expect(docToWhatsApp(doc(p(text('a', 'bold'), text(' ', 'italic'), text('b', 'bold'))))).toBe('*a b*')
  })

  it('drops underline, which WhatsApp does not have', () => {
    expect(docToWhatsApp(doc(p(text('x', 'underline'))))).toBe('x')
    expect(docToWhatsApp(doc(p(text('x', 'bold', 'underline'))))).toBe('*x*')
  })

  it('applies markers per line across hard breaks', () => {
    expect(docToWhatsApp(doc(p(text('a', 'bold'), br, text('b', 'bold'))))).toBe('*a*\n*b*')
  })

  it('writes bullets with two spaces of indentation per level', () => {
    const list = bullets([p(text('uno'))], [p(text('dos')), bullets([p(text('tres', 'bold'))])])
    expect(docToWhatsApp(doc(list))).toBe('- uno\n- dos\n  - *tres*')
  })

  it('writes task items with ☐ and ☑, interleaved with paragraphs', () => {
    const content = doc(p(text('Compra')), tasks([false, [p(text('pan'))]], [true, [p(text('leche'))]]), p(text('fin')))
    expect(docToWhatsApp(content)).toBe('Compra\n☐ pan\n☑ leche\nfin')
  })

  it('indents nested task items and hard breaks inside items', () => {
    const content = doc(tasks([false, [p(text('a'), br, text('b')), tasks([true, [p(text('c'))]])]]))
    expect(docToWhatsApp(content)).toBe('☐ a\n  b\n  ☑ c')
  })

  it('writes attachments as 📎 and their name', () => {
    const attachment = { type: 'attachment', attrs: { name: 'foto.png', url: 'https://x/y' } }
    expect(docToWhatsApp(doc(p(text('ver '), attachment)))).toBe('ver 📎 foto.png')
  })

  it('writes links as their text, adding the address only when it differs', () => {
    expect(docToWhatsApp(doc(p(link('https://x.com/a', 'https://x.com/a'))))).toBe('https://x.com/a')
    expect(docToWhatsApp(doc(p(link('example.com', 'https://example.com'))))).toBe('example.com')
    expect(docToWhatsApp(doc(p(text('ve a '), link('Google', 'https://google.com', 'bold'))))).toBe(
      've a *Google* (https://google.com)',
    )
  })

  it('accepts a fragment (array of nodes) or nothing', () => {
    expect(docToWhatsApp([p(text('a')), p(text('b'))])).toBe('a\nb')
    expect(docToWhatsApp(null)).toBe('')
  })
})

describe('whatsAppToHtml', () => {
  it('turns markers into strong, em and s', () => {
    expect(whatsAppToHtml('Hola *mundo*')).toBe('<p>Hola <strong>mundo</strong></p>')
    expect(whatsAppToHtml('_a_ ~b~')).toBe('<p><em>a</em> <s>b</s></p>')
  })

  it('allows nested markers', () => {
    expect(whatsAppToHtml('*_x_*')).toBe('<p><strong><em>x</em></strong></p>')
    expect(whatsAppToHtml('*a _b_*')).toBe('<p><strong>a <em>b</em></strong></p>')
  })

  it('needs a boundary before the opening marker and after the closing one', () => {
    expect(whatsAppToHtml('2*3*4')).toBe('<p>2*3*4</p>')
    expect(whatsAppToHtml('snake_case_name')).toBe('<p>snake_case_name</p>')
    expect(whatsAppToHtml('a * b * c')).toBe('<p>a * b * c</p>')
    expect(whatsAppToHtml('*a *')).toBe('<p>*a *</p>')
    expect(whatsAppToHtml('(*hola*), ok')).toBe('<p>(<strong>hola</strong>), ok</p>')
  })

  it('never joins markers across lines', () => {
    expect(whatsAppToHtml('*a\nb*')).toBe('<p>*a</p><p>b*</p>')
  })

  it('escapes HTML', () => {
    expect(whatsAppToHtml('<b>x</b> & "y"')).toBe('<p>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</p>')
  })

  it('keeps empty lines as empty paragraphs and accepts CRLF', () => {
    expect(whatsAppToHtml('a\r\n\r\nb')).toBe('<p>a</p><p></p><p>b</p>')
  })

  it('turns "- ", "* " and "• " lines into bullet items', () => {
    expect(whatsAppToHtml('- a\n* b\n• c')).toBe('<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>')
  })

  it('nests bullets by indentation', () => {
    expect(whatsAppToHtml('- a\n  - b\n- c')).toBe('<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>')
  })

  it('turns checkbox symbols into task items', () => {
    const item = (checked: boolean, value: string) =>
      `<li data-type="taskItem" data-checked="${checked}"><p>${value}</p></li>`
    expect(whatsAppToHtml('☐ a\n☑ b\n✅ c\n[ ] d\n[x] e\n✔️ f\n[X] g\n✔ h\n☑️ i\n- [ ] j')).toBe(
      `<ul data-type="taskList">${[
        item(false, 'a'),
        item(true, 'b'),
        item(true, 'c'),
        item(false, 'd'),
        item(true, 'e'),
        item(true, 'f'),
        item(true, 'g'),
        item(true, 'h'),
        item(true, 'i'),
        item(false, 'j'),
      ].join('')}</ul>`,
    )
  })

  it('interleaves paragraphs, bullets and task lists', () => {
    expect(whatsAppToHtml('texto\n- a\notro\n☐ *b*')).toBe(
      '<p>texto</p><ul><li><p>a</p></li></ul><p>otro</p>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p><strong>b</strong></p></li></ul>',
    )
  })

  it('joins indented lines without marker to the previous item', () => {
    expect(whatsAppToHtml('☐ a\n  b')).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>a<br>b</p></li></ul>',
    )
  })

  it('turns URLs into links without applying markers inside them', () => {
    expect(whatsAppToHtml('ver https://example.com/a_b_c ya')).toBe(
      '<p>ver <a href="https://example.com/a_b_c">https://example.com/a_b_c</a> ya</p>',
    )
    expect(whatsAppToHtml('*example.com*')).toBe('<p><strong><a href="https://example.com">example.com</a></strong></p>')
  })
})

describe('looksLikeWhatsApp', () => {
  it('detects formatting markers, bullets and checkboxes', () => {
    expect(looksLikeWhatsApp('hola *mundo*')).toBe(true)
    expect(looksLikeWhatsApp('- a\n- b')).toBe(true)
    expect(looksLikeWhatsApp('☐ comprar pan')).toBe(true)
    expect(looksLikeWhatsApp('una línea\n_otra_')).toBe(true)
  })

  it('ignores plain text', () => {
    expect(looksLikeWhatsApp('texto normal')).toBe(false)
    expect(looksLikeWhatsApp('2*3*4 y snake_case')).toBe(false)
    expect(looksLikeWhatsApp('https://x.com/a_b_c')).toBe(false)
  })
})

describe('hasFormattingHtml', () => {
  it('detects formatting tags, styles and content copied from the editor', () => {
    expect(hasFormattingHtml('<p>a <b>b</b></p>')).toBe(true)
    expect(hasFormattingHtml('<ul><li>a</li></ul>')).toBe(true)
    expect(hasFormattingHtml('<span style="font-weight: 700">a</span>')).toBe(true)
    expect(hasFormattingHtml('<p data-pm-slice="1 1 []">a</p>')).toBe(true)
  })

  it('ignores plain HTML', () => {
    expect(hasFormattingHtml('')).toBe(false)
    expect(hasFormattingHtml('<body><span>Hola *mundo*</span><br><img src="x"></body>')).toBe(false)
  })
})

describe('long lines', () => {
  it('detects and converts a long line full of opening markers with the same result', () => {
    const unclosed = ' *a'.repeat(16_000)
    const bold = `${unclosed}*`
    expect(looksLikeWhatsApp(unclosed)).toBe(false)
    expect(whatsAppToHtml(unclosed)).toBe(`<p>${unclosed}</p>`)
    expect(looksLikeWhatsApp(bold)).toBe(true)
    expect(whatsAppToHtml(bold)).toBe(`<p> <strong>a${unclosed.slice(3)}</strong></p>`)
  }, 60_000)

  it('takes time proportional to the line length, not to its square', () => {
    // Se compara el tiempo con una línea cuatro veces más larga: lineal ≈ ×4, cuadrático ≈ ×16.
    // La proporción no depende de lo rápida que sea la máquina; el mejor de varios intentos quita el ruido.
    const timeFor = (repeats: number) => {
      const unclosed = ' *a'.repeat(repeats)
      const bold = `${unclosed}*`
      let best = Infinity
      for (let attempt = 0; attempt < 5; attempt++) {
        const started = performance.now()
        looksLikeWhatsApp(unclosed)
        whatsAppToHtml(unclosed)
        looksLikeWhatsApp(bold)
        whatsAppToHtml(bold)
        best = Math.min(best, performance.now() - started)
      }
      return best
    }
    expect(timeFor(32_000) / timeFor(8_000)).toBeLessThan(10)
  }, 60_000)
})
