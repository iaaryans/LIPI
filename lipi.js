/* ============================================================
   LIPI ENGINE v3.0 — PRODUCTION-GRADE AST COMPILER
   Architecture: Lexer → Parser → AST → Code Generator → Runtime
   
   CHANGELOG from v10.0:
   ─────────────────────────────────────────────────────────────
   [FIX-CRITICAL] callExpr no longer blindly injects `await`.
     Only user-defined functions, `wait`, and `getInput` are awaited.
     This fixes broken output like `(await console.log(...))`.
   
   [FIX-CRITICAL] `on target.event` codegen now handles both
     __sel_ identifiers AND plain variable expressions correctly.
   
   [FIX-CRITICAL] `for key in obj` now correctly iterates object
     keys (Object.keys) and array indices/values appropriately.
   
   [FIX] `new Function(js)()` upgraded to properly surface async
     errors via .catch() so runtime errors always show in console.
   
   [FIX] style shortcut map: box.style.bg → backgroundColor,
     box.style.fg → color, box.style.size → fontSize, etc.
   
   [NEW] `print` builtin added (alias for log).
   
   [NEW] `++` and `--` postfix/prefix increment operators.
   
   [NEW] `**` exponentiation operator.
   
   [NEW] `delete obj.key` statement support.
   
   [NEW] `typeof expr` unary operator.
   
   [NEW] Ternary expression: `x if cond else y` (Python-style).
   
   [NEW] String interpolation via backtick syntax: `hello {name}`.
   
   [NEW] Additional builtins: len(), keys(), values(), str(), 
     bool(), abs(), max(), min(), round(), floor(), ceil(),
     type(), push(), pop(), append(), has(), random().
   
   [NEW] `assert cond` statement for debugging.
   
   [NEW] Compound assignment operators: //= (floor div), **=.
   
   [NEW] Named function calls are auto-detected as async when
     the function is declared async in the current scope — the
     compiler now tracks user-declared function names and awaits
     them correctly.
   
   [IMPROVED] Error messages include compiled JS snippet for
     debugging when a JS syntax error occurs.
   
   [IMPROVED] Runtime fully exposes Math, JSON, Object, Array,
     console, Date so user code can access them directly.
   ============================================================ */

(function () {
  "use strict";

  function __iterKeys(obj) {
  if (obj == null) return [];

  if (typeof obj === "number") {
    const a = [];
    for (let i = 0; i < obj; i++) a.push(i);
    return a;
  }

  if (Array.isArray(obj) || typeof obj === "string") return obj;
  if (typeof obj[Symbol.iterator] === "function") return obj;

  return Object.keys(obj);
}

window.__iterKeys = __iterKeys;

  const Lipi = {
    // DOM selector helper
    $: (sel) => {
      const id = sel.replace(/^#/, "");
      const direct = document.getElementById(id);
      if (direct) return direct;
      const roots = [
        document.getElementById("app-preview"),
        document.getElementById("fs-body"),
      ].filter(Boolean);
      for (const root of roots) {
        const el = root.querySelector(sel);
        if (el) return el;
      }
      return null;
    },

    init: () => {
      // ── Core async helpers ──
      window.__wait  = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));
      window.__input = (promptText) =>
        new Promise((resolve) => {
          const consoleDiv = document.getElementById("console");
          if (!consoleDiv) {
            resolve(window.prompt(promptText || "Input:") ?? "");
            return;
          }
          const line = document.createElement("div");
          line.className = "mb-1 flex items-center gap-2 font-mono text-xs";
          line.innerHTML = `<span class="text-violet-400 shrink-0">? ${promptText || "Input:"}</span>`;
          const inp = document.createElement("input");
          inp.className = "bg-transparent border-none outline-none text-white flex-1 font-mono text-xs";
          inp.style.caretColor = "#8b5cf6";
          inp.autocomplete = "off";
          line.appendChild(inp);
          consoleDiv.appendChild(line);
          consoleDiv.scrollTop = consoleDiv.scrollHeight;
          inp.focus();
          inp.onkeydown = (e) => {
            if (e.key === "Enter") {
              const val = inp.value;
              line.innerHTML = `<span class="text-violet-400 shrink-0">? ${promptText || "Input:"}</span><span class="text-white ml-2">${val}</span>`;
              resolve(val);
            }
          };
        });

      // ── DOM selector available as $ ──
      window.__lipiSel = (sel) => Lipi.$(sel);

      // ─────────────────────────────────────────────
      // roccoDB BRIDGE — dbInsert / dbGet / dbUpload / dbOnChange
      // Talks to the Express bridge (server/db-bridge.js) since roccoDB
      // itself only runs inside Node, never in the browser.
      // ─────────────────────────────────────────────

      // Base URL for the bridge. Override before Lipi.init() runs, e.g.
      // window.LIPI_DB_API = 'https://api.myapp.com/db';
      window.LIPI_DB_API = 'https://lipi-backend-okzg.onrender.com/api/db';

      async function _dbAuthToken() {
        try {
          if (typeof window._SyncAPI?.getIdToken === 'function') {
            return await window._SyncAPI.getIdToken();
          }
        } catch (e) {
          console.warn(`[roccoDB] Could not read auth token: ${e.message}`);
        }
        return null;
      }

      async function _dbFetch(path, options = {}) {
        const token   = await _dbAuthToken();
        const headers = Object.assign(
          { 'Content-Type': 'application/json' },
          options.headers || {}
        );
        if (token) headers['Authorization'] = `Bearer ${token}`;

        let res;
        try {
          res = await fetch(`${window.LIPI_DB_API}${path}`, { ...options, headers });
        } catch (netErr) {
          throw new Error(`network error reaching db bridge (${netErr.message})`);
        }

        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json()).error || ''; } catch (_) {}
          throw new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
        }
        return res.json();
      }

      // dbInsert(collection, doc) → id
      window.dbInsert = async (collection, doc) => {
        try {
          if (typeof collection !== 'string' || !collection) {
            throw new Error('dbInsert: "collection" must be a non-empty string');
          }
          if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
            throw new Error('dbInsert: "doc" must be an object');
          }
          const data = await _dbFetch('/insert', {
            method: 'POST',
            body: JSON.stringify({ collection, doc }),
          });
          return data.id;
        } catch (e) {
          console.error(`[roccoDB] dbInsert("${collection}") failed: ${e.message}`);
          throw e;
        }
      };

      // dbGet(collection, id) → object | null
      window.dbGet = async (collection, id) => {
        try {
          if (typeof collection !== 'string' || !collection) {
            throw new Error('dbGet: "collection" must be a non-empty string');
          }
          if (!id) throw new Error('dbGet: "id" is required');
          const qs = new URLSearchParams({ collection, id });
          const data = await _dbFetch(`/get?${qs.toString()}`, { method: 'GET' });
          return data.doc ?? null;
        } catch (e) {
          console.error(`[roccoDB] dbGet("${collection}", "${id}") failed: ${e.message}`);
          throw e;
        }
      };

      // dbUpload(fileOrSelector, collection?, meta?) → storage ref
      // fileOrSelector: a File/Blob, a "#fileInput" selector, or an <input type=file>
      window.dbUpload = async (fileOrSelector, collection, meta) => {
        let file = fileOrSelector;
        try {
          if (typeof fileOrSelector === 'string') {
            const el = Lipi.$(fileOrSelector);
            file = el?.files?.[0];
          } else if (typeof HTMLInputElement !== 'undefined' && fileOrSelector instanceof HTMLInputElement) {
            file = fileOrSelector.files?.[0];
          }
          if (!(file instanceof Blob)) {
            throw new Error('expected a File/Blob, a file-input selector, or an <input type="file"> element');
          }

          const token = await _dbAuthToken();
          const form  = new FormData();
          form.append('file', file, file.name || 'upload.bin');
          if (collection) form.append('collection', collection);
          if (meta)       form.append('meta', JSON.stringify(meta));

          const headers = {};
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const res = await fetch(`${window.LIPI_DB_API}/upload`, {
            method: 'POST', headers, body: form,
          });
          if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).error || ''; } catch (_) {}
            throw new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
          }
          const data = await res.json();
          return data.ref;
        } catch (e) {
          console.error(`[roccoDB] dbUpload failed: ${e.message}`);
          throw e;
        }
      };

      // dbOnChange(collection, callback) → unsubscribe()
      // NOT auto-awaited by the compiler — it's a subscription, not a
      // one-shot value. Reconnects with backoff if the stream drops.
      window.dbOnChange = (collection, callback) => {
        if (typeof collection !== 'string' || !collection) {
          console.error('[roccoDB] dbOnChange: "collection" must be a non-empty string');
          return () => {};
        }
        if (typeof callback !== 'function') {
          console.error('[roccoDB] dbOnChange: a callback function is required');
          return () => {};
        }

        let es        = null;
        let closed     = false;
        let retryDelay = 1000;
        // Bind this subscription to the run that created it. If a new RUN
        // starts (session id bumps), stop retrying/reconnecting even if a
        // stray timeout fires — prevents cross-session callback bleed.
        const mySessionId = _runSession.id;
        const deregister = _runSession.register(() => { closed = true; es?.close(); });

        const connect = async () => {
          if (closed || _runSession.id !== mySessionId) return;
          try {
            const token = await _dbAuthToken();
            const qs = new URLSearchParams({ collection });
            if (token) qs.set('token', token); // EventSource can't send headers
            es = new EventSource(`${window.LIPI_DB_API}/stream?${qs.toString()}`);

            es.onopen = () => { retryDelay = 1000; };
            es.onmessage = (evt) => {
              try { callback(JSON.parse(evt.data)); }
              catch (e) { console.error(`[roccoDB] dbOnChange("${collection}") bad payload: ${e.message}`); }
            };
            es.onerror = () => {
              console.warn(`[roccoDB] dbOnChange("${collection}") connection lost — retrying in ${retryDelay}ms`);
              es?.close();
              if (!closed) setTimeout(connect, Math.min((retryDelay *= 2), 15000));
            };
          } catch (e) {
            console.error(`[roccoDB] dbOnChange("${collection}") failed to connect: ${e.message}`);
            if (!closed) setTimeout(connect, Math.min((retryDelay *= 2), 15000));
          }
        };
        connect();

        return () => { closed = true; es?.close(); deregister(); };
      };

      // ── Standard builtins ──
      window.range = (start, end, step) => {
        if (end === undefined) { end = start; start = 0; }
        step = step ?? 1;
        const a = [];
        if (step > 0) { for (let i = start; i < end; i += step) a.push(i); }
        else          { for (let i = start; i > end; i += step) a.push(i); }
        return a;
      };

      window.len = (x) => {
        if (x === null || x === undefined) return 0;
        if (typeof x === "string" || Array.isArray(x)) return x.length;
        if (typeof x === "object") return Object.keys(x).length;
        return 0;
      };

      window.keys   = (obj) => Object.keys(obj ?? {});
      window.values = (obj) => Object.values(obj ?? {});
      window.items  = (obj) => Object.entries(obj ?? {});
      window.has    = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

      window.str    = (v) => String(v ?? "");
      window.int    = (v) => parseInt(v, 10);
      window.float  = (v) => parseFloat(v);
      window.bool   = (v) => Boolean(v);
      window.num    = (v) => Number(v);

      window.abs    = (v) => Math.abs(v);
      window.max    = (...args) => args.length === 1 && Array.isArray(args[0]) ? Math.max(...args[0]) : Math.max(...args);
      window.min    = (...args) => args.length === 1 && Array.isArray(args[0]) ? Math.min(...args[0]) : Math.min(...args);
      window.round  = (v, d) => d !== undefined ? parseFloat(v.toFixed(d)) : Math.round(v);
      window.floor  = (v) => Math.floor(v);
      window.ceil   = (v) => Math.ceil(v);
      window.sqrt   = (v) => Math.sqrt(v);
      window.pow    = (b, e) => Math.pow(b, e);
      window.random = (a, b) => {
        if (a === undefined) return Math.random();
        if (b === undefined) return Math.floor(Math.random() * a);
        return Math.floor(Math.random() * (b - a) + a);
      };

      window.type   = (v) => {
        if (v === null) return "null";
        if (Array.isArray(v)) return "array";
        return typeof v;
      };

      // Array helpers
      window.push   = (arr, ...items) => { arr.push(...items); return arr; };
      window.pop    = (arr) => arr.pop();
      window.append = (arr, item) => { arr.push(item); return arr; };
      window.prepend= (arr, item) => { arr.unshift(item); return arr; };
      window.remove = (arr, idx) => arr.splice(idx, 1);
      window.join   = (arr, sep) => arr.join(sep ?? ",");
      window.split  = (str, sep) => str.split(sep ?? "");
      window.slice  = (arr, a, b) => arr.slice(a, b);
      window.reverse= (arr) => [...arr].reverse();
      window.sort   = (arr, fn) => [...arr].sort(fn);
      window.filter = (arr, fn) => arr.filter(fn);
      window.map    = (arr, fn) => arr.map(fn);
      window.find   = (arr, fn) => arr.find(fn);
      window.includes=(arr, v) => arr.includes(v);
      window.indexOf = (arr, v) => arr.indexOf(v);
      window.flat   = (arr, d) => arr.flat(d ?? 1);
      window.sum    = (arr) => arr.reduce((a, b) => a + b, 0);
      window.avg    = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      // String helpers
      window.upper  = (s) => String(s).toUpperCase();
      window.lower  = (s) => String(s).toLowerCase();
      window.trim   = (s) => String(s).trim();
      window.replace= (s, a, b) => String(s).replaceAll(a, b);
      window.startsWith = (s, p) => String(s).startsWith(p);
      window.endsWith   = (s, p) => String(s).endsWith(p);
      window.contains   = (s, p) => String(s).includes(p);
      window.pad    = (s, n, c) => String(s).padStart(n, c ?? " ");
      window.repeat = (s, n) => String(s).repeat(n);

      // Object helpers
      window.merge  = (...objs) => Object.assign({}, ...objs);
      window.copy   = (obj) => Array.isArray(obj) ? [...obj] : { ...obj };
      window.deepCopy= (obj) => JSON.parse(JSON.stringify(obj));
      window.toJSON = (obj) => JSON.stringify(obj, null, 2);
      window.fromJSON=(s) => JSON.parse(s);

      // Time / Date helpers
      window.now    = () => Date.now();
      window.timestamp = () => new Date().toISOString();

      // Expose common globals directly
      window.Math_   = Math;    // in case user wrote Math_ in Lipi
      // Math is already global, as are JSON, Object, Array, etc.
      // We also expose them as lowercase aliases for Python-style feel:
      window.PI     = Math.PI;
      window.E      = Math.E;
      window.INF    = Infinity;
      window.NaN_   = NaN;

      // DOM creation helpers
      window.createElement = (tag, props, ...children) => {
        const el = document.createElement(tag);
        if (props) {
          for (const [k, v] of Object.entries(props)) {
            if (k === "class" || k === "className") el.className = v;
            else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
            else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
            else el.setAttribute(k, v);
          }
        }
        for (const child of children) {
          if (child === null || child === undefined) continue;
          if (typeof child === "string") el.appendChild(document.createTextNode(child));
          else el.appendChild(child);
        }
        return el;
      };

      window.appendTo = (parent, child) => {
        if (typeof parent === "string") parent = Lipi.$(parent);
        if (parent && child) parent.appendChild(child);
      };

      window.setHTML = (el, html) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.innerHTML = html;
      };

      window.setText = (el, text) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.innerText = String(text);
      };

      window.getHTML = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        return el ? el.innerHTML : "";
      };

      window.getText = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        return el ? el.innerText : "";
      };

      window.addClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.classList.add(...cls.split(" ").filter(Boolean));
      };

      window.removeClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.classList.remove(...cls.split(" ").filter(Boolean));
      };

      window.toggleClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.classList.toggle(cls);
      };

      window.hasClass = (el, cls) => {
        if (typeof el === "string") el = Lipi.$(el);
        return el ? el.classList.contains(cls) : false;
      };

      window.queryAll = (sel, root) => {
        const r = root ? (typeof root === "string" ? Lipi.$(root) : root) : document.getElementById("app-preview") || document;
        return r ? Array.from(r.querySelectorAll(sel)) : [];
      };

      window.show = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.style.display = "";
      };

      window.hide = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.style.display = "none";
      };

      window.clear = (el) => {
        if (typeof el === "string") el = Lipi.$(el);
        if (el) el.innerHTML = "";
      };

      // Sleep alias
      window.sleep = window.__wait;

      // $ shorthand
      window.$ = (s) => Lipi.$(s);

      console.log("[lipi.info] Lipi Engine v4.0 ready (Production AST)");
    },

    // Compile Lipi source → JavaScript string
    compile: (code) => {
      const lexer  = new Lexer(code);
      const tokens = lexer.tokenize();
      const parser = new Parser(tokens);
      const ast    = parser.parse();
      return new CodeGen(parser.asyncFunctions).generate(ast);
    },

    // Compile and execute Lipi source
  run: async (code) => {
    document.getElementById("lipi-runtime-error")?.remove();

    let js = "";

    try {
      const response = await fetch(
        "https://lipi-backend-okzg.onrender.com/api/db/compile",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ code })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Compile failed: ${response.status}`);
      }

      js = data.javascript;

      const fn = new Function("__iterKeys", "__lipiSel", js);
      fn(__iterKeys, (sel) => Lipi.$(sel));

    } catch (e) {
      if (e instanceof SyntaxError && js) {
        e.message += `\n\n[Compiled JS snippet]:\n${js.slice(0, 500)}`;
      }

      Lipi.showError(e);
    }
},

    // Build a full, self-contained HTML document that runs a Lipi project
    // outside the Studio shell (no CodeMirror, no sidebar, no AI panel).
    // Used by both "Open App" (blob URL in a new tab) and "Export App"
    // (bundled into a downloadable zip) so the two features can never drift
    // apart from each other.
    // lipiJsSource: the full text of lipi.js, inlined so the exported
    // bundle has zero external runtime dependencies.
    buildStandaloneHtml: ({ name, html, lipi, lipiJsSource, dbApiUrl }) => {
      const safeName = String(name || "LIPI App").replace(/</g, "&lt;");
      const escapedHtml = String(html || "");
      const safeLipiJsSource = String(lipiJsSource || '')
       .replace(/<\/script/gi, '<\\/script');
      const engineTag = lipiJsSource
    ? `<script>\n${safeLipiJsSource}\n</script>`
    : `<script src="./lipi.js"></script>`;
      const dbApiLine = dbApiUrl
        ? `<script>window.LIPI_DB_API = ${JSON.stringify(dbApiUrl)};</script>`
        : "";
      const lipiSourceJson = JSON.stringify(String(lipi || ""));
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeName}</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;padding:0;min-height:100vh;background:#0a0a0b;}</style>
${dbApiLine}
</head>
<body>
<div id="app-preview">${escapedHtml}</div>
${engineTag}
<script>
  const __lipiSrc = ${lipiSourceJson};
  function __lipiBoot() {
    if (!window.Lipi) { setTimeout(__lipiBoot, 20); return; }
    Lipi.run(__lipiSrc);
  }
  document.addEventListener("DOMContentLoaded", __lipiBoot);
</script>
</body>
</html>`;
    },

    showError: (e) => {
      console.error("[Lipi Error]", e);
      document.getElementById("lipi-runtime-error")?.remove();
      const box = document.createElement("div");
      box.id = "lipi-runtime-error";
      box.style.cssText = [
        "position:fixed", "bottom:20px", "right:20px", "padding:16px",
        "background:#18181b", "color:#f87171", "border-radius:10px",
        "font-family:'JetBrains Mono',monospace", "font-size:12px",
        "z-index:99999", "box-shadow:0 10px 30px rgba(0,0,0,.6)",
        "border:1px solid #7f1d1d", "max-width:440px", "word-break:break-word",
        "line-height:1.6",
      ].join(";");
      const msg = String(e.message || e).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:bold;color:#fff;font-size:13px">Lipi Error</span>
          <button onclick="this.parentNode.parentNode.remove()" style="background:none;border:none;color:#71717a;cursor:pointer;font-size:16px;line-height:1;">×</button>
        </div>
        <pre style="margin:0;white-space:pre-wrap;color:#fca5a5;font-size:11px">${msg}</pre>`;
      document.body.appendChild(box);
      setTimeout(() => box.parentNode && box.remove(), 10000);
    },
  };

  window.Lipi      = Lipi;
})();

// Auto-init on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  window.Lipi?.init();
});
