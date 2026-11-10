// Genera firestore.rules y storage.rules a partir de las plantillas con los correos de las cuentas permitidas.
// Uso: OWNER_EMAIL=tu@gmail.com[,otra@gmail.com] npm run rules:deploy
import { readFileSync, writeFileSync } from 'node:fs'

const emails = [...new Set((process.env.OWNER_EMAIL ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))]
// Solo correos simples: evita inyectar comillas o código en las reglas.
if (emails.length === 0 || !emails.every((e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e))) {
  console.error('Set OWNER_EMAIL to the Google account(s) allowed to use the app, comma-separated, e.g.\n  OWNER_EMAIL=you@gmail.com,friend@gmail.com npm run rules:deploy')
  process.exit(1)
}

const list = emails.map((e) => `'${e}'`).join(', ')
for (const name of ['firestore', 'storage']) {
  const template = readFileSync(`${name}.rules.template`, 'utf8')
  if (!template.includes('__OWNER_EMAILS__')) throw new Error(`${name}.rules.template has no __OWNER_EMAILS__ placeholder`)
  writeFileSync(`${name}.rules`, template.replaceAll('__OWNER_EMAILS__', list))
  console.log(`${name}.rules generated for ${emails.join(', ')}`)
}
