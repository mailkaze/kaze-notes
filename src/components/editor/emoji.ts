import { isSpanish } from '../../lib/i18n'
import { normalize } from '../../lib/search'

/** Campos de emojibase-data (compact.json) que se usan. */
export interface RawEmoji {
  label: string
  unicode: string
  hexcode: string
  tags?: string[]
  group?: number
  order?: number
}

export type RawShortcodes = Record<string, string | string[]>

export interface EmojiSources {
  es: RawEmoji[]
  en: RawEmoji[]
  esShortcodes: RawShortcodes
  enShortcodes: RawShortcodes
}

export interface EmojiEntry {
  emoji: string
  /** Nombre en el idioma de la interfaz. */
  name: string
  /** Alias propios: van por delante de todo. */
  explicit: string[]
  shortcodes: string[]
  /** Palabras de cada nombre (es y en), en orden. */
  labels: string[][]
  /** Palabras del nombre (es + en) y de los shortcodes. */
  words: string[]
  tags: string[]
  order: number
}

// Alias explícitos: ninguna de las dos lenguas etiqueta 👍 con "ok".
const ALIASES: Record<string, string[]> = {
  '1F44D': ['ok', 'vale'],
  '2764': ['corazon'],
}

// Grupo "componentes" (tonos de piel, pelo): no son emojis sueltos.
const COMPONENT_GROUP = 2
const LIMIT = 8
const MAX_POSITION = 20

const asList = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const wordsOf = (text: string) => normalize(text).split(/[^\p{L}\p{N}+-]+/u).filter(Boolean)

export function buildEmojiIndex(sources: EmojiSources, spanish: boolean): EmojiEntry[] {
  const english = new Map(sources.en.map((e) => [e.hexcode, e]))
  const entries: EmojiEntry[] = []
  for (const es of sources.es) {
    if (es.group === undefined || es.group === COMPONENT_GROUP) continue
    const en = english.get(es.hexcode)
    const shortcodes = [...asList(sources.esShortcodes[es.hexcode]), ...asList(sources.enShortcodes[es.hexcode])].map(normalize)
    const labels = [wordsOf(es.label), wordsOf(en?.label ?? '')]
    entries.push({
      emoji: es.unicode,
      name: spanish || !en ? es.label : en.label,
      explicit: ALIASES[es.hexcode] ?? [],
      shortcodes,
      labels,
      words: [...new Set([...labels.flat(), ...shortcodes.flatMap((s) => s.split('_'))])],
      tags: [...new Set([...(es.tags ?? []), ...(en?.tags ?? [])].flatMap(wordsOf))],
      order: es.order ?? Number.MAX_SAFE_INTEGER,
    })
  }
  return entries
}

/** Posición de la primera palabra del nombre que empieza por `term` (los nombres que empiezan por ella van antes). */
function wordPosition(entry: EmojiEntry, term: string): number {
  let best = MAX_POSITION
  for (const words of entry.labels) {
    const i = words.findIndex((w) => w.startsWith(term))
    if (i >= 0 && i < best) best = i
  }
  return best
}

/** Menor es mejor; -1 si no coincide. Alias exacto > palabra del nombre > etiqueta. */
function rank(entry: EmojiEntry, query: string, terms: string[]): number {
  if (entry.explicit.includes(query)) return 0
  if (entry.shortcodes.includes(query)) return 1
  const inWords = (term: string) => entry.words.some((w) => w.startsWith(term))
  const position = () => wordPosition(entry, terms[0]) / (MAX_POSITION + 1)
  if (terms.every(inWords)) return (terms.every((term) => entry.words.includes(term)) ? 2 : 3) + position()
  const inTags = (term: string) => inWords(term) || entry.tags.some((w) => w.startsWith(term))
  if (terms.every(inTags)) return terms.every((term) => entry.words.includes(term) || entry.tags.includes(term)) ? 4 : 5
  return -1
}

/** Busca emojis por nombre, etiqueta o shortcode (sin distinguir tildes ni mayúsculas). */
export function searchEmoji(index: EmojiEntry[], query: string, limit = LIMIT): EmojiEntry[] {
  const q = normalize(query).trim()
  if (!q) return []
  const terms = q.split(/[_\s]+/).filter(Boolean)
  const scored: { entry: EmojiEntry; score: number }[] = []
  for (const entry of index) {
    const score = rank(entry, q, terms)
    if (score >= 0) scored.push({ entry, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.order - b.entry.order)
    .slice(0, limit)
    .map((s) => s.entry)
}

let loading: Promise<EmojiEntry[]> | null = null

/** Carga los datos de emojibase la primera vez que se usan (van en un chunk aparte). */
export function loadEmojiIndex(): Promise<EmojiEntry[]> {
  loading ??= Promise.all([
    import('emojibase-data/es/compact.json'),
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/es/shortcodes/cldr.json'),
    import('emojibase-data/en/shortcodes/github.json'),
  ]).then(
    ([es, en, esShortcodes, enShortcodes]) =>
      buildEmojiIndex(
        { es: es.default, en: en.default, esShortcodes: esShortcodes.default, enShortcodes: enShortcodes.default },
        isSpanish,
      ),
    (error: unknown) => {
      loading = null
      throw error
    },
  )
  return loading
}
