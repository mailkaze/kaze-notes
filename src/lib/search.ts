import { plainText } from './docText'
import { byOrder } from './order'
import type { Note } from './types'

/** Minúsculas y sin tildes/diacríticos ("Canción" → "cancion"). */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

interface Indexed {
  key: string
  title: string
  body: string
  words: string[]
}

const cache = new Map<string, Indexed>()

function index(note: Note): Indexed {
  const key = `${note.updatedAt}:${note.title.length}:${note.content.length}:${Boolean(note.locked)}`
  const hit = cache.get(note.id)
  if (hit && hit.key === key) return hit
  const title = normalize(note.title)
  // De las notas protegidas solo se busca en el título.
  const body = note.locked ? '' : normalize(plainText(note.content))
  const words = `${title} ${body}`.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)
  const entry = { key, title, body, words: [...new Set(words)] }
  cache.set(note.id, entry)
  return entry
}

/** Errores tolerados según la longitud del término: nada en términos muy cortos. */
function allowedTypos(term: string): number {
  if (term.length < 4) return 0
  if (term.length < 8) return 1
  return 2
}

/** Distancia de Damerau-Levenshtein (transposiciones incluidas) con corte temprano. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1)
      }
      row.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return max + 1
    prev2 = prev
    prev = row
  }
  return prev[b.length]
}

/**
 * Cota rápida: cada errata deja como mucho una letra del término sin pareja, así que si faltan más de `max`
 * letras en el comienzo de la palabra que se compara, ni la palabra ni sus prefijos pueden coincidir.
 */
function tooManyMissing(term: string, text: string, max: number): boolean {
  let rest = text
  let missing = 0
  for (let i = 0; i < term.length; i++) {
    const at = rest.indexOf(term[i])
    if (at === -1) {
      if (++missing > max) return true
    } else {
      rest = rest.slice(0, at) + rest.slice(at + 1)
    }
  }
  return false
}

/** true si `term` se parece a la palabra entera o a su comienzo (búsqueda parcial con erratas). */
function fuzzyWordMatch(term: string, word: string, max: number): boolean {
  if (tooManyMissing(term, word.slice(0, term.length + max), max)) return false
  if (editDistance(term, word, max) <= max) return true
  for (let len = term.length - max; len <= term.length + max; len++) {
    if (len < 3 || len >= word.length) continue
    if (editDistance(term, word.slice(0, len), max) <= max) return true
  }
  return false
}

/** `memo` guarda, para este término, el resultado de cada palabra: se repiten mucho entre notas. */
function termScore(term: string, entry: Indexed, memo: Map<string, boolean>): number {
  if (entry.title.includes(term)) return 5
  if (entry.body.includes(term)) return 3
  const max = allowedTypos(term)
  if (max === 0) return 0
  const matches = (word: string) => {
    let hit = memo.get(word)
    if (hit === undefined) {
      hit = fuzzyWordMatch(term, word, max)
      memo.set(word, hit)
    }
    return hit
  }
  return entry.words.some(matches) ? 1 : 0
}

/**
 * Busca notas por texto parcial del título o del contenido.
 * Sin distinguir mayúsculas ni tildes y tolerando pequeñas erratas. Todos los términos deben coincidir.
 */
export function searchNotes(notes: readonly Note[], query: string): Note[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const memos = terms.map(() => new Map<string, boolean>())
  const scored: { note: Note; score: number }[] = []
  for (const note of notes) {
    const entry = index(note)
    let score = 0
    for (const [i, term] of terms.entries()) {
      const s = termScore(term, entry, memos[i])
      if (s === 0) {
        score = 0
        break
      }
      score += s
    }
    if (score > 0) scored.push({ note, score })
  }
  return scored.sort((a, b) => b.score - a.score || byOrder(a.note, b.note)).map((s) => s.note)
}
