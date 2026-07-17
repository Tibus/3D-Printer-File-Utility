// Historique undo/redo du sculpt.
// - Strokes (draw/smooth/flatten/move) : on ne stocke QUE les vertices touchés
//   (position + normale, avant/après) -> léger même sur de gros meshes.
// - Opérations structurelles (split, subdivision, suppression) : deux closures
//   undo/redo + un dispose optionnel (libère les meshes retenus à l'éviction).

const MAX = 30;
const undoStack = [];
const redoStack = [];
let listener = null;

export function setHistoryListener(fn) { listener = fn; fire(); }
function fire() { if (listener) listener(undoStack.length > 0, redoStack.length > 0); }

function disposeEntry(e) { if (e && e.dispose) { try { e.dispose(); } catch (_) { /* noop */ } } }
function clearRedo() { for (const e of redoStack) disposeEntry(e); redoStack.length = 0; }

function pushEntry(e) {
  undoStack.push(e);
  while (undoStack.length > MAX) disposeEntry(undoStack.shift());
  clearRedo();
  fire();
}

// change : { mesh, indices:Uint32Array, old:Float32Array, new:Float32Array } (6 floats/vertex)
export function pushGeom(change) { if (change && change.indices.length) pushEntry({ type: 'geom', ...change }); }

// undoFn/redoFn : callbacks ; dispose : libère les meshes retenus non réutilisés
export function pushAction(undoFn, redoFn, dispose) { pushEntry({ type: 'action', undoFn, redoFn, dispose }); }

function applyGeom(e, useNew) {
  const g = e.mesh.geometry;
  if (!g || !g.attributes.position) return;
  const pos = g.attributes.position.array, nor = g.attributes.normal.array;
  const src = useNew ? e.new : e.old, idx = e.indices;
  for (let k = 0; k < idx.length; k++) {
    const v3 = idx[k] * 3, o = k * 6;
    pos[v3] = src[o]; pos[v3 + 1] = src[o + 1]; pos[v3 + 2] = src[o + 2];
    nor[v3] = src[o + 3]; nor[v3 + 1] = src[o + 4]; nor[v3 + 2] = src[o + 5];
  }
  g.attributes.position.needsUpdate = true;
  g.attributes.normal.needsUpdate = true;
  if (g.boundsTree) g.boundsTree.refit();
}

export function undo() {
  const e = undoStack.pop(); if (!e) return;
  if (e.type === 'geom') applyGeom(e, false); else e.undoFn();
  redoStack.push(e); fire();
}

export function redo() {
  const e = redoStack.pop(); if (!e) return;
  if (e.type === 'geom') applyGeom(e, true); else e.redoFn();
  undoStack.push(e); fire();
}

export function clearHistory() {
  for (const e of undoStack) disposeEntry(e);
  for (const e of redoStack) disposeEntry(e);
  undoStack.length = 0; redoStack.length = 0; fire();
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }
