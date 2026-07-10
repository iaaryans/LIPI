// editor-sync.js — LIPI Studio v12.0 (Stabilized)
// Firebase Auth + Firestore init.  Exposes window._SyncAPI.
// No fragile polling — ProjectManager.init() is called synchronously after
// the auth callback because all non-module scripts are already evaluated.

import { initializeApp }                       from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    getFirestore,
    doc,
    collection,
    addDoc,
    setDoc,
    getDoc,
    updateDoc,
    deleteDoc,
    onSnapshot,
    query,
    orderBy,
    serverTimestamp,
    enableIndexedDbPersistence,
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey:            'AIzaSyCqF4YvZ9DX34Xi9yQAKtmLiQl16A-MX1M',
    authDomain:        'lipi-a2281.firebaseapp.com',
    projectId:         'lipi-a2281',
    storageBucket:     'lipi-a2281.firebasestorage.app',
    messagingSenderId: '520308268843',
    appId:             '1:520308268843:web:43a05b9a1613accc3daf6e',
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Offline persistence — best-effort, ignore errors
enableIndexedDbPersistence(db).catch(err => {
    if (err.code === 'failed-precondition') console.warn('[Sync] Persistence disabled: multiple tabs open.');
    else if (err.code === 'unimplemented')  console.warn('[Sync] Persistence not available in this browser.');
});

// ─────────────────────────────────────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────────────────────────────────────
const globalLoader = document.getElementById('globalLoader');
const userDisplay  = document.getElementById('user-display');
const logoutBtn    = document.getElementById('logoutBtn');

// ─────────────────────────────────────────────────────────────────────────────
// BUILD SYNC API OBJECT  (shared set of Firestore helpers for ProjectManager)
// ─────────────────────────────────────────────────────────────────────────────
function _buildSyncAPI(uid) {
    return {
        uid,
        db,
        // Used by lipi.js's dbInsert/dbGet/dbUpload/dbOnChange to authenticate
        // against the roccoDB Express bridge (server/db-bridge.js).
        getIdToken: (forceRefresh = false) => {
            const user = auth.currentUser;
            if (!user) return Promise.resolve(null);
            return user.getIdToken(forceRefresh);
        },
        firebase: {
            doc,
            collection,
            addDoc,
            setDoc,
            getDoc,
            updateDoc,
            deleteDoc,
            onSnapshot,
            query,
            orderBy,
            serverTimestamp,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH OBSERVER
// ─────────────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
    if (user) {
        _onSignedIn(user);
    } else {
        console.warn('[Sync] No active session → redirecting to account.html');
        window.location.replace('account.html');
    }
});

function _onSignedIn(user) {
    // ── Update header display name ──────────────────────────────────────────
    if (userDisplay) {
        const name = user.displayName || user.email.split('@')[0];
        userDisplay.textContent = name.length > 16 ? name.slice(0, 16) + '…' : name;
    }

    // ── Expose SyncAPI globally ─────────────────────────────────────────────
    window._SyncAPI = _buildSyncAPI(user.uid);

    // ── Hide global loader ──────────────────────────────────────────────────
    if (globalLoader) {
        globalLoader.style.opacity       = '0';
        globalLoader.style.pointerEvents = 'none';
        setTimeout(() => { if (globalLoader) globalLoader.style.display = 'none'; }, 500);
    }

    // ── Init ProjectManager ─────────────────────────────────────────────────
    // All sync scripts (editor.js, project-manager.js, ai-panel.js) are loaded
    // via regular <script> tags BEFORE this module, so they are guaranteed
    // to be evaluated and attached to window by this point.
    // No polling needed.
    if (typeof window.ProjectManager !== 'undefined') {
        ProjectManager.init(user.uid, db, window._SyncAPI.firebase);
    } else {
        // Fallback: if somehow not ready, retry once after a frame
        requestAnimationFrame(() => {
            if (typeof window.ProjectManager !== 'undefined') {
                ProjectManager.init(user.uid, db, window._SyncAPI.firebase);
            } else {
                console.error('[Sync] ProjectManager not defined. Check script load order in editor.html.');
            }
        });
    }

    // ── Wire logout button ──────────────────────────────────────────────────
    if (logoutBtn) logoutBtn.onclick = _handleLogout;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────────────────────
async function _handleLogout() {
    try {
        if (globalLoader) { 
            globalLoader.style.display       = 'flex';
            globalLoader.style.opacity       = '1';
            globalLoader.style.pointerEvents = 'all';
            const lbl = globalLoader.querySelector('.text-xs, [class*="font-mono"]');
            if (lbl) lbl.textContent = 'Signing out…';
        }
        await signOut(auth);
        // onAuthStateChanged fires → redirects to account.html
    } catch (err) {
        console.error('[Sync] Logout failed:', err.message);
        alert('Logout failed. Please try again.');
        // Restore loader state
        if (globalLoader) globalLoader.style.display = 'none';
    }
}
