// Point d'entrée : init scène, wiring UI + événements pointeur, boucle de rendu.

import * as THREE from 'three';
import { state } from './state.js';
import { initScene } from './scene.js';
import {
  loadModelFromFile, subdivideTarget, separateComponents,
  createObject, setActiveObject, setOnObjectsChanged,
  detachObject, attachObject, disposeObject,
} from './loader.js';
import {
  raycastSurface, updateBrushCursor, performStroke,
  startGrab, moveGrab, endGrab, beginStroke,
  recordStrokeBegin, recordStrokeEnd,
} from './brush.js';
import { lassoSplitAsync } from './split.js';
import { lassoSplitCSG } from './split-csg.js';
import { pushGeom, pushAction, pushMask, undo, redo, setHistoryListener } from './history.js';
import { initGizmo, activateGizmo, deactivateGizmo, setAltPivot, isGizmoActive } from './gizmo.js';
import { ensureMask, invertMask, clearMask, setMaskBlur, rebuildMask, bakeMaskBlur, maskRecordBegin, maskRecordEnd } from './mask.js';
import { exportGLB, exportOBJ } from './exporter.js';
import { refreshWireframe, setStatus, showLoading, setProgress } from './ui.js';
import { makeSquareAlpha, makeRoundAlpha, loadAlphaFromImage, renderAlphaPreview, makeFalloff, loadFalloffFromImage, renderFalloffPreview } from './alpha.js';

initScene();
initGizmo();
state.alpha = makeSquareAlpha(); // forme du brush (défaut : carré)
state.falloff = makeFalloff(state.params.falloffHardness); // falloff radial

const dom = state.renderer.domElement;

// Ajustement du rayon du brush en maintenant X : la souris change le diamètre.
let radiusMode = false, radiusStartX = 0, radiusStartSize = 0, radiusAnchor = null, lastClientX = 0;
const RADIUS_PER_PX = 0.0012; // vitesse d'ajustement (unités monde / pixel)
function setBrushSize(v) {
  const r = document.getElementById('size-range'), num = document.getElementById('size-num');
  v = Math.max(parseFloat(r.min), Math.min(parseFloat(r.max), v));
  state.params.size = v; r.value = v; num.value = v.toFixed(3);
}
let sculpting = false;   // un stroke est en cours (pointerdown démarré sur le mesh)

// ---------- Résolution dynamique (pendant le sculpt uniquement) ----------
// Écrire le buffer chaque frame force un sync GPU : le CPU attend la fin du rendu
// de la frame précédente. Réduire pixelRatio pendant le stroke raccourcit ce
// rendu (donc le stall). La rotation n'écrit pas le buffer -> pleine résolution.
const FULL_DPR = Math.min(window.devicePixelRatio || 1, 2);
function setSculptResolution(active) {
  state.renderer.setPixelRatio(active ? 1 : FULL_DPR);
}

// ---------- Utilitaires ----------

function setMouseFromEvent(e) {
  const rect = dom.getBoundingClientRect();
  state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function modifiersFor(e) {
  // Shift => lissage temporaire ; Ctrl/Cmd => inverser (remove) le draw
  if (e.shiftKey) return { tool: 'smooth' };
  if (e.ctrlKey || e.metaKey) return { invert: !state.params.invert };
  return {};
}

// Spacing de stroke : un coup tous les SPACING_FRAC * rayon PARCOURUS (comme
// ZBrush / Nomad), pas un coup par frame. L'impact devient proportionnel à la
// distance parcourue par la souris — bouger un peu = peu de matière, plus d'effet
// « exponentiel » quand on va lentement. Interpole les coups sur les mouvements
// rapides pour un trait continu et d'intensité constante quelle que soit la vitesse.
const SPACING_FRAC = 0.15;
const MAX_STAMPS = 10; // garde-fou sur un grand saut de curseur
const _ls = { x: 0, y: 0, z: 0, has: false };

function stampSpaced(p, mods) {
  if (!_ls.has) { performStroke(p, mods); _ls.x = p.x; _ls.y = p.y; _ls.z = p.z; _ls.has = true; return; }
  const spacing = Math.max(1e-4, state.params.size * SPACING_FRAC);
  let dx = p.x - _ls.x, dy = p.y - _ls.y, dz = p.z - _ls.z;
  let remaining = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let stamps = 0;
  while (remaining >= spacing && stamps < MAX_STAMPS) {
    const t = spacing / remaining;
    _ls.x += (p.x - _ls.x) * t; _ls.y += (p.y - _ls.y) * t; _ls.z += (p.z - _ls.z) * t;
    performStroke(_ls, mods);
    dx = p.x - _ls.x; dy = p.y - _ls.y; dz = p.z - _ls.z;
    remaining = Math.sqrt(dx * dx + dy * dy + dz * dz);
    stamps++;
  }
  if (stamps >= MAX_STAMPS) { _ls.x = p.x; _ls.y = p.y; _ls.z = p.z; } // gros saut : on recale
}

// ---------- Outil Split (lasso) ----------

const lassoSvg = document.getElementById('lasso-overlay');
const lassoPath = document.getElementById('lasso-path');
let lassoPts = [];
let lassoing = false;

function startLasso(e) {
  lassoing = true;
  lassoPts = [{ x: e.clientX, y: e.clientY }];
  state.controls.enabled = false;
  state.brushMesh.visible = false;
  lassoSvg.style.display = 'block';
  updateLassoPath();
  try { dom.setPointerCapture(e.pointerId); } catch (_) {}
}

function addLassoPoint(e) {
  const last = lassoPts[lassoPts.length - 1];
  if (last && Math.abs(last.x - e.clientX) < 2 && Math.abs(last.y - e.clientY) < 2) return;
  lassoPts.push({ x: e.clientX, y: e.clientY });
  updateLassoPath();
}

function updateLassoPath() {
  lassoPath.setAttribute('points', lassoPts.map((p) => `${p.x},${p.y}`).join(' '));
}

function finishLasso(e) {
  lassoing = false;
  state.controls.enabled = true;
  lassoSvg.style.display = 'none';
  if (e && e.pointerId !== undefined) { try { dom.releasePointerCapture(e.pointerId); } catch (_) {} }
  if (lassoPts.length >= 3) performSplit();
  lassoPts = [];
}

function performSplit() {
  const mesh = state.targetMesh;
  if (!mesh) return;
  const rect = dom.getBoundingClientRect();
  const poly = lassoPts.map((p) => ({ x: p.x - rect.left, y: p.y - rect.top }));
  mesh.updateMatrixWorld(true);

  const csg = state.params.splitMode === 'csg';
  showLoading(true, csg ? 'Découpe (CSG, lent)…' : 'Découpe…');
  setProgress(csg ? null : 0);
  // Mode CSG : booléen bloquant sur le thread principal -> setTimeout pour laisser
  // le spinner s'afficher avant le calcul. Mode rapide : worker (CDT) + progression.
  const run = csg
    ? new Promise((resolve) => setTimeout(() => {
      const r = lassoSplitCSG(mesh.geometry, poly, state.camera, mesh.matrixWorld, rect.width, rect.height, state.params.cutDetail);
      if (r) r.capMode = 'csg';
      resolve(r);
    }, 40))
    : lassoSplitAsync(mesh.geometry, poly, state.camera, mesh.matrixWorld, rect.width, rect.height, state.params.cutDetail, setProgress);
  run
    .then((res) => {
      if (!res) { setStatus('Le lasso n’a rien séparé.'); return; }
      // Cap dégradé (repli fast, pas le CDT ni le CSG) : refuse la découpe pour ne PAS
      // détruire le maillage courant avec des "lignes verticales" ni cascader.
      if (res.capMode && res.capMode !== 'worker-cdt' && res.capMode !== 'csg') {
        setStatus('Découpe impossible ici : maillage trop peu dense sous le lasso. Passe en mode « Précise (CSG) », clique « Subdiviser », ou agrandis le tracé.');
        return;
      }
      // DoubleSide : l'orientation des parois n'est pas garantie.
      const matIn = mesh.material.clone(); matIn.side = THREE.DoubleSide;
      const matOut = mesh.material.clone(); matOut.side = THREE.DoubleSide;
      const inMesh = createObject(res.inside, matIn);
      const outMesh = createObject(res.outside, matOut);
      detachObject(mesh); // garde l'original pour l'undo (pas de dispose)
      setActiveObject(outMesh);
      renderObjectList();
      setStatus('Split effectué (2 objets).');
      pushAction(
        () => { detachObject(inMesh); detachObject(outMesh); attachObject(mesh); setActiveObject(mesh); renderObjectList(); },
        () => { detachObject(mesh); attachObject(inMesh); attachObject(outMesh); setActiveObject(outMesh); renderObjectList(); },
        () => { for (const m of [mesh, inMesh, outMesh]) if (!state.objects.includes(m)) disposeObject(m); },
      );
    })
    .catch((err) => { console.error(err); setStatus(`Split : ${err.message}`); })
    .finally(() => { showLoading(false); setProgress(null); });
}

// ---------- Liste d'objets ----------

function renderObjectList() {
  const list = document.getElementById('object-list');
  list.innerHTML = '';
  if (!state.objects.length) {
    list.innerHTML = '<div style="font-size:12px;color:#888;">Aucun objet</div>';
    return;
  }
  state.objects.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'obj-row' + (m === state.targetMesh ? ' active' : '');

    const name = document.createElement('span');
    name.className = 'obj-name';
    name.textContent = m.name;
    name.addEventListener('click', () => { if (m.visible) { setActiveObject(m); if (isGizmoActive()) activateGizmo(m); renderObjectList(); } });

    const eye = document.createElement('button');
    eye.className = 'obj-btn';
    eye.textContent = m.visible ? '👁' : '🚫';
    eye.title = 'Afficher / masquer';
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      m.visible = !m.visible;
      if (!m.visible && state.targetMesh === m) {
        const n = state.objects.find((o) => o.visible);
        if (n) setActiveObject(n);
        if (isGizmoActive()) { if (n) activateGizmo(n); else deactivateGizmo(); }
      }
      renderObjectList();
    });

    const del = document.createElement('button');
    del.className = 'obj-btn';
    del.textContent = '🗑';
    del.title = 'Supprimer';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasActive = state.targetMesh === m;
      if (isGizmoActive() && wasActive) deactivateGizmo();
      detachObject(m); renderObjectList(); // détache (undoable) au lieu de dispose
      pushAction(
        () => { attachObject(m); if (wasActive) setActiveObject(m); renderObjectList(); },
        () => { detachObject(m); renderObjectList(); },
        () => { if (!state.objects.includes(m)) disposeObject(m); },
      );
    });

    row.append(name, eye, del);
    list.appendChild(row);
  });
}
setOnObjectsChanged(renderObjectList);
renderObjectList();
window.__objects = state.objects; // debug (comme window.__perf)

// ---------- Événements pointeur ----------

dom.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.targetMesh) return;
  if (radiusMode) return; // réglage du rayon en cours (X maintenu)
  if (state.params.tool === 'gizmo') return; // TransformControls gère ses propres events
  if (state.params.tool === 'split') { startLasso(e); return; }
  setMouseFromEvent(e);
  const hit = raycastSurface();
  if (!hit) return; // clic dans le vide => laisser OrbitControls tourner

  sculpting = true;
  setSculptResolution(true);
  state.controls.enabled = false;
  try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  if (state.params.tool === 'mask') { ensureMask(state.targetMesh.geometry, state.targetMesh.material); maskRecordBegin(state.targetMesh.geometry); }
  else recordStrokeBegin(); // undo : démarre la capture des vertices touchés

  if (state.params.tool === 'move') {
    if (!startGrab(hit)) { sculpting = false; state.controls.enabled = true; }
    state.brushMesh.visible = false;
  } else {
    _ls.has = false;
    beginStroke(); // nouvelle session d'accumulation (buildup plafonné)
    stampSpaced(hit.point, modifiersFor(e)); // premier coup au clic
  }
});

// pointermove peut se déclencher plusieurs fois par frame → on coalesce et on
// ne traite qu'une fois par frame d'animation (gros gain de perf sur gros mesh).
let pendingMods = null;
let moveScheduled = false;

function processMove() {
  moveScheduled = false;
  if (!pendingMods) return;
  const mods = pendingMods;
  pendingMods = null;

  if (!sculpting) {
    if (state.params.tool === 'split' || state.params.tool === 'gizmo') { state.brushMesh.visible = false; return; }
    updateBrushCursor(raycastSurface());
    return;
  }
  const st = performance.now();
  if (state.params.tool === 'move') {
    moveGrab();
  } else {
    const hit = raycastSurface();
    updateBrushCursor(hit, false); // orientation figée pendant le stroke (perf)
    if (hit) stampSpaced(hit.point, mods);
  }
  perf.sculptLast = performance.now() - st;
}

dom.addEventListener('pointermove', (e) => {
  lastClientX = e.clientX;
  if (radiusMode) { // X maintenu : la souris règle le rayon du brush
    setBrushSize(radiusStartSize + (e.clientX - radiusStartX) * RADIUS_PER_PX);
    if (radiusAnchor) updateBrushCursor(radiusAnchor, false);
    return;
  }
  if (lassoing) { addLassoPoint(e); return; }
  setMouseFromEvent(e);
  pendingMods = modifiersFor(e);
  if (!moveScheduled) {
    moveScheduled = true;
    requestAnimationFrame(processMove);
  }
});

function endStroke(e) {
  if (!sculpting) return;
  sculpting = false;
  _ls.has = false;
  setSculptResolution(false);
  state.controls.enabled = true;
  endGrab();
  if (state.params.tool === 'mask') {
    if (state.targetMesh) rebuildMask(state.targetMesh.geometry); // applique le flou en fin de stroke
    pushMask(maskRecordEnd());
  } else {
    pushGeom(recordStrokeEnd()); // undo : enregistre le stroke terminé
  }
  if (e && e.pointerId !== undefined) {
    try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
  }
}
function onPointerUp(e) {
  if (lassoing) { finishLasso(e); return; }
  endStroke(e);
}
dom.addEventListener('pointerup', onPointerUp);
dom.addEventListener('pointercancel', onPointerUp);
dom.addEventListener('pointerleave', () => { if (!lassoing) state.brushMesh.visible = false; });

// Empêche le menu contextuel de gêner (au cas où on mappe le clic droit plus tard)
dom.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- UI : chargement / export ----------

document.getElementById('model-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) { deactivateGizmo(); loadModelFromFile(file); }
  e.target.value = '';
});

document.getElementById('export-glb-btn').addEventListener('click', exportGLB);
document.getElementById('export-obj-btn').addEventListener('click', exportOBJ);
document.getElementById('subdivide-btn').addEventListener('click', subdivideTarget);
document.getElementById('separate-btn').addEventListener('click', () => {
  if (isGizmoActive()) deactivateGizmo();
  separateComponents();
  renderObjectList();
});

// Undo / redo
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
setHistoryListener((cu, cr) => { undoBtn.disabled = !cu; redoBtn.disabled = !cr; });

// ---------- UI : outils ----------

const toolButtons = document.querySelectorAll('.tool-btn');
toolButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.params.tool = btn.dataset.tool;
    toolButtons.forEach((b) => b.classList.toggle('active', b === btn));
    // L'inversion n'a de sens que pour le draw
    document.getElementById('invert-row').style.display =
      state.params.tool === 'draw' ? '' : 'none';
    const t = state.params.tool, isGizmo = t === 'gizmo', isMask = t === 'mask';
    if (t === 'split' || isGizmo) state.brushMesh.visible = false;
    if (isGizmo) activateGizmo(state.targetMesh); else deactivateGizmo();
    document.getElementById('gizmo-hint').style.display = isGizmo ? '' : 'none';
    document.getElementById('mask-panel').style.display = isMask ? 'flex' : 'none';
    if (isMask && state.targetMesh) {
      ensureMask(state.targetMesh.geometry, state.targetMesh.material);
      const b = state.targetMesh.geometry.userData.maskBlur || 0;
      document.getElementById('maskblur-range').value = b;
      document.getElementById('maskblur-val').textContent = b;
    }
  });

// Panneau masque : inverser / effacer / flou
document.getElementById('mask-invert').addEventListener('click', () => {
  if (!state.targetMesh) return;
  const g = state.targetMesh.geometry; ensureMask(g, state.targetMesh.material);
  invertMask(g);
  pushAction(() => invertMask(g), () => invertMask(g));
});
document.getElementById('mask-clear').addEventListener('click', () => {
  if (!state.targetMesh) return;
  const g = state.targetMesh.geometry; ensureMask(g, state.targetMesh.material);
  const old = Float32Array.from(g.userData.maskSharp);
  clearMask(g);
  pushAction(
    () => { g.userData.maskSharp.set(old); rebuildMask(g); },
    () => clearMask(g),
  );
});
{
  const range = document.getElementById('maskblur-range');
  const val = document.getElementById('maskblur-val');
  range.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    val.textContent = v;
    if (state.targetMesh) { ensureMask(state.targetMesh.geometry, state.targetMesh.material); setMaskBlur(state.targetMesh.geometry, v); }
  });
  // Au relâchement : "cuit" le flou dans le masque net puis remet le slider à 0,
  // pour que repeindre par-dessus ne réapplique pas de flou.
  range.addEventListener('change', () => {
    if (!state.targetMesh) return;
    const g = state.targetMesh.geometry;
    const oldSharp = Float32Array.from(g.userData.maskSharp || []);
    const oldBlur = g.userData.maskBlur | 0;
    if (!bakeMaskBlur(g)) return;             // rien à cuire (flou = 0)
    rebuildMask(g);
    range.value = 0; val.textContent = 0;
    const newSharp = Float32Array.from(g.userData.maskSharp);
    pushAction(
      () => { g.userData.maskSharp.set(oldSharp); g.userData.maskBlur = oldBlur; rebuildMask(g); },
      () => { g.userData.maskSharp.set(newSharp); g.userData.maskBlur = 0; rebuildMask(g); },
    );
  });
}
});

// ---------- UI : sliders ----------

function bindSlider(rangeId, numId, key, format) {
  const range = document.getElementById(rangeId);
  const num = document.getElementById(numId);
  const apply = (v) => {
    state.params[key] = v;
    range.value = v;
    num.value = format ? format(v) : v;
  };
  range.addEventListener('input', (e) => apply(parseFloat(e.target.value)));
  num.addEventListener('input', (e) => {
    let v = parseFloat(e.target.value);
    if (isNaN(v)) return;
    v = Math.max(parseFloat(range.min), Math.min(parseFloat(range.max), v));
    apply(v);
  });
  apply(state.params[key]);
}
bindSlider('size-range', 'size-num', 'size', (v) => v.toFixed(3));

// Intensité : slider seul + affichage en % (pas de champ éditable).
{
  const range = document.getElementById('intensity-range');
  const val = document.getElementById('intensity-val');
  const apply = (v) => { state.params.intensity = v; range.value = v; val.textContent = `${Math.round(v)}%`; };
  range.addEventListener('input', (e) => apply(parseFloat(e.target.value)));
  apply(state.params.intensity);
}

// Falloff radial : slider Dureté (génère la LUT) OU image importée.
{
  const range = document.getElementById('hardness-range');
  const val = document.getElementById('hardness-val');
  const preview = document.getElementById('falloff-preview');
  const drawPreview = () => renderFalloffPreview(preview, state.falloff);
  const apply = (v) => {
    state.params.falloffHardness = v / 100;
    state.falloff = makeFalloff(state.params.falloffHardness);
    range.value = v;
    val.textContent = `${Math.round(v)}%`;
    drawPreview();
  };
  range.addEventListener('input', (e) => apply(parseFloat(e.target.value)));
  apply(state.params.falloffHardness * 100);

  document.getElementById('falloff-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.falloff = await loadFalloffFromImage(file);
      drawPreview();
      setStatus(`Falloff importé : ${file.name}`);
    } catch (err) {
      setStatus(`Falloff : ${err.message}`);
    }
    e.target.value = '';
  });
}

// Détail des parois du split (subdivisions en profondeur).
{
  const range = document.getElementById('cutdetail-range');
  const val = document.getElementById('cutdetail-val');
  const apply = (v) => { state.params.cutDetail = v; range.value = v; val.textContent = `${Math.round(v)}`; };
  range.addEventListener('input', (e) => apply(parseInt(e.target.value, 10)));
  apply(state.params.cutDetail);
}
{
  const sel = document.getElementById('split-mode');
  if (sel) {
    sel.value = state.params.splitMode;
    sel.addEventListener('change', (e) => { state.params.splitMode = e.target.value; });
  }
}

// ---------- UI : alpha ----------

{
  const preview = document.getElementById('alpha-preview');
  const btns = document.querySelectorAll('.alpha-btn');
  const setActive = (name) => btns.forEach((b) => b.classList.toggle('active', b.dataset.alpha === name));
  const refresh = () => renderAlphaPreview(preview, state.alpha);
  refresh();

  btns.forEach((b) => b.addEventListener('click', () => {
    state.alpha = b.dataset.alpha === 'round' ? makeRoundAlpha() : makeSquareAlpha();
    setActive(state.alpha.name);
    refresh();
  }));

  document.getElementById('alpha-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.alpha = await loadAlphaFromImage(file);
      setActive('custom'); // aucun preset actif
      refresh();
      setStatus(`Alpha importé : ${file.name}`);
    } catch (err) {
      setStatus(`Alpha : ${err.message}`);
    }
    e.target.value = '';
  });
}

// ---------- UI : cases à cocher ----------

document.getElementById('invert-check').addEventListener('change', (e) => {
  state.params.invert = e.target.checked;
});
document.getElementById('symmetry-check').addEventListener('change', (e) => {
  state.params.symmetryX = e.target.checked;
});
document.getElementById('wireframe-check').addEventListener('change', (e) => {
  state.params.displayHelper = e.target.checked;
  refreshWireframe();
});

// ---------- Redimensionnement ----------

window.addEventListener('resize', () => {
  state.camera.aspect = window.innerWidth / window.innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Drag & drop de fichier ----------

document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) { deactivateGizmo(); loadModelFromFile(file); }
});

// ---------- HUD de perf (touche P) ----------
// Mesure sur le VRAI GPU : temps de frame, rendu (inclut l'upload GPU), sculpt
// (avec détail collect/apply/normals/refit via window.__perf).
window.__perf = { collect: 0, apply: 0, normals: 0, refit: 0, count: 0, affected: 0, tris: 0 };
const perf = { sculptLast: 0, frameEMA: 0, renderEMA: 0, sculptEMA: 0, lastT: performance.now(), visible: false };
const hud = document.createElement('div');
hud.id = 'perf-hud';
hud.style.cssText = 'position:fixed;bottom:60px;left:20px;z-index:300;background:rgba(0,0,0,.75);color:#8f8;font:12px/1.5 ui-monospace,monospace;padding:8px 12px;border-radius:8px;white-space:pre;pointer-events:none;display:none';
document.body.appendChild(hud);
document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // laisser l'undo natif des champs
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (isGizmoActive() && e.key === 'Alt') { e.preventDefault(); setAltPivot(true); return; }
  if ((e.key === 'x' || e.key === 'X') && !e.repeat) { enterRadiusMode(); return; }
  if (e.key === 'p' || e.key === 'P') { perf.visible = !perf.visible; hud.style.display = perf.visible ? 'block' : 'none'; }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') setAltPivot(false);
  if (e.key === 'x' || e.key === 'X') exitRadiusMode();
});
window.addEventListener('blur', () => { setAltPivot(false); exitRadiusMode(); }); // sécurité si une touche "coince"

// X maintenu : la souris règle le rayon du brush (relâcher = retour normal).
function enterRadiusMode() {
  if (radiusMode || !state.targetMesh) return;
  const t = state.params.tool;
  if (t === 'split' || t === 'gizmo' || t === 'move') return; // sans objet de brush
  radiusMode = true;
  radiusStartX = lastClientX;
  radiusStartSize = state.params.size;
  radiusAnchor = raycastSurface(); // point figé sous le curseur
  state.controls.enabled = false;
  if (radiusAnchor) { state.brushMesh.visible = true; updateBrushCursor(radiusAnchor, false); }
  setStatus(`Rayon : ${state.params.size.toFixed(3)} — bouge la souris, relâche X`);
}
function exitRadiusMode() {
  if (!radiusMode) return;
  radiusMode = false; radiusAnchor = null;
  if (!sculpting) state.controls.enabled = true;
}

// ---------- Boucle de rendu ----------

function animate() {
  requestAnimationFrame(animate);
  state.controls.update();

  const now = performance.now();
  const frame = now - perf.lastT;
  perf.lastT = now;

  const r0 = performance.now();
  state.renderer.render(state.scene, state.camera);
  const render = performance.now() - r0;

  // EMA
  perf.frameEMA = perf.frameEMA * 0.9 + frame * 0.1;
  perf.renderEMA = perf.renderEMA * 0.9 + render * 0.1;
  perf.sculptEMA = perf.sculptEMA * 0.9 + perf.sculptLast * 0.1;
  perf.sculptLast = 0;

  if (perf.visible) {
    const P = window.__perf;
    const n = Math.max(1, P.count);
    hud.textContent =
      `frame ${perf.frameEMA.toFixed(1)}ms  ${(1000 / perf.frameEMA).toFixed(0)}fps\n` +
      `render ${perf.renderEMA.toFixed(1)}ms  sculpt ${perf.sculptEMA.toFixed(1)}ms\n` +
      `  collect ${(P.collect / n).toFixed(1)}  apply ${(P.apply / n).toFixed(1)}\n` +
      `  normals ${(P.normals / n).toFixed(1)}  refit ${(P.refit / n).toFixed(1)}\n` +
      `  affected ${P.affected}  tris ${P.tris}`;
    if (P.count > 30) { P.collect = P.apply = P.normals = P.refit = P.count = 0; }
  }
}
animate();

setStatus('Chargez un modèle (.glb, .gltf, .obj, .stl, .fbx, .3mf) pour commencer.');
