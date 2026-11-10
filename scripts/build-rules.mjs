// Genera firestore.rules y storage.rules a partir de las plantillas con el correo de la cuenta propietaria.
// Uso: OWNER_EMAIL=tu@gmail.com npm run rules:deploy
import { readFileSync, writeFileSync } from 'node:fs'

const email = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase()
// Solo un correo simple: evita inyectar comillas o código en las reglas.
if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
  console.error('Set OWNER_EMAIL to the Google account allowed to use the app, e.g.\n  OWNER_EMAIL=you@gmail.com npm run rules:deploy')
  process.exit(1)
}

for (const name of ['firestore', 'storage']) {
  const template = readFileSync(`${name}.rules.template`, 'utf8')
  if (!template.includes('__OWNER_EMAIL__')) throw new Error(`${name}.rules.template has no __OWNER_EMAIL__ placeholder`)
  writeFileSync(`${name}.rules`, template.replaceAll('__OWNER_EMAIL__', email))
  console.log(`${name}.rules generated for ${email}`)
}
