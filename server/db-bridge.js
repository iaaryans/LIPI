// server/db-bridge.js — LIPI Studio v12.0
// Express bridge: exposes roccoDB (Node-only, C++20 native addon) to the
// browser-side Lipi runtime over HTTP + SSE.
//
// Mount modes:
//   1. Standalone:  node server/db-bridge.js
//   2. Mounted:     const { createDbBridge } = require('./server/db-bridge');
//                   app.use('/api/db', createDbBridge().router);
//
// Requires: Node.js >= 18 (uses the built-in global `fetch` for the AI proxy)
//   npm i express cors helmet express-rate-limit multer firebase-admin roccodb-iaaryan
//
// Env vars:
//   PORT                         — default 4000
//   ALLOWED_ORIGIN               — CSV of allowed CORS origins (required in prod)
//   ROCCO_DB_PATH                — local folder for the roccoDB data dir (default ./data)
//   FIREBASE_SERVICE_ACCOUNT     — path to a Firebase service-account JSON file
//   DB_BRIDGE_DISABLE_AUTH       — 'true' to skip auth (LOCAL DEV ONLY — never in prod)
//   DB_BRIDGE_MAX_UPLOAD_MB      — max upload size in MB (default 15)
//   GROQ_API_KEY                 — server-side key for the /api/ai/chat proxy (never sent to the browser)
//   GROQ_MODEL                   — default 'llama-3.3-70b-versatile'

'use strict';

require('dotenv').config();
const path            = require('path');
const os               = require('os');
const fs               = require('fs/promises');
const crypto           = require('crypto');
const express           = require('express');
const cors              = require('cors');
const helmet            = require('helmet');
const rateLimit          = require('express-rate-limit');
const multer             = require('multer');
const { RoccoDB }        = require('roccodb-iaaryan');
const { getAuth } = require('firebase-admin/auth');

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────
const PORT              = parseInt(process.env.PORT || '4000', 10);
const DB_PATH           = process.env.ROCCO_DB_PATH || path.join(process.cwd(), 'data');
const AUTH_DISABLED     = process.env.DB_BRIDGE_DISABLE_AUTH === 'true';
const MAX_UPLOAD_BYTES  = (parseInt(process.env.DB_BRIDGE_MAX_UPLOAD_MB || '15', 10)) * 1024 * 1024;
const ALLOWED_ORIGINS   = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Collection name allow-list — mirrors roccoDB's "folder-based" storage model.
// Prevents path traversal / injection via collection names becoming folder names.
const COLLECTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ─────────────────────────────────────────────────────────────────────────
// FIREBASE ADMIN (auth verification) — lazy, optional
// ─────────────────────────────────────────────────────────────────────────
let admin = null;
if (!AUTH_DISABLED) {
    try {
        admin = require('firebase-admin');
        const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
        // Sirf initializeApp tab chalega jab admin available ho
        if (!admin.apps || admin.apps.length === 0) {
            admin.initializeApp(
                saPath
                    ? { credential: admin.credential.cert(require(path.resolve(saPath))) }
                    : { credential: admin.credential.applicationDefault() }
            );
        }
    } catch (err) {
        console.error(
            '[db-bridge] FATAL: firebase-admin could not be initialized. ' +
            'Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS, ' +
            'or set DB_BRIDGE_DISABLE_AUTH=true for local development only.\n',
            err.message
        );
        process.exitCode = 1;
        throw err;
    }
} else {
    console.warn('[db-bridge] ⚠ AUTH DISABLED — do not run this in production.');
}

/**
 * Verifies a Firebase ID token from either the Authorization header
 * (normal fetch/XHR calls) or a `token` query param (EventSource cannot
 * set custom headers, so SSE auth has to travel via the URL).
 */
async function requireAuth(req, res, next) {
    if (AUTH_DISABLED) { req.uid = 'dev-user'; return next(); }

    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const token  = bearer || req.query.token;

    if (!token) {
        return res.status(401).json({ error: 'Missing auth token.' });
    }
    try {
        const decoded = await getAuth().verifyIdToken(token);
        req.uid = decoded.uid;
        next();
    } catch (err) {
        console.warn('[db-bridge] Rejected invalid token:', err.message);
        res.status(401).json({ error: 'Invalid or expired auth token.' });
    }
}

// ─────────────────────────────────────────────────────────────────────────
// ROCCODB — single embedded instance for this Node process
// ─────────────────────────────────────────────────────────────────────────
const db = new RoccoDB(DB_PATH);

// Cache of opened collections so we don't re-open (and re-attach listeners)
// on every request.
const _collections = new Map();
function getCollection(name) {
    if (!_collections.has(name)) {
        _collections.set(name, db.collection(name));
    }
    return _collections.get(name);
}

// ─────────────────────────────────────────────────────────────────────────
// SSE FAN-OUT — one roccoDB onChange listener per collection, broadcast to
// every subscribed HTTP client. Avoids attaching N listeners for N tabs.
// ─────────────────────────────────────────────────────────────────────────
const _sseClients = new Map(); // collectionName -> Set<res>

function subscribeSSE(collectionName, res) {
    if (!_sseClients.has(collectionName)) {
        _sseClients.set(collectionName, new Set());

        // Attach the single underlying roccoDB listener for this collection.
        try {
            const col = getCollection(collectionName);
            col.onChange((event) => {
                broadcast(collectionName, event);
            });
        } catch (err) {
            console.error(`[db-bridge] Failed to attach onChange for "${collectionName}":`, err.message);
        }
    }
    _sseClients.get(collectionName).add(res);
}

function unsubscribeSSE(collectionName, res) {
    const set = _sseClients.get(collectionName);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) _sseClients.delete(collectionName);
    // Note: roccoDB's README does not currently expose an off()/removeListener
    // API, so the underlying native listener stays attached for the lifetime
    // of the process once a collection has been watched. This is safe (it's
    // a no-op broadcast to an empty client set) but is worth flagging as a
    // known limitation of the current roccoDB version.
}

function broadcast(collectionName, event) {
    const set = _sseClients.get(collectionName);
    if (!set || set.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
        res.write(payload);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// MULTER — temp disk storage, required because roccoDB's storage.upload()
// takes a local file path (per README), not a buffer/stream.
// ─────────────────────────────────────────────────────────────────────────
const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

// ─────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────
function createDbBridge() {
    const router = express.Router();

    router.use(helmet());
    router.use(cors({
        origin: (origin, cb) => {
            // Allow same-origin/non-browser requests (no Origin header) and
            // anything explicitly allow-listed.
            if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
                return cb(null, true);
            }
            cb(new Error('Not allowed by CORS'));
        },
        credentials: true,
    }));
    router.use(express.json({ limit: '2mb' }));

    router.use(rateLimit({
        windowMs: 60 * 1000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
    }));

    // ── POST /insert ────────────────────────────────────────────────────
    router.post('/insert', requireAuth, (req, res) => {
        try {
            const { collection, doc } = req.body || {};

            if (typeof collection !== 'string' || !COLLECTION_NAME_RE.test(collection)) {
                return res.status(400).json({ error: 'Invalid or missing "collection" name.' });
            }
            if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
                return res.status(400).json({ error: '"doc" must be a JSON object.' });
            }

            const col = getCollection(collection);
            const record = {
                ...doc,
                _createdBy: req.uid,
                _createdAt: Date.now(),
            };
            const id = col.insert(record);
            res.status(201).json({ id });
        } catch (err) {
            console.error('[db-bridge] insert failed:', err);
            res.status(500).json({ error: 'roccoDB insert failed.' });
        }
    });

    // ── GET /get?collection=&id= ────────────────────────────────────────
    router.get('/get', requireAuth, (req, res) => {
        try {
            const { collection, id } = req.query;

            if (typeof collection !== 'string' || !COLLECTION_NAME_RE.test(collection)) {
                return res.status(400).json({ error: 'Invalid or missing "collection" name.' });
            }
            if (typeof id !== 'string' || !id) {
                return res.status(400).json({ error: 'Missing "id".' });
            }

            const col = getCollection(collection);
            const doc = col.get(id);

            if (doc === undefined || doc === null) {
                return res.status(404).json({ error: 'Document not found.', doc: null });
            }
            res.json({ doc });
        } catch (err) {
            console.error('[db-bridge] get failed:', err);
            res.status(500).json({ error: 'roccoDB get failed.' });
        }
    });

    // ── GET /stream?collection=  (SSE, real-time onChange) ──────────────
    router.get('/stream', requireAuth, (req, res) => {
        const { collection } = req.query;

        if (typeof collection !== 'string' || !COLLECTION_NAME_RE.test(collection)) {
            return res.status(400).json({ error: 'Invalid or missing "collection" name.' });
        }

        res.writeHead(200, {
            'Content-Type':      'text/event-stream',
            'Cache-Control':     'no-cache, no-transform',
            'Connection':        'keep-alive',
            'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
        });
        res.write(`retry: 2000\n\n`);

        subscribeSSE(collection, res);

        // Heartbeat keeps the connection alive through proxies/load balancers.
        const heartbeat = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (_) { /* client gone */ }
        }, 25000);

        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribeSSE(collection, res);
        });
    });

    // ── POST /upload  (multipart/form-data, field name "file") ──────────
    router.post('/upload', requireAuth, (req, res) => {
        upload.single('file')(req, res, async (err) => {
            if (err) {
                const msg = err.code === 'LIMIT_FILE_SIZE'
                    ? `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit.`
                    : 'Upload failed.';
                return res.status(400).json({ error: msg });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'No file provided (expected field "file").' });
            }

            const tempPath = req.file.path;
            try {
                const { collection, meta } = req.body || {};
                if (collection && !COLLECTION_NAME_RE.test(collection)) {
                    return res.status(400).json({ error: 'Invalid "collection" name.' });
                }

                // roccoDB's storage.upload() takes a local file path (README §Image and File Storage).
                const imageRef = db.storage.upload(tempPath);

                let insertedId = null;
                if (collection) {
                    let parsedMeta = {};
                    if (meta) {
                        try { parsedMeta = JSON.parse(meta); }
                        catch { return res.status(400).json({ error: '"meta" must be valid JSON.' }); }
                    }
                    const col = getCollection(collection);
                    insertedId = col.insert({
                        ...parsedMeta,
                        file: imageRef,
                        originalName: req.file.originalname,
                        mimeType: req.file.mimetype,
                        size: req.file.size,
                        _createdBy: req.uid,
                        _createdAt: Date.now(),
                    });
                }

                res.status(201).json({ ref: imageRef, id: insertedId });
            } catch (err) {
                console.error('[db-bridge] upload failed:', err);
                res.status(500).json({ error: 'roccoDB storage.upload failed.' });
            } finally {
                // Always scrub the temp file — roccoDB copies/manages its own
                // storage internally, so nothing else needs this copy.
                fs.unlink(tempPath).catch(() => {});
            }
        });
    });

    // ── POST /ai/chat  (Groq proxy — key stays server-side) ─────────────
    // Mounted under the same router as /insert /get /upload, so from the
    // browser this is reachable at `${LIPI_DB_API}/ai/chat`.
    // [FIX-SECURITY] ai-panel.js previously called Groq directly from the
    // browser, which meant the API key had to live in frontend JS or the
    // user's localStorage — visible to anyone with devtools. This route
    // holds GROQ_API_KEY as a server env var and streams the SSE response
    // straight through to the authenticated client, so the key never
    // leaves the server process.
    const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
    const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

    router.post('/ai/chat', requireAuth, async (req, res) => {
        if (!GROQ_API_KEY) {
            return res.status(503).json({ error: 'AI assistant is not configured on this server (missing GROQ_API_KEY).' });
        }
        const { messages } = req.body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: '"messages" must be a non-empty array.' });
        }
        // Basic shape/size guard so the proxy can't be used to relay arbitrary payloads.
        if (messages.length > 60 || JSON.stringify(messages).length > 200_000) {
            return res.status(400).json({ error: 'Message history too large.' });
        }

        try {
            const upstream = await fetch(GROQ_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    messages,
                    max_tokens: 2048,
                    temperature: 0.35,
                    stream: true,
                }),
            });

            if (!upstream.ok || !upstream.body) {
                const detail = await upstream.text().catch(() => '');
                return res.status(upstream.status || 502).json({ error: `Groq upstream error: ${detail.slice(0, 300)}` });
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            const reader = upstream.body.getReader();
            req.on('close', () => reader.cancel().catch(() => {}));
            const decoder = new TextDecoder('utf-8');
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(decoder.decode(value, { stream: true }));
            }
            res.end();
        } catch (err) {
            console.error('[db-bridge] /ai/chat proxy failed:', err.message);
            if (!res.headersSent) res.status(502).json({ error: 'AI proxy request failed.' });
            else res.end();
        }
    });

    // ── Health check ──────────────────────────────────────────────────
    router.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

    // ── 404 + error handlers (scoped to this router) ────────────────────
    router.use((req, res) => res.status(404).json({ error: 'Not found.' }));
    router.use((err, req, res, next) => {
        console.error('[db-bridge] Unhandled error:', err);
        res.status(500).json({ error: 'Internal server error.' });
    });

    return { router, db };
}

// ─────────────────────────────────────────────────────────────────────────
// STANDALONE MODE
// ─────────────────────────────────────────────────────────────────────────
if (require.main === module) {
    const app = express();
    const { router } = createDbBridge();
    app.use('/api/db', router);

    const server = app.listen(PORT, () => {
        console.log(`[db-bridge] roccoDB bridge listening on :${PORT} (data dir: ${DB_PATH})`);
    });

    const shutdown = () => {
        console.log('[db-bridge] Shutting down...');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = { createDbBridge };
