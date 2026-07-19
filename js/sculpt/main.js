// Point d'entrée : init scène, wiring UI + événements pointeur, boucle de rendu.

import * as THREE from 'three';
import { state } from './state.js';
import { initScene } from './scene.js';
import {
  loadModelFromFile, subdivideTarget, separateComponents, newScene,
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
import { lassoSplitManifold, warmupManifold } from './split-manifold.js';
import { lassoSplitLocalized } from './split-local.js';
import { voxelRemesh } from './remesh.js';
import { booleanObjects } from './boolean.js';
import { repairMesh } from './repair.js';
import { hollowMesh } from './hollow.js';
import { checkThickness } from './wallcheck.js';
import { autoOrient } from './orient.js';
import { decimateMesh } from './decimate.js';
import { applyDisplayMode } from './display.js';
import { saveScene, loadScene, clearScene } from './autosave.js';
import { splitByMask } from './split-mask.js';
import { pushGeom, pushAction, pushMask, undo, redo, setHistoryListener } from './history.js';
import { initGizmo, activateGizmo, deactivateGizmo, setAltPivot, isGizmoActive } from './gizmo.js';
import { ensureMask, invertMask, clearMask, setMaskBlur, rebuildMask, bakeMaskBlur, maskRecordBegin, maskRecordEnd } from './mask.js';
import { exportGLB, exportOBJ } from './exporter.js';
import { refreshWireframe, setStatus, showLoading, setProgress } from './ui.js';
import { makeSquareAlpha, makeRoundAlpha, loadAlphaFromImage, renderAlphaPreview, makeFalloff, loadFalloffFromImage, renderFalloffPreview } from './alpha.js';

// Matériau RÉEL d'un objet (indépendant du mode d'affichage matcap/uni).
const baseMatOf = (m) => m.userData.baseMat || m.material;

// Clignotement d'alpha d'un mesh sur ~0,5 s (feedback visuel, ex. après un split) : on
// clone son matériau, on fait varier l'opacité 1 -> ~0.15 -> 1, puis on restaure.
function flashMesh(mesh, dur = 500) {
  if (!mesh || !mesh.material) return;
  const original = mesh.material;
  const anim = original.clone();
  anim.transparent = true; anim.depthWrite = false;
  mesh.material = anim;
  const start = performance.now();
  const tick = () => {
    const t = Math.min(1, (performance.now() - start) / dur);
    anim.opacity = 1 - 0.85 * Math.sin(t * Math.PI); // 1 -> 0.15 -> 1
    if (t < 1) requestAnimationFrame(tick);
    else { if (mesh.material === anim) mesh.material = original; anim.dispose(); }
  };
  requestAnimationFrame(tick);
}

initScene();
initGizmo();
warmupManifold(); // précharge le WASM du booléen (mode de découpe par défaut)
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
  const g = mesh.geometry, cam = state.camera, mw = mesh.matrixWorld, w = rect.width, h = rect.height, det = state.params.cutDetail;
  showLoading(true, csg ? 'Découpe (booléen)…' : 'Découpe…');
  setProgress(csg ? null : 0);
  const startedAt = performance.now();
  // Mode "précis" : d'abord LOCALISÉ (booléen sur la zone du lasso seulement -> rapide).
  // Si non applicable (petit maillage / lasso couvrant tout), Manifold (watertight) puis
  // three-bvh-csg. Double rAF : GARANTIT le rendu du spinner avant le calcul bloquant.
  const run = csg
    ? new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(async () => {
      const loc = lassoSplitLocalized(g, poly, cam, mw, w, h, det, lassoSplitCSG);
      if (loc && !loc.fallback) { resolve(loc); return; }
      let r = await lassoSplitManifold(g, poly, cam, mw, w, h, det);
      if (r && r.fallback) { const c = lassoSplitCSG(g, poly, cam, mw, w, h, det); if (c) c.capMode = 'csg'; r = c; }
      resolve(r);
    })))
    : lassoSplitAsync(g, poly, cam, mw, w, h, det, setProgress);
  run
    .then((res) => {
      if (!res) { setStatus('Le lasso n’a rien séparé.'); return; }
      // Cap dégradé (mode rapide uniquement) : refuse pour ne PAS détruire le maillage
      // ni cascader. Les modes booléens (local/manifold/csg) sont toujours acceptés.
      if (!csg && res.capMode && res.capMode !== 'worker-cdt') {
        setStatus('Découpe impossible ici : maillage trop peu dense sous le lasso. Passe en mode « Précise (booléen) », clique « Subdiviser », ou agrandis le tracé.');
        return;
      }
      // DoubleSide : l'orientation des parois n'est pas garantie.
      const matIn = baseMatOf(mesh).clone(); matIn.side = THREE.DoubleSide;
      const matOut = baseMatOf(mesh).clone(); matOut.side = THREE.DoubleSide;
      const inMesh = createObject(res.inside, matIn);
      const outMesh = createObject(res.outside, matOut);
      detachObject(mesh); // garde l'original pour l'undo (pas de dispose)
      setActiveObject(outMesh);
      renderObjectList();
      flashMesh(inMesh); // clignotement d'alpha sur la pièce découpée (feedback visuel)
      setStatus('Split effectué (2 objets).');
      pushAction(
        () => { detachObject(inMesh); detachObject(outMesh); attachObject(mesh); setActiveObject(mesh); renderObjectList(); },
        () => { detachObject(mesh); attachObject(inMesh); attachObject(outMesh); setActiveObject(outMesh); renderObjectList(); },
        () => { for (const m of [mesh, inMesh, outMesh]) if (!state.objects.includes(m)) disposeObject(m); },
      );
    })
    .catch((err) => { console.error(err); setStatus(`Split : ${err.message}`); })
    .finally(() => {
      // durée minimale d'affichage du spinner (les coupes localisées sont très rapides
      // -> sinon le loading ne serait pas visible).
      const wait = Math.max(0, 250 - (performance.now() - startedAt));
      setTimeout(() => { showLoading(false); setProgress(null); }, wait);
    });
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
    const tri = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
    name.textContent = `${m.name} (${tri.toLocaleString('fr-FR')} tri)`;
    name.addEventListener('click', () => { if (m.visible) { setActiveObject(m); if (isGizmoActive()) activateGizmo(m); renderObjectList(); } });

    const eye = document.createElement('button');
    eye.className = 'obj-btn';
    eye.textContent = m.visible ? '👁' : '🚫';
    eye.title = 'Afficher / masquer';
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      m.visible = !m.visible;
      if (!m.visible && state.targetMesh === m) {
        // l'objet actif ne doit jamais rester caché : bascule vers un visible, ou aucun.
        const n = state.objects.find((o) => o.visible) || null;
        setActiveObject(n);
        if (isGizmoActive()) { if (n) activateGizmo(n); else deactivateGizmo(); }
      }
      renderObjectList();
    });

    const dup = document.createElement('button');
    dup.className = 'obj-btn';
    dup.textContent = '⧉';
    dup.title = 'Dupliquer';
    dup.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (isGizmoActive()) deactivateGizmo();
      const g = m.geometry.clone();
      if (g.boundsTree) delete g.boundsTree;
      const copy = createObject(g, baseMatOf(m).clone(), `${m.name} (copie)`, false); // déjà ordonné
      copy.quaternion.copy(m.quaternion); copy.scale.copy(m.scale);
      g.computeBoundingBox();
      const w = (g.boundingBox.max.x - g.boundingBox.min.x) || 0.5;
      copy.position.copy(m.position); copy.position.x += w * 1.05 + 0.1; // à côté de l'original
      copy.updateMatrixWorld(true);
      const msk = m.geometry.userData.maskSharp;
      if (msk) {
        ensureMask(copy.geometry, copy.userData.baseMat);
        copy.geometry.userData.maskSharp.set(msk);
        copy.geometry.userData.maskBlur = m.geometry.userData.maskBlur | 0;
        copy.geometry.attributes.mask.array.set(msk); copy.geometry.attributes.mask.needsUpdate = true;
      }
      setActiveObject(copy); renderObjectList();
      pushAction(
        () => { detachObject(copy); setActiveObject(m); renderObjectList(); },
        () => { attachObject(copy); setActiveObject(copy); renderObjectList(); },
        () => { if (!state.objects.includes(copy)) disposeObject(copy); },
      );
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

    row.append(name, eye, dup, del);
    list.appendChild(row);
  });
  refreshBoolTargets();
}

// Peuple le sélecteur de cible booléenne (tous les objets sauf l'actif) et masque la
// section s'il y a moins de 2 objets.
function refreshBoolTargets() {
  const sec = document.getElementById('bool-section');
  const sel = document.getElementById('bool-target');
  if (!sec || !sel) return;
  const others = state.objects.filter((o) => o !== state.targetMesh);
  sec.style.display = others.length ? '' : 'none';
  const prev = sel.value;
  sel.innerHTML = '';
  for (let i = 0; i < state.objects.length; i++) {
    const o = state.objects[i];
    if (o === state.targetMesh) continue;
    const opt = document.createElement('option');
    opt.value = String(i); opt.textContent = o.name;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ---------- Autosave (IndexedDB) : restaure la scène au rechargement ----------
let _saveTimer = null, _restoring = false;
function autosaveMeta() {
  return { now: Date.now(), cam: state.camera.position.toArray(), target: state.controls.target.toArray(), displayMode: state.params.displayMode };
}
function markDirty() {
  if (_restoring) return; // pas de save pendant la restauration
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { saveScene(state.objects, autosaveMeta()).catch((e) => console.warn('[autosave]', e)); }, 2500);
}
function flushSave() {
  if (_restoring) return;
  clearTimeout(_saveTimer);
  saveScene(state.objects, autosaveMeta()).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', flushSave);

async function restoreAutosave() {
  let data;
  try { data = await loadScene(); } catch (e) { console.warn('[autosave] load', e); return; }
  if (!data || !data.objects.length) return;
  if (state.objects.length) return; // ne JAMAIS empiler la restauration sur une scène déjà peuplée (évite les doublons)
  _restoring = true;
  try {
    for (const o of data.objects) {
      const mesh = createObject(o.geometry, o.material, o.name, false); // géométrie déjà ordonnée
      mesh.position.fromArray(o.pos); mesh.quaternion.fromArray(o.quat); mesh.scale.fromArray(o.scale); mesh.updateMatrixWorld(true);
      mesh.visible = o.visible;
      if (o.mask && o.mask.sharp) {
        ensureMask(mesh.geometry, mesh.userData.baseMat);
        mesh.geometry.userData.maskSharp.set(o.mask.sharp);
        mesh.geometry.userData.maskBlur = o.mask.blur | 0;
        mesh.geometry.attributes.mask.array.set(o.mask.sharp);
        mesh.geometry.attributes.mask.needsUpdate = true;
      }
    }
    setActiveObject(state.objects.find((m) => m.visible) || state.objects[0]);
    if (data.meta.displayMode) { state.params.displayMode = data.meta.displayMode; const sel = document.getElementById('display-mode'); if (sel) sel.value = data.meta.displayMode; applyDisplayMode(state.objects, data.meta.displayMode); }
    if (data.meta.cam) state.camera.position.fromArray(data.meta.cam);
    if (data.meta.target) { state.controls.target.fromArray(data.meta.target); }
    state.controls.update();
    renderObjectList();
    setStatus(`Scène restaurée — ${state.objects.length} objet(s). « Nouvelle scène » pour repartir de zéro.`);
  } catch (e) { console.warn('[autosave] restore', e); }
  finally { _restoring = false; }
}

setOnObjectsChanged(() => { renderObjectList(); markDirty(); });
renderObjectList();
window.__objects = state.objects; // debug (comme window.__perf)
restoreAutosave();

// ---------- Événements pointeur ----------

dom.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.targetMesh || !state.targetMesh.visible) return;
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
document.getElementById('new-scene-btn').addEventListener('click', () => {
  if (isGizmoActive()) deactivateGizmo();
  newScene();
  renderObjectList();
  clearScene(); // efface aussi l'autosave
});
{
  const range = document.getElementById('remesh-range'), val = document.getElementById('remesh-val');
  range.value = state.params.remeshRes; val.textContent = state.params.remeshRes;
  range.addEventListener('input', (e) => { state.params.remeshRes = parseInt(e.target.value, 10); val.textContent = state.params.remeshRes; });
}
{
  const sel = document.getElementById('display-mode');
  if (sel) {
    sel.value = state.params.displayMode;
    sel.addEventListener('change', (e) => { state.params.displayMode = e.target.value; applyDisplayMode(state.objects, e.target.value); });
  }
}
document.getElementById('remesh-btn').addEventListener('click', async () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet à remailler.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Voxel remesh…');
  const startedAt = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // affiche le spinner
  try {
    const geom = await voxelRemesh(mesh.geometry, state.params.remeshRes);
    if (!geom || geom.index.count === 0) { setStatus('Remesh échoué (rien produit).'); return; }
    const newMesh = createObject(geom, baseMatOf(mesh).clone(), mesh.name);
    newMesh.position.copy(mesh.position); newMesh.updateMatrixWorld(true);
    const old = mesh;
    detachObject(old); setActiveObject(newMesh); renderObjectList();
    setStatus(`Remesh — ${geom.attributes.position.count.toLocaleString()} vertices, ${(geom.index.count / 3).toLocaleString()} triangles`);
    pushAction(
      () => { detachObject(newMesh); attachObject(old); setActiveObject(old); renderObjectList(); },
      () => { detachObject(old); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [old, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Remesh : ${err.message}`); }
  finally { const wait = Math.max(0, 300 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
});

// ---------- Booléens entre objets ----------
async function runBoolean(op) {
  const A = state.targetMesh;
  const sel = document.getElementById('bool-target');
  const B = sel ? state.objects[parseInt(sel.value, 10)] : null;
  if (!A || !B || A === B) { setStatus('Sélectionne deux objets différents.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Booléen…');
  const startedAt = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const res = await booleanObjects(A, B, op);
    if (!res || res.fallback) {
      setStatus(res && res.fallback ? 'Booléen impossible (maillage non-manifold — fais un « Voxel remesh » d’abord).' : 'Booléen : rien produit.');
      return;
    }
    const newMesh = createObject(res.geometry, baseMatOf(A).clone(), `${A.name} ⊕`); // géométrie déjà en monde
    const a = A, b = B;
    detachObject(a); detachObject(b); setActiveObject(newMesh); renderObjectList();
    setStatus('Booléen effectué.');
    pushAction(
      () => { detachObject(newMesh); attachObject(a); attachObject(b); setActiveObject(a); renderObjectList(); },
      () => { detachObject(a); detachObject(b); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [a, b, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Booléen : ${err.message}`); }
  finally { const wait = Math.max(0, 250 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
}
{
  // épaisseur de paroi (%) + lecture en mm si taille réelle définie
  const range = document.getElementById('hollow-range'), val = document.getElementById('hollow-val'), mm = document.getElementById('realsize-mm');
  const refresh = () => {
    const pct = Math.round(state.params.hollowThickness * 100);
    const real = state.params.realSizeMM;
    val.textContent = real > 0 ? `${pct} % (≈ ${(state.params.hollowThickness * real).toFixed(1)} mm)` : `${pct} %`;
  };
  range.value = Math.round(state.params.hollowThickness * 100);
  range.addEventListener('input', (e) => { state.params.hollowThickness = parseInt(e.target.value, 10) / 100; refresh(); });
  mm.addEventListener('input', (e) => { state.params.realSizeMM = Math.max(0, parseFloat(e.target.value) || 0); refresh(); });
  refresh();
}
{
  const range = document.getElementById('decimate-range'), val = document.getElementById('decimate-val');
  range.value = Math.round(state.params.decimateRatio * 100); val.textContent = `${Math.round(state.params.decimateRatio * 100)} %`;
  range.addEventListener('input', (e) => { state.params.decimateRatio = parseInt(e.target.value, 10) / 100; val.textContent = `${e.target.value} %`; });
}
document.getElementById('decimate-btn').addEventListener('click', async () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet à décimer.'); return; }
  if (mesh.userData._wallView) { setStatus('Quitte d’abord la vue épaisseur.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  const beforeTris = mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3;
  showLoading(true, 'Décimation…');
  const startedAt = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const { geometry } = await decimateMesh(mesh.geometry, state.params.decimateRatio);
    if (!geometry || geometry.index.count === 0) { setStatus('Décimation échouée.'); return; }
    const newMesh = createObject(geometry, baseMatOf(mesh).clone(), mesh.name);
    newMesh.position.copy(mesh.position); newMesh.updateMatrixWorld(true);
    const old = mesh;
    detachObject(old); setActiveObject(newMesh); renderObjectList();
    setStatus(`Décimé — ${beforeTris.toLocaleString()} → ${(geometry.index.count / 3).toLocaleString()} triangles`);
    pushAction(
      () => { detachObject(newMesh); attachObject(old); setActiveObject(old); renderObjectList(); },
      () => { detachObject(old); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [old, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Décimation : ${err.message}`); }
  finally { const wait = Math.max(0, 250 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
});
document.getElementById('orient-btn').addEventListener('click', async () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet à orienter.'); return; }
  if (mesh.userData._wallView) { setStatus('Quitte d’abord la vue épaisseur.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Auto-orientation…');
  const startedAt = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const geom = await Promise.resolve().then(() => autoOrient(mesh.geometry));
    if (!geom) { setStatus('Auto-orientation impossible.'); return; }
    const newMesh = createObject(geom, baseMatOf(mesh).clone(), mesh.name);
    newMesh.position.copy(mesh.position); newMesh.updateMatrixWorld(true);
    const old = mesh;
    detachObject(old); setActiveObject(newMesh); renderObjectList();
    setStatus('Orienté pour l’impression (base au sol, surplombs minimisés).');
    pushAction(
      () => { detachObject(newMesh); attachObject(old); setActiveObject(old); renderObjectList(); },
      () => { detachObject(old); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [old, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Auto-orientation : ${err.message}`); }
  finally { const wait = Math.max(0, 250 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
});
document.getElementById('wallcheck-btn').addEventListener('click', async () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet.'); return; }
  const g = mesh.geometry;
  if (mesh.userData._wallView) { // revenir en vue normale
    if (mesh.userData._wallSavedMat) mesh.material = mesh.userData._wallSavedMat;
    g.deleteAttribute('color');
    mesh.userData._wallView = false; mesh.userData._wallSavedMat = null;
    setStatus('Vue normale.');
    return;
  }
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Analyse d’épaisseur…');
  const startedAt = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    g.computeBoundingBox();
    const s = new THREE.Vector3(); g.boundingBox.getSize(s);
    const maxDim = Math.max(s.x, s.y, s.z) || 1;
    const threshold = state.params.hollowThickness * maxDim;
    const { colors, thinFrac } = checkThickness(g, threshold);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh.userData._wallSavedMat = mesh.material;
    mesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0, side: mesh.material.side || THREE.FrontSide });
    mesh.userData._wallView = true;
    const mmTxt = state.params.realSizeMM > 0 ? ` (seuil ≈ ${(state.params.hollowThickness * state.params.realSizeMM).toFixed(1)} mm)` : '';
    setStatus(`${(thinFrac * 100).toFixed(1)} % de la surface trop fine — en rouge${mmTxt}. Reclique pour revenir.`);
  } catch (err) { console.error(err); setStatus(`Vérif épaisseur : ${err.message}`); }
  finally { const wait = Math.max(0, 250 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
});
document.getElementById('hollow-btn').addEventListener('click', async () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet à évider.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Évidement…');
  const startedAt = performance.now();
  const frac = state.params.hollowThickness;
  const res = Math.max(64, Math.min(140, Math.ceil(2.2 / frac))); // assez fin pour résoudre la paroi (borné pour la perf)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const out = await hollowMesh(mesh.geometry, frac, res);
    if (out && out.tooThick) { setStatus('Épaisseur trop grande : pas d’intérieur. Réduis l’épaisseur.'); return; }
    if (!out || !out.geometry || out.geometry.index.count === 0) { setStatus('Évidement échoué.'); return; }
    const newMesh = createObject(out.geometry, baseMatOf(mesh).clone(), mesh.name);
    newMesh.position.copy(mesh.position); newMesh.updateMatrixWorld(true);
    const old = mesh;
    detachObject(old); setActiveObject(newMesh); renderObjectList();
    setStatus(`Évidé — coque, ${(out.geometry.index.count / 3).toLocaleString()} triangles`);
    pushAction(
      () => { detachObject(newMesh); attachObject(old); setActiveObject(old); renderObjectList(); },
      () => { detachObject(old); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [old, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Évidement : ${err.message}`); }
  finally { const wait = Math.max(0, 300 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
});
document.getElementById('repair-btn').addEventListener('click', () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet à réparer.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  try {
    const { geometry, stats } = repairMesh(mesh.geometry, { detail: state.params.cutDetail });
    const newMesh = createObject(geometry, baseMatOf(mesh).clone(), mesh.name);
    newMesh.position.copy(mesh.position); newMesh.updateMatrixWorld(true);
    const old = mesh;
    detachObject(old); setActiveObject(newMesh); renderObjectList();
    setStatus(`Réparé — soudés ${stats.welded.toLocaleString()}, îlots retirés ${stats.removedIslands}, trous bouchés ${stats.filledHoles}`);
    pushAction(
      () => { detachObject(newMesh); attachObject(old); setActiveObject(old); renderObjectList(); },
      () => { detachObject(old); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [old, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Réparation : ${err.message}`); }
});
document.getElementById('bool-union').addEventListener('click', () => runBoolean('union'));
document.getElementById('bool-subtract').addEventListener('click', () => runBoolean('subtract'));
document.getElementById('bool-intersect').addEventListener('click', () => runBoolean('intersect'));

// Undo / redo
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
setHistoryListener((cu, cr) => { undoBtn.disabled = !cu; redoBtn.disabled = !cr; markDirty(); });

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
}); // <- fin du toolButtons.forEach (sinon les listeners ci-dessous seraient liés 1×/bouton)

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
document.getElementById('mask-split').addEventListener('click', () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet.'); return; }
  const maskAttr = mesh.geometry.attributes.mask;
  if (!maskAttr) { setStatus('Peins d’abord un masque.'); return; }
  // On splitte sur le masque PEINT (maskSharp), pas sur le flouté : le curseur de flou
  // n'influe donc plus sur la découpe (évite les mini-objets dus au dégradé du flou).
  const maskSrc = mesh.geometry.userData.maskSharp || maskAttr.array;
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Séparation du masque…');
  const startedAt = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      const res = splitByMask(mesh.geometry, maskSrc, 0.5, state.params.cutDetail);
      if (!res) { setStatus('Rien à séparer (masque vide, total, ou sans frontière nette).'); return; }
      // DoubleSide : l'orientation des parois/caps n'est pas garantie (évite les faces noires
      // et les normales à l'envers sur les caps après recalcul).
      const matIn = baseMatOf(mesh).clone(); matIn.side = THREE.DoubleSide;
      const matOut = baseMatOf(mesh).clone(); matOut.side = THREE.DoubleSide;
      const inMesh = createObject(res.inside, matIn, `${mesh.name} (masqué)`);
      const outMesh = createObject(res.outside, matOut, `${mesh.name} (reste)`);
      inMesh.position.copy(mesh.position); inMesh.quaternion.copy(mesh.quaternion); inMesh.scale.copy(mesh.scale); inMesh.updateMatrixWorld(true);
      outMesh.position.copy(mesh.position); outMesh.quaternion.copy(mesh.quaternion); outMesh.scale.copy(mesh.scale); outMesh.updateMatrixWorld(true);
      detachObject(mesh); setActiveObject(outMesh); renderObjectList();
      flashMesh(inMesh);
      setStatus('Masque séparé (2 objets, caps bouchés).');
      pushAction(
        () => { detachObject(inMesh); detachObject(outMesh); attachObject(mesh); setActiveObject(mesh); renderObjectList(); },
        () => { detachObject(mesh); attachObject(inMesh); attachObject(outMesh); setActiveObject(outMesh); renderObjectList(); },
        () => { for (const m of [mesh, inMesh, outMesh]) if (!state.objects.includes(m)) disposeObject(m); },
      );
    } catch (err) { console.error(err); setStatus(`Séparation masque : ${err.message}`); }
    finally { const wait = Math.max(0, 250 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
  }));
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
