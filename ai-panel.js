// ai-panel.js — LIPI Studio v12.0 (Stabilized)
// Context-aware AI assistant using Groq's llama-3.3-70b-versatile.
// [FIX-SECURITY] The API key is NEVER present in this file or in the
// browser at all anymore. Requests go through the authenticated backend
// proxy at `${window.LIPI_DB_API}/ai/chat` (see server/db-bridge.js),
// which holds GROQ_API_KEY as a server-side env var and streams the
// response straight through. No key entry UI, no localStorage key.

'use strict';

window.AiPanel = (() => {

    // ─────────────────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────────────────
    // Same base URL the roccoDB bridge uses. Override before this script
    // runs (or before send()) with window.LIPI_DB_API = '...'.
    const AI_ENDPOINT = () => `${window.LIPI_DB_API || 'http://127.0.0.1:4000/api/db'}/ai/chat`;

    // ─────────────────────────────────────────────────────────────────────────
    // SYSTEM PROMPT — makes the model a Lipi expert
    // ─────────────────────────────────────────────────────────────────────────
    const SYSTEM_PROMPT = `You are Lipi AI, the intelligent assistant embedded in LIPI Studio. LIPI is a custom web-native programming language that compiles to JavaScript in the browser.

LIPI LANGUAGE REFERENCE:
Variables:       let x = 42 | let s = "hello" | let b = true | let t = \`Hi {name}!\`
Comments:        # hash comment | // slash comment
Conditions:      if x > 5 { } else if x == 3 { } else { }
Ternary:         "yes" if cond else "no"
While:           while x > 0 { x-- }
For-in:          for i in 5 { }  →  0..4
                 for x in [1,2,3] { }  →  values
                 for k in obj { }  →  keys
                 for n in range(1, 10, 2) { }  →  range with optional step
Functions:       func add(a, b) { return a + b }
                 All user functions are internally async — they can call wait() freely
DOM selection:   let el = #elementId   OR   let el = $("css-selector")
Event binding:   on btn.click { ... }   on el.mouseenter { ... }
Async pause:     wait(500)   ← pauses cleanly, no await keyword in user code
Delete:          delete obj.key
Assert:          assert cond, "message"
Operators:       + - * / % ** // (floor div) ++ -- += -= *= //= **= %=
Logical:         and  or  not
Typeof:          typeof x

STYLE SHORTCUTS (el.style.xxx):
  bg → backgroundColor | fg → color | size → fontSize | weight → fontWeight
  radius → borderRadius | shadow → boxShadow | cursor → cursor
  transition → transition | opacity → opacity | display → display

BUILT-IN FUNCTIONS (all synchronous unless noted):
  Math:    abs floor ceil round sqrt pow max min random PI E
  Type:    str int float bool type has len
  Array:   append pop push sort reverse filter map find includes indexOf slice join split sum avg copy deepCopy
  String:  upper lower trim replace startsWith endsWith contains repeat split
  Object:  keys values merge copy deepCopy toJSON fromJSON
  DOM:     show hide clear setText setHTML queryAll addClass removeClass toggleClass
  Async:   wait(ms)  sleep(ms) [alias]  getInput("prompt")

EXECUTION MODEL:
  Source → Lexer → Parser → AST → Code Generator → JavaScript → Execution
  Wrapped in async IIFE. wait(ms) → await __wait(ms). User funcs → async function + auto-await at call sites.

ANSWERING RULES:
- Always give LIPI code examples (not JavaScript) unless asked specifically about JS
- Wrap all code in triple backticks with "lipi" language tag
- Be concise. Point out bugs clearly if visible in the user's code
- Respond in the same language the user writes in`;

    // ─────────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────────
    let _isOpen      = false;
    let _isThinking  = false;
    let _history     = [];   // [{ role, content }]  — kept for multi-turn context

    // ─────────────────────────────────────────────────────────────────────────
    // PANEL TOGGLE
    // ─────────────────────────────────────────────────────────────────────────
    function toggle() {
        _isOpen = !_isOpen;
        document.getElementById('ai-panel')?.classList.toggle('collapsed', !_isOpen);
        if (_isOpen) setTimeout(() => document.getElementById('ai-input')?.focus(), 220);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CLEAR CHAT
    // ─────────────────────────────────────────────────────────────────────────
    function clearChat() {
        _history = [];
        const container = document.getElementById('ai-messages');
        if (container) {
            container.innerHTML = _welcomeHTML();
        }
    }

    function _welcomeHTML() {
        return `<div class="ai-message">
            <div class="ai-bubble assistant">
                <strong style="color:#a78bfa;">Lipi AI</strong> — I know the Lipi language, its syntax, builtins, and the AST compiler. I can see your current code. Ask me anything.
            </div>
        </div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // QUICK PROMPTS
    // ─────────────────────────────────────────────────────────────────────────
    function quickPrompt(text) {
        const inp = document.getElementById('ai-input');
        if (inp) { inp.value = text; inp.focus(); }
        if (!_isOpen) toggle();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // KEY HANDLER
    // ─────────────────────────────────────────────────────────────────────────
    function handleKey(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SEND MESSAGE
    // ─────────────────────────────────────────────────────────────────────────
    async function send() {
        const inp = document.getElementById('ai-input');
        if (!inp || _isThinking) return;

        const userText = inp.value.trim();
        if (!userText) return;

        inp.value    = '';
        inp.disabled = true;
        _isThinking  = true;

        const sendBtn = document.getElementById('ai-send-btn');
        if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }

        // Build context-aware user message
        const ctx     = _gatherContext();
        const fullMsg = _buildMessage(userText, ctx);

        // Add to history with FULL context so model has it
        _history.push({ role: 'user', content: fullMsg });

        // Show user bubble with ONLY the user's plain question
        _appendUserBubble(userText);

        // Show thinking indicator
        const bubbleEl = _appendThinkingBubble();

        try {
            const response = await _streamAI(_history, (partial) => {
                _updateBubble(bubbleEl, partial, true);
            });

            _updateBubble(bubbleEl, response, false);
            _history.push({ role: 'assistant', content: response });

        } catch (err) {
            const errMsg = `**Error reaching Lipi AI:** ${err.message}\n\nMake sure the roccoDB/AI bridge server is running and \`GROQ_API_KEY\` is set in its environment.`;
            _updateBubble(bubbleEl, errMsg, false);
            console.error('[AiPanel]', err.message);
        } finally {
            _isThinking      = false;
            inp.disabled     = false;
            inp.focus();
            if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ''; }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STREAMING FETCH → backend AI proxy (SSE passthrough of Groq's stream)
    // ─────────────────────────────────────────────────────────────────────────
    async function _streamAI(messages, onChunk) {
        const headers = { 'Content-Type': 'application/json' };
        const token = await window._SyncAPI?.getIdToken?.();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch(AI_ENDPOINT(), {
            method:  'POST',
            headers,
            body: JSON.stringify({
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
            }),
        });

        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.json()).error || await resp.text(); } catch (_) {}
            throw new Error(`HTTP ${resp.status}: ${String(detail).slice(0, 200)}`);
        }

        const reader  = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let   full    = '';
        let   buf     = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop(); // keep incomplete line

            for (const line of lines) {
                const t = line.trim();
                if (!t || t === 'data: [DONE]') continue;
                if (!t.startsWith('data: ')) continue;
                try {
                    const chunk = JSON.parse(t.slice(6));
                    const delta = chunk?.choices?.[0]?.delta?.content ?? '';
                    if (delta) {
                        full += delta;
                        onChunk(full);
                    }
                } catch (_) { /* malformed SSE line */ }
            }
        }

        return full;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CONTEXT HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function _gatherContext() {
        if (!window.EditorManager) return { lipi: '', html: '' };
        const files = window.EditorManager.getFiles?.() ?? {};
        return {
            lipi: typeof files.lipi === 'string' ? files.lipi : '',
            html: typeof files.html === 'string' ? files.html : '',
        };
    }

    function _buildMessage(question, ctx) {
        const parts = [];
        if (ctx.lipi) parts.push(`Current Lipi code:\n\`\`\`lipi\n${ctx.lipi}\n\`\`\``);
        if (ctx.html) parts.push(`Current HTML:\n\`\`\`html\n${ctx.html}\n\`\`\``);
        parts.push(question);
        return parts.join('\n\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DOM BUBBLE HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function _appendUserBubble(text) {
        const wrap = document.createElement('div');
        wrap.className = 'ai-message';
        wrap.style.alignItems = 'flex-end';
        wrap.innerHTML = `<div class="ai-bubble user">${_esc(text)}</div>`;
        _appendToMessages(wrap);
    }

    function _appendThinkingBubble() {
        const wrap = document.createElement('div');
        wrap.className = 'ai-message';
        wrap.innerHTML = `
            <div class="ai-bubble assistant">
                <div class="ai-thinking">
                    <span></span><span></span><span></span>
                </div>
            </div>`;
        _appendToMessages(wrap);
        return wrap;
    }

    function _updateBubble(wrapEl, text, streaming) {
        if (!wrapEl) return;
        const bubble = wrapEl.querySelector('.ai-bubble');
        if (!bubble) return;
        const cursor = streaming ? '<span style="color:#a78bfa;margin-left:2px;animation:cursorBlink 0.8s step-end infinite">▌</span>' : '';
        bubble.innerHTML = _renderMarkdown(text) + cursor;
        const container = document.getElementById('ai-messages');
        if (container) container.scrollTop = container.scrollHeight;
    }

    function _appendToMessages(el) {
        const container = document.getElementById('ai-messages');
        if (container) {
            container.appendChild(el);
            container.scrollTop = container.scrollHeight;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MINIMAL MARKDOWN → HTML  (handles code blocks, inline code, bold, lists)
    // ─────────────────────────────────────────────────────────────────────────
    function _renderMarkdown(raw) {
        if (!raw) return '';

        // Escape HTML first, then restore safe constructs
        let s = _esc(raw);

        // ``` code blocks
        s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const langTag = lang
                ? `<span style="color:#52525b;font-size:9px;display:block;margin-bottom:3px;font-family:JetBrains Mono,monospace;">${lang}</span>`
                : '';
            return `<pre style="margin:6px 0;background:#0a0a0a;border:1px solid #27272a;border-radius:6px;padding:10px;overflow-x:auto;">${langTag}<code style="color:#86efac;font-family:JetBrains Mono,monospace;font-size:11px;">${code.trim()}</code></pre>`;
        });

        // Inline code
        s = s.replace(/`([^`]+)`/g, '<code style="background:#1f1f22;color:#c084fc;padding:1px 5px;border-radius:3px;font-family:JetBrains Mono,monospace;font-size:11px;">$1</code>');

        // **bold**
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong style="color:#e5e7eb;">$1</strong>');

        // *italic*
        s = s.replace(/\*([^*\n]+)\*/g, '<em style="color:#a1a1aa;">$1</em>');

        // ### headings
        s = s.replace(/^###\s+(.+)$/gm, '<div style="font-weight:700;color:#c084fc;font-size:12px;margin:8px 0 3px;">$1</div>');
        s = s.replace(/^##\s+(.+)$/gm,  '<div style="font-weight:700;color:#a78bfa;font-size:13px;margin:8px 0 3px;">$1</div>');
        s = s.replace(/^#\s+(.+)$/gm,   '<div style="font-weight:800;color:#a78bfa;font-size:14px;margin:8px 0 4px;">$1</div>');

        // Bullet list items
        s = s.replace(/^[\-\*•]\s+(.+)$/gm,
            '<div style="display:flex;gap:6px;margin:2px 0;"><span style="color:#52525b;flex-shrink:0;">•</span><span>$1</span></div>');

        // Numbered list items
        s = s.replace(/^(\d+)\.\s+(.+)$/gm,
            '<div style="display:flex;gap:6px;margin:2px 0;"><span style="color:#52525b;min-width:14px;flex-shrink:0;">$1.</span><span>$2</span></div>');

        // Blank lines → paragraph break
        s = s.replace(/\n\n/g, '<br><br>');

        // Single newlines
        s = s.replace(/\n/g, '<br>');

        return s;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HTML ESCAPE
    // ─────────────────────────────────────────────────────────────────────────
    function _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────
    return {
        toggle,
        clearChat,
        quickPrompt,
        handleKey,
        send,
    };

})();
