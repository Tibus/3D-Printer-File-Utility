// Helpers UI : barre de statut, overlay de chargement, wireframe.

import { state } from './state.js';

export function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

export function showLoading(visible) {
  const el = document.getElementById('loading');
  if (el) el.style.display = visible ? 'flex' : 'none';
}

// Reflète state.params.displayHelper sur l'overlay wireframe du mesh courant.
export function refreshWireframe() {
  if (!state.targetMesh) return;
  const wire = state.targetMesh.getObjectByName('wireframe');
  if (wire) wire.visible = state.params.displayHelper;
}
