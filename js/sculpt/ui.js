// Helpers UI : barre de statut, overlay de chargement, wireframe.

import { state } from './state.js';

// Toast unique (bas-centre) qui se met à jour à chaque message et disparaît tout seul. setStatus est
// appelé souvent -> un seul toast réutilisé (pas d'empilement), timer d'auto-masquage réinitialisé.
let _toastEl = null, _toastTimer = null;
function showToast(text, ms = 3800) {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
  if (!_toastEl) { _toastEl = document.createElement('div'); _toastEl.className = 'toast'; wrap.appendChild(_toastEl); }
  _toastEl.textContent = text;
  requestAnimationFrame(() => _toastEl && _toastEl.classList.add('show'));
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { if (_toastEl) _toastEl.classList.remove('show'); }, ms);
}

export function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text; // fil discret (record) dans le panneau
  if (text) showToast(text);
}

export function showLoading(visible, text) {
  const el = document.getElementById('loading');
  if (el) el.style.display = visible ? 'flex' : 'none';
  if (text !== undefined) { const t = document.getElementById('loading-text'); if (t) t.textContent = text; }
}

// Barre de progression (0..1) ; null = masquée.
export function setProgress(v) {
  const bar = document.getElementById('progress-bar');
  const fill = document.getElementById('progress-fill');
  if (!bar || !fill) return;
  if (v === null || v === undefined) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

// Reflète state.params.displayHelper sur l'overlay wireframe du mesh courant.
export function refreshWireframe() {
  if (!state.targetMesh) return;
  const wire = state.targetMesh.getObjectByName('wireframe');
  if (wire) wire.visible = state.params.displayHelper;
}
