// editor.js — LIPI Studio v12.0 (Stabilized)
// Full EditorManager API: loadProjectFiles, markSaved, markUnsaved, setProjectName, etc.

'use strict';

if (typeof lucide !== 'undefined') lucide.createIcons();

// ─────────────────────────────────────────────────────────────────────────────
// 1. DEFAULT FILE TEMPLATES  (window-scoped so project-manager.js can read them)
// ─────────────────────────────────────────────────────────────────────────────
window.DEFAULT_LIPI = `# Welcome to LIPI Studio
# Design your UI in the HTML tab, write logic here.

log("🚀 LIPI Engine Ready!")

let box     = #demo-box
let counter = 0

on box.click {
  counter += 1
  box.innerText = "Clicks: " + counter

  let hue = (counter * 30) % 360
  box.style.bg = "hsl(" + hue + ", 65%, 45%)"

  if counter == 5 {
    log("🎉 Reached 5 clicks!")
    wait(300)
    box.style.bg = "#7c3aed"
    box.innerText = "Keep going!"
  }
}`;

window.DEFAULT_HTML = `<div class="h-full flex flex-col items-center justify-center gap-4 bg-white select-none">
  <div
    id="demo-box"
    class="w-40 h-40 bg-[#7c3aed] rounded-2xl flex items-center justify-center cursor-pointer text-white font-bold text-lg shadow-xl transition-all duration-300 hover:scale-105 active:scale-95"
  >
    Click Me
  </div>
  <p class="text-gray-400 text-sm font-mono">Logic is in the Lipi tab →</p>
</div>`;

// ─────────────────────────────────────────────────────────────────────────────
// 2. IN-MEMORY FILE STATE
// ─────────────────────────────────────────────────────────────────────────────
window.fileSystem = {
    lipi: window.DEFAULT_LIPI,
    html: window.DEFAULT_HTML,
};

let _currentTab     = 'lipi';
let _isRemoteUpdate = false;
let _hasUnsaved     = false;

// ─────────────────────────────────────────────────────────────────────────────
// 3. CODEMIRROR SYNTAX MODE
// ─────────────────────────────────────────────────────────────────────────────
CodeMirror.defineSimpleMode('lipi', {
    start: [
        { regex: /`[^`]*`/,                   token: 'string'    },
        { regex: /"(?:[^"\\]|\\.)*"/,         token: 'string'    },
        { regex: /'(?:[^'\\]|\\.)*'/,         token: 'string'    },
        { regex: /\b(func|let|if|else|for|while|return|wait|sleep|getInput|and|or|not|in|on|delete|typeof|assert|break|continue)\b/, token: 'keyword' },
        { regex: /#[^\n]*/,                   token: 'comment'   },
        { regex: /\/\/[^\n]*/,                token: 'comment'   },
        { regex: /[\{\[\(]/,                   indent: true       },
        { regex: /[\}\]\)]/,                   dedent: true       },
        { regex: /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/, token: 'number' },
        { regex: /\b(true|false|null|undefined)\b/, token: 'atom' },
        { regex: /\b(log|print|len|range|keys|values|str|int|float|bool|num|abs|max|min|round|floor|ceil|sqrt|pow|random|type|push|pop|append|join|split|sort|reverse|filter|map|find|includes|indexOf|slice|sum|avg|upper|lower|trim|replace|merge|copy|deepCopy|toJSON|fromJSON|now|show|hide|clear|setText|setHTML|queryAll|addClass|removeClass|toggleClass|sleep|has|wait|dbInsert|dbGet|dbUpload|dbOnChange)\b/, token: 'builtin' },
        { regex: /\bdb(Insert|Get|Upload|OnChange)\b/, token: 'variable-3' },
        { regex: /\$[a-zA-Z0-9_-]*/,          token: 'variable-2' },
        { regex: /#[a-zA-Z0-9_-]+/,           token: 'variable-2' },
    ]
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CODEMIRROR INSTANCE
// ─────────────────────────────────────────────────────────────────────────────
const _editor = CodeMirror.fromTextArea(document.getElementById('code'), {
    mode:              'lipi',
    theme:             'material-palenight',
    lineNumbers:       true,
    indentUnit:        4,
    tabSize:           4,
    indentWithTabs:    false,
    autoCloseBrackets: true,
    styleActiveLine:   true,
    lineWrapping:      false,
    extraKeys: {
        'Tab': (cm) => {
            if (cm.somethingSelected()) { cm.indentSelection('add'); }
            else { cm.replaceSelection('    ', 'end', '+input'); }
        },
        'Ctrl-Enter': () => document.getElementById('runBtn')?.click(),
        'Cmd-Enter':  () => document.getElementById('runBtn')?.click(),
        'Ctrl-S':     () => { _forceSave(); return false; },
        'Cmd-S':      () => { _forceSave(); return false; },
    }
});

_editor.setValue(window.fileSystem.lipi);

_editor.on('cursorActivity', () => {
    const cur = _editor.getCursor();
    const el  = document.getElementById('cursor-pos');
    if (el) el.textContent = `Ln ${cur.line + 1}, Col ${cur.ch + 1}`;
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Strip undefined/null so Firestore never receives invalid field values */
function _sanitizeFiles(files) {
    return {
        lipi: (files && typeof files.lipi === 'string' && files.lipi !== undefined)
              ? files.lipi : window.DEFAULT_LIPI,
        html: (files && typeof files.html === 'string' && files.html !== undefined)
              ? files.html : window.DEFAULT_HTML,
    };
}

function _updatePreview() {
    const preview = document.getElementById('app-preview');
    if (!preview) return;
    preview.innerHTML = _currentTab === 'html' ? _editor.getValue() : window.fileSystem.html;
}

function _forceSave() {
    window.fileSystem[_currentTab] = _editor.getValue();
    window.dispatchEvent(new CustomEvent('project-force-save'));
    window.EditorManager.setSyncState('saving');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. EDITOR MANAGER  — the full public API used by ProjectManager & AI panel
// ─────────────────────────────────────────────────────────────────────────────
window.EditorManager = {

    // Switch between lipi / html tabs
    switchTab(tab) {
        if (tab === _currentTab) return;

        window.fileSystem[_currentTab] = _editor.getValue();

        document.querySelectorAll('.tab-btn').forEach(el => {
            el.classList.remove('active');
            el.classList.add('inactive');
        });
        const tabEl = document.getElementById(`tab-${tab}`);
        if (tabEl) { tabEl.classList.add('active'); tabEl.classList.remove('inactive'); }

        _currentTab = tab;
        _isRemoteUpdate = true;
        _editor.setValue(window.fileSystem[tab] || '');
        _editor.setOption('mode', tab === 'lipi' ? 'lipi' : 'htmlmixed');
        _isRemoteUpdate = false;
        _editor.refresh();

        if (tab === 'html') _updatePreview();
    },

    // Load a project's files into the editor.
    // suppressSave = true → don't mark as saved (used when remote update arrives mid-edit)
    loadProjectFiles(files, suppressSave) {
        const safe = _sanitizeFiles(files);
        window.fileSystem = { ...safe };

        const cursor = _editor.getCursor();
        _isRemoteUpdate = true;
        _editor.setValue(window.fileSystem[_currentTab]);
        _isRemoteUpdate = false;
        try { _editor.setCursor(cursor); } catch (_) {}
        _editor.refresh();

        _updatePreview();
        if (!suppressSave) this.markSaved();
    },

    // Alias kept for any legacy call sites
    loadFiles(files, suppressSave) {
        return this.loadProjectFiles(files, suppressSave);
    },

    // Return sanitized snapshot of current in-memory files
    getFiles() {
        window.fileSystem[_currentTab] = _editor.getValue();
        return _sanitizeFiles(window.fileSystem);
    },

    // Unsaved indicator
    markUnsaved() {
        if (_hasUnsaved) return;
        _hasUnsaved = true;
        document.getElementById('unsaved-dot')?.classList.remove('hidden');
    },
    markSaved() {
        _hasUnsaved = false;
        document.getElementById('unsaved-dot')?.classList.add('hidden');
    },

    // Header project name + page title
    setProjectName(name) {
        const el = document.getElementById('header-project-name');
        if (el) el.textContent = name || '—';
        document.title = name ? `${name} — LIPI Studio` : 'LIPI Studio';
    },

    // Sync state pill
    setSyncState(state) {
        const container = document.getElementById('syncStatus');
        const dot       = document.getElementById('syncDot');
        const text      = document.getElementById('syncText');
        if (!container || !dot || !text) return;

        container.className = 'hidden md:flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all duration-300 select-none';
        dot.className       = 'w-1.5 h-1.5 rounded-full';

        const map = {
            saved:   { cls: 'bg-green-500/10 border-green-500/20',   dot: 'bg-green-500',                txt: 'Saved'      },
            saving:  { cls: 'bg-violet-500/10 border-violet-500/20', dot: 'bg-violet-400 animate-pulse', txt: 'Saving...'  },
            offline: { cls: 'bg-red-500/10 border-red-500/20',       dot: 'bg-red-500',                  txt: 'Offline'    },
            error:   { cls: 'bg-red-500/10 border-red-500/20',       dot: 'bg-red-400',                  txt: 'Sync Error' },
        };
        const c = map[state] ?? map.saved;
        container.classList.add(...c.cls.split(' '));
        dot.classList.add(...c.dot.split(' '));
        text.textContent = c.txt;
    },

    // Trigger force save (also callable from outside)
    forceSave: _forceSave,
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. INITIAL PREVIEW RENDER
// ─────────────────────────────────────────────────────────────────────────────
_updatePreview();

// ─────────────────────────────────────────────────────────────────────────────
// 8. CONSOLE UI
// ─────────────────────────────────────────────────────────────────────────────
const _consoleDiv = document.getElementById('console');

function _consoleReset(html) {
    if (!_consoleDiv) return;
    _consoleDiv.innerHTML = `<div class="text-zinc-600 italic text-[11px] px-1 py-0.5">${html}</div>`;
}
_consoleReset('// Console ready — Ctrl+Enter to run');

function _uiLog(type, args) {
    if (!_consoleDiv) return;
    _consoleDiv.querySelector('.italic')?.remove();

    const isErr  = type === 'error';
    const isWarn = type === 'warn';
    const line   = document.createElement('div');
    const color  = isErr ? 'text-red-400' : isWarn ? 'text-yellow-400' : 'text-gray-300';
    const icon   = isErr  ? '<span class="shrink-0 text-red-500">✗</span>'
                 : isWarn ? '<span class="shrink-0 text-yellow-500">⚠</span>'
                 :          '<span class="shrink-0 text-violet-500 opacity-60">›</span>';

    line.className = `flex gap-2 font-mono text-[11px] px-2 py-0.5 rounded mb-0.5 ${color}`;

    const content = args.map(a => {
        try {
            if (a === null)      return 'null';
            if (a === undefined) return 'undefined';
            return typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a);
        } catch (_) { return '[Circular]'; }
    }).join(' ');

    line.innerHTML = `${icon}<span class="whitespace-pre-wrap break-all flex-1">${content}</span>`;
    _consoleDiv.appendChild(line);
    _consoleDiv.scrollTop = _consoleDiv.scrollHeight;
}

// Intercept console — guard against double-intercept
if (!window.__lipiConsoleHooked) {
    window.__lipiConsoleHooked = true;
    const _origLog   = console.log;
    const _origError = console.error;
    const _origWarn  = console.warn;
    console.log   = (...a) => { _origLog(...a);   _uiLog('log',   a); };
    console.error = (...a) => { _origError(...a); _uiLog('error', a); };
    console.warn  = (...a) => { _origWarn(...a);  _uiLog('warn',  a); };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. RUN LOGIC
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('runBtn')?.addEventListener('click', _runCode);

function _runCode() {
    _consoleReset('<span style="color:#a16207;opacity:0.7;">▷ Running...</span>');

    window.fileSystem[_currentTab] = _editor.getValue();

    const preview = document.getElementById('app-preview');
    if (preview) preview.innerHTML = window.fileSystem.html;

    const statusDot  = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    if (statusDot)  statusDot.className = 'w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse';
    if (statusText) statusText.textContent = 'Running';

    const execEl = document.getElementById('exec-time');
    if (execEl) execEl.classList.add('hidden');

    const t0 = performance.now();

    setTimeout(() => {
        if (typeof Lipi === 'undefined') { console.error('Lipi engine not loaded.'); return; }
        try {
            Lipi.run(window.fileSystem.lipi);
            const ms = (performance.now() - t0).toFixed(1);
            if (execEl) { execEl.textContent = `${ms}ms`; execEl.classList.remove('hidden'); }
            if (statusDot)  statusDot.className = 'w-1.5 h-1.5 rounded-full bg-green-500';
            if (statusText) statusText.textContent = 'Ready';
        } catch (e) {
            console.error('Runtime Error:', e.message || e);
            if (statusDot)  statusDot.className = 'w-1.5 h-1.5 rounded-full bg-red-500';
            if (statusText) statusText.textContent = 'Error';
        }
    }, 50);
}

document.getElementById('clearTerm')?.addEventListener('click', () => {
    _consoleReset('// Console cleared');
    document.getElementById('exec-time')?.classList.add('hidden');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9b. OPEN APP — run the current project in its own tab, no Studio chrome.
// ─────────────────────────────────────────────────────────────────────────────
let _liveAppWindow = null;
const _liveAppChannel = new BroadcastChannel('lipi-live-app');

async function _openApp() {
    const files = window.EditorManager.getFiles();
    const name =
        document.getElementById('header-project-name')?.textContent ||
        'LIPI App';

    const lipiJsSource = await _fetchLipiJsSource();

    let html = Lipi.buildStandaloneHtml({
        name,
        html: files.html,
        lipi: files.lipi,
        lipiJsSource,
        dbApiUrl: window.LIPI_DB_API,
    });

    // Inject live-update receiver into the standalone app
    const liveReceiver = `
<script>
    const __lipiLiveChannel = new BroadcastChannel('lipi-live-app');

    __lipiLiveChannel.onmessage = (event) => {
        const data = event.data;

        if (!data || data.type !== 'LIPI_LIVE_UPDATE') return;

        // Update page title
        if (data.name) {
            document.title = data.name;
        }

        // Replace app HTML
        const preview = document.getElementById('app-preview');

        if (preview && typeof data.html === 'string') {
            preview.innerHTML = data.html;
        }

        // Run latest LIPI code
        if (typeof data.lipi === 'string' && window.Lipi) {
            Lipi.run(data.lipi);
        }
    };
</script>
`;

    html = html.replace(
        '</body>',
        liveReceiver + '\\n</body>'
    );

    const blob = new Blob([html], {
        type: 'text/html'
    });

    const url = URL.createObjectURL(blob);

    _liveAppWindow = window.open(url, '_blank');

    if (!_liveAppWindow) {
        console.error(
            'Open App: popup blocked. Allow popups for this site.'
        );
        return;
    }

    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 30000);
}

async function _fetchLipiJsSource() {
    // Reuse the exact engine already loaded on this page so Open App /
    // Export App can never drift from what Studio itself runs.
    const scriptEl = Array.from(document.scripts).find(s => /lipi\.js(\?|$)/.test(s.src || ''));
    if (!scriptEl) return null;
    try {
        const res = await fetch(scriptEl.src);
        if (!res.ok) return null;
        return await res.text();
    } catch (_) {
        return null;
    }
}

async function _openApp() {
    const files = window.EditorManager.getFiles();
    const name =
        document.getElementById('header-project-name')?.textContent ||
        'LIPI App';

    const lipiJsSource = await _fetchLipiJsSource();

    if (!lipiJsSource) {
        console.error('Open App: could not load lipi.js');
        return;
    }

    const engineBlob = new Blob([lipiJsSource], {
        type: 'text/javascript'
    });

    const engineUrl = URL.createObjectURL(engineBlob);

    const liveReceiver = `
<script>
const __lipiLiveChannel = new BroadcastChannel('lipi-live-app');

__lipiLiveChannel.onmessage = (event) => {
    const data = event.data;

    if (!data || data.type !== 'LIPI_LIVE_UPDATE') return;

    if (data.name) {
        document.title = data.name;
    }

    const preview = document.getElementById('app-preview');

    if (preview && typeof data.html === 'string') {
        preview.innerHTML = data.html;
    }

    if (typeof data.lipi === 'string' && window.Lipi) {
        Lipi.run(data.lipi);
    }
};
</script>
`;

    let html = Lipi.buildStandaloneHtml({
        name,
        html: files.html,
        lipi: files.lipi,
        lipiJsSource: null,
        dbApiUrl: window.LIPI_DB_API,
    });

    html = html.replace(
        '<script src="./lipi.js"></script>',
        '<script src="' + engineUrl + '"></script>'
    );

    html = html.replace(
        '</body>',
        liveReceiver + '\n</body>'
    );

    const appBlob = new Blob([html], {
        type: 'text/html'
    });

    const appUrl = URL.createObjectURL(appBlob);

    _liveAppWindow = window.open(appUrl, '_blank');

    if (!_liveAppWindow) {
        console.error('Open App: popup blocked.');
        URL.revokeObjectURL(engineUrl);
        URL.revokeObjectURL(appUrl);
        return;
    }

    setTimeout(() => {
        URL.revokeObjectURL(appUrl);
    }, 30000);

    _liveAppWindow.addEventListener('beforeunload', () => {
        URL.revokeObjectURL(engineUrl);
    });
}
document.getElementById('openAppBtn')?.addEventListener('click', _openApp);

// ─────────────────────────────────────────────────────────────────────────────
// 9c. PUBLISH — push a public snapshot + show the shareable URL.
// ─────────────────────────────────────────────────────────────────────────────
async function _publishApp() {
    const btn = document.getElementById('publishBtn');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
    try {
        window.dispatchEvent(new CustomEvent('project-force-save'));
        const url = await window.ProjectManager.publishActiveProject();
        _showShareModal(url);
    } catch (e) {
        console.error('Publish failed:', e.message);
        alert(`Publish failed: ${e.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }
}
document.getElementById('publishBtn')?.addEventListener('click', _publishApp);

document.getElementById('unpublishBtn')?.addEventListener('click', async () => {
    try {
        await window.ProjectManager.unpublishActiveProject();
        document.getElementById('share-modal')?.classList.add('hidden');
    } catch (e) {
        console.error('Unpublish failed:', e.message);
    }
});

function _showShareModal(url) {
    const modal = document.getElementById('share-modal');
    const input = document.getElementById('share-url-input');
    if (input) input.value = url;
    modal?.classList.remove('hidden');
}
window._closeShareModal = () => document.getElementById('share-modal')?.classList.add('hidden');
window._copyShareUrl = () => {
    const input = document.getElementById('share-url-input');
    if (!input) return;
    input.select();
    navigator.clipboard?.writeText(input.value).catch(() => document.execCommand('copy'));
};

// ─────────────────────────────────────────────────────────────────────────────
// 9d. EXPORT APP — download a runnable, self-contained bundle (.zip).
// ─────────────────────────────────────────────────────────────────────────────
function _loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = () => resolve(window.JSZip);
        s.onerror = () => reject(new Error('Failed to load JSZip from CDN.'));
        document.head.appendChild(s);
    });
}

async function _exportApp() {
    const btn = document.getElementById('exportAppBtn');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
    try {
        const JSZip = await _loadJSZip();
        const files = window.EditorManager.getFiles();
        const name  = document.getElementById('header-project-name')?.textContent || 'lipi-app';
        const lipiJsSource = await _fetchLipiJsSource();

        if (!lipiJsSource) {
            throw new Error('Could not read the Lipi engine source to bundle. Reload Studio and try again.');
        }

        const html = Lipi.buildStandaloneHtml({
            name,
            html: files.html,
            lipi: files.lipi,
            lipiJsSource: null, // reference ./lipi.js instead of inlining, for a cleaner bundle
            dbApiUrl: window.LIPI_DB_API,
        });

        const zip = new JSZip();
        zip.file('index.html', html);
        zip.file('lipi.js', lipiJsSource);
        zip.file('project.lipi', files.lipi);
        zip.file('README.md', [
            `# ${name}`,
            '',
            'Exported from LIPI Studio as a standalone runnable bundle.',
            '',
            '## Run it locally',
            '',
            '```bash',
            'npx serve .',
            '```',
            '',
            'Then open the printed URL. Opening `index.html` directly via `file://` also',
            'works for apps that only use DOM features.',
            '',
            '## Database features (dbInsert / dbGet / dbUpload / dbOnChange)',
            '',
            'If this app uses roccoDB calls, it needs a running roccoDB bridge server',
            'reachable at the URL set in `index.html` via `window.LIPI_DB_API`',
            `(currently: \`${window.LIPI_DB_API || 'not configured'}\`). See the main`,
            'project README for how to run `server/db-bridge.js`.',
            '',
            '## Files',
            '',
            '- `index.html` — the app shell + compiled preview markup',
            '- `lipi.js` — the Lipi language engine (lexer/parser/codegen/runtime)',
            '- `project.lipi` — your original Lipi source, kept for reference/editing',
        ].join('\n'));

        const blob = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'lipi-app'}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (e) {
        console.error('Export failed:', e.message);
        alert(`Export failed: ${e.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }
}
document.getElementById('exportAppBtn')?.addEventListener('click', _exportApp);

// ─────────────────────────────────────────────────────────────────────────────
// 10. CHANGE EVENTS  → debounced project save
// ─────────────────────────────────────────────────────────────────────────────
let _liveUpdateTimer = null;

_editor.on('change', (cm, change) => {
    if (change.origin === 'setValue' || _isRemoteUpdate) return;

    window.fileSystem[_currentTab] = _editor.getValue();
    if (_currentTab === 'html') _updatePreview();

    window.EditorManager.markUnsaved();
    window.dispatchEvent(new CustomEvent('project-changed'));
    window.EditorManager.setSyncState('saving');

    clearTimeout(_liveUpdateTimer);
    _liveUpdateTimer = setTimeout(() => {
        _broadcastLiveAppUpdate();
    }, 300);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. SPLIT PANES
// ─────────────────────────────────────────────────────────────────────────────
if (typeof Split !== 'undefined') {
    Split(['#left-pane', '#right-pane'], {
        sizes: [50, 50], minSize: 240, gutterSize: 5,
        onDrag: () => _editor.refresh(),
    });
    Split(['#preview-pane', '#console-pane'], {
        direction: 'vertical', sizes: [65, 35], minSize: 80, gutterSize: 5,
    });
}
 