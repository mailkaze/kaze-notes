import type { JSONContent } from '@tiptap/react'
import { find as findLinks } from 'linkifyjs'

/** Formatos que WhatsApp entiende, en el orden en que se anidan (negrita por fuera). */
const FORMATS = [
  { mark: 'bold', marker: '*', tag: 'strong' },
  { mark: 'italic', marker: '_', tag: 'em' },
  { mark: 'strike', marker: '~', tag: 's' },
] as const

type Format = (typeof FORMATS)[number]

interface Run {
  text: string
  formats: Format[]
  href?: string
}

const INDENT = '  '

// ---------- Documento → texto de WhatsApp ----------

function runsOf(node: JSONContent): Run[] {
  if (node.type === 'attachment') return [{ text: `📎 ${String(node.attrs?.name ?? '')}`, formats: [] }]
  if (node.type !== 'text' || !node.text) return []
  const marks = node.marks ?? []
  const formats = FORMATS.filter((f) => marks.some((m) => m.type === f.mark))
  const href = marks.find((m) => m.type === 'link')?.attrs?.href
  return [{ text: node.text, formats, href: typeof href === 'string' ? href : undefined }]
}

/** Separa el contenido en línea en líneas (saltos de línea) de tramos con formato. */
function inlineLines(nodes: JSONContent[] | undefined): Run[][] {
  const lines: Run[][] = [[]]
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      lines.push([])
      continue
    }
    for (const run of runsOf(node)) {
      run.text.split('\n').forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part) lines[lines.length - 1].push({ ...run, text: part })
      })
    }
  }
  return lines
}

function withoutScheme(url: string): string {
  return url
    .trim()
    .replace(/^(?:https?:\/\/|mailto:)/i, '')
    .replace(/\/$/, '')
}

/** Añade " (dirección)" tras cada enlace cuyo texto no sea la propia dirección. */
function withLinkAddresses(runs: Run[]): Run[] {
  const out: Run[] = []
  let label = ''
  runs.forEach((run, i) => {
    out.push(run)
    if (!run.href) return
    label += run.text
    if (runs[i + 1]?.href === run.href) return
    if (withoutScheme(label) !== withoutScheme(run.href)) out.push({ text: ` (${run.href})`, formats: [] })
    label = ''
  })
  return out
}

function lineToWhatsApp(runs: Run[]): string {
  let out = ''
  let open: Format[] = []
  // Espacios pendientes: se escriben fuera de los marcadores.
  let pending = ''
  for (const run of withLinkAddresses(runs)) {
    const lead = /^\s*/.exec(run.text)![0]
    const core = run.text.slice(lead.length).trimEnd()
    if (!core) {
      pending += run.text
      continue
    }
    let keep = 0
    while (keep < open.length && open[keep] === run.formats[keep]) keep++
    for (let i = open.length - 1; i >= keep; i--) out += open[i].marker
    out += pending + lead
    for (let i = keep; i < run.formats.length; i++) out += run.formats[i].marker
    out += core
    open = run.formats
    pending = run.text.slice(lead.length + core.length)
  }
  for (let i = open.length - 1; i >= 0; i--) out += open[i].marker
  return out + pending
}

function pushText(out: string[], first: string, rest: string, nodes: JSONContent[] | undefined) {
  inlineLines(nodes).forEach((runs, i) => out.push((i === 0 ? first : rest) + lineToWhatsApp(runs)))
}

function pushItem(out: string[], item: JSONContent, indent: string) {
  const marker = item.type === 'taskItem' ? (item.attrs?.checked ? '☑ ' : '☐ ') : '- '
  const [first, ...rest] = item.content ?? []
  if (first?.type === 'paragraph') {
    pushText(out, indent + marker, indent + INDENT, first.content)
    pushBlocks(out, rest, indent + INDENT)
  } else {
    out.push(indent + marker.trimEnd())
    pushBlocks(out, item.content, indent + INDENT)
  }
}

function pushBlocks(out: string[], nodes: JSONContent[] | undefined, indent: string) {
  let inline: JSONContent[] = []
  const flushInline = () => {
    if (inline.length) pushText(out, indent, indent, inline)
    inline = []
  }
  for (const node of nodes ?? []) {
    if (node.type === 'text' || node.type === 'hardBreak' || node.type === 'attachment') {
      inline.push(node)
      continue
    }
    flushInline()
    if (node.type === 'bulletList' || node.type === 'taskList') {
      for (const item of node.content ?? []) pushItem(out, item, indent)
    } else if (node.type === 'listItem' || node.type === 'taskItem') {
      pushItem(out, node, indent)
    } else if (node.type === 'paragraph') {
      pushText(out, indent, indent, node.content)
    } else {
      pushBlocks(out, node.content, indent)
    }
  }
  flushInline()
}

/**
 * Convierte un documento (o un fragmento: lista de nodos) en texto con el formato de WhatsApp:
 * `*negrita*`, `_cursiva_`, `~tachado~`, viñetas "- " y casillas "☐ " / "☑ ". El subrayado se pierde.
 */
export function docToWhatsApp(content: JSONContent | JSONContent[] | null | undefined): string {
  if (!content) return ''
  const out: string[] = []
  pushBlocks(out, Array.isArray(content) ? content : [content], '')
  return out.join('\n')
}

// ---------- Texto de WhatsApp → HTML ----------

// Marcador de posición para los enlaces mientras se buscan los formatos (carácter de uso privado).
const LINK_SLOT = ''

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || /[\s\p{P}\p{S}]/u.test(ch)
}

function isOpening(s: string, i: number): boolean {
  return isBoundary(s[i - 1]) && i + 1 < s.length && !/\s/.test(s[i + 1])
}

function closingIndex(s: string, open: number): number {
  const marker = s[open]
  for (let j = open + 2; j < s.length; j++) {
    if (s[j] === marker && !/\s/.test(s[j - 1]) && isBoundary(s[j + 1])) return j
  }
  return -1
}

function formatAt(s: string, i: number): Format | undefined {
  const format = FORMATS.find((f) => f.marker === s[i])
  return format && isOpening(s, i) && closingIndex(s, i) > 0 ? format : undefined
}

/** Sustituye los enlaces por `LINK_SLOT` para que sus caracteres no cuenten como marcadores. */
function maskLinks(line: string): { masked: string; links: { text: string; href: string }[] } {
  const clean = line.replaceAll(LINK_SLOT, '')
  const links = findLinks(clean, { defaultProtocol: 'https' }).filter((l) => l.isLink)
  let masked = ''
  let last = 0
  for (const link of links) {
    masked += clean.slice(last, link.start) + LINK_SLOT
    last = link.end
  }
  masked += clean.slice(last)
  return { masked, links: links.map((l) => ({ text: l.value, href: l.href })) }
}

function inlineToHtml(line: string): string {
  const { masked, links } = maskLinks(line)
  let next = 0
  const plain = (text: string) =>
    escapeHtml(text).replace(new RegExp(LINK_SLOT, 'g'), () => {
      const link = links[next++]
      return link ? `<a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>` : ''
    })
  const parse = (s: string): string => {
    let out = ''
    let start = 0
    for (let i = 0; i < s.length; i++) {
      const format = formatAt(s, i)
      if (!format) continue
      const end = closingIndex(s, i)
      out += plain(s.slice(start, i)) + `<${format.tag}>` + parse(s.slice(i + 1, end)) + `</${format.tag}>`
      start = end + 1
      i = end
    }
    return out + plain(s.slice(start))
  }
  return parse(masked)
}

function hasInlineFormat(line: string): boolean {
  const { masked } = maskLinks(line)
  for (let i = 0; i < masked.length; i++) if (formatAt(masked, i)) return true
  return false
}

type LineKind = 'bullet' | 'task' | 'text'

interface Line {
  indent: number
  kind: LineKind
  checked: boolean
  text: string
}

const BULLET = /^[-*•]\s+/
const TASK = /^(?:(☐|\[ \])|(☑️?|✅|✔️?|\[[xX]\]))(?:\s+|$)/u

function parseLine(raw: string): Line {
  const space = /^[ \t ]*/.exec(raw)![0]
  const indent = space.replace(/\t/g, INDENT).length
  let text = raw.slice(space.length)
  let kind: LineKind = 'text'
  const bullet = BULLET.exec(text)
  if (bullet) {
    kind = 'bullet'
    text = text.slice(bullet[0].length)
  }
  const task = TASK.exec(text)
  if (task) {
    kind = 'task'
    text = text.slice(task[0].length)
  }
  return { indent, kind, checked: Boolean(task?.[2]), text: kind === 'text' ? raw : text }
}

interface ListBlock {
  kind: 'bullet' | 'task'
  items: { html: string; checked: boolean; children: ListBlock[] }[]
}

type Block = { kind: 'p'; html: string } | ListBlock

function renderList(list: ListBlock): string {
  const items = list.items
    .map((item) => {
      const inner = `<p>${item.html}</p>${item.children.map(renderList).join('')}`
      return list.kind === 'task' ? `<li data-type="taskItem" data-checked="${item.checked}">${inner}</li>` : `<li>${inner}</li>`
    })
    .join('')
  return list.kind === 'task' ? `<ul data-type="taskList">${items}</ul>` : `<ul>${items}</ul>`
}

/**
 * Convierte texto de WhatsApp en HTML que entiende el editor: formatos en línea,
 * viñetas ("- ", "* ", "• ") y casillas (☐ ☑ ✅ ✔ [ ] [x]) anidadas por sangría.
 */
export function whatsAppToHtml(text: string): string {
  const blocks: Block[] = []
  let stack: { indent: number; list: ListBlock }[] = []
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = parseLine(raw)
    if (line.kind === 'text') {
      const top = stack[stack.length - 1]
      if (top && line.indent > 0 && raw.trim()) {
        // Línea sangrada sin marcador: continúa el último elemento de la lista.
        const item = top.list.items[top.list.items.length - 1]
        item.html += `<br>${inlineToHtml(raw.trim())}`
        continue
      }
      stack = []
      blocks.push({ kind: 'p', html: inlineToHtml(raw) })
      continue
    }
    const kind = line.kind
    while (stack.length && stack[stack.length - 1].indent > line.indent) stack.pop()
    let top = stack[stack.length - 1]
    if (top && top.indent === line.indent && top.list.kind !== kind) {
      stack.pop()
      top = stack[stack.length - 1]
    }
    const item: ListBlock['items'][number] = { html: inlineToHtml(line.text), checked: line.checked, children: [] }
    if (top && top.indent === line.indent) {
      top.list.items.push(item)
      continue
    }
    const list: ListBlock = { kind, items: [item] }
    if (top) top.list.items[top.list.items.length - 1].children.push(list)
    else blocks.push(list)
    stack.push({ indent: line.indent, list })
  }
  return blocks.map((b) => (b.kind === 'p' ? `<p>${b.html}</p>` : renderList(b))).join('')
}

/** true si el texto usa viñetas, casillas o formatos de WhatsApp. */
export function looksLikeWhatsApp(text: string): boolean {
  return text.split(/\r\n?|\n/).some((raw) => parseLine(raw).kind !== 'text' || hasInlineFormat(raw))
}

/** true si el HTML del portapapeles ya trae formatos (en ese caso se respeta el pegado normal). */
export function hasFormattingHtml(html: string): boolean {
  if (!html) return false
  if (/data-pm-slice/.test(html)) return true
  return (
    /<(?:strong|b|em|i|s|del|strike|u|ul|ol|li)\b[^>]*>/i.test(html) ||
    /font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic|text-decoration[^;"]*(?:underline|line-through)/i.test(html)
  )
}
