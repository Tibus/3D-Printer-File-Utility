// Helpers UI : barre de statut, overlay de chargement, wireframe.

import { state } from './state.js';

export function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
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
