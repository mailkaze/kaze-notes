import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { previewContent } from './previewContent'

const html = (preview: string) => {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<span>{previewContent(preview)}</span>)
  return root
}

describe('note preview', () => {
  it('draws checklist items as checkboxes instead of "☐" / "☑", and crosses out the done ones', () => {
    const root = html('Para el finde\n☐ Leche de avena\n☑ Pan integral\n  ☐ Tomates')
    expect(root.textContent).not.toMatch(/[☐☑]/u)
    const boxes = root.querySelectorAll('.preview-check')
    expect(boxes).toHaveLength(3)
    expect([...boxes].map((b) => b.hasAttribute('data-checked'))).toEqual([false, true, false])
    expect(root.querySelector('.preview-done')?.textContent).toBe('Pan integral')
    expect(root.textContent).toBe('Para el finde\nLeche de avena\nPan integral\n  Tomates')
  })

  it('leaves text without checkboxes as it was', () => {
    const root = html('Una línea\n• una viñeta\nY ☐ en medio no es casilla')
    expect(root.querySelectorAll('.preview-check')).toHaveLength(0)
    expect(root.textContent).toBe('Una línea\n• una viñeta\nY ☐ en medio no es casilla')
  })
})
