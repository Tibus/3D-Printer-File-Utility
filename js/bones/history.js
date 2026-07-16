// Système d'undo/redo pour les modifications du squelette.
//
// Capture : pour chaque bone, position/quaternion/scale.
//          Pour chaque skinnedMesh, ses boneInverses (modifiés par le mode joints).
//
// Granularité : un snapshot par "action" (= un drag complet, ou un reset).
// Chaque appel à pushUndo() doit être fait AVANT la modification (état before).
//
// Raccourcis clavier (wirés dans main.js) :
//   Ctrl/Cmd + Z         → undo
//   Ctrl/Cmd + Shift + Z → redo
//   Ctrl/Cmd + Y         → redo

import { state } from './state.js';
import { updateRotationUI } from './bones.js';
import { updateInfo } from './ui.js';
import { rebuildWorldPositionCache, refreshWeightColors } from './weight-paint.js';

const MAX_STACK_SIZE = 50;
const undoStack = [];
const redoStack = [];

function captureMarkerPositions(map) {
  const out = [];
  for (const [name, m] of map) out.push({ chainName: name, pos: m.position.toArray() });
  return out;
}

function captureSnapshot() {
  return {
    boneTransforms: state.bones.map((b) => ({
      uuid: b.uuid,
      position: b.position.toArray(),
      quaternion: b.quaternion.toArray(),
      scale: b.scale.toArray(),
    })),
    boneInverses: state.skinnedMeshes.map((m) => ({
      meshUuid: m.uuid,
      data: m.skeleton.boneInverses.map((mat) => mat.toArray()),
    })),
    // Skinning : skinIndex et skinWeight (modifiés en weight paint).
    // On clone les TypedArrays pour éviter les références partagées.
    skinning: state.skinnedMeshes.map((m) => {
      const sw = m.geometry.attributes.skinWeight;
      const si = m.geometry.attributes.skinIndex;
      return {
        meshUuid: m.uuid,
        skinWeight: sw ? new sw.array.constructor(sw.array) : null,
        skinIndex: si ? new si.array.constructor(si.array) : null,
      };
    }),
    // Positions des markers IK (target / pole / orientation) — uniquement si mode IK actif.
    ikMarkers: state.ikMode ? {
      targets: captureMarkerPositions(state.ikTargetMarkers),
      poles: captureMarkerPositions(state.ikPoleMarkers),
      orientations: captureMarkerPositions(state.ikOrientationMarkers),
    } : null,
  };
}

function applySnapshot(snap) {
  // Index des bones par uuid pour O(1) lookup
  const boneByUuid = new Map();
  for (const b of state.bones) boneByUuid.set(b.uuid, b);

  for (const t of snap.boneTransforms) {
    const b = boneByUuid.get(t.uuid);
    if (!b) continue;
    b.position.fromArray(t.position);
    b.quaternion.fromArray(t.quaternion);
    b.scale.fromArray(t.scale);
    b.updateMatrixWorld(true);
  }

  const meshByUuid = new Map();
  for (const m of state.skinnedMeshes) meshByUuid.set(m.uuid, m);

  for (const inv of snap.boneInverses) {
    const mesh = meshByUuid.get(inv.meshUuid);
    if (!mesh || !mesh.skeleton) continue;
    inv.data.forEach((arr, i) => {
      if (mesh.skeleton.boneInverses[i]) {
        mesh.skeleton.boneInverses[i].fromArray(arr);
      }
    });
  }

  // Skinning : restaure skinIndex / skinWeight et marque needsUpdate
  if (snap.skinning) {
    for (const s of snap.skinning) {
      const mesh = meshByUuid.get(s.meshUuid);
      if (!mesh) continue;
      const sw = mesh.geometry.attributes.skinWeight;
      const si = mesh.geometry.attributes.skinIndex;
      if (s.skinWeight && sw) {
        sw.array.set(s.skinWeight);
        sw.needsUpdate = true;
      }
      if (s.skinIndex && si) {
        si.array.set(s.skinIndex);
        si.needsUpdate = true;
      }
    }
  }

  // Refresh paint visuals si mode actif (cache des positions skinnées + heatmap)
  if (state.weightPaintMode) {
    state.skinnedMeshes.forEach((m) => rebuildWorldPositionCache(m));
    refreshWeightColors();
  }

  // Restaure les positions des markers IK si mode IK actif et snapshot pris en mode IK
  if (state.ikMode && snap.ikMarkers) {
    const restoreFromArray = (entries, map) => {
      for (const e of entries) {
        const m = map.get(e.chainName);
        if (m) m.position.fromArray(e.pos);
      }
    };
    restoreFromArray(snap.ikMarkers.targets, state.ikTargetMarkers);
    restoreFromArray(snap.ikMarkers.poles, state.ikPoleMarkers);
    restoreFromArray(snap.ikMarkers.orientations, state.ikOrientationMarkers);
  }

  if (state.selectedBone) updateRotationUI();
}

// À appeler AVANT toute action qui modifie le squelette.
export function pushUndo() {
  undoStack.push(captureSnapshot());
  if (undoStack.length > MAX_STACK_SIZE) undoStack.shift();
  redoStack.length = 0; // toute nouvelle action invalide le redo
}

export function undo() {
  if (undoStack.length === 0) {
    updateInfo('Rien à annuler.');
    return;
  }
  redoStack.push(captureSnapshot());
  applySnapshot(undoStack.pop());
  updateInfo(`Undo (${undoStack.length} restants)`);
}

export function redo() {
  if (redoStack.length === 0) {
    updateInfo('Rien à rétablir.');
    return;
  }
  undoStack.push(captureSnapshot());
  applySnapshot(redoStack.pop());
  updateInfo(`Redo (${redoStack.length} restants)`);
}

// À appeler au chargement d'un nouveau modèle pour repartir de zéro.
export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
}
