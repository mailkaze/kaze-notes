import enEmoji from 'emojibase-data/en/compact.json'
import enShortcodes from 'emojibase-data/en/shortcodes/github.json'
import esEmoji from 'emojibase-data/es/compact.json'
import esShortcodes from 'emojibase-data/es/shortcodes/cldr.json'
import { describe, expect, it } from 'vitest'
import { buildEmojiIndex, searchEmoji } from './emoji'

const index = buildEmojiIndex({ es: esEmoji, en: enEmoji, esShortcodes, enShortcodes }, true)
const found = (query: string) => searchEmoji(index, query).map((e) => e.emoji)

const SMILING = ['😀', '😃', '😄', '😁', '🙂', '😊', '☺️', '😸']

describe('searchEmoji', () => {
  it('ranks the explicit alias :ok → 👍 first', () => {
    expect(found('ok')[0]).toBe('👍')
  })

  it('finds 👍 by its Spanish name', () => {
    expect(found('pulgar')[0]).toBe('👍')
  })

  it('ignores accents and case', () => {
    expect(found('corazon')).toContain('❤️')
    expect(found('CORAZÓN')).toContain('❤️')
    expect(found('Pulgar')[0]).toBe('👍')
  })

  it('finds smiling faces in English and Spanish', () => {
    expect(SMILING).toContain(found('smile')[0])
    expect(SMILING).toContain(found('sonrisa')[0])
  })

  it('matches word prefixes and shortcodes', () => {
    expect(found('thumbsup')[0]).toBe('👍')
    expect(found('+1')[0]).toBe('👍')
    expect(found('pulg')[0]).toBe('👍')
  })

  it('ranks exact aliases over label words, and label words over tags', () => {
    // "heart" es un shortcode exacto de ❤️; los demás corazones solo lo tienen en el nombre.
    expect(found('heart')[0]).toBe('❤️')
  })

  it('returns at most 8 results with a name in the UI language', () => {
    const results = searchEmoji(index, 'cara')
    expect(results).toHaveLength(8)
    expect(results.every((e) => e.name.length > 0)).toBe(true)
    expect(searchEmoji(index, 'pulgar')[0].name).toBe('pulgar hacia arriba')
  })

  it('returns nothing for an empty or unknown query', () => {
    expect(found('')).toEqual([])
    expect(found('zzzzqqq')).toEqual([])
  })
})
