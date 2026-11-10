const lang = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en'

export const isSpanish = lang.startsWith('es')

/** Devuelve el texto en el idioma del navegador: español si es `es-*`, inglés en otro caso. */
export function t(en: string, es: string): string {
  return isSpanish ? es : en
}
