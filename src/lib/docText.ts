import type { JSONContent } from '@tiptap/react'

export function parseContent(content: string): JSONContent | null {
  if (!content) return null
  try {
    return JSON.parse(content) as JSONContent
  } catch {
    return null
  }
}

function inlineText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'attachment') return `📎 ${String(node.attrs?.name ?? '')}`
  return (node.content ?? []).map(inlineText).join('')
}

/** Convierte el documento en líneas de texto plano: viñetas como "• ", casillas como "☐ " / "☑ ". */
export function docToLines(doc: JSONContent | null): string[] {
  const lines: string[] = []
  const push = (prefix: string, indent: string, text: string) => {
    text.split('\n').forEach((line, i) => lines.push((i === 0 ? prefix : indent) + line))
  }
  const walk = (nodes: JSONContent[] | undefined, indent: string) => {
    for (const node of nodes ?? []) {
      if (node.type === 'bulletList' || node.type === 'taskList') {
        for (const item of node.content ?? []) {
          const marker = node.type === 'taskList' ? (item.attrs?.checked ? '☑ ' : '☐ ') : '• '
          const [first, ...rest] = item.content ?? []
          if (first?.type === 'paragraph') {
            push(indent + marker, indent + '  ', inlineText(first))
            walk(rest, indent + '  ')
          } else {
            walk(item.content, indent + '  ')
          }
        }
      } else if (node.type === 'paragraph') {
        push(indent, indent, inlineText(node))
      } else if (node.content) {
        walk(node.content, indent)
      }
    }
  }
  if (doc) walk(doc.type === 'doc' ? doc.content : [doc], '')
  return lines
}

/** Texto completo de la nota (para buscar). */
export function plainText(content: string): string {
  return docToLines(parseContent(content)).join('\n')
}

/** Primeras líneas con contenido, para la barra lateral y las tarjetas. */
export function previewFromDoc(doc: JSONContent | null, maxLines = 12, maxChars = 600): string {
  const out: string[] = []
  for (const raw of docToLines(doc)) {
    const line = raw.trimEnd()
    if (!line.trim() && (out.length === 0 || !out[out.length - 1].trim())) continue
    out.push(line)
    if (out.length >= maxLines) break
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n').slice(0, maxChars)
}

/** true si el documento tiene texto o adjuntos. */
export function hasContent(doc: JSONContent | null): boolean {
  return docToLines(doc).some((line) => line.trim() !== '' && line.trim() !== '•' && line.trim() !== '☐')
}
