import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

type Header = { key: string; value: string }
type HeaderRule = { source: string; headers: Header[] }
type Config = {
  firestore: { predeploy?: string[] }
  storage: { predeploy?: string[] }
  hosting: { predeploy?: string[]; headers: HeaderRule[] }
}

const config: Config = JSON.parse(readFileSync('firebase.json', 'utf8'))
const rules = config.hosting.headers
const headerOf = (source: string, key: string) =>
  rules.find((r) => r.source === source)?.headers.find((h) => h.key === key)?.value

describe('Firebase Hosting configuration', () => {
  it('allows every inline script of index.html in the CSP by its hash', () => {
    const html = readFileSync('index.html', 'utf8')
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(inline.length).toBeGreaterThan(0)
    for (const source of ['/', '/index.html']) {
      const csp = headerOf(source, 'Content-Security-Policy') ?? ''
      for (const script of inline) {
        const hash = createHash('sha256').update(script).digest('base64')
        expect(csp).toContain(`'sha256-${hash}'`)
      }
    }
  })

  it('applies the CSP only to the app page, never to the Firebase reserved /__/ pages', () => {
    const withCsp = rules.filter((r) => r.headers.some((h) => h.key === 'Content-Security-Policy')).map((r) => r.source)
    expect(withCsp.sort()).toEqual(['/', '/index.html'])
    expect(headerOf('/', 'Content-Security-Policy')).toBe(headerOf('/index.html', 'Content-Security-Policy'))
  })

  it('serves index.html and the service worker without HTTP caching', () => {
    for (const source of ['/', '/index.html', '/sw.js']) {
      expect(headerOf(source, 'Cache-Control')).toBe('no-cache')
    }
  })

  it('regenerates the rules before any rules deploy and builds production before any hosting deploy', () => {
    expect(config.firestore.predeploy).toEqual(['node scripts/build-rules.mjs'])
    expect(config.storage.predeploy).toEqual(['node scripts/build-rules.mjs'])
    expect(config.hosting.predeploy).toEqual(['npm run build'])
  })

  it('stops a rules deploy when OWNER_EMAIL is missing', () => {
    const run = spawnSync(process.execPath, ['scripts/build-rules.mjs'], {
      env: { ...process.env, OWNER_EMAIL: '' },
      encoding: 'utf8',
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Set OWNER_EMAIL')
  })
})
