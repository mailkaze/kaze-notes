import { describe, expect, it } from 'vitest'
import { renderServiceWorker, shellManifest, type BuiltFile } from './swBuild'

const BUILD: BuiltFile[] = [
  { path: 'index.html', content: '<script src="/assets/index-a1.js"></script>' },
  { path: 'assets/index-a1.js', content: 'app' },
  { path: 'assets/index-a1.js.map', content: '{}' },
  { path: 'assets/NoteEditor-b2.js', content: 'editor' },
  { path: 'assets/compact-c3.js', content: 'emoji' },
  { path: 'assets/index-d4.css', content: 'css' },
  { path: 'icon-192.png', content: new Uint8Array([1, 2, 3]) },
  { path: '.DS_Store', content: 'x' },
  { path: 'sw.js', content: 'old worker' },
]

const TEMPLATE = "const VERSION = '__SW_VERSION__'\nconst PRECACHE = ['__SW_PRECACHE__']\n"

describe('shellManifest', () => {
  it('lists every built and public file except source maps, hidden files and the worker itself', () => {
    expect(shellManifest(BUILD).urls).toEqual([
      '/assets/NoteEditor-b2.js',
      '/assets/compact-c3.js',
      '/assets/index-a1.js',
      '/assets/index-d4.css',
      '/icon-192.png',
      '/index.html',
    ])
  })

  it('keeps the same version for the same output, whatever the order', () => {
    expect(shellManifest([...BUILD].reverse()).version).toBe(shellManifest(BUILD).version)
  })

  it('changes the version when any file changes its content or its name', () => {
    const base = shellManifest(BUILD).version
    const withIcon = BUILD.map((f) => (f.path === 'icon-192.png' ? { ...f, content: new Uint8Array([9]) } : f))
    const renamed = BUILD.map((f) => (f.path === 'assets/compact-c3.js' ? { ...f, path: 'assets/compact-e5.js' } : f))
    expect(shellManifest(withIcon).version).not.toBe(base)
    expect(shellManifest(renamed).version).not.toBe(base)
    // Lo que no se sirve no cuenta.
    expect(shellManifest(BUILD.filter((f) => !f.path.endsWith('.map'))).version).toBe(base)
  })
})

describe('renderServiceWorker', () => {
  it('changes the version when only the headers served with the app change (e.g. the CSP), with the same files', () => {
    const csp = (value: string) => JSON.stringify([{ source: '/', headers: [{ key: 'Content-Security-Policy', value }] }])
    expect(shellManifest(BUILD, csp("default-src 'self'")).version).not.toBe(shellManifest(BUILD, csp("default-src 'none'")).version)
    expect(shellManifest(BUILD, csp("default-src 'self'")).version).toBe(shellManifest(BUILD, csp("default-src 'self'")).version)
  })

  it('writes a different worker whenever the build output differs', () => {
    const a = renderServiceWorker(TEMPLATE, shellManifest(BUILD))
    const b = renderServiceWorker(TEMPLATE, shellManifest([...BUILD, { path: 'assets/new-f6.js', content: 'new' }]))
    expect(a).toContain(`const VERSION = "${shellManifest(BUILD).version}"`)
    expect(a).toContain('const PRECACHE = ["/assets/NoteEditor-b2.js",')
    expect(b).not.toBe(a)
    expect(renderServiceWorker(TEMPLATE, shellManifest(BUILD))).toBe(a)
  })

  it('refuses a template without its markers', () => {
    expect(() => renderServiceWorker('self.addEventListener()', shellManifest(BUILD))).toThrow()
  })
})
