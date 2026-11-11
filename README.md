# Kaze Notes

Personal notes web app: Google sign-in, nested folders, drag & drop, rich text that round-trips with WhatsApp Web, checklists, inline attachments, colors, pins, trash, fuzzy search and automatic cloud sync. Runs entirely in the browser on Firebase (Auth, Firestore, Storage) — no backend.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in your Firebase web app config
npm run dev
```

Without Firebase (data stays in this browser, for development and e2e tests):

```bash
npm run dev:memory
```

## Firebase setup (one time)

1. **Authentication** → Sign-in method → enable **Google** (keep it as the only provider). Under *Settings → Authorized domains* add every domain that will serve the app (`localhost` is there by default; `<project-id>.web.app` and `<project-id>.firebaseapp.com` are added automatically).
2. **Firestore Database** → Create database (production mode, any region).
3. **Storage** → Get started. Since February 2026 Cloud Storage for Firebase requires the **Blaze** (pay-as-you-go) plan; the no-cost quota still applies (5 GB stored in `US-CENTRAL1`, `US-EAST1` or `US-WEST1`). Set a budget alert in Google Cloud Billing to stay safe.
4. Put your Firebase project id in `.firebaserc`, then deploy the security rules for your Google account (and, optionally, the app itself to Firebase Hosting):

```bash
npm install -g firebase-tools   # once
firebase login
OWNER_EMAIL=you@gmail.com npm run rules:deploy    # rules
firebase deploy --only hosting                    # app → https://<project-id>.web.app (builds it first)
```

Deploys are guarded by `predeploy` hooks in `firebase.json`: a hosting deploy always runs `npm run build` first (so a test build never ships), and any deploy that includes the rules regenerates them from `OWNER_EMAIL`, so a plain `firebase deploy` without it stops instead of uploading stale local rules.

The rules are generated from `firestore.rules.template` and `storage.rules.template` with `OWNER_EMAIL` (the generated `firestore.rules` / `storage.rules` are git-ignored). To let more people use the app, list every account comma-separated, e.g. `OWNER_EMAIL=you@gmail.com,friend@gmail.com`; each deploy replaces the previous list, so always pass all of them. Only those Google accounts, with a verified email, can read and write their own data under `users/{uid}` (nobody sees anyone else's notes), with a 100 MB limit per attachment. Any other account can sign in but gets permission errors. Attachments are displayed through Firebase download URLs, which carry an unguessable token: anyone who gets one of those URLs can open that file.

Recommended: in Google Cloud Console → *APIs & Services → Credentials*, restrict the browser API key to your app's domains.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server against Firebase (`.env.local`) |
| `npm run dev:memory` | Dev server with the in-browser backend |
| `npm run build` | Type-check and production build into `dist/` |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright, in-browser backend) |
| `npm run test:e2e:offline` | Offline tests on a production-style build with the in-browser backend, served with the production CSP (built into `dist-e2e`, never `dist`) |
| `OWNER_EMAIL=… npm run rules:deploy` | Generate the security rules for the allowed account(s) and deploy them |

## Offline

After the first visit the app works with no connection, and syncs by itself when the connection comes back:

- **The app itself**: the production build writes `dist/sw.js`, a service worker that saves every file of that build (HTML, code, styles, icons). The app always opens from that copy, with or without network. The previous version stays saved too, so a page still running it keeps working.
- **Notes and folders**: Firestore keeps them in the browser and queues the changes made offline; they are sent when the connection returns.
- **Attachments**: a file added offline (or whose upload fails because of the network) is saved on the device first. Its chip shows "Esperando conexión" with a local preview, and it uploads automatically when the connection returns or the app opens again, even after a reload. "Pendiente de subir" means another device still has to upload it. Files the cloud refuses (100 MB or more, permissions, quota) show "Error al subir" and are not retried. Images already viewed stay available offline (the latest 100; when the app reaches half of the browser's storage quota the oldest half is dropped, so they never crowd out notes or queued files); other file types open in a new tab and need the network. After a network failure an upload is retried later, waiting longer after each failure in a row (from 30 seconds up to 15 minutes).
- **Updates**: the app looks for a new version on each load, when the connection comes back and when you return to it (at most once a minute). When one is installed it shows "Hay una versión nueva · Recargar"; reloading saves pending edits first.
- The app asks the browser for persistent storage, so local data that is not synced yet is not evicted when the device runs low on space. On iPhone and iPad, Safari deletes a website's data after about 7 days without visiting it unless the app is added to the home screen: add it there if you edit offline.
- If the cloud rejects a change (for example after losing permission), the text is not lost: it stays on the device, the note explains it, and it is sent again with the next edit (or can be discarded).

Nothing from Firestore, Auth or Firebase's reserved `/__/` pages goes through the service worker, and it never runs in `npm run dev`.

Emergency switch, if a broken version ever gets stuck on devices: deploy a build whose `sw.js` is replaced by a worker that, on `install`, calls `self.skipWaiting()` and, on `activate`, deletes every cache whose name starts with `kaze-`, calls `self.registration.unregister()` and reloads each window client (`client.navigate(client.url)`), and remove the `registerServiceWorker()` call from `src/main.tsx` in that same build (otherwise each reload registers it again). Clients pick it up on their next load, because `sw.js` is served with `Cache-Control: no-cache`.

## Signing out

Signing out first sends what is pending and waits a few seconds for the cloud. If something is still not synced (offline edits, files waiting to upload, rejected text), the app asks before deleting it. Signing out removes this account's data from the device: the notes cache, queued files, cached attachments and rejected text. Interface preferences (theme, layout, sidebar) stay. Other open tabs of the app reload when the session ends; if one of them still holds the notes cache, it is removed the next time the app opens with nobody signed in (signing in again with the same account keeps it as that account's cache).

## Security headers

`firebase.json` sends a Content-Security-Policy and other security headers with the app page (`/` and `/index.html`) only, so Firebase's own sign-in pages under `/__/` keep theirs. The inline theme script in `index.html` is allowed by its hash: if you change it, update the hash (`src/hosting.test.ts` fails until you do). Try header changes on a preview channel before going live: `firebase hosting:channel:deploy preview` (then sign in and open notes and attachments on each device you use).

## Handwriting

On an iPad, write with the Apple Pencil anywhere in a note: a handwriting area appears where the pencil lands and grows as you write near its bottom. Your finger scrolls and edits text as usual. While the pencil is in use the note is not editable, so iPadOS Scribble cannot turn the strokes into text; a tap with your finger makes it editable again. Strokes are saved inside the note as vector points, so they scale with the note's width.

## WhatsApp compatibility

Copying from a note puts WhatsApp syntax on the clipboard: `*bold*`, `_italic_`, `~strike~`, `- ` bullets and `☐` / `☑` checkboxes. Pasting WhatsApp text (with those markers) restores the formatting. WhatsApp has no underline, so underline stays inside the app only.

## Protected notes

The fingerprint button in a note's header protects it. A protected note shows only its title in lists, the sidebar and the trash. Search matches only its title. Opening it asks the device to verify you (fingerprint, Face ID, pattern or PIN) through WebAuthn with the device's own authenticator. Each device is registered the first time it verifies you. The note locks again when you leave it, and when you come back to the app after it has been hidden for a minute or more (another app, a locked screen); a shorter absence, like picking a file or taking a photo to attach, keeps it open. Protection hides the content only: a protected note can still be moved, pinned, colored or moved to the trash without verifying. It is a lock in the app, not encryption: the note is stored like any other.

This only locks the interface. The content is still stored unencrypted in Firestore and in the browser's offline cache, so it does not protect against someone who has access to your account or to the device's browser data.

## Data model

- `users/{uid}/folders/{id}` — `name`, `parentId`, `order`
- `users/{uid}/notes/{id}` — `title`, `content` (TipTap JSON string), `preview`, `folderId`, `order`, `pinned`, `locked`, `color`, `trashed`, `trashedAt`, plus `rev`/`baseRev`/`device` stamped on each title/content save (a save based on an older `rev` than the one a device holds keeps that device's version as a "(conflict)" copy; notes from older app versions have none)
- Storage: `users/{uid}/notes/{noteId}/{timestamp}-{random}-{file}`

`order` fields are fractional-index keys, so reordering only rewrites the moved item.
