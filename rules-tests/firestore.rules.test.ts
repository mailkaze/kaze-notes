import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  arrayRemove,
  arrayUnion,
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  FieldPath,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

// Reglas de firestore.rules.template contra el emulador (npm run test:rules). Las escrituras imitan las de
// src/lib/backend/firebase.ts: share, acceptShare, removeShare y setSharedNote.

const ANA = { uid: 'ana', email: 'ana@x.test' }
const BOB = { uid: 'bob', email: 'bob@x.test' }
const CAROL = { uid: 'carol', email: 'carol@x.test' }
// Permitida, pero nadie le comparte nada.
const ERIN = { uid: 'erin', email: 'erin@x.test' }
// Invitado, pero fuera de la lista de cuentas permitidas.
const DAN = { uid: 'dan', email: 'dan@x.test' }

let env: RulesTestEnvironment

const rules = readFileSync('firestore.rules.template', 'utf8').replaceAll(
  '__OWNER_EMAILS__',
  [ANA, BOB, CAROL, ERIN].map((u) => `'${u.email}'`).join(', '),
)

const as = (u: { uid: string; email: string }, verified = true): RulesTestContext =>
  env.authenticatedContext(u.uid, { email: u.email, email_verified: verified })
const noteRef = (ctx: RulesTestContext, owner = ANA.uid, id = 'n1') => doc(ctx.firestore(), 'users', owner, 'notes', id)

/** Nota de Ana con los campos de compartir dados. */
async function seed(sharing: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', ANA.uid, 'notes', 'n1'), {
      title: 'Groceries',
      content: '{}',
      preview: '',
      folderId: 'ana-folder',
      order: 'a0',
      pinned: false,
      locked: false,
      color: null,
      trashed: false,
      trashedAt: null,
      createdAt: 1,
      updatedAt: 1,
      ownerEmail: ANA.email,
      ...sharing,
    })
    await setDoc(doc(ctx.firestore(), 'users', ANA.uid, 'folders', 'ana-folder'), { name: 'Home' })
  })
}

const acceptShare = (ctx: RulesTestContext, email: string, extra: unknown[] = []) =>
  updateDoc(
    noteRef(ctx),
    new FieldPath('prefs', email),
    { folderId: null, order: 'a0', pinned: false, locked: false },
    'invited',
    arrayRemove(email),
    'members',
    arrayUnion(email),
    ...extra,
  )

const removeShare = (ctx: RulesTestContext, email: string) =>
  updateDoc(noteRef(ctx), new FieldPath('prefs', email), deleteField(), 'invited', arrayRemove(email), 'members', arrayRemove(email))

const sharedQuery = (ctx: RulesTestContext, field: 'members' | 'invited', email: string) =>
  getDocs(query(collectionGroup(ctx.firestore(), 'notes'), where(field, 'array-contains', email)))

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-kaze-notes', firestore: { rules } })
})

afterAll(async () => {
  await env?.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
})

describe('owner (unchanged behavior)', () => {
  it('reads and writes everything in their account, shares and stops sharing', async () => {
    await seed({ invited: [], members: [] })
    const ana = as(ANA)
    await assertSucceeds(getDoc(noteRef(ana)))
    await assertSucceeds(getDocs(collection(ana.firestore(), 'users', ANA.uid, 'notes')))
    await assertSucceeds(updateDoc(noteRef(ana), { ownerEmail: ANA.email, invited: arrayUnion(BOB.email) }))
    await assertSucceeds(updateDoc(noteRef(ana), 'invited', arrayRemove(BOB.email), 'members', arrayRemove(BOB.email)))
    await assertSucceeds(deleteDoc(noteRef(ana)))
  })

  it('an unverified email or an account outside the allowlist gets nothing, not even its own data', async () => {
    await seed({ invited: [], members: [] })
    await assertFails(getDoc(noteRef(as(ANA, false))))
    await assertFails(setDoc(doc(as(DAN).firestore(), 'users', DAN.uid, 'notes', 'x'), { title: 'x' }))
  })
})

describe('pending invitee', () => {
  beforeEach(() => seed({ invited: [BOB.email, DAN.email], members: [] }))

  it('reads the note and finds it with the invitations query', async () => {
    const bob = as(BOB)
    await assertSucceeds(getDoc(noteRef(bob)))
    await assertSucceeds(sharedQuery(bob, 'invited', BOB.email))
    await assertSucceeds(sharedQuery(bob, 'members', BOB.email))
  })

  it('cannot edit the note before accepting', async () => {
    await assertFails(setDoc(noteRef(as(BOB)), { title: 'Mine now' }, { merge: true }))
  })

  it('accepts: moves only their own email from invited to members and stores their prefs (email key with dots)', async () => {
    const bob = as(BOB)
    await assertSucceeds(acceptShare(bob, BOB.email))
    const docs = await assertSucceeds(sharedQuery(bob, 'members', BOB.email))
    if (docs.size !== 1) throw new Error(`expected 1 shared note, got ${docs.size}`)
  })

  it('rejects: removes only their own email', async () => {
    await assertSucceeds(removeShare(as(BOB), BOB.email))
    await assertFails(getDoc(noteRef(as(BOB))))
  })

  it('cannot accept on behalf of someone else, bring someone else in or change other fields while accepting', async () => {
    const bob = as(BOB)
    await assertFails(acceptShare(bob, DAN.email))
    await assertFails(acceptShare(bob, BOB.email, ['members', arrayUnion(BOB.email, CAROL.email)]))
    await assertFails(acceptShare(bob, BOB.email, ['title', 'Hijacked']))
  })

  it('an invited account outside the allowlist cannot read or accept', async () => {
    const dan = as(DAN)
    await assertFails(getDoc(noteRef(dan)))
    await assertFails(acceptShare(dan, DAN.email))
  })
})

describe('member', () => {
  beforeEach(() => seed({ invited: [], members: [BOB.email, CAROL.email], prefs: { [CAROL.email]: { pinned: true } } }))

  it('edits title, text and color and its own folder, order, pin and lock', async () => {
    const bob = as(BOB)
    await assertSucceeds(
      setDoc(
        noteRef(bob),
        { title: 'T', content: 'C', preview: 'P', color: 'sky', rev: 2, baseRev: 1, device: 'd', updatedAt: 9 },
        { merge: true },
      ),
    )
    await assertSucceeds(
      setDoc(noteRef(bob), { prefs: { [BOB.email]: { folderId: 'bob-folder', order: 'a1', pinned: true, locked: true } } }, { merge: true }),
    )
  })

  it("cannot trash it, move it in the owner's folders, rename the owner, change the lists or someone else's prefs", async () => {
    const bob = as(BOB)
    for (const change of [
      { trashed: true },
      { folderId: null },
      { pinned: true },
      { ownerEmail: BOB.email },
      { createdAt: 5 },
      { members: [BOB.email, CAROL.email, DAN.email] },
      { invited: [DAN.email] },
      { prefs: { [CAROL.email]: { pinned: false } } },
      { prefs: { [BOB.email]: { evil: 'x' } } },
    ]) {
      await assertFails(setDoc(noteRef(bob), change, { merge: true }))
    }
  })

  it('cannot remove another member, delete the note or create notes in the owner account', async () => {
    const bob = as(BOB)
    await assertFails(updateDoc(noteRef(bob), 'members', arrayRemove(CAROL.email)))
    await assertFails(deleteDoc(noteRef(bob)))
    await assertFails(setDoc(noteRef(bob, ANA.uid, 'new'), { title: 'x' }))
    await assertFails(getDocs(collection(bob.firestore(), 'users', ANA.uid, 'notes')))
    await assertFails(getDoc(doc(bob.firestore(), 'users', ANA.uid, 'folders', 'ana-folder')))
  })

  it('a shared write to a note that no longer exists is refused (it would create it)', async () => {
    await env.withSecurityRulesDisabled((ctx) => deleteDoc(noteRef(ctx)))
    await assertFails(setDoc(noteRef(as(BOB)), { title: 'Ghost' }, { merge: true }))
  })

  it('leaves: removes their email and prefs, and then can no longer read it', async () => {
    const bob = as(BOB)
    await assertSucceeds(setDoc(noteRef(bob), { prefs: { [BOB.email]: { pinned: true } } }, { merge: true }))
    await assertSucceeds(removeShare(bob, BOB.email))
    await assertFails(getDoc(noteRef(bob)))
    await assertSucceeds(getDoc(noteRef(as(CAROL))))
  })

  it("is refused once the owner stops sharing with them; the owner's note stays", async () => {
    await assertSucceeds(updateDoc(noteRef(as(ANA)), 'members', arrayRemove(BOB.email)))
    await assertFails(getDoc(noteRef(as(BOB))))
    await assertFails(setDoc(noteRef(as(BOB)), { title: 'Late edit' }, { merge: true }))
  })
})

describe('an allowed account the note was never shared with', () => {
  beforeEach(() => seed({ invited: [BOB.email], members: [CAROL.email] }))

  it('cannot read it, list notes across accounts or add itself; its own shared queries come back empty', async () => {
    const erin = as(ERIN)
    await assertFails(getDoc(noteRef(erin)))
    await assertFails(getDocs(collectionGroup(erin.firestore(), 'notes')))
    await assertFails(acceptShare(erin, ERIN.email))
    await assertFails(updateDoc(noteRef(erin), 'members', arrayUnion(ERIN.email)))
    const found = await assertSucceeds(sharedQuery(erin, 'members', ERIN.email))
    if (found.size !== 0) throw new Error('an unshared note leaked into the shared query')
  })
})
