// project-manager.js — LIPI Studio v12.0 (Stabilized)
// Multi-project CRUD with Firestore sub-collection
// Firestore path: users/{uid}/projects/{projectId}
// Requires: window.EditorManager (from editor.js), window._SyncAPI (from editor-sync.js)

'use strict';

window.ProjectManager = (() => {

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE STATE
    // ─────────────────────────────────────────────────────────────────────────
    let _projects      = {};     // { [id]: { id, name, files:{lipi,html}, updatedAt, ... } }
    let _activeId      = null;
    let _unsubscribe   = null;   // Firestore snapshot unsubscriber
    let _sidebarOpen   = true;
    let _deleteTarget  = null;   // { id, name }
    let _renameTarget  = null;   // project id being inline-renamed
    let _initialized   = false;
    let _loadInProgress = false; // prevent recursive snapshot → load → snapshot loops

    // ─────────────────────────────────────────────────────────────────────────
    // INIT (called once from editor-sync.js after auth is confirmed)
    // ─────────────────────────────────────────────────────────────────────────
    function init(uid, db, firebase) {
        if (_initialized) return;
        _initialized = true;
        _listenToProjects(uid, db, firebase);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FIRESTORE REALTIME LISTENER
    // ─────────────────────────────────────────────────────────────────────────
    function _listenToProjects(uid, db, firebase) {
        if (_unsubscribe) _unsubscribe();

        const { collection, query, orderBy, onSnapshot } = firebase;
        const ref = collection(db, 'users', uid, 'projects');
        const q   = query(ref, orderBy('updatedAt', 'desc'));

        _unsubscribe = onSnapshot(q, (snapshot) => {
            const incoming = {};
            snapshot.forEach(d => {
                incoming[d.id] = { id: d.id, ..._cleanDoc(d.data()) };
            });
            _projects = incoming;

            // First load: auto-select most recent project
            if (!_activeId) {
                const sorted = _sortedProjects();
                if (sorted.length > 0) {
                    _loadProject(sorted[0].id, false);
                } else {
                    // No projects at all — create a default one
                    _createDefaultProject();
                }
            } else if (_activeId && _projects[_activeId]) {
                // Active project received a server update — only apply if not our own write
                const snap = snapshot.docs.find(d => d.id === _activeId);
                if (snap && !snap.metadata.hasPendingWrites && !_loadInProgress) {
                    const remoteFiles = _safeFiles(_projects[_activeId].files);
                    const localFiles  = window.EditorManager ? window.EditorManager.getFiles() : null;
                    if (localFiles && (
                        remoteFiles.lipi !== localFiles.lipi ||
                        remoteFiles.html !== localFiles.html
                    )) {
                        // Only overwrite if we don't have unsaved local changes
                        // (Check the unsaved dot — a clean proxy for _hasUnsaved)
                        const unsavedDot = document.getElementById('unsaved-dot');
                        const isClean    = !unsavedDot || unsavedDot.classList.contains('hidden');
                        if (isClean) {
                            window.EditorManager?.loadProjectFiles(remoteFiles, true);
                            window.EditorManager?.setSyncState('saved');
                        }
                    }
                }
            }

            _renderList();
        }, (err) => {
            console.error('[ProjectManager] Snapshot error:', err.message);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOAD / SWITCH PROJECT  (the only place that calls loadProjectFiles)
    // ─────────────────────────────────────────────────────────────────────────
    function _loadProject(id, updateFirestore) {
        if (!_projects[id] || _loadInProgress) return;
        if (id === _activeId && updateFirestore === false) {
            // Same project re-selected — still render the list to update active style
            _renderList();
            return;
        }

        _loadInProgress = true;
        _activeId       = id;

        const proj = _projects[id];
        const safe = _safeFiles(proj.files);

        window.EditorManager?.loadProjectFiles(safe);
        window.EditorManager?.setProjectName(proj.name || 'Untitled');

        _renderList();
        _loadInProgress = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CREATE PROJECT
    // ─────────────────────────────────────────────────────────────────────────
    async function createProject() {
        const sync = window._SyncAPI;
        if (!sync) { console.warn('[PM] _SyncAPI not ready'); return; }

        const name = `Project ${Object.keys(_projects).length + 1}`;
        const { addDoc, collection, serverTimestamp } = sync.firebase;

        // Always use safe defaults — never send undefined to Firestore
        const payload = _cleanObj({
            name,
            files: {
                lipi: window.DEFAULT_LIPI || '',
                html: window.DEFAULT_HTML || '',
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });

        try {
            const ref = await addDoc(
                collection(sync.db, 'users', sync.uid, 'projects'),
                payload
            );

            // Optimistically switch before snapshot fires
            _activeId = ref.id;
            _projects[ref.id] = {
                id: ref.id,
                name,
                files: { lipi: window.DEFAULT_LIPI || '', html: window.DEFAULT_HTML || '' },
            };
            window.EditorManager?.loadProjectFiles(_safeFiles(_projects[ref.id].files));
            window.EditorManager?.setProjectName(name);
            _renderList();
        } catch (e) {
            console.error('[ProjectManager] Create failed:', e.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SAVE ACTIVE PROJECT
    // ─────────────────────────────────────────────────────────────────────────
    async function saveActiveProject() {
        const sync = window._SyncAPI;
        if (!sync || !_activeId) return;

        const files = window.EditorManager ? window.EditorManager.getFiles() : null;
        if (!files) return;

        const { doc, updateDoc, serverTimestamp } = sync.firebase;

        const payload = _cleanObj({
            files: _safeFiles(files),
            updatedAt: serverTimestamp(),
        });

        try {
            await updateDoc(
                doc(sync.db, 'users', sync.uid, 'projects', _activeId),
                payload
            );
            window.EditorManager?.markSaved();
            window.EditorManager?.setSyncState('saved');
        } catch (e) {
            console.error('[ProjectManager] Save failed:', e.message);
            window.EditorManager?.setSyncState(navigator.onLine ? 'error' : 'offline');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLISH — writes a safe public SNAPSHOT (not the live/private project
    // doc) to top-level `published/{projectId}`. Firestore rules (see
    // firestore.rules) allow anyone to READ that collection but only the
    // owning uid to WRITE it, so publishing never exposes the private
    // `users/{uid}/projects/*` tree — only the explicit snapshot the owner
    // chose to publish, at the moment they clicked Publish.
    // ─────────────────────────────────────────────────────────────────────────
    async function publishActiveProject() {
        const sync = window._SyncAPI;
        if (!sync || !_activeId) throw new Error('No active project to publish.');

        const files = window.EditorManager ? window.EditorManager.getFiles() : null;
        if (!files) throw new Error('Editor not ready.');

        const { doc, setDoc, updateDoc, serverTimestamp } = sync.firebase;
        const name = _projects[_activeId]?.name || 'Untitled';

        const payload = _cleanObj({
            projectId: _activeId,
            ownerUid: sync.uid,
            name,
            files: _safeFiles(files),
            publishedAt: serverTimestamp(),
        });

        await setDoc(doc(sync.db, 'published', _activeId), payload);
        await updateDoc(doc(sync.db, 'users', sync.uid, 'projects', _activeId), { published: true });

        if (_projects[_activeId]) _projects[_activeId].published = true;
        _renderList();

        return _publicUrlFor(_activeId);
    }

    async function unpublishActiveProject() {
        const sync = window._SyncAPI;
        if (!sync || !_activeId) throw new Error('No active project.');

        const { doc, deleteDoc, updateDoc } = sync.firebase;
        await deleteDoc(doc(sync.db, 'published', _activeId));
        await updateDoc(doc(sync.db, 'users', sync.uid, 'projects', _activeId), { published: false });

        if (_projects[_activeId]) _projects[_activeId].published = false;
        _renderList();
    }

    function _publicUrlFor(projectId) {
        // Points at the static app.html public runner shipped alongside
        // Studio. Works on any static host (Firebase Hosting, Vercel,
        // Netlify, nginx, etc.) as long as app.html is deployed next to it.
        const base = window.location.origin + window.location.pathname.replace(/editor\.html.*$/, '');
        return `${base}app.html?id=${encodeURIComponent(projectId)}`;
    }

    /** Snapshot of the active project's files, for Open App / Export App. */
    function getActiveProjectSnapshot() {
        const files = window.EditorManager ? window.EditorManager.getFiles() : null;
        if (!files) return null;
        return {
            id: _activeId,
            name: _projects[_activeId]?.name || 'Untitled',
            files: _safeFiles(files),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RENAME — inline
    // ─────────────────────────────────────────────────────────────────────────
    function startRename(id) {
        _renameTarget = id;
        _renderList();
    }

    function _renameKey(event, id) {
        if (event.key === 'Enter')  { event.preventDefault(); _commitRename(id); }
        if (event.key === 'Escape') { _renameTarget = null; _renderList(); }
    }

    async function _commitRename(id) {
        const inp = document.getElementById(`rename-input-${id}`);
        if (!inp) { _renameTarget = null; return; }

        const newName = inp.value.trim() || (_projects[id]?.name ?? 'Untitled');
        _renameTarget = null;

        // Optimistic update in memory
        if (_projects[id]) _projects[id].name = newName;
        if (_activeId === id) window.EditorManager?.setProjectName(newName);
        _renderList();

        const sync = window._SyncAPI;
        if (!sync) return;

        try {
            const { doc, updateDoc, serverTimestamp } = sync.firebase;
            await updateDoc(
                doc(sync.db, 'users', sync.uid, 'projects', id),
                _cleanObj({ name: newName, updatedAt: serverTimestamp() })
            );
        } catch (e) {
            console.error('[ProjectManager] Rename failed:', e.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE
    // ─────────────────────────────────────────────────────────────────────────
    function openDeleteModal(id, name) {
        _deleteTarget = { id, name };
        const modal = document.getElementById('delete-modal');
        const label = document.getElementById('delete-modal-name');
        const btn   = document.getElementById('delete-confirm-btn');
        if (!modal) return;
        if (label) label.textContent = name;
        if (btn)   btn.onclick = () => _confirmDelete();
        modal.classList.remove('hidden');
    }

    function closeDeleteModal() {
        _deleteTarget = null;
        document.getElementById('delete-modal')?.classList.add('hidden');
    }

    async function _confirmDelete() {
        if (!_deleteTarget) return;
        const { id } = _deleteTarget;
        closeDeleteModal();

        const sync = window._SyncAPI;
        if (!sync) return;

        // Remove from local cache optimistically
        delete _projects[id];

        try {
            const { doc, deleteDoc } = sync.firebase;
            await deleteDoc(doc(sync.db, 'users', sync.uid, 'projects', id));
        } catch (e) {
            console.error('[ProjectManager] Delete failed:', e.message);
        }

        // If we deleted the active project, load the next one
        if (_activeId === id) {
            _activeId = null;
            const remaining = _sortedProjects();
            if (remaining.length > 0) {
                _loadProject(remaining[0].id, false);
            } else {
                window.EditorManager?.loadProjectFiles({});
                window.EditorManager?.setProjectName('—');
                _renderList();
            }
        } else {
            _renderList();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER PROJECT LIST
    // ─────────────────────────────────────────────────────────────────────────
    function _renderList() {
        const list = document.getElementById('project-list');
        if (!list) return;

        const sorted = _sortedProjects();

        if (sorted.length === 0) {
            list.innerHTML = `<div class="px-4 py-3 text-[11px] text-zinc-600 italic">No projects yet.<br>Click + to create one.</div>`;
            return;
        }

        list.innerHTML = '';

        sorted.forEach(proj => {
            const isActive = proj.id === _activeId;
            const item     = document.createElement('div');
            item.className = `proj-item${isActive ? ' active' : ''}`;
            item.dataset.id = proj.id;

            if (_renameTarget === proj.id) {
                // Inline rename mode
                item.innerHTML = `
                    <i data-lucide="file-code" style="width:12px;height:12px;flex-shrink:0;color:#a78bfa;"></i>
                    <input
                        class="proj-rename-input flex-1"
                        id="rename-input-${proj.id}"
                        value="${_esc(proj.name)}"
                        maxlength="60"
                        onblur="ProjectManager._commitRename('${proj.id}')"
                        onkeydown="ProjectManager._renameKey(event,'${proj.id}')"
                    />`;
                list.appendChild(item);
                requestAnimationFrame(() => {
                    const inp = document.getElementById(`rename-input-${proj.id}`);
                    if (inp) { inp.focus(); inp.select(); }
                });
            } else {
                item.innerHTML = `
                    <i data-lucide="file-code" style="width:12px;height:12px;flex-shrink:0;color:${isActive ? '#a78bfa' : '#52525b'};"></i>
                    <span class="proj-item-name">${_esc(proj.name)}</span>
                    <div class="proj-item-actions">
                        <button class="proj-action-btn" title="Rename"
                            onclick="event.stopPropagation();ProjectManager.startRename('${proj.id}')">
                            <i data-lucide="pencil" style="width:11px;height:11px;"></i>
                        </button>
                        <button class="proj-action-btn danger" title="Delete"
                            onclick="event.stopPropagation();ProjectManager.openDeleteModal('${proj.id}','${_esc(proj.name)}')">
                            <i data-lucide="trash-2" style="width:11px;height:11px;"></i>
                        </button>
                    </div>`;
                item.addEventListener('click', () => _loadProject(proj.id, false));
                list.appendChild(item);
            }
        });

        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SIDEBAR TOGGLE
    // ─────────────────────────────────────────────────────────────────────────
    function toggleSidebar() {
        _sidebarOpen = !_sidebarOpen;
        document.getElementById('project-sidebar')
            ?.classList.toggle('collapsed', !_sidebarOpen);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE UTILITIES
    // ─────────────────────────────────────────────────────────────────────────

    /** Sort projects by updatedAt descending */
    function _sortedProjects() {
        return Object.values(_projects).sort((a, b) => {
            const ta = a.updatedAt?.toMillis?.() ?? (a.updatedAt?.seconds ?? 0) * 1000;
            const tb = b.updatedAt?.toMillis?.() ?? (b.updatedAt?.seconds ?? 0) * 1000;
            return tb - ta;
        });
    }

    /** Ensure files object has no undefined/null — Firestore rejects them */
    function _safeFiles(files) {
        return {
            lipi: (files && typeof files.lipi === 'string') ? files.lipi : (window.DEFAULT_LIPI || ''),
            html: (files && typeof files.html === 'string') ? files.html : (window.DEFAULT_HTML || ''),
        };
    }

    /** Strip undefined values from any object before sending to Firestore */
    function _cleanObj(obj) {
        const out = {};
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (v === undefined) continue;
            if (v !== null && typeof v === 'object' && !_isFirestoreSpecial(v)) {
                out[k] = _cleanObj(v);
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    /** Firestore sentinel objects (serverTimestamp etc.) should not be recursed into */
    function _isFirestoreSpecial(v) {
        return typeof v === 'object' && v !== null && typeof v.toMillis === 'function';
    }

    /** Strip undefined from a Firestore document's data */
    function _cleanDoc(data) {
        if (!data || typeof data !== 'object') return {};
        const out = {};
        for (const k of Object.keys(data)) {
            if (data[k] !== undefined) out[k] = data[k];
        }
        return out;
    }

    /** Create a default project for brand-new users */
    async function _createDefaultProject() {
        const sync = window._SyncAPI;
        if (!sync) return;

        const { addDoc, collection, serverTimestamp } = sync.firebase;
        const payload = _cleanObj({
            name: 'My First Project',
            files: {
                lipi: window.DEFAULT_LIPI || '',
                html: window.DEFAULT_HTML || '',
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });

        try {
            const ref = await addDoc(
                collection(sync.db, 'users', sync.uid, 'projects'),
                payload
            );
            _activeId           = ref.id;
            _projects[ref.id]   = {
                id:    ref.id,
                name:  'My First Project',
                files: { lipi: window.DEFAULT_LIPI || '', html: window.DEFAULT_HTML || '' },
            };
            window.EditorManager?.loadProjectFiles(_safeFiles(_projects[ref.id].files));
            window.EditorManager?.setProjectName('My First Project');
            _renderList();
        } catch (e) {
            console.error('[ProjectManager] Default project creation failed:', e.message);
        }
    }

    /** HTML-escape for inline onclick attributes */
    function _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────
    return {
        init,
        createProject,
        saveActiveProject,
        publishActiveProject,
        unpublishActiveProject,
        getActiveProjectSnapshot,
        startRename,
        _renameKey,
        _commitRename,
        openDeleteModal,
        closeDeleteModal,
        toggleSidebar,
        getActiveId: () => _activeId,
        getProjects: () => ({ ..._projects }),
    };

})();

// ─────────────────────────────────────────────────────────────────────────────
// DEBOUNCED AUTO-SAVE
// ─────────────────────────────────────────────────────────────────────────────
;(function () {
    let _timer = null;

    window.addEventListener('project-changed', () => {
        clearTimeout(_timer);
        _timer = setTimeout(() => window.ProjectManager?.saveActiveProject(), 1500);
    });

    window.addEventListener('project-force-save', () => {
        clearTimeout(_timer);
        window.ProjectManager?.saveActiveProject();
    });
})();
