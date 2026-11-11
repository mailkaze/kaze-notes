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
  writeBatch,
} from 'firebase/firestore'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

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
const inviteRef = (ctx: RulesTestContext, email: string, owner = ANA.uid, noteId = 'n1') =>
  doc(ctx.firestore(), 'invites', `${owner}:${noteId}:${email}`)
const invite = (email: string) => ({ ownerUid: ANA.uid, ownerEmail: ANA.email, noteId: 'n1', email, createdAt: 1 })

/** Nota de Ana con los campos de compartir dados, y las invitaciones pendientes de `invited`. */
async function seed(sharing: { invited?: string[]; members?: string[]; prefs?: object }) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(noteRef(ctx), {
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
    for (const email of sharing.invited ?? []) await setDoc(inviteRef(ctx, email), invite(email))
  })
}

// Mismas escrituras que firebase.ts: la nota y la invitación cambian juntas en un lote.
function share(ctx: RulesTestContext, email: string, data = invite(email)) {
  const batch = writeBatch(ctx.firestore())
  batch.set(inviteRef(ctx, email), data)
  batch.update(noteRef(ctx), { ownerEmail: ANA.email, invited: arrayUnion(email) })
  return batch.commit()
}

function acceptShare(ctx: RulesTestContext, email: string, extra: unknown[] = []) {
  const batch = writeBatch(ctx.firestore())
  batch.update(
    noteRef(ctx),
    new FieldPath('prefs', email),
    { folderId: null, order: 'a0', pinned: false, locked: false },
    'invited',
    arrayRemove(email),
    'members',
    arrayUnion(email),
    ...extra,
  )
  batch.delete(inviteRef(ctx, email))
  return batch.commit()
}

function removeShare(ctx: RulesTestContext, email: string) {
  const batch = writeBatch(ctx.firestore())
  batch.update(noteRef(ctx), new FieldPath('prefs', email), deleteField(), 'invited', arrayRemove(email), 'members', arrayRemove(email))
  batch.delete(inviteRef(ctx, email))
  return batch.commit()
}

const sharedQuery = (ctx: RulesTestContext, field: 'members' | 'invited', email: string) =>
  getDocs(query(collectionGroup(ctx.firestore(), 'notes'), where(field, 'array-contains', email)))
const invitesQuery = (ctx: RulesTestContext, email: string) =>
  getDocs(query(collection(ctx.firestore(), 'invites'), where('email', '==', email)))

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
    await assertSucceeds(share(ana, BOB.email))
    await assertSucceeds(getDoc(inviteRef(ana, BOB.email)))
    await assertSucceeds(removeShare(ana, BOB.email))
    await assertSucceeds(updateDoc(noteRef(ana), { ownerEmail: ANA.email, title: 'Renamed' }))
    await assertSucceeds(deleteDoc(noteRef(ana)))
  })

  it("the inviter's email on a note is always the owner's own (an invitation cannot pretend to come from someone else)", async () => {
    await seed({ invited: [], members: [] })
    const ana = as(ANA)
    await assertFails(updateDoc(noteRef(ana), { ownerEmail: BOB.email, invited: arrayUnion(CAROL.email) }))
    await assertFails(setDoc(noteRef(ana, ANA.uid, 'n2'), { title: 'x', ownerEmail: BOB.email, invited: [CAROL.email] }))
    await assertFails(share(ana, CAROL.email, { ...invite(CAROL.email), ownerEmail: BOB.email }))
    await assertSucceeds(setDoc(noteRef(ana, ANA.uid, 'n3'), { title: 'x' }))
    await assertSucceeds(setDoc(doc(ana.firestore(), 'users', ANA.uid, 'folders', 'f2'), { name: 'Work' }))
  })

  it('an invitation must name the owner, an existing note of theirs and match its id, with nothing else in it', async () => {
    await seed({ invited: [], members: [] })
    const ana = as(ANA)
    const db = ana.firestore()
    await assertFails(setDoc(doc(db, 'invites', `${BOB.uid}:n1:${CAROL.email}`), { ...invite(CAROL.email), ownerUid: BOB.uid }))
    await assertFails(setDoc(doc(db, 'invites', `${ANA.uid}:missing:${CAROL.email}`), { ...invite(CAROL.email), noteId: 'missing' }))
    await assertFails(setDoc(doc(db, 'invites', `${ANA.uid}:n1:${BOB.email}`), invite(CAROL.email)))
    await assertFails(setDoc(inviteRef(ana, CAROL.email), { ...invite(CAROL.email), title: 'Groceries' }))
    await assertSucceeds(setDoc(inviteRef(ana, CAROL.email), invite(CAROL.email)))
    // Una invitación no se modifica: se retira y, si hace falta, se crea otra.
    await assertFails(updateDoc(inviteRef(ana, CAROL.email), { createdAt: 2 }))
  })

  it('an unverified email or an account outside the allowlist gets nothing, not even its own data', async () => {
    await seed({ invited: [], members: [] })
    await assertFails(getDoc(noteRef(as(ANA, false))))
    await assertFails(setDoc(doc(as(DAN).firestore(), 'users', DAN.uid, 'notes', 'x'), { title: 'x' }))
  })
})

describe('pending invitee', () => {
  beforeEach(() => seed({ invited: [BOB.email, DAN.email], members: [] }))

  it('cannot read the note before accepting, but sees the invitation, which only says who sent it', async () => {
    const bob = as(BOB)
    await assertFails(getDoc(noteRef(bob)))
    await assertFails(sharedQuery(bob, 'invited', BOB.email))
    const found = await assertSucceeds(sharedQuery(bob, 'members', BOB.email))
    expect(found.size).toBe(0)
    const invites = await assertSucceeds(invitesQuery(bob, BOB.email))
    expect(invites.docs.map((d) => d.data())).toEqual([invite(BOB.email)])
  })

  it("cannot see other people's invitations", async () => {
    const bob = as(BOB)
    await assertFails(getDoc(inviteRef(bob, DAN.email)))
    await assertFails(invitesQuery(bob, DAN.email))
    await assertFails(getDocs(collection(as(ERIN).firestore(), 'invites')))
  })

  it('cannot edit the note or create invitations to it', async () => {
    const bob = as(BOB)
    await assertFails(setDoc(noteRef(bob), { title: 'Mine now' }, { merge: true }))
    await assertFails(setDoc(inviteRef(bob, CAROL.email), invite(CAROL.email)))
  })

  it('accepts: moves only their own email from invited to members, stores their prefs and removes the invitation', async () => {
    const bob = as(BOB)
    await assertSucceeds(acceptShare(bob, BOB.email))
    await assertSucceeds(getDoc(noteRef(bob)))
    const shared = await assertSucceeds(sharedQuery(bob, 'members', BOB.email))
    expect(shared.size).toBe(1)
    expect((await assertSucceeds(invitesQuery(bob, BOB.email))).size).toBe(0)
  })

  it('rejects: removes only their own email and the invitation', async () => {
    const bob = as(BOB)
    await assertSucceeds(removeShare(bob, BOB.email))
    await assertFails(getDoc(noteRef(bob)))
    expect((await assertSucceeds(invitesQuery(bob, BOB.email))).size).toBe(0)
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(inviteRef(ctx, DAN.email))).exists()).toBe(true)
    })
  })

  it('cannot accept on behalf of someone else, bring someone else in or change other fields while accepting', async () => {
    const bob = as(BOB)
    await assertFails(acceptShare(bob, DAN.email))
    await assertFails(acceptShare(bob, BOB.email, ['members', arrayUnion(BOB.email, CAROL.email)]))
    await assertFails(acceptShare(bob, BOB.email, ['title', 'Hijacked']))
  })

  it('an invited account outside the allowlist cannot read the note or its invitation, nor accept', async () => {
    const dan = as(DAN)
    await assertFails(getDoc(noteRef(dan)))
    await assertFails(invitesQuery(dan, DAN.email))
    await assertFails(acceptShare(dan, DAN.email))
  })
})

describe('member', () => {
  beforeEach(() => seed({ invited: [], members: [BOB.email, CAROL.email], prefs: { [CAROL.email]: { pinned: true } } }))

  it('reads the note and edits title, text and color and its own folder, order, pin and lock', async () => {
    const bob = as(BOB)
    await assertSucceeds(getDoc(noteRef(bob)))
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

  it('cannot remove another member, delete the note, invite people or create notes in the owner account', async () => {
    const bob = as(BOB)
    await assertFails(updateDoc(noteRef(bob), 'members', arrayRemove(CAROL.email)))
    await assertFails(deleteDoc(noteRef(bob)))
    await assertFails(setDoc(inviteRef(bob, ERIN.email), { ...invite(ERIN.email), ownerUid: BOB.uid }))
    await assertFails(setDoc(noteRef(bob, ANA.uid, 'new'), { title: 'x' }))
    await assertFails(getDocs(collection(bob.firestore(), 'users', ANA.uid, 'notes')))
    await assertFails(getDoc(doc(bob.firestore(), 'users', ANA.uid, 'folders', 'ana-folder')))
  })

  it('a shared write to a note that no longer exists is refused (it would create it)', async () => {
    await env.withSecurityRulesDisabled((ctx) => deleteDoc(noteRef(ctx)))
    await assertFails(setDoc(noteRef(as(BOB)), { title: 'Ghost' }, { merge: true }))
  })

  it('leaves: removes their email and prefs (there is no invitation left to delete), and then can no longer read it', async () => {
    const bob = as(BOB)
    await assertSucceeds(setDoc(noteRef(bob), { prefs: { [BOB.email]: { pinned: true } } }, { merge: true }))
    await assertSucceeds(removeShare(bob, BOB.email))
    await assertFails(getDoc(noteRef(bob)))
    await assertSucceeds(getDoc(noteRef(as(CAROL))))
  })

  it("is refused once the owner stops sharing with them; the owner's note stays", async () => {
    await assertSucceeds(removeShare(as(ANA), BOB.email))
    await assertFails(getDoc(noteRef(as(BOB))))
    await assertFails(setDoc(noteRef(as(BOB)), { title: 'Late edit' }, { merge: true }))
  })
})

describe('an allowed account the note was never shared with', () => {
  beforeEach(() => seed({ invited: [BOB.email], members: [CAROL.email] }))

  it('cannot read it or its invitations, list notes across accounts, invite itself or add itself', async () => {
    const erin = as(ERIN)
    await assertFails(getDoc(noteRef(erin)))
    await assertFails(getDocs(collectionGroup(erin.firestore(), 'notes')))
    await assertFails(getDoc(inviteRef(erin, BOB.email)))
    await assertFails(setDoc(inviteRef(erin, ERIN.email), invite(ERIN.email)))
    await assertFails(acceptShare(erin, ERIN.email))
    await assertFails(updateDoc(noteRef(erin), 'members', arrayUnion(ERIN.email)))
    const found = await assertSucceeds(sharedQuery(erin, 'members', ERIN.email))
    expect(found.size).toBe(0)
  })
})
