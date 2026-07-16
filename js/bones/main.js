// Point d'entrée : init de la scène, wiring de tous les listeners DOM, lancement de la boucle.

import { state } from './state.js';
import { initScene } from './scene.js';
import { animate, togglePlayPause, toggleSkeleton, toggleRestPose, attachTimelineListeners } from './animation.js';
import {
  selectBone, deselectBone, onCanvasClick,
  updateBoneRotation, resetBoneRotation, updateRotationUI,
  attachBoneSchemaListeners,
} from './bones.js';
import { updateInfo } from './ui.js';
import { loadPrincipal, loadFBXAnimation } from './loader.js';
import {
  enterWeightPaintMode, exitWeightPaintMode,
  updateBrushHelper, paintAtPointer,
  smoothSelectedBoneWeights, smoothAllWeights,
  setPaintShading,
  selectVerticesInScreenRect, clearVertexSelection, applyWeightToSelection,
} from './weight-paint.js';
import {
  enterJointEditMode, exitJointEditMode, resetAllJoints,
  attachJointDragListeners, attachJointRotationListeners,
} from './joint-edit.js';
import { enterIKMode, exitIKMode, attachIKDragListeners, updateGroundPreview } from './ik.js';
import { enterPropsMode, exitPropsMode, attachPropsListeners } from './props.js';
import { tryPickCageVertex, attachCageListeners } from './cage.js';
import { undo, redo, pushUndo } from './history.js';
import { exportToGLB } from './exporter.js';

initScene();

// Met à jour l'UI rotation quand le gizmo est utilisé (mode Pose uniquement,
// car en weight paint et joints le gizmo est détaché).
state.transformControls.addEventListener('change', () => {
  if (state.selectedBone) updateRotationUI();
});

// Snapshot undo avant chaque drag du gizmo
state.transformControls.addEventListener('mouseDown', () => {
  if (state.selectedBone) pushUndo();
});

// Toggle Liste / Schéma de bones
{
  const listBtn = document.getElementById('bone-list-btn');
  const schemaBtn = document.getElementById('bone-schema-btn');
  const listDiv = document.getElementById('bone-list');
  const schemaDiv = document.getElementById('bone-schema');
  listBtn.addEventListener('click', () => {
    listBtn.classList.add('active');
    schemaBtn.classList.remove('active');
    listDiv.style.display = '';
    schemaDiv.style.display = 'none';
  });
  schemaBtn.addEventListener('click', () => {
    schemaBtn.classList.add('active');
    listBtn.classList.remove('active');
    listDiv.style.display = 'none';
    schemaDiv.style.display = '';
  });
  attachBoneSchemaListeners();
}

// File inputs
document.getElementById('modele-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadPrincipal(URL.createObjectURL(file), file.name);
});
document.getElementById('fbx-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadFBXAnimation(URL.createObjectURL(file), file.name);
});

// Boutons généraux
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('toggle-skeleton-btn').addEventListener('click', toggleSkeleton);
document.getElementById('toggle-rest-pose-btn').addEventListener('click', toggleRestPose);
document.getElementById('export-glb-btn').addEventListener('click', exportToGLB);

// Timeline d'animation (play/pause + scrub)
attachTimelineListeners();

// Click sur le canvas : en mode Props on essaie d'abord de piquer un cage
// vertex ; sinon on délègue à la sélection de bone via marker.
state.renderer.domElement.addEventListener('click', (e) => {
  if (state.propsMode && tryPickCageVertex(e)) return;
  onCanvasClick(e);
});

function exitAllSpecialModes() {
  if (state.weightPaintMode) exitWeightPaintMode();
  if (state.jointEditMode) exitJointEditMode();
  if (state.ikMode) exitIKMode();
  if (state.propsMode) exitPropsMode();
}

// Toggles de mode (mutuellement exclusifs)
document.getElementById('mode-pose-btn').addEventListener('click', exitAllSpecialModes);
document.getElementById('mode-paint-btn').addEventListener('click', () => {
  exitAllSpecialModes();
  enterWeightPaintMode();
});
document.getElementById('mode-joints-btn').addEventListener('click', () => {
  exitAllSpecialModes();
  enterJointEditMode();
});
document.getElementById('mode-ik-btn').addEventListener('click', () => {
  exitAllSpecialModes();
  enterIKMode();
});
document.getElementById('mode-props-btn').addEventListener('click', () => {
  exitAllSpecialModes();
  enterPropsMode();
});
attachPropsListeners();
attachCageListeners();
document.getElementById('reset-joints-btn').addEventListener('click', resetAllJoints);

document.getElementById('smooth-weights-btn').addEventListener('click', () => {
  if (state.weightPaintMode && state.selectedBone) pushUndo();
  smoothSelectedBoneWeights();
});

document.getElementById('smooth-all-btn').addEventListener('click', () => {
  if (state.weightPaintMode) pushUndo();
  smoothAllWeights();
});

// document.getElementById('paint-shading').addEventListener('change', (e) => {
//   setPaintShading(e.target.checked);
// });

document.getElementById('brush-geodesic').addEventListener('change', (e) => {
  state.brushGeodesic = e.target.checked;
});

// ----- Toggle Brush / Sélection (modes du panneau weight paint) -----
const brushControlsDiv = document.getElementById('brush-controls');
const selectionControlsDiv = document.getElementById('selection-controls');
const selectionRectDiv = document.getElementById('selection-rect');
const brushModeBtn = document.getElementById('paint-brush-btn');
const selectModeBtn = document.getElementById('paint-select-btn');

function setPaintInteractionMode(isSelection) {
  state.paintSelectionMode = isSelection;
  brushControlsDiv.style.display = isSelection ? 'none' : '';
  selectionControlsDiv.style.display = isSelection ? 'flex' : 'none';
  brushModeBtn.classList.toggle('active', !isSelection);
  selectModeBtn.classList.toggle('active', isSelection);
  if (!isSelection) {
    clearVertexSelection();
    selectionRectDiv.style.display = 'none';
  } else {
    state.brushHelper.visible = false;
  }
}
brushModeBtn.addEventListener('click', () => setPaintInteractionMode(false));
selectModeBtn.addEventListener('click', () => setPaintInteractionMode(true));

bindBrushSlider('selection-weight', 'selection-weight-num', (v) => { state.selectionWeight = v; });

document.getElementById('apply-selection-weight').addEventListener('click', () => {
  pushUndo();
  applyWeightToSelection(state.selectionWeight);
});
document.getElementById('clear-selection').addEventListener('click', clearVertexSelection);

// Drag rectangle 2D : capture les pointer events en mode sélection (priorité sur paint)
let _selStart = null;
state.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!state.weightPaintMode || !state.paintSelectionMode || e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  state.controls.enabled = false;
  _selStart = { x: e.clientX, y: e.clientY, additive: e.shiftKey };
  selectionRectDiv.style.left = `${e.clientX}px`;
  selectionRectDiv.style.top = `${e.clientY}px`;
  selectionRectDiv.style.width = '0px';
  selectionRectDiv.style.height = '0px';
  selectionRectDiv.style.display = 'block';
  try { state.renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
}, true);

state.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!_selStart) return;
  e.stopPropagation();
  const x1 = Math.min(_selStart.x, e.clientX);
  const y1 = Math.min(_selStart.y, e.clientY);
  const x2 = Math.max(_selStart.x, e.clientX);
  const y2 = Math.max(_selStart.y, e.clientY);
  selectionRectDiv.style.left = `${x1}px`;
  selectionRectDiv.style.top = `${y1}px`;
  selectionRectDiv.style.width = `${x2 - x1}px`;
  selectionRectDiv.style.height = `${y2 - y1}px`;
}, true);

function endSelectionDrag(e) {
  if (!_selStart) return;
  const x1 = Math.min(_selStart.x, e.clientX);
  const y1 = Math.min(_selStart.y, e.clientY);
  const x2 = Math.max(_selStart.x, e.clientX);
  const y2 = Math.max(_selStart.y, e.clientY);
  const additive = _selStart.additive;
  _selStart = null;
  selectionRectDiv.style.display = 'none';
  state.controls.enabled = true;
  try { state.renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
  // Si le rectangle est trop petit (< 3px), c'est un click → ne rien faire
  if ((x2 - x1) < 3 && (y2 - y1) < 3) return;
  selectVerticesInScreenRect(x1, y1, x2, y2, additive);
}
state.renderer.domElement.addEventListener('pointerup', endSelectionDrag, true);
state.renderer.domElement.addEventListener('pointercancel', endSelectionDrag, true);

// Toggles IK
document.getElementById('ik-full-body').addEventListener('change', (e) => {
  state.ikFullBody = e.target.checked;
});
document.getElementById('ik-lock-feet').addEventListener('change', (e) => {
  state.ikLockFeet = e.target.checked;
  updateGroundPreview();
});
document.getElementById('ik-constraints').addEventListener('change', (e) => {
  state.ikConstraintsEnabled = e.target.checked;
});
document.getElementById('ik-auto-balance').addEventListener('change', (e) => {
  state.ikAutoBalance = e.target.checked;
});

// Sliders du brush
function bindBrushSlider(rangeId, numId, setter) {
  const range = document.getElementById(rangeId);
  const num = document.getElementById(numId);
  range.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    num.value = v;
    setter(v);
  });
  num.addEventListener('input', (e) => {
    let v = parseFloat(e.target.value);
    if (isNaN(v)) return;
    v = Math.max(parseFloat(range.min), Math.min(parseFloat(range.max), v));
    range.value = v;
    setter(v);
  });
}
bindBrushSlider('brush-radius', 'brush-radius-num', (v) => { state.brushRadius = v; });
bindBrushSlider('brush-strength', 'brush-strength-num', (v) => { state.brushStrength = v; });
bindBrushSlider('brush-falloff', 'brush-falloff-num', (v) => { state.brushFalloff = v; });

// ---------- Pointer events weight paint (capture phase) ----------
const dom = state.renderer.domElement;

dom.addEventListener('pointerdown', (e) => {
  if (!state.weightPaintMode || e.button !== 0) return;
  if (state.paintSelectionMode) return; // le mode sélection prend la main

  const hit = updateBrushHelper(e);
  if (!hit) return; // pas sur le mesh → laisse OrbitControls

  if (!state.selectedBone) {
    updateInfo("Sélectionne un bone d'abord (clic sur un marker ou dans la liste).");
    return;
  }

  e.stopPropagation();
  e.preventDefault();
  state.isPainting = true;
  state.controls.enabled = false;
  try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  state.brushSubtract = e.shiftKey;
  pushUndo(); // snapshot AVANT le premier coup de brush du stroke
  paintAtPointer(e);
}, true);

// Throttle pointermove à 1 par frame
let _pendingPointerEvent = null;
let _rafScheduled = false;
function flushPointerMove() {
  _rafScheduled = false;
  const e = _pendingPointerEvent;
  _pendingPointerEvent = null;
  if (!e || !state.weightPaintMode) return;
  updateBrushHelper(e);
  if (!state.isPainting) return;
  state.brushSubtract = e.shiftKey;
  paintAtPointer(e);
}
dom.addEventListener('pointermove', (e) => {
  if (!state.weightPaintMode) return;
  if (state.isPainting) e.stopPropagation();
  _pendingPointerEvent = e;
  if (!_rafScheduled) {
    _rafScheduled = true;
    requestAnimationFrame(flushPointerMove);
  }
}, true);

function endPaint(e) {
  if (!state.isPainting) return;
  state.isPainting = false;
  state.controls.enabled = true;
  if (e && e.pointerId !== undefined) {
    try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
  }
}
dom.addEventListener('pointerup', endPaint, true);
dom.addEventListener('pointerleave', (e) => {
  state.brushHelper.visible = false;
  endPaint(e);
}, true);
dom.addEventListener('pointercancel', endPaint, true);

// ---------- Drag direct des joints + gizmo rotation pour mains/pieds ----------
attachJointDragListeners(selectBone);
attachJointRotationListeners();

// ---------- Drag des cibles IK ----------
attachIKDragListeners();

// ---------- Clavier ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') state.brushSubtract = true;
  if (e.key === 'Escape') {
    if (state.weightPaintMode) exitWeightPaintMode();
    else if (state.jointEditMode) exitJointEditMode();
    else if (state.ikMode) exitIKMode();
    else deselectBone();
  }

  // Undo / Redo (ignorer si focus sur un input pour ne pas casser les sliders)
  const target = e.target;
  const inForm = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  if (!inForm && (e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      redo();
    }
  }

  // Navigation flèches haut/bas dans la liste des bones (cycle aux extrémités)
  if (!inForm && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.bones.length > 0) {
    e.preventDefault();
    const n = state.bones.length;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    let newIdx;
    if (state.selectedBoneIndex < 0) {
      newIdx = dir === 1 ? 0 : n - 1;
    } else {
      newIdx = (state.selectedBoneIndex + dir + n) % n;
    }
    selectBone(newIdx);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') state.brushSubtract = false;
});

// ---------- Sliders rotation ----------
// On snapshot une seule fois au pointerdown du slider (début d'une session
// d'édition continue) pour ne pas spammer l'historique pendant un drag.
['x', 'y', 'z'].forEach((axis) => {
  const range = document.getElementById(`rot-${axis}`);
  const num = document.getElementById(`rot-${axis}-num`);
  range.addEventListener('pointerdown', () => { if (state.selectedBone) pushUndo(); });
  num.addEventListener('focus', () => { if (state.selectedBone) pushUndo(); });
  range.addEventListener('input', (e) => {
    updateBoneRotation(axis, parseFloat(e.target.value));
  });
  num.addEventListener('input', (e) => {
    let val = parseFloat(e.target.value) || 0;
    val = Math.max(-180, Math.min(180, val));
    updateBoneRotation(axis, val);
  });
});
document.getElementById('reset-bone-btn').addEventListener('click', resetBoneRotation);

// ---------- Drag and drop ----------
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.style.opacity = '0.7';
});
document.addEventListener('dragleave', () => {
  document.body.style.opacity = '1';
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.style.opacity = '1';
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (file.name.endsWith('.glb') || file.name.endsWith('.gltf')) {
    loadPrincipal(URL.createObjectURL(file), file.name);
  } else if (file.name.endsWith('.fbx') && state.currentModel) {
    loadFBXAnimation(URL.createObjectURL(file), file.name);
  }
});

// ---------- Resize ----------
window.addEventListener('resize', () => {
  state.camera.aspect = window.innerWidth / window.innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Boucle ----------
animate();
