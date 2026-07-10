# LIPI Studio — v12.0

LIPI is a small web-native programming language (its own lexer, Pratt-parser,
AST, and JS code generator) that runs in the browser, plus **LIPI Studio**: a
CodeMirror-based IDE with Firebase-backed multi-project sync, a live preview,
a console, an AI assistant, and a real database — **roccoDB**, a custom
C++20 embedded NoSQL store — wired in through a small Node.js/Express bridge.

This README documents the actual, current implementation only. Nothing here
describes a feature that isn't in the codebase.

---

## 1. Project structure

```
.
├── index.html            Landing page
├── account.html          Firebase auth (sign in / sign up)
├── editor.html            Studio shell (loads editor.js, project-manager.js, ai-panel.js, editor-sync.js, lipi.js)
├── editor.js               CodeMirror editor, RUN, Open App, Publish, Export App
├── editor-sync.js           Firebase init + auth observer (ES module)
├── project-manager.js      Multi-project CRUD + Firestore realtime sync + Publish/Unpublish
├── ai-panel.js              AI assistant UI — talks to the backend AI proxy only
├── lipi.js                  The LIPI language: Lexer, Parser, CodeGen, runtime, db bridge client
├── app.html                  Public, unauthenticated "published app" viewer
├── firestore.rules         Security rules (private projects + public `published/*`)
├── server/
│   └── db-bridge.js        Express bridge: roccoDB + Firebase-auth-verified REST/SSE API + AI proxy
├── .env.example
└── README.md
```

roccoDB itself (`roccodb-iaaryan` on npm) is a native C++20 Node addon and
**only runs inside Node.js** — never in the browser. `server/db-bridge.js` is
the only thing that talks to it directly; the browser talks to
`server/db-bridge.js` over HTTP + Server-Sent Events.

```
Browser (lipi.js: dbInsert/dbGet/dbUpload/dbOnChange)
        │  HTTPS + Firebase ID token
        ▼
server/db-bridge.js  (Express, verifies the token, then calls roccoDB)
        │
        ▼
roccoDB (C++20 engine, local folder storage, OUTSIDE any watched frontend dir)
```

---

## 2. Setup

### 2.1 Install dependencies

```bash
# Frontend has no build step — it's static HTML/JS.
# Backend bridge:
mkdir server && mv db-bridge.js server/db-bridge.js   # if not already there
cd server
npm init -y
npm install express cors helmet express-rate-limit multer firebase-admin roccodb-iaaryan
```

Node.js **18+** is required (the AI proxy uses the built-in global `fetch`).
`roccodb-iaaryan` contains a native addon — make sure you have build tools
available for your platform (e.g. `build-essential`/Xcode CLT/`windows-build-tools`).

### 2.2 Configure environment variables

Create `server/.env` (or export these in your process manager):

```bash
PORT=4000
ROCCO_DB_PATH=./data                 # roccoDB data folder — keep OUTSIDE your frontend's watched dir
ALLOWED_ORIGIN=http://localhost:5500,https://your-studio-domain.com

# Firebase Admin — verifies the ID tokens sent by the browser
FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json
# or rely on GOOGLE_APPLICATION_CREDENTIALS / applicationDefault()

# LOCAL DEV ONLY — never set this in production
DB_BRIDGE_DISABLE_AUTH=false

DB_BRIDGE_MAX_UPLOAD_MB=15

# AI assistant (Groq) — kept server-side only, never sent to the browser
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=llama-3.3-70b-versatile
```

Get a free Groq key at https://console.groq.com. If `GROQ_API_KEY` is unset,
the AI panel still loads — it just returns a clear "not configured" error
instead of a raw failure.

### 2.3 Run the backend bridge

```bash
cd server
node db-bridge.js
# [db-bridge] roccoDB bridge listening on :4000 (data dir: ./data)
```

### 2.4 Serve the frontend

Any static file server works — the Studio itself has no build step.

```bash
npx serve .           # or: python3 -m http.server 5500, nginx, Firebase Hosting, etc.
```

Open `index.html` → sign up/sign in via `account.html` → you land in
`editor.html` (Studio).

If your bridge isn't at `http://127.0.0.1:4000/api/db`, set
`window.LIPI_DB_API` before `lipi.js` loads — this is already wired up as a
small inline `<script>` block at the top of `editor.html` and `app.html`.

### 2.5 Deploy Firestore security rules

```bash
firebase deploy --only firestore:rules
```

See `firestore.rules` — private projects live under `users/{uid}/projects/*`
and are readable/writable only by their owner. Publishing writes a
deliberate, separate snapshot to `published/{projectId}`, which is
public-read but owner-only write. Publishing never makes your private
project tree readable by anyone else.

---

## 3. The LIPI language

```lipi
let x = 42
let name = "Ada"
let greeting = `Hi {name}!`

if x > 5 { log("big") } else if x == 3 { log("three") } else { log("small") }

func add(a, b) { return a + b }        # user functions are internally async

let box = #demo-box                     # DOM selection: #id or $("css selector")
on box.click {
  box.innerText = "clicked"
  wait(300)                             # pauses cleanly — no `await` needed in user code
  box.style.bg = "#7c3aed"              # style shortcuts: bg, fg, size, weight, radius, shadow...
}

for i in range(0, 10, 2) { log(i) }
for k in { a: 1, b: 2 } { log(k) }

let id = dbInsert("notes", { text: "hello" })   # async under the hood — no `await` written
let doc = dbGet("notes", id)
dbOnChange("notes", (evt) => log(evt))          # returns an unsubscribe function
```

**Execution model:** Source → Lexer → Parser → AST → CodeGen → JavaScript
(wrapped in an async IIFE) → `new Function(...)`. User-declared functions are
compiled to `async function` and calls to them are auto-awaited by the
compiler; `wait()`, `getInput()`, and the three one-shot roccoDB calls
(`dbInsert`, `dbGet`, `dbUpload`) are auto-awaited too. `dbOnChange` is
**not** auto-awaited — it returns an unsubscribe function synchronously.

Built-ins: `range len str int float bool type has` · array:
`append pop push sort reverse filter map find includes indexOf slice join
split sum avg copy deepCopy` · string: `upper lower trim replace startsWith
endsWith contains repeat split` · object: `keys values merge copy deepCopy
toJSON fromJSON` · DOM: `show hide clear setText setHTML queryAll addClass
removeClass toggleClass` · async: `wait/sleep`, `getInput`.

---

## 4. roccoDB integration — API reference

Four LIPI globals, unchanged from the original spec, all backed by
`server/db-bridge.js`:

| LIPI call | Backend route | Auth |
|---|---|---|
| `dbInsert(collection, doc)` → `id` | `POST /insert` | Firebase ID token required |
| `dbGet(collection, id)` → `doc \| null` | `GET /get` | Firebase ID token required |
| `dbUpload(fileOrSelector, collection?, meta?)` → `ref` | `POST /upload` (multipart) | Firebase ID token required |
| `dbOnChange(collection, cb)` → `unsubscribe()` | `GET /stream` (SSE) | Firebase ID token required |

Every insert/upload is stamped server-side with `_createdBy` (the verified
uid) and `_createdAt`. Collection names are restricted to
`[a-zA-Z0-9_-]{1,64}` to keep them safe as roccoDB's folder-based collection
names. The bridge fans a single roccoDB `onChange` listener per collection
out to every subscribed SSE client, so N open tabs/streams cost one native
listener, not N.

**Why data can't cause a reload loop:** `ROCCO_DB_PATH` must point outside
any directory your dev file-watcher/Live-Server watches. The bridge process
is a separate Node process from your static file server, so a roccoDB write
never touches a file your frontend dev server is watching.

**Why repeated RUN is safe:** `Lipi.run()` now tears down a run-session
registry before compiling/executing new code — every `dbOnChange` stream
opened by the previous run is closed first, so clicking RUN five times
leaves exactly one active subscription, not five.

---

## 5. Studio features

- **Run** — compiles and executes the current project in the live preview.
- **Open App** — bundles the current project into a self-contained HTML
  document (Blob URL) and opens it in a new tab with no Studio UI.
- **Publish** — writes a public snapshot to `published/{projectId}` in
  Firestore and shows a shareable URL (`app.html?id=...`). Anyone with the
  link can view a **read-only snapshot** of the app; it is not a live view
  of your editor, and it does not expose your other projects. **Unpublish**
  deletes the snapshot.
- **Export App** — downloads a runnable `.zip` (`index.html`, `lipi.js`,
  `project.lipi`, `README.md`) that runs on any static file host with zero
  build step. If the exported app uses `dbInsert`/`dbGet`/`dbUpload`/
  `dbOnChange`, it still needs a reachable `server/db-bridge.js` — the
  exported `README.md` inside the zip says so explicitly.
- **AI assistant** — a Lipi-language-aware chat panel. Requests go through
  `POST {LIPI_DB_API}/ai/chat`, an authenticated proxy that holds
  `GROQ_API_KEY` server-side and streams the model's response back. The key
  is never present in any frontend file or in `localStorage`.

---

## 6. Security notes

- The Groq API key lives only in `server/.env` on the backend; the browser
  never sees it (`server/db-bridge.js` → `/ai/chat`).
- roccoDB calls require a valid Firebase ID token, verified server-side with
  `firebase-admin`; `DB_BRIDGE_DISABLE_AUTH=true` is for local dev only and
  logs a warning on startup.
- Collection names are allow-listed to prevent path-traversal into roccoDB's
  folder-based storage.
- Publishing writes an explicit snapshot the owner chose to make public — it
  never grants read access to the private `users/{uid}/projects/*` tree (see
  `firestore.rules`).
- CORS is locked to `ALLOWED_ORIGIN` in production; set it before deploying.

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Lipi engine not loaded` in console | `lipi.js` failed to load before `editor.js` ran — check script order in `editor.html`. |
| `dbInsert`/`dbGet` reject with `401` | Missing/expired Firebase ID token, or the bridge's `FIREBASE_SERVICE_ACCOUNT` isn't configured. |
| Live Server keeps reloading after a DB write | `ROCCO_DB_PATH` points inside a folder your static dev server is watching — move it outside. |
| AI panel says "not configured on this server" | `GROQ_API_KEY` isn't set in the bridge's environment. |
| `dbOnChange` stops firing after several RUNs | Should no longer happen (session teardown fix in `lipi.js` §"RUN-SESSION REGISTRY") — if it does, check the browser console for SSE connection errors. |
| Publish button fails silently | Firestore rules not deployed, or the user isn't signed in. |

---

## 8. Original roccoDB package docs

The underlying `roccodb-iaaryan` npm package's own API (`RoccoDB`,
`db.collection()`, `.insert()`, `.get()`, `.onChange()`,
`db.storage.upload()`) is documented in that package directly — see
https://www.npmjs.com/package/roccodb-iaaryan. `server/db-bridge.js` is a
thin, security-hardened HTTP/SSE wrapper around exactly that API; it does
not add features roccoDB itself doesn't have (e.g. no update/delete, no
querying beyond get-by-id — those are upstream roccoDB limitations, not
bridge limitations).

## License

ISC
