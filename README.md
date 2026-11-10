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
npm run build && firebase deploy --only hosting   # app → https://<project-id>.web.app
```

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
| `OWNER_EMAIL=… npm run rules:deploy` | Generate the security rules for the allowed account(s) and deploy them |

## Handwriting

On an iPad, write with the Apple Pencil anywhere in a note: a handwriting area appears where the pencil lands and grows as you write near its bottom. Your finger scrolls and edits text as usual. While the pencil is in use the note is not editable, so iPadOS Scribble cannot turn the strokes into text; a tap with your finger makes it editable again. Strokes are saved inside the note as vector points, so they scale with the note's width.

## WhatsApp compatibility

Copying from a note puts WhatsApp syntax on the clipboard: `*bold*`, `_italic_`, `~strike~`, `- ` bullets and `☐` / `☑` checkboxes. Pasting WhatsApp text (with those markers) restores the formatting. WhatsApp has no underline, so underline stays inside the app only.

## Data model

- `users/{uid}/folders/{id}` — `name`, `parentId`, `order`
- `users/{uid}/notes/{id}` — `title`, `content` (TipTap JSON string), `preview`, `folderId`, `order`, `pinned`, `color`, `trashed`, `trashedAt`
- Storage: `users/{uid}/notes/{noteId}/{timestamp}-{file}`

`order` fields are fractional-index keys, so reordering only rewrites the moved item.
