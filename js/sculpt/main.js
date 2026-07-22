// Point d'entrée : init scène, wiring UI + événements pointeur, boucle de rendu.

import * as THREE from 'three';
import { state } from './state.js';
import { initScene } from './scene.js';
import { symmetryPoints, initSymmetryHelper, updateSymmetryHelper, updateSymmetryCursor, enterSymEdit, exitSymEdit, isSymEditing, symEditMesh, setSymGizmoMode, resetSymFrame } from './symmetry.js';
import { unwrapUVs } from './unwrap.js';
import { addConnectors } from './connectors.js';
import {
  loadModelFromFile, subdivideTarget, separateComponents, newScene,
  createObject, setActiveObject, setOnObjectsChanged,
  detachObject, attachObject, disposeObject,
} from './loader.js';
import {
  raycastSurface, updateBrushCursor, hideBrushCursor, performStroke,
  startGrab, moveGrab, endGrab, beginStroke,
  recordStrokeBegin, recordStrokeEnd,
  paintColorAt, recordColorBegin, recordColorEnd, paintReliefMaskAt,
} from './brush.js';
import { lassoSplitAsync } from './split.js';
import { lassoSplitCSG } from './split-csg.js';
import { lassoSplitManifold, warmupManifold } from './split-manifold.js';
import { voxelRemesh } from './remesh.js';
import { booleanObjects } from './boolean.js';
import { repairMesh } from './repair.js';
import { hollowMesh } from './hollow.js';
import { checkThickness } from './wallcheck.js';
import { autoOrient } from './orient.js';
import { decimateMesh } from './decimate.js';
import { applyDisplayMode } from './display.js';
import { saveScene, loadScene, clearScene, restoreRig } from './autosave.js';
import { isRenderMode, enterRenderMode, exitRenderMode, renderFrame as renderModeFrame, onResize as renderModeResize, renderModeParams, setAOStrength, setAORadius, setAmbient, setShadowOpacity, setContactBlur, setCastBlur, setShadowAzimuth, setShadowElevation, setModelShadows, setContactShadow, setProjShadow, setGI, setSelfShadow } from './render-mode.js';
import { captureView, reprojectToUV, compositeLayers, applyTextureCanvas, hasPendingCam, getPendingCam, captureSquareSidePx, paintMaskDab, readMaskCanvas, disposeLayerMask, setLayerMask, invertLayerMask, renderMaskView, renderReliefMaskView, generateNanoBanana } from './retexture.js';
import { splitByMask } from './split-mask.js';
import { pushGeom, pushAction, pushMask, pushColor, undo, redo, setHistoryListener } from './history.js';
import { getPalette, ensureColorAttr, eyedropSample, applyPaletteFromTexture, buildVertexPaint3MF, rgbToHex, hexToRgb, nearestPaletteIndex } from './vertexpaint.js';
import { isRig, rigOf, bakePose, isPoseDirty, markPoseDirty, resetRigPose, updateRigs, playClip, setPlaying, stopClip, seekClip, clipInfo, toggleSkeleton } from './rig.js';
import { loadRetargetSource, playRetargetClip, disposeRetarget } from './rig-retarget.js';
import { enterPose, exitPose, isPoseActive, pickBoneAtMouse, resetPose, updatePoseMarkers, selectByIndex, poseBones, selectedIndex, selectedBone, isTwistBone, setGizmoMode, markerUnderMouse } from './rig-pose.js';
import { enterWeightPaint, exitWeightPaint, isWeightPaintActive, setPaintBone, paintAt as wpPaintAt, smooth as wpSmooth, refreshWeights, beginWeightStroke, endWeightStroke, applySkinRecord, pickPoint as wpPickPoint } from './rig-weightpaint.js';
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
initSymmetryHelper(state.scene);
initGizmo();
warmupManifold(); // précharge le WASM du booléen (mode de découpe par défaut)
state.alpha = makeSquareAlpha(); // forme du brush (défaut : carré)
state.falloff = makeFalloff(state.params.falloffHardness); // falloff radial

const dom = state.renderer.domElement;

// Ajustement du rayon du brush en maintenant X : la souris change le diamètre.
let radiusMode = false, radiusStartX = 0, radiusStartSize = 0, radiusAnchor = null, lastClientX = 0;
const RADIUS_PER_PX = 0.0012; // vitesse d'ajustement (fraction d'écran / pixel)
function setBrushSize(v) {
  const r = document.getElementById('size-range'), num = document.getElementById('size-num');
  v = Math.max(parseFloat(r.min), Math.min(parseFloat(r.max), v));
  state.params.sizeFrac = v; r.value = v; num.value = v.toFixed(3);
  syncWpRadiusUI(); // le slider du panneau weight paint suit la même valeur
}
// Reflète sizeFrac sur le slider « Rayon » du panneau weight paint (même zone d'influence que le sculpt).
function syncWpRadiusUI() {
  const wr = document.getElementById('bones-wp-radius'); if (!wr) return;
  wr.value = state.params.sizeFrac;
  const wv = document.getElementById('bones-wp-radius-v'); if (wv) wv.textContent = Math.round(state.params.sizeFrac * 100) + '%';
}

// Rayon MONDE d'un pinceau à `worldPoint` pour une fraction d'écran `frac` : frac · distance · tan(fov/2)
// -> taille ÉCRAN constante quel que soit le zoom. Base commune brosse sculpt / retexture / weight paint.
function screenWorldRadius(worldPoint, frac) {
  const d = state.camera.position.distanceTo(worldPoint);
  return Math.max(1e-4, frac * d * Math.tan(THREE.MathUtils.degToRad(state.camera.fov) / 2));
}
// Recale state.params.size (rayon monde effectif) sur la fraction d'écran, au point donné. À appeler
// juste avant chaque coup / affichage du curseur : brush.js lit state.params.size tel quel.
function syncBrushRadius(worldPoint) { if (worldPoint) state.params.size = screenWorldRadius(worldPoint, state.params.sizeFrac); }
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
  // Bascule temporaire d'outil active (Shift=smooth / Ctrl=masque). Ctrl seul = ajoute ; Ctrl+Alt = inverse
  // (démasque). On n'utilise pas Ctrl lui-même comme modificateur d'inversion (c'est le déclencheur).
  if (_tempTool) return e.altKey ? { invert: true } : {};
  // Sinon, en cours de stroke : Shift => lissage ; Alt => inverser l'outil courant.
  if (e.shiftKey) return { tool: 'smooth' };
  if (e.altKey || e.ctrlKey || e.metaKey) return { invert: !state.params.invert };
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

// Un « coup » à la position p : sculpt géométrique OU peinture de couleur (Vertex Paint).
function strokeStamp(p, mods) {
  syncBrushRadius(p); // rayon monde effectif = fraction d'écran au point du coup (taille écran constante)
  if (state.params.tool === 'vertexpaint') {
    const mesh = state.targetMesh; if (!mesh) return;
    const pal = getPalette(mesh), c = pal[_vpSel]; if (!c) return;
    paintColorAt(p, c.r, c.g, c.b);
    for (const mp of symmetryPoints(p)) paintColorAt(mp, c.r, c.g, c.b); // symétrie X/Y/Z (local/world)
    return;
  }
  performStroke(p, mods);
}

function stampSpaced(p, mods) {
  syncBrushRadius(p); // rayon monde à jour avant de calculer l'espacement des coups
  if (!_ls.has) { strokeStamp(p, mods); _ls.x = p.x; _ls.y = p.y; _ls.z = p.z; _ls.has = true; return; }
  const spacing = Math.max(1e-4, state.params.size * SPACING_FRAC);
  let dx = p.x - _ls.x, dy = p.y - _ls.y, dz = p.z - _ls.z;
  let remaining = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let stamps = 0;
  while (remaining >= spacing && stamps < MAX_STAMPS) {
    const t = spacing / remaining;
    _ls.x += (p.x - _ls.x) * t; _ls.y += (p.y - _ls.y) * t; _ls.z += (p.z - _ls.z) * t;
    strokeStamp(_ls, mods);
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
  hideBrushCursor();
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

// Ajoute des connecteurs (tenons/mortaises) aux 2 pièces d'un split si l'option est cochée.
// `res` porte res.inside/res.outside (géométries locales) ; `refGeom` = géométrie d'origine (pour la taille).
async function maybeAddConnectors(res, refGeom) {
  if (!state.params.splitConnectors || !res || !res.inside || !res.outside) return;
  refGeom.computeBoundingBox();
  const bs = refGeom.boundingBox.getSize(new THREE.Vector3());
  const size = Math.max(bs.x, bs.y, bs.z) || 2;
  try {
    const conn = await addConnectors(res.inside, res.outside, { size });
    if (conn) { res.inside = conn.inside; res.outside = conn.outside; }
    else setStatus('Connecteurs non ajoutés (interface non détectée ou maillage non-watertight).');
  } catch (e) { console.warn('[connectors]', e); }
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
      // Manifold pour les maillages propres (caps nets). S'il refuse (non-watertight), three-bvh-csg
      // coupe quand même (marche sur n'importe quel mesh, caps parfois imparfaits) -> le split
      // produit TOUJOURS un résultat.
      let r = await lassoSplitManifold(g, poly, cam, mw, w, h, det);
      if (r && r.fallback) {
        const c = lassoSplitCSG(g, poly, cam, mw, w, h, det);
        if (c && c.inside) { c.capMode = 'csg'; c.approx = true; r = c; }
      }
      resolve(r);
    })))
    : lassoSplitAsync(g, poly, cam, mw, w, h, det, setProgress);
  run
    .then(async (res) => {
      if (res && res.fallback) { setStatus('Découpe impossible sur ce maillage (essaie « Voxel remesh »).'); return; }
      if (!res) { setStatus(csg ? 'Rien séparé (le lasso ne traverse pas l’objet ?).' : 'Le lasso n’a rien séparé.'); return; }
      // Cap dégradé (mode rapide uniquement) : refuse pour ne PAS détruire le maillage
      // ni cascader. Les modes booléens (local/manifold/csg) sont toujours acceptés.
      if (!csg && res.capMode && res.capMode !== 'worker-cdt') {
        setStatus('Découpe impossible ici : maillage trop peu dense sous le lasso. Passe en mode « Précise (booléen) », clique « Subdiviser », ou agrandis le tracé.');
        return;
      }
      await maybeAddConnectors(res, g); // tenons/mortaises si l'option est cochée
      // DoubleSide : l'orientation des parois n'est pas garantie.
      const matIn = baseMatOf(mesh).clone(); matIn.side = THREE.DoubleSide;
      const matOut = baseMatOf(mesh).clone(); matOut.side = THREE.DoubleSide;
      const inMesh = createObject(res.inside, matIn);
      const outMesh = createObject(res.outside, matOut);
      detachObject(mesh); // garde l'original pour l'undo (pas de dispose)
      setActiveObject(outMesh);
      renderObjectList();
      flashMesh(inMesh); // clignotement d'alpha sur la pièce découpée (feedback visuel)
      setStatus(res.approx
        ? 'Split effectué (approximatif — maillage non-watertight ; « Réparer » ou « Voxel remesh » pour des caps nets).'
        : 'Split effectué (2 objets).');
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

// Cadre la caméra sur un objet (recentre + distance adaptée pour le voir en entier), en conservant
// l'angle de vue courant.
function focusObject(mesh) {
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  // precise=true : itère les sommets réels (ignore le boundingBox en cache, obsolète après sculpt) ->
  // centre = vrai centre de la bounding box (≠ origine de l'objet).
  const box = new THREE.Box3().setFromObject(mesh, true);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const r = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
  const cam = state.camera;
  const vHalf = THREE.MathUtils.degToRad(cam.fov) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * cam.aspect);
  const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * 1.15; // marge 15 %
  const dir = new THREE.Vector3().subVectors(cam.position, state.controls.target);
  if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1); dir.normalize();
  state.controls.target.copy(center);
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.near = Math.max(0.001, dist / 200); cam.far = dist * 200; cam.updateProjectionMatrix();
  state.controls.update();
}

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
    const rigged = isRig(m);
    const tri = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
    name.textContent = `${rigged ? '🦴 ' : ''}${m.name} (${tri.toLocaleString('fr-FR')} tri)`;
    if (rigged) name.title = 'Modèle riggé — sculpt/retexture en pose de repos, animations via l’outil Bones';
    name.addEventListener('click', () => { if (m.visible) { setActiveObject(m); if (isGizmoActive()) activateGizmo(m); renderObjectList(); } });
    row.addEventListener('dblclick', () => { if (m.visible) focusObject(m); }); // double-clic : cadrer l'objet

    const eye = document.createElement('button');
    eye.className = 'obj-btn';
    eye.textContent = m.visible ? '👁' : '🚫';
    eye.title = 'Afficher / masquer';
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      m.visible = !m.visible;
      if (rigged && rigOf(m) && rigOf(m).helper) rigOf(m).helper.visible = m.visible; // le squelette suit l'objet
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

    if (rigged) row.append(name, eye, del); // pas de duplication pour un objet riggé
    else row.append(name, eye, dup, del);
    list.appendChild(row);
  });
  refreshBoolTargets();
  updateToolAvailability();
}

// Le retexturing exige des UV. On laisse ENTRER dans l'outil, mais tant qu'il n'y a pas d'UV : seul le
// bouton « Déplier les UV » du panneau est actif, les autres actions sont désactivées + un message s'affiche.
function updateToolAvailability() { updateRetexUVState(); }
function updateRetexUVState() {
  const m = state.targetMesh;
  const hasUV = !!(m && m.geometry && m.geometry.attributes && m.geometry.attributes.uv);
  const need = document.getElementById('retex-needuv');
  if (need) need.style.display = hasUV ? 'none' : 'block';
  // Active/désactive toutes les actions retexture SAUF le dépliage UV.
  document.querySelectorAll('#retexture-panel [data-needuv]').forEach((el) => {
    el.disabled = !hasUV; el.style.opacity = hasUV ? '' : '0.4'; el.style.pointerEvents = hasUV ? '' : 'none';
  });
}

// Peuple le sélecteur de cible booléenne (tous les objets sauf l'actif) et n'affiche la section
// que dans l'outil « Autres » et s'il y a au moins 2 objets.
function refreshBoolTargets() {
  const sec = document.getElementById('bool-section');
  const sel = document.getElementById('bool-target');
  if (!sec || !sel) return;
  const others = state.objects.filter((o) => o !== state.targetMesh);
  sec.style.display = (state.params.tool === 'other' && others.length) ? '' : 'none';
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
      if (o.kind === 'rig') { await restoreRig(o.data); continue; } // rig complet : squelette + skin + anims reconstruits
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
  // Bouton gauche uniquement, SAUF en masque temporaire (Ctrl) où Mac mappe le clic sur « bouton 2 » -> on l'accepte.
  // En Shift (smooth temp), le clic droit doit tourner la caméra -> on ne l'accepte PAS ici.
  const ctrlTemp = _tempTool && _tempTool.key === 'Control';
  if ((e.button !== 0 && !ctrlTemp) || !state.targetMesh || !state.targetMesh.visible) return;
  if (isRenderMode()) return; // mode Rendu : preview, pas d'édition (l'orbite reste dispo)
  if (isSymEditing()) return; // édition du plan de symétrie : seul le gizmo est actif
  if (radiusMode) return; // réglage du rayon en cours (X maintenu)
  if (state.params.tool === 'gizmo' || state.params.tool === 'retexture' || state.params.tool === 'other' || state.params.tool === 'bones') return; // pas de sculpt
  if (state.params.tool === 'split') { startLasso(e); return; }
  // Vertex Paint, pipette : panel pipette -> AJOUTE la couleur ; « i » maintenu -> SÉLECTIONNE la couleur
  // de palette la plus proche. Dans les deux cas : pas de peinture (retour immédiat).
  if (state.params.tool === 'vertexpaint' && (_vpPipette || _vpKeyPick)) {
    setMouseFromEvent(e); const hit = raycastSurface(); if (hit) { if (_vpKeyPick) vpPickSelect(hit); else vpPick(hit); }
    return;
  }
  setMouseFromEvent(e);
  const hit = raycastSurface();
  if (!hit) return; // clic dans le vide => laisser OrbitControls tourner
  // Sculpt d'un rig POSÉ : bake la pose comme NOUVEAU bind (garde le squelette). La forme posée devient la
  // géométrie -> BVH/topologie cohérents, pose conservée, rig re-posable. Une fois (flag poseDirty).
  if (isRig(state.targetMesh) && isPoseDirty(state.targetMesh)) { bakePose(state.targetMesh); setActiveObject(state.targetMesh); }

  sculpting = true;
  setSculptResolution(true);
  state.controls.enabled = false;
  try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  if (state.params.tool === 'mask') { ensureMask(state.targetMesh.geometry, state.targetMesh.material); maskRecordBegin(state.targetMesh.geometry); }
  else if (state.params.tool === 'vertexpaint') { ensureColorAttr(state.targetMesh); state.targetMesh.userData._vpPainted = true; recordColorBegin(); } // undo couleur
  else recordStrokeBegin(); // undo : démarre la capture des vertices touchés

  if (state.params.tool === 'move') {
    if (!startGrab(hit)) { sculpting = false; state.controls.enabled = true; }
    hideBrushCursor();
  } else {
    _ls.has = false;
    updateBrushCursor(hit, false, false); // dès la pression : cercle caché, point de collision gardé
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
  if (isRenderMode()) { hideBrushCursor(); return; } // preview : pas de curseur d'influence

  if (!sculpting) {
    // retexture : on montre le cercle d'influence (comme les brosses) pour voir la zone peinte du masque
    if (state.params.tool === 'split' || state.params.tool === 'gizmo' || state.params.tool === 'other') { hideBrushCursor(); return; }
    if (state.params.tool === 'bones') {
      // weight paint : même cercle d'influence que le sculpt, MASQUÉ au survol d'un os (on sélectionnerait).
      if (isWeightPaintActive() && !markerUnderMouse(true)) showInfluenceCursor(wpPickPoint(state.mouse));
      else hideBrushCursor();
      return;
    }
    if (state.params.tool === 'vertexpaint' && _vpKeyPick) { const h = raycastSurface(); if (h) vpPickSelect(h); hideBrushCursor(); return; } // « i » : pipette continue
    if (state.params.tool === 'vertexpaint' && _vpPipette) { hideBrushCursor(); return; } // pipette panel : pas de cercle
    showInfluenceCursor(raycastSurface()); // cercle : rayon = fraction d'écran au point survolé
    return;
  }
  const st = performance.now();
  if (state.params.tool === 'move') {
    moveGrab();
  } else {
    const hit = raycastSurface();
    updateBrushCursor(hit, false, false); // pendant le stroke : cercle caché, point de collision gardé
    if (hit) stampSpaced(hit.point, mods);
  }
  perf.sculptLast = performance.now() - st;
}

dom.addEventListener('pointermove', (e) => {
  lastClientX = e.clientX;
  if (radiusMode) { // X maintenu : la souris règle le rayon du brush
    setBrushSize(radiusStartSize + (e.clientX - radiusStartX) * RADIUS_PER_PX);
    if (radiusAnchor) showInfluenceCursor(radiusAnchor);
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

// La caméra bouge (zoom/orbite) sans mouvement souris -> rafraîchir le cercle d'influence : sa taille
// est screen-constante (dépend de la distance caméra) et le point sous le curseur change au zoom.
state.controls.addEventListener('change', () => {
  if (sculpting || radiusMode || lassoing) return; // stroke/réglage en cours : géré ailleurs
  pendingMods = pendingMods || {}; // le rendu du curseur (branche hover) n'utilise pas les modificateurs
  if (!moveScheduled) { moveScheduled = true; requestAnimationFrame(processMove); }
});

function endStroke(e) {
  if (!sculpting) return;
  sculpting = false;
  _ls.has = false;
  setSculptResolution(false);
  state.controls.enabled = !(_tempTool && _tempTool.key === 'Control'); // seul le masque temp (Ctrl) garde l'orbite OFF ; en Shift on doit pouvoir tourner (clic droit)
  endGrab();
  if (state.params.tool === 'mask') {
    if (state.targetMesh) rebuildMask(state.targetMesh.geometry); // applique le flou en fin de stroke
    pushMask(maskRecordEnd());
  } else if (state.params.tool === 'vertexpaint') {
    pushColor(recordColorEnd()); // undo : enregistre la peinture terminée
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
dom.addEventListener('pointerleave', () => { if (!lassoing) hideBrushCursor(); });

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
// Change le mode d'affichage (met à jour l'état + le select + les matériaux). En mode « vcflat »
// (Vertex Paint), garantit un attribut color sur chaque objet (sinon rendu noir).
function setDisplayMode(mode) {
  state.params.displayMode = mode;
  const sel = document.getElementById('display-mode'); if (sel) sel.value = mode;
  if (mode === 'vcflat') for (const o of state.objects) if (o.isMesh) ensureColorAttr(o);
  applyDisplayMode(state.objects, mode);
}
{
  const sel = document.getElementById('display-mode');
  if (sel) {
    sel.value = state.params.displayMode;
    sel.addEventListener('change', (e) => setDisplayMode(e.target.value));
  }
}

// ---------- Retexture : compositing de la texture couleur (calques) ----------
const RETEX_SIZE = 2048;
let _retexSelLayer = null;         // calque sélectionné (mode 'layer')
let _retexMaskMode = 'layer';      // 'layer' = masque du calque sélectionné ; 'pregen' = masque pré-génération
let _retexPendingMask = null;      // { _maskRT, mask } peint avant import, appliqué au prochain calque
let _retexHiliteCanvas = null;     // calque de surbrillance du masque pré-gen (feedback visuel)
let _retexMaskEdit = false;        // mode édition : affiche le masque du calque sélectionné en N&B sur l'objet
// Cible de peinture de masque selon le mode courant.
function retexPaintTarget() {
  if (_retexMaskMode === 'pregen') { if (!_retexPendingMask) _retexPendingMask = { name: '(pré-gen)' }; return _retexPendingMask; }
  return _retexSelLayer;
}
function retexHilite() {
  if (!_retexHiliteCanvas) { _retexHiliteCanvas = document.createElement('canvas'); _retexHiliteCanvas.width = _retexHiliteCanvas.height = RETEX_SIZE; const c = _retexHiliteCanvas.getContext('2d'); c.fillStyle = '#22d3ee'; c.fillRect(0, 0, RETEX_SIZE, RETEX_SIZE); }
  return _retexHiliteCanvas;
}
function updateRetexModeUI() {
  const btn = document.getElementById('retex-pregen'); if (btn) btn.style.outline = _retexMaskMode === 'pregen' ? '2px solid #22d3ee' : '';
}
// Cadre de capture 1:1 : carré centré de côté min(largeur, hauteur) de la vue.
function updateCaptureFrame(show) {
  const el = document.getElementById('capture-frame'); if (!el) return;
  if (show === undefined) show = state.params.tool === 'retexture';
  if (!show) { el.style.display = 'none'; return; }
  const S = captureSquareSidePx();
  el.style.width = S + 'px'; el.style.height = S + 'px';
  el.style.left = ((window.innerWidth - S) / 2) + 'px';
  el.style.top = ((window.innerHeight - S) / 2) + 'px';
  el.style.display = 'block';
}
window.addEventListener('resize', () => updateCaptureFrame());
// Aperçu debug de la texture composite (bas-gauche, en mode Retexture).
function updateTexturePreview(show) {
  const wrap = document.getElementById('texture-preview'); if (!wrap) return;
  if (show === undefined) show = state.params.tool === 'retexture';
  const mesh = state.targetMesh;
  if (!show || !mesh) { wrap.style.display = 'none'; return; }
  const base = mesh.userData.baseMat || mesh.material;
  const src = base && base.map && base.map.image;
  const cv = document.getElementById('texture-preview-canvas'); const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (src) { try { ctx.drawImage(src, 0, 0, cv.width, cv.height); } catch (_) { ctx.fillStyle = '#333'; ctx.fillRect(0, 0, cv.width, cv.height); } }
  else { ctx.fillStyle = '#333'; ctx.fillRect(0, 0, cv.width, cv.height); }
  drawUVWireframe(ctx, mesh.geometry, cv.width, cv.height); // superpose le développement UV
  wrap.style.display = 'block';
}
// Trace le fil-de-fer des UV (arêtes des triangles) sur l'aperçu débug. Échantillonne si trop de triangles.
function drawUVWireframe(ctx, geom, w, h) {
  const uv = geom.attributes.uv; if (!uv) return;
  const idx = geom.index ? geom.index.array : null;
  const triCount = idx ? idx.length / 3 : uv.count / 3;
  const step = Math.max(1, Math.ceil(triCount / 60000)); // cap le nb de tris dessinés
  ctx.strokeStyle = 'rgba(34,211,238,0.55)'; ctx.lineWidth = 0.5; ctx.beginPath();
  for (let t = 0; t < triCount; t += step) {
    const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ax = uv.getX(a) * w, ay = (1 - uv.getY(a)) * h, bx = uv.getX(b) * w, by = (1 - uv.getY(b)) * h, cx = uv.getX(c) * w, cy = (1 - uv.getY(c)) * h;
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.lineTo(ax, ay);
  }
  ctx.stroke();
}
// Copie une image/canvas source dans un canvas carré RETEX_SIZE (pour en faire un calque).
function toRetexCanvas(src) {
  const c = document.createElement('canvas'); c.width = c.height = RETEX_SIZE;
  c.getContext('2d').drawImage(src, 0, 0, RETEX_SIZE, RETEX_SIZE);
  return c;
}
// Érode l'alpha de `src` (silhouette) de r pixels -> canvas w×h. Astuce : destination-in avec des
// copies décalées dans 8 directions = on ne garde que les pixels dont le voisinage est opaque.
function erodeMaskCanvas(src, r, w, h) {
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const c = out.getContext('2d');
  c.drawImage(src, 0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) c.drawImage(src, dx, dy, w, h);
  c.globalCompositeOperation = 'source-over';
  return out;
}
function retexLayersOf(mesh) {
  if (!mesh.userData._retexLayers) {
    mesh.userData._retexLayers = [];
    // La texture de base devient un CALQUE (au fond) : masquable + opacité, comme les autres.
    const base = mesh.userData.baseMat || mesh.material;
    const img = (base && base.map && base.map.image) ? base.map.image : null;
    if (img) mesh.userData._retexLayers.push({ name: 'Texture de base', canvas: toRetexCanvas(img), opacity: 1, visible: true, _isBase: true });
    mesh.userData._retexBase = null; // plus de fond séparé : tout passe par les calques
  }
  return mesh.userData._retexLayers;
}
// withHilite=false : recompose SANS la surbrillance du masque pré-gen (ex. juste avant la
// capture envoyée à l'IA — le cyan ne doit pas se retrouver dans le screenshot).
// Canvas N&B du masque (blanc = révélé, noir = masqué) pour l'affichage/édition sur l'objet.
function maskBWCanvas(mask, size) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, size, size); // pas de masque -> tout révélé (blanc)
  if (mask) { c.fillStyle = '#000'; c.fillRect(0, 0, size, size); c.drawImage(mask, 0, 0, size, size); }
  return cv;
}
function recomposeRetex(withHilite = true) {
  const mesh = state.targetMesh; if (!mesh) return;
  const layers = retexLayersOf(mesh);
  // Mode édition de masque : on affiche le masque du calque sélectionné en N&B sur l'objet.
  if (_retexMaskEdit && _retexSelLayer && layers.includes(_retexSelLayer)) {
    applyTextureCanvas(mesh, maskBWCanvas(_retexSelLayer.mask, RETEX_SIZE));
    updateTexturePreview(true);
    return;
  }
  // En mode pré-génération : surbrillance de la zone du masque pré-gen (feedback visuel).
  let display = layers;
  if (withHilite && _retexMaskMode === 'pregen' && _retexPendingMask && _retexPendingMask.mask) {
    display = [...layers, { name: '_hilite', canvas: retexHilite(), mask: _retexPendingMask.mask, opacity: 0.55, visible: true }];
  }
  const cv = compositeLayers(mesh.userData._retexBase, display, RETEX_SIZE);
  applyTextureCanvas(mesh, cv);
  updateTexturePreview(true);
}
function loadImageFile(file) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(file); const im = new Image(); im.onload = () => { URL.revokeObjectURL(url); res(im); }; im.onerror = rej; im.src = url; });
}
function loadImageURL(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('image illisible')); im.src = url; });
}
// ---------- Édition N&B du masque d'un calque RELIEF (parité avec les masques couleur) ----------
// En édition : l'objet est affiché en niveaux de gris du poids w (blanc = relief plein, noir = effacé),
// via l'attribut color temporaire + le matériau vcflat. On restaure l'attribut/le mode en sortant.
let _reliefMaskEdit = false, _reliefMaskLayer = null, _reliefBWSaved = null, _reliefBWMode = null;
function reliefGrayColors(mesh, layer) {
  const N = mesh.geometry.attributes.position.count;
  const cols = new Float32Array(N * 3); // 0 = noir (hors zone de relief)
  for (let k = 0; k < layer.moved.length; k++) { const w = layer.w[k], v3 = layer.moved[k] * 3; cols[v3] = w; cols[v3 + 1] = w; cols[v3 + 2] = w; }
  return cols;
}
function updateReliefGrayLive(mesh, layer) { // met à jour l'affichage N&B pendant la peinture
  const col = mesh.geometry.attributes.color; if (!col) return;
  const a = col.array;
  for (let k = 0; k < layer.moved.length; k++) { const w = layer.w[k], v3 = layer.moved[k] * 3; a[v3] = w; a[v3 + 1] = w; a[v3 + 2] = w; }
  col.needsUpdate = true;
}
function enterReliefMaskEdit(mesh, layer) {
  if (_reliefMaskEdit) exitReliefMaskEdit(mesh);
  _reliefMaskEdit = true; _reliefMaskLayer = layer;
  _retexSelLayer = layer; _retexMaskMode = 'layer';
  _reliefBWSaved = mesh.geometry.getAttribute('color') || null;   // sauve d'éventuelles couleurs (vertex paint)
  _reliefBWMode = state.params.displayMode;
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(reliefGrayColors(mesh, layer), 3));
  setDisplayMode('vcflat');
}
function exitReliefMaskEdit(mesh) {
  if (!_reliefMaskEdit) return;
  _reliefMaskEdit = false; _reliefMaskLayer = null;
  if (mesh) {
    if (_reliefBWSaved) mesh.geometry.setAttribute('color', _reliefBWSaved); else mesh.geometry.deleteAttribute('color');
    setDisplayMode(_reliefBWMode || 'texture');
  }
  _reliefBWSaved = null;
}

// Menu contextuel des opérations de masque d'un calque (clic droit sur la ligne / la vignette masque).
let _maskMenuAway = null;
function closeMaskMenu() {
  const m = document.getElementById('retex-mask-menu'); if (m) m.remove();
  if (_maskMenuAway) { document.removeEventListener('pointerdown', _maskMenuAway); _maskMenuAway = null; }
}
function showMaskMenu(x, y, layer) {
  closeMaskMenu();
  const mesh = state.targetMesh; if (!mesh) return;
  const menu = document.createElement('div'); menu.id = 'retex-mask-menu'; menu.className = 'ctx-menu';
  const item = (label, fn) => { const b = document.createElement('button'); b.className = 'ctx-item'; b.textContent = label; b.onclick = () => { fn(); closeMaskMenu(); }; menu.appendChild(b); };

  if (layer.type === 'relief') {
    // Masque de relief (poids w par sommet) : mêmes opérations que les masques couleur.
    const editing = _reliefMaskEdit && _reliefMaskLayer === layer;
    const live = () => { if (_reliefMaskEdit && _reliefMaskLayer === layer) updateReliefGrayLive(mesh, layer); };
    item(editing ? '🎨 Revenir à l’affichage' : '✏️ Éditer le masque sur l’objet (N&B)', () => {
      if (editing) exitReliefMaskEdit(mesh); else enterReliefMaskEdit(mesh, layer);
      renderRetexLayers();
      setStatus(_reliefMaskEdit ? 'Édition du masque relief (N&B) — peins pour révéler, Alt = effacer.' : 'Affichage normal.');
    });
    item('🎭 Masque plein (tout le relief)', () => { layer.w.fill(1); reapplyReliefLayer(mesh, layer, true); live(); renderRetexLayers(); });
    item('⬛ Masque vide (relief effacé)', () => { layer.w.fill(0); reapplyReliefLayer(mesh, layer, true); live(); renderRetexLayers(); });
    item('🔄 Inverser le masque', () => { for (let k = 0; k < layer.w.length; k++) layer.w[k] = 1 - layer.w[k]; reapplyReliefLayer(mesh, layer, true); live(); renderRetexLayers(); });
    document.body.appendChild(menu);
    const r0 = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r0.width - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r0.height - 8)) + 'px';
    _maskMenuAway = (e) => { if (!menu.contains(e.target)) closeMaskMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', _maskMenuAway), 0);
    return;
  }

  const refresh = () => { readMaskCanvas(layer, RETEX_SIZE, mesh); recomposeRetex(); renderRetexLayers(); };
  // Bascule l'affichage du masque en N&B sur l'objet (pour l'éditer directement).
  const editing = _retexMaskEdit && _retexSelLayer === layer;
  item(editing ? '🎨 Revenir à la couleur' : '✏️ Éditer le masque sur l’objet (N&B)', () => {
    if (editing) { _retexMaskEdit = false; }
    else { _retexMaskEdit = true; _retexSelLayer = layer; _retexMaskMode = 'layer'; }
    recomposeRetex(); renderRetexLayers();
    setStatus(_retexMaskEdit ? 'Édition du masque (N&B) — peins sur l’objet pour révéler (Alt = masquer).' : 'Affichage couleur.');
  });
  // Masque plein = supprimer le masque : plein blanc « tout révélé », indépendant des UV.
  item('🎭 Masque plein (tout révélé)', () => { disposeLayerMask(layer); recomposeRetex(); renderRetexLayers(); });
  item('⬛ Masque vide (tout masqué)', () => { setLayerMask(layer, RETEX_SIZE, false); refresh(); });
  item('🔄 Inverser le masque', () => { invertLayerMask(layer, RETEX_SIZE); refresh(); });
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  _maskMenuAway = (e) => { if (!menu.contains(e.target)) closeMaskMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', _maskMenuAway), 0);
}
function renderRetexLayers() {
  const box = document.getElementById('retex-layers'); if (!box) return; box.innerHTML = '';
  updateRetexModeUI();
  const mesh = state.targetMesh; const layers = mesh ? retexLayersOf(mesh) : [];
  if (!layers.length) { box.innerHTML = '<div style="font-size:11px;color:#888;">Aucun calque</div>'; return; }
  for (let i = layers.length - 1; i >= 0; i--) { // du dessus (dernier) vers le bas
    const l = layers[i];
    // ---- Calque RELIEF : vignette + amplitude (~opacité) + visibilité/suppression + MASQUE peignable ----
    if (l.type === 'relief') {
      const sel = _retexSelLayer === l;
      const row = document.createElement('div'); row.className = 'obj-row' + (sel ? ' active' : '');
      row.title = 'Calque de relief — sélectionne-le puis peins sur l’objet pour révéler / effacer (Alt) le relief';
      const openMenuR = (e) => { e.preventDefault(); showMaskMenu(e.clientX, e.clientY, l); };
      row.oncontextmenu = openMenuR;
      const thumb = document.createElement('canvas'); thumb.width = thumb.height = 44; thumb.className = 'retex-thumb';
      { const tc = thumb.getContext('2d'); tc.fillStyle = '#12121e'; tc.fillRect(0, 0, 44, 44); if (l.thumb) { try { tc.drawImage(l.thumb, 0, 0, 44, 44); } catch (_) {} } }
      const selectRelief = () => {
        const willSel = _retexSelLayer !== l;
        if (_reliefMaskEdit && _reliefMaskLayer === l && !willSel) exitReliefMaskEdit(mesh); // désélection pendant l'édition N&B
        _retexSelLayer = willSel ? l : null; _retexMaskMode = 'layer'; _retexMaskEdit = false;
        renderRetexLayers(); setStatus(willSel ? 'Masque de relief — peins sur l’objet pour révéler, Alt = effacer.' : 'Calque désélectionné.');
      };
      thumb.onclick = selectRelief;
      // Vignette de MASQUE (blanc = relief plein, noir = effacé) rendue dans le cadrage de capture.
      const sel2 = _retexSelLayer === l;
      const mthumb = document.createElement('canvas'); mthumb.width = mthumb.height = 44; mthumb.className = 'retex-thumb retex-mask-thumb has-mask' + (sel2 ? ' editing' : '');
      mthumb.title = 'Masque du relief — clic gauche : sélectionner ; clic droit : options (éditer N&B, plein, vide, inverser)';
      mthumb.oncontextmenu = openMenuR;
      { const mc = mthumb.getContext('2d'); mc.fillStyle = '#0a0a12'; mc.fillRect(0, 0, 44, 44);
        try { const gray = new Float32Array(mesh.geometry.attributes.position.count * 3); for (let k = 0; k < l.moved.length; k++) { const w = l.w[k], v3 = l.moved[k] * 3; gray[v3] = w; gray[v3 + 1] = w; gray[v3 + 2] = w; } const mv = renderReliefMaskView(mesh, gray, l.cam, 96); if (mv) mc.drawImage(mv, 0, 0, 44, 44); } catch (_) {} }
      mthumb.onclick = selectRelief;
      const eye = document.createElement('button'); eye.className = 'obj-btn'; eye.textContent = l.visible ? '👁' : '🚫';
      eye.title = l.visible ? 'Masquer le relief' : 'Afficher le relief';
      eye.onclick = () => { l.visible = !l.visible; reapplyReliefLayer(mesh, l, true); renderRetexLayers(); };
      const name = document.createElement('span'); name.className = 'obj-name'; name.textContent = l.name; name.style.cssText = 'font-size:11px;cursor:pointer;'; name.onclick = selectRelief;
      const amp = document.createElement('input'); amp.type = 'range'; amp.min = 0; amp.max = 100; amp.value = Math.round((l.amplitude ?? RELIEF_DEFAULT_AMP) * 100); amp.style.width = '48px';
      amp.title = 'Amplitude du relief';
      amp.oninput = () => { l.amplitude = amp.value / 100; if (l.visible) reliefSlideSchedule(mesh, l); };
      amp.onchange = () => { if (l.visible) reapplyReliefLayer(mesh, l, true); }; // relâcher -> refit BVH
      const del = document.createElement('button'); del.className = 'obj-btn'; del.textContent = '🗑'; del.title = 'Supprimer le relief';
      del.onclick = () => { l.visible = false; reapplyReliefLayer(mesh, l, true); if (_retexSelLayer === l) _retexSelLayer = null; layers.splice(i, 1); renderRetexLayers(); };
      row.append(thumb, mthumb, name, eye, amp, del);
      box.appendChild(row);
      continue;
    }
    const row = document.createElement('div'); row.className = 'obj-row' + (l === _retexSelLayer ? ' active' : '');
    const select = () => {
      _retexSelLayer = (_retexSelLayer === l ? null : l);
      _retexMaskMode = 'layer'; // sélectionner un calque -> mode masque de calque
      if (!_retexSelLayer) _retexMaskEdit = false; // désélection -> retour couleur
      recomposeRetex(); renderRetexLayers();
      setStatus(_retexSelLayer ? 'Masque de calque — peins sur l’objet pour révéler (Alt = effacer).' : 'Calque désélectionné.');
    };
    const openMenu = (e) => { e.preventDefault(); showMaskMenu(e.clientX, e.clientY, l); };
    row.oncontextmenu = openMenu; // clic droit n'importe où sur la ligne -> menu masque
    // Vignette photo : image source du calque (fallback : la texture UV composée)
    const thumb = document.createElement('canvas'); thumb.width = thumb.height = 44; thumb.className = 'retex-thumb';
    thumb.title = 'Sélectionner (peins sur l’objet pour masquer/révéler ce calque)';
    { const tc = thumb.getContext('2d'); const src = l.thumb || l.canvas;
      tc.fillStyle = '#12121e'; tc.fillRect(0, 0, 44, 44);
      if (src) { try { tc.drawImage(src, 0, 0, 44, 44); } catch (_) {} } }
    thumb.onclick = select;
    // Vignette masque (façon Photoshop) : blanc = révélé, noir = masqué ; gris clair = pas de masque.
    // Si le calque a une caméra de capture, on montre le masque DANS LE CADRAGE PHOTO (pas en UV).
    const mthumb = document.createElement('canvas'); mthumb.width = mthumb.height = 44; mthumb.className = 'retex-thumb retex-mask-thumb' + ((l._maskRT || l.mask) ? ' has-mask' : '') + ((_retexMaskEdit && l === _retexSelLayer) ? ' editing' : '');
    mthumb.title = 'Masque du calque — clic droit pour les options (éditer N&B, plein, vide, inverser…)';
    { const mc = mthumb.getContext('2d');
      if (l.mask && l.cam && l.cam.camLocal && mesh) {
        try { mc.drawImage(renderMaskView(mesh, l.mask, l.cam, 96), 0, 0, 44, 44); } catch (_) { mc.fillStyle = '#0a0a12'; mc.fillRect(0, 0, 44, 44); mc.drawImage(l.mask, 0, 0, 44, 44); }
      } else if (l.mask) { mc.fillStyle = '#0a0a12'; mc.fillRect(0, 0, 44, 44); try { mc.drawImage(l.mask, 0, 0, 44, 44); } catch (_) {} }
      else { mc.fillStyle = '#dcdce4'; mc.fillRect(0, 0, 44, 44); } } // pas de masque = tout révélé
    mthumb.onclick = select;
    mthumb.oncontextmenu = openMenu;
    const eye = document.createElement('button'); eye.className = 'obj-btn'; eye.textContent = l.visible ? '👁' : '🚫';
    eye.title = l.visible ? 'Masquer le calque' : 'Afficher le calque';
    eye.onclick = () => { l.visible = !l.visible; recomposeRetex(); renderRetexLayers(); };
    const name = document.createElement('span'); name.className = 'obj-name'; name.textContent = l.name; name.style.fontSize = '11px'; name.style.cursor = 'pointer';
    name.title = 'Sélectionner (peins sur l’objet pour masquer/révéler ce calque)';
    name.onclick = select;
    const op = document.createElement('input'); op.type = 'range'; op.min = 0; op.max = 100; op.value = Math.round((l.opacity ?? 1) * 100); op.style.width = '48px';
    op.title = 'Opacité'; op.oninput = () => { l.opacity = op.value / 100; recomposeRetex(); };
    const up = document.createElement('button'); up.className = 'obj-btn'; up.textContent = '↑'; up.title = 'Monter';
    up.onclick = () => { if (i < layers.length - 1) { const t = layers[i]; layers[i] = layers[i + 1]; layers[i + 1] = t; recomposeRetex(); renderRetexLayers(); } };
    const del = document.createElement('button'); del.className = 'obj-btn'; del.textContent = '🗑'; del.title = 'Supprimer le calque';
    del.onclick = () => { if (_retexSelLayer === l) { _retexSelLayer = null; _retexMaskEdit = false; } disposeLayerMask(l); layers.splice(i, 1); recomposeRetex(); renderRetexLayers(); };
    row.append(thumb, mthumb, name, eye, op, up, del);
    box.appendChild(row);
  }
}
document.getElementById('retex-capture').addEventListener('click', () => {
  if (!state.targetMesh) { setStatus('Aucun objet.'); return; }
  recomposeRetex(false);          // pas de surbrillance cyan dans le screenshot
  const url = captureView();
  recomposeRetex(true);           // restaure la surbrillance à l'écran
  const a = document.createElement('a'); a.href = url; a.download = 'capture-vue.png'; a.click();
  setStatus('Vue capturée + téléchargée. Modifie-la (IA) puis « Importer (reprojeté) » sans bouger la caméra… (les matrices sont mémorisées).');
});
let _retexMode = 'proj';
document.getElementById('retex-import-proj').addEventListener('click', () => {
  if (!hasPendingCam()) { setStatus('Capture d’abord la vue (📷).'); return; }
  _retexMode = 'proj'; document.getElementById('retex-file').click();
});
document.getElementById('retex-import-uv').addEventListener('click', () => { _retexMode = 'uv'; document.getElementById('retex-file').click(); });
document.getElementById('retex-replace').addEventListener('click', () => { _retexMode = 'replace'; document.getElementById('retex-file').click(); });
document.getElementById('retex-download').addEventListener('click', () => {
  const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
  const base = mesh.userData.baseMat || mesh.material;
  const img = base && base.map && base.map.image;
  if (!img) { setStatus('Aucune texture à télécharger.'); return; }
  let canvas;
  if (img instanceof HTMLCanvasElement) canvas = img;
  else { // Image/ImageBitmap -> passer par un canvas
    const w = img.naturalWidth || img.width || RETEX_SIZE, h = img.naturalHeight || img.height || RETEX_SIZE;
    canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0);
  }
  const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `${mesh.name || 'texture'}.png`; a.click();
  setStatus('Texture téléchargée.');
});
document.getElementById('retex-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
  const layers = retexLayersOf(mesh);
  let img; try { img = await loadImageFile(file); } catch (_) { setStatus('Image illisible.'); return; }
  if (_retexMode === 'replace') {
    // remplace la texture de base (calque du fond) ; les calques existants restent au-dessus
    const b = toRetexCanvas(img);
    const baseLayer = layers.find((l) => l._isBase);
    if (baseLayer) baseLayer.canvas = b;
    else layers.unshift({ name: 'Texture de base', canvas: b, opacity: 1, visible: true, _isBase: true });
    recomposeRetex(); renderRetexLayers();
    setStatus('Texture de base remplacée.');
    return;
  }
  let canvas;
  if (_retexMode === 'proj') {
    showLoading(true, 'Reprojection sur l’UV…');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { canvas = reprojectToUV(img, mesh, RETEX_SIZE); }
    catch (err) { console.error(err); setStatus(`Reprojection : ${err.message}`); showLoading(false); return; }
    showLoading(false);
  } else {
    canvas = document.createElement('canvas'); canvas.width = canvas.height = RETEX_SIZE;
    canvas.getContext('2d').drawImage(img, 0, 0, RETEX_SIZE, RETEX_SIZE);
  }
  const newLayer = { name: file.name.replace(/\.[^.]+$/, '').slice(0, 16), canvas, thumb: img, cam: _retexMode === 'proj' ? getPendingCam() : null, opacity: 1, visible: true };
  // Si un masque pré-génération a été peint, il devient le masque de ce calque.
  let usedPregen = false;
  if (_retexPendingMask && _retexPendingMask.mask) {
    newLayer.mask = _retexPendingMask.mask; newLayer._maskRT = _retexPendingMask._maskRT;
    _retexPendingMask = null; _retexMaskMode = 'layer'; _retexSelLayer = newLayer; usedPregen = true;
  }
  layers.push(newLayer);
  recomposeRetex(); renderRetexLayers();
  setStatus(`Calque ajouté (${_retexMode === 'proj' ? 'reprojeté' : 'UV direct'})${usedPregen ? ' + masque pré-génération appliqué' : ''}.`);
});

// ---- Peinture du masque alpha du calque sélectionné (brush 3D sur l'objet) ----
let _retexPainting = false, _retexPendingPt = null, _retexScheduled = false, _retexErase = false;
function retexPaintFrame() {
  _retexScheduled = false;
  const mesh = state.targetMesh, l = retexPaintTarget();
  if (!_retexPainting || !_retexPendingPt || !mesh || !l) return;
  syncBrushRadius(_retexPendingPt); // rayon monde = fraction d'écran au point peint (taille écran constante)
  // Calque relief : on peint son MASQUE (poids par sommet) -> repositionne les vertices, pas de masque UV.
  if (l.type === 'relief') {
    if (paintReliefMaskAt(_retexPendingPt.clone(), l, _retexErase)) {
      reapplyReliefLayer(mesh, l, false);
      if (_reliefMaskEdit && _reliefMaskLayer === l) updateReliefGrayLive(mesh, l); // affichage N&B live
    }
    _retexPendingPt = null;
    return;
  }
  const radius = state.params.size;
  const hardness = state.params.falloffHardness != null ? state.params.falloffHardness : 0.5;
  const strength = Math.max(0.05, (state.params.intensity / 100) * 0.5);
  paintMaskDab(mesh, l, _retexPendingPt.clone(), radius, hardness, strength, _retexErase, RETEX_SIZE, mesh.matrixWorld);
  _retexPendingPt = null;
  readMaskCanvas(l, RETEX_SIZE, state.targetMesh); recomposeRetex();
}
function retexScheduleFrame() { if (!_retexScheduled) { _retexScheduled = true; requestAnimationFrame(retexPaintFrame); } }

dom.addEventListener('pointerdown', (e) => {
  if (state.params.tool !== 'retexture' || e.button !== 0 || isRenderMode()) return;
  if (!state.targetMesh || !state.targetMesh.visible) return;
  if (!state.targetMesh.geometry.attributes.uv) return; // pas d'UV -> retexturing indisponible (déplie d'abord)
  if (_retexMaskMode === 'layer' && !_retexSelLayer) return; // rien à peindre
  setMouseFromEvent(e);
  const hit = raycastSurface();
  if (!hit) return;
  if (isRig(state.targetMesh) && isPoseDirty(state.targetMesh)) { bakePose(state.targetMesh); setActiveObject(state.targetMesh); } // retexture d'un rig posé : bake la pose (garde le squelette)
  _retexPainting = true; _retexErase = e.altKey || e.ctrlKey || e.metaKey;
  state.controls.enabled = false;
  try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  _retexPendingPt = hit.point.clone(); retexScheduleFrame();
});
dom.addEventListener('pointermove', (e) => {
  if (!_retexPainting) return;
  setMouseFromEvent(e);
  const hit = raycastSurface();
  if (hit) { _retexPendingPt = hit.point.clone(); retexScheduleFrame(); }
});
function endRetexPaint(e) {
  if (!_retexPainting) return;
  _retexPainting = false; state.controls.enabled = true;
  if (e && e.pointerId !== undefined) { try { dom.releasePointerCapture(e.pointerId); } catch (_) {} }
  const l = retexPaintTarget();
  if (l && l.type === 'relief') { reapplyReliefLayer(state.targetMesh, l, true); renderRetexLayers(); return; } // refit BVH + refresh vignette masque
  if (l) { readMaskCanvas(l, RETEX_SIZE, state.targetMesh); recomposeRetex(); renderRetexLayers(); }
}
dom.addEventListener('pointerup', endRetexPaint);
dom.addEventListener('pointercancel', endRetexPaint);

// Génération IA (Nano Banana / Gemini) — clé de l'utilisateur (BYOK, stockée en localStorage)
{
  const keyInput = document.getElementById('retex-apikey');
  keyInput.value = localStorage.getItem('geminiApiKey') || '';
  keyInput.addEventListener('change', () => localStorage.setItem('geminiApiKey', keyInput.value.trim()));
  const promptInput = document.getElementById('retex-prompt');
  promptInput.value = localStorage.getItem('nanoPrompt') || '';
  promptInput.addEventListener('input', () => localStorage.setItem('nanoPrompt', promptInput.value));
}
document.getElementById('retex-generate').addEventListener('click', async () => {
  const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
  const key = document.getElementById('retex-apikey').value.trim();
  if (!key) { setStatus('Renseigne ta clé API Gemini (voir « Comment créer une clé »).'); return; }
  const prompt = document.getElementById('retex-prompt').value.trim();
  if (!prompt) { setStatus('Écris un prompt.'); return; }
  localStorage.setItem('geminiApiKey', key);
  showLoading(true, 'Génération Nano Banana…');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    // Retire la surbrillance du masque pré-gen de la texture AVANT la capture (sinon le cyan
    // part dans le screenshot envoyé à l'IA). Le masque pré-gen reste mémorisé (_retexPendingMask)
    // et sera appliqué au calque généré plus bas.
    recomposeRetex(false);
    const capUrl = captureView(); // capture 1:1 flat (albédo) de l'ÉTAT COURANT + mémorise la caméra
    // INPAINT : si une zone est peinte (masque pré-gen), on l'envoie à l'IA rendue dans le cadrage
    // de la capture -> l'IA n'édite QUE cette zone et raccorde au reste (au lieu de tout régénérer).
    let maskUrl = null;
    if (_retexPendingMask && _retexPendingMask.mask) {
      maskUrl = renderMaskView(mesh, _retexPendingMask.mask, getPendingCam(), 1024).toDataURL('image/png');
    }
    const outUrl = await generateNanoBanana(capUrl, prompt, key, undefined, maskUrl); // image éditée (dataURL)
    const loadURL = (u) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('image illisible')); im.src = u; });
    const [aiImg, capImg] = await Promise.all([loadURL(outUrl), loadURL(capUrl)]);
    const dbg = document.getElementById('retex-debug').checked;
    const dl = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
    if (dbg) { dl(capUrl, 'debug-1-capture.png'); if (maskUrl) dl(maskUrl, 'debug-1b-inpaint-mask.png'); dl(outUrl, 'debug-2-ia-brut.png'); }
    // Fond transparent GARANTI : on découpe le retour de l'IA avec la silhouette de la capture, ÉRODÉE
    // de quelques pixels. L'IA rend souvent un fond clair qui bave sur le bord anti-aliasé de la
    // silhouette (liseré blanc) ; en érodant on ne garde que l'intérieur franc, et l'edge-padding de
    // la reprojection réétend la couleur vers le bord/coutures. Nano Banana ne sait pas rendre d'alpha.
    const w = aiImg.naturalWidth || aiImg.width, h = aiImg.naturalHeight || aiImg.height;
    const mask = erodeMaskCanvas(capImg, 2, w, h);
    const img = document.createElement('canvas'); img.width = w; img.height = h;
    { const c = img.getContext('2d'); c.drawImage(aiImg, 0, 0); c.globalCompositeOperation = 'destination-in'; c.drawImage(mask, 0, 0); c.globalCompositeOperation = 'source-over'; }
    if (dbg) dl(img.toDataURL('image/png'), 'debug-3-detoure.png');
    const layers = retexLayersOf(mesh);
    const canvas = reprojectToUV(img, mesh, RETEX_SIZE);
    if (dbg) dl(canvas.toDataURL('image/png'), 'debug-4-bake-uv.png');
    const newLayer = { name: 'IA: ' + prompt.slice(0, 14), canvas, thumb: img, cam: getPendingCam(), opacity: 1, visible: true };
    if (_retexPendingMask && _retexPendingMask.mask) { newLayer.mask = _retexPendingMask.mask; newLayer._maskRT = _retexPendingMask._maskRT; _retexPendingMask = null; _retexMaskMode = 'layer'; _retexSelLayer = newLayer; }
    layers.push(newLayer);
    recomposeRetex(); renderRetexLayers();
    setStatus(maskUrl ? 'Inpaint IA généré (zone ciblée) et reprojeté.' : 'Calque IA généré et reprojeté.');
  } catch (err) { console.error(err); setStatus(`Nano Banana : ${err.message}`); }
  finally { showLoading(false); }
});

// Texturing COMPLET multi-vues : on tourne autour de l'objet (nViews azimuts, élévation conservée).
// Vue 1 = génération complète ; vues suivantes = INPAINT des zones encore non couvertes (raccord
// cohérent avec le déjà-texturé). Accumule dans une seule texture UV -> un calque final.
async function multiViewTexture(mesh, prompt, key, nViews) {
  const cam = state.camera, ctrls = state.controls;
  const savePos = cam.position.clone(), saveTarget = ctrls.target.clone(), saveUp = cam.up.clone();
  const wasEnabled = ctrls.enabled; ctrls.enabled = false;
  mesh.updateMatrixWorld(true);
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
  const bs = mesh.geometry.boundingSphere;
  const center = bs.center.clone().applyMatrix4(mesh.matrixWorld);
  const rel = savePos.clone().sub(center); const relLen = rel.length() || 1;
  const dist = Math.max(relLen, bs.radius * 2.2);
  // Poses de caméra : 6 vues = FACES DU CUBE (front/back/droite/gauche/dessus/dessous) ; sinon orbite 360°.
  const CUBE = [
    { d: [0, 0, 1], up: [0, 1, 0] }, { d: [0, 0, -1], up: [0, 1, 0] },   // avant / arrière
    { d: [1, 0, 0], up: [0, 1, 0] }, { d: [-1, 0, 0], up: [0, 1, 0] },   // droite / gauche
    { d: [0, 1, 0], up: [0, 0, -1] }, { d: [0, -1, 0], up: [0, 0, 1] },  // dessus / dessous
  ];
  const poses = [];
  if (nViews === 6) {
    for (const v of CUBE) poses.push({ pos: center.clone().addScaledVector(new THREE.Vector3(v.d[0], v.d[1], v.d[2]), dist), up: new THREE.Vector3(v.up[0], v.up[1], v.up[2]) });
  } else {
    const el = Math.asin(THREE.MathUtils.clamp(rel.y / relLen, -0.999, 0.999)); const ce = Math.cos(el), se = Math.sin(el);
    for (let i = 0; i < nViews; i++) { const az = (i / nViews) * Math.PI * 2; poses.push({ pos: new THREE.Vector3(center.x + dist * Math.cos(az) * ce, center.y + dist * se, center.z + dist * Math.sin(az) * ce), up: new THREE.Vector3(0, 1, 0) }); }
  }
  nViews = poses.length;
  const layers = retexLayersOf(mesh);
  const baseComposite = compositeLayers(mesh.userData._retexBase, layers, RETEX_SIZE); // fond des captures
  const accum = document.createElement('canvas'); accum.width = accum.height = RETEX_SIZE; const actx = accum.getContext('2d');
  const disp = document.createElement('canvas'); disp.width = disp.height = RETEX_SIZE; const dctx = disp.getContext('2d');
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const dbg = document.getElementById('retex-debug').checked;
  const dl = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
  try {
    for (let i = 0; i < nViews; i++) {
      showLoading(true, `Multi-view ${i + 1}/${nViews}…`);
      const vv = String(i + 1).padStart(2, '0'); // préfixe debug par vue
      cam.position.copy(poses[i].pos); cam.up.copy(poses[i].up); cam.lookAt(center); ctrls.target.copy(center); cam.updateMatrixWorld(true);
      // Affiche l'état courant (calques existants + accum) pour que la capture le voie (contexte inpaint).
      dctx.clearRect(0, 0, RETEX_SIZE, RETEX_SIZE); dctx.drawImage(baseComposite, 0, 0); dctx.drawImage(accum, 0, 0);
      applyTextureCanvas(mesh, disp);
      await raf2();
      const capUrl = captureView();
      const maskUrl = i > 0 ? renderMaskView(mesh, accum, getPendingCam(), 1024, true).toDataURL('image/png') : null;
      const outUrl = await generateNanoBanana(capUrl, prompt, key, undefined, maskUrl);
      const [aiImg, capImg] = await Promise.all([loadImageURL(outUrl), loadImageURL(capUrl)]);
      const w = aiImg.naturalWidth || aiImg.width, h = aiImg.naturalHeight || aiImg.height;
      const cut = erodeMaskCanvas(capImg, 2, w, h);
      const cutImg = document.createElement('canvas'); cutImg.width = w; cutImg.height = h;
      { const c = cutImg.getContext('2d'); c.drawImage(aiImg, 0, 0); c.globalCompositeOperation = 'destination-in'; c.drawImage(cut, 0, 0); c.globalCompositeOperation = 'source-over'; }
      const viewCanvas = reprojectToUV(cutImg, mesh, RETEX_SIZE);
      if (dbg) {
        dl(capUrl, `mv-${vv}-a-capture.png`);
        if (maskUrl) dl(maskUrl, `mv-${vv}-b-masque-zones-vides.png`);
        dl(outUrl, `mv-${vv}-c-ia.png`);
        dl(cutImg.toDataURL('image/png'), `mv-${vv}-d-detoure.png`);
        dl(viewCanvas.toDataURL('image/png'), `mv-${vv}-e-bake-uv.png`);
      }
      actx.globalCompositeOperation = i === 0 ? 'source-over' : 'destination-over'; // ne remplit que le vide
      actx.drawImage(viewCanvas, 0, 0);
      actx.globalCompositeOperation = 'source-over';
    }
    if (dbg) dl(accum.toDataURL('image/png'), 'mv-accum-final.png');
    layers.push({ name: (nViews === 6 ? 'IA cube: ' : 'IA 360°: ') + prompt.slice(0, 12), canvas: accum, thumb: accum, opacity: 1, visible: true });
    _retexSelLayer = null; _retexMaskMode = 'layer';
    recomposeRetex(); renderRetexLayers();
    setStatus(`Texturing multi-vues terminé (${nViews} vues).`);
  } catch (err) { console.error(err); setStatus(`Multi-view : ${err.message}`); }
  finally {
    cam.position.copy(savePos); cam.up.copy(saveUp); ctrls.target.copy(saveTarget); cam.lookAt(saveTarget); cam.updateMatrixWorld(true);
    if (ctrls.update) ctrls.update();
    ctrls.enabled = wasEnabled; showLoading(false);
  }
}
function runMultiView(nViews) {
  const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
  const key = document.getElementById('retex-apikey').value.trim();
  if (!key) { setStatus('Renseigne ta clé API Gemini.'); return; }
  const prompt = document.getElementById('retex-prompt').value.trim();
  if (!prompt) { setStatus('Écris un prompt.'); return; }
  localStorage.setItem('geminiApiKey', key);
  multiViewTexture(mesh, prompt, key, nViews);
}
document.getElementById('retex-mv6').addEventListener('click', () => runMultiView(6));
document.getElementById('retex-mv12').addEventListener('click', () => runMultiView(12));

// ---------- Relief IA : calque de type « relief » (déplacement des vertices) ----------
// Un calque relief est stocké dans la même liste que les calques couleur, avec :
//   { type:'relief', name, thumb (canvas height preview), visible, amplitude (0..1, ~opacité),
//     vcount, moved:Uint32Array, dir:Float32Array(3·n), disp:Float32Array(n) [déplacement à amp=1],
//     applied:Float32Array(n) [déplacement actuellement appliqué par sommet], w:Float32Array(n) [masque 0..1],
//     recIdx:Uint32Array (1-anneau, pour recalcul normales), tris:Int32Array, rmin, rmax }
// Non destructif comme un calque couleur : amplitude/visibilité/masque pilotent un DELTA incrémental PAR
// SOMMET (cible = disp·amplitude·w) le long des directions figées (télescope -> pas de dérive ; se compose
// avec le sculpt manuel). Le masque w se peint sur l'objet (calque sélectionné). Comme l'opacité couleur,
// ces réglages NE passent PAS par Ctrl+Z ; on retire un relief en supprimant son calque.
const RELIEF_DEFAULT_AMP = 0.4;

function markRange(attr, vmin, vmax) {
  const dim = attr.itemSize, start = vmin * dim, count = (vmax - vmin + 1) * dim;
  if (typeof attr.addUpdateRange === 'function') attr.addUpdateRange(start, count);
  else if (attr.updateRange) { attr.updateRange.offset = start; attr.updateRange.count = count; }
  attr.needsUpdate = true;
}

// Recalcule les normales UNIQUEMENT sur les triangles touchés (rapide, pour le drag temps réel),
// re-moyennées aux coutures qui intersectent la zone.
function recomputeNormalsLocal(g, st) {
  const pos = g.attributes.position.array, nor = g.attributes.normal.array, idx = g.index.array;
  const rec = st.recIdx, tris = st.tris;
  for (let k = 0; k < rec.length; k++) { const v3 = rec[k] * 3; nor[v3] = 0; nor[v3 + 1] = 0; nor[v3 + 2] = 0; }
  for (let t = 0; t < tris.length; t++) {
    const o = tris[t] * 3, a = idx[o] * 3, b = idx[o + 1] * 3, c = idx[o + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const e1x = pos[b] - ax, e1y = pos[b + 1] - ay, e1z = pos[b + 2] - az;
    const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
    nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
    nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
  }
  for (let k = 0; k < rec.length; k++) { const v3 = rec[k] * 3; const x = nor[v3], y = nor[v3 + 1], z = nor[v3 + 2]; const l = Math.hypot(x, y, z); if (l > 0) { nor[v3] = x / l; nor[v3 + 1] = y / l; nor[v3 + 2] = z / l; } }
  const gm = state.groupMembers;
  if (gm && gm.size > 0) {
    const rep = state.rep, done = new Set();
    for (let k = 0; k < rec.length; k++) {
      const r = rep[rec[k]]; if (done.has(r)) continue; done.add(r);
      const members = gm.get(r); if (!members) continue;
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < members.length; j++) { const m3 = members[j] * 3; x += nor[m3]; y += nor[m3 + 1]; z += nor[m3 + 2]; }
      const l = Math.hypot(x, y, z); if (l > 0) { x /= l; y /= l; z /= l; }
      for (let j = 0; j < members.length; j++) { const m3 = members[j] * 3; nor[m3] = x; nor[m3 + 1] = y; nor[m3 + 2] = z; }
    }
  }
  markRange(g.attributes.position, st.rmin, st.rmax);
  markRange(g.attributes.normal, st.rmin, st.rmax);
}

// Réapplique un calque relief à la géométrie COURANTE : pour chaque sommet, cible = disp·amplitude·masque
// (0 si calque caché), et on applique le DELTA (cible − déjà-appliqué) le long de la direction figée.
// Modèle par sommet -> gère amplitude ET masque (poids par sommet), télescope sans dérive, se compose
// avec le sculpt manuel. doRefit=false pendant un drag (fluide), true au relâcher (BVH pour raycast/export).
// Garde : topologie changée (subdivision/remesh) -> champ inapplicable -> no-op.
function reapplyReliefLayer(mesh, layer, doRefit) {
  const g = mesh.geometry;
  if (layer.vcount !== g.attributes.position.count) return;
  const pos = g.attributes.position.array;
  const amp = layer.visible ? layer.amplitude : 0;
  const moved = layer.moved, dir = layer.dir, disp = layer.disp, applied = layer.applied, w = layer.w;
  let any = false;
  for (let k = 0; k < moved.length; k++) {
    const tgt = disp[k] * amp * (w ? w[k] : 1);
    const d = tgt - applied[k];
    if (d === 0) continue;
    const v3 = moved[k] * 3;
    pos[v3] += dir[k * 3] * d; pos[v3 + 1] += dir[k * 3 + 1] * d; pos[v3 + 2] += dir[k * 3 + 2] * d;
    applied[k] = tgt; any = true;
  }
  if (any) { recomputeNormalsLocal(g, layer); if (doRefit && g.boundsTree) g.boundsTree.refit(); markDirty(); }
  else if (doRefit && g.boundsTree) g.boundsTree.refit();
}

// Drag d'amplitude / peinture de masque throttlé en rAF (sans refit BVH pendant le glissement).
let _reliefSched = false, _reliefPending = null;
function reliefSlideSchedule(mesh, layer) {
  _reliefPending = { mesh, layer };
  if (_reliefSched) return; _reliefSched = true;
  requestAnimationFrame(() => { _reliefSched = false; const p = _reliefPending; if (p) reapplyReliefLayer(p.mesh, p.layer, false); });
}

// High-pass d'une image en niveaux de gris : détail = mid-gris + (image − flou). Retire la
// composante très basse fréquence (dégradé global / ombrage doux que l'IA bake parfois) et ne
// garde QUE le détail local, recentré sur 128 -> évite que tout le patch gonfle (dérive).
// Signal de relief = DIFFÉRENCE de luminance entre l'image IA et la capture d'origine, recentrée sur
// 128 (= « pas de changement » -> relief nul). Là où l'IA a ASSOMBRI -> < 128 (creux) ; ÉCLAIRCI -> > 128
// (bosse). Zone morte : les écarts minuscules (bruit JPEG / pixels identiques) -> 128 -> aucun relief.
// -> on ne sculpte QUE ce que l'IA a réellement modifié, et aucun fonçage au bord (bord inchangé = 128).
const RELIEF_GAIN = 2.0, RELIEF_DEAD = 6;
function computeReliefDiff(aiImg, capImg, w, h) {
  const read = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
  const ad = read(aiImg), cd = read(capImg);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const oc = out.getContext('2d'); const oi = oc.createImageData(w, h); const od = oi.data;
  for (let i = 0; i < w * h; i++) {
    const la = ad[i * 4] * 0.299 + ad[i * 4 + 1] * 0.587 + ad[i * 4 + 2] * 0.114;
    const lc = cd[i * 4] * 0.299 + cd[i * 4 + 1] * 0.587 + cd[i * 4 + 2] * 0.114;
    let d = la - lc;
    if (Math.abs(d) < RELIEF_DEAD) d = 0;                    // quasi identique -> pas de relief
    let v = 128 + d * RELIEF_GAIN; if (v < 0) v = 0; else if (v > 255) v = 255;
    od[i * 4] = od[i * 4 + 1] = od[i * 4 + 2] = v; od[i * 4 + 3] = 255;
  }
  oc.putImageData(oi, 0, 0);
  return out;
}

// Construit un calque relief à partir de (image IA, capture) : diff -> découpe silhouette (intérieur) ->
// reprojection UV -> displacement. `maskCanvas` confine (optionnel). Renvoie le calque (ou null).
function reliefLayerFromDiff(mesh, aiImg, capImg, cam, maskCanvas, name, dbg, dl, prefix) {
  const w = aiImg.naturalWidth || aiImg.width, h = aiImg.naturalHeight || aiImg.height;
  const diff = computeReliefDiff(aiImg, capImg, w, h);
  const cut = erodeMaskCanvas(capImg, 2, w, h);             // silhouette érodée : bord exclu -> pas d'artefact
  { const c = diff.getContext('2d'); c.globalCompositeOperation = 'destination-in'; c.drawImage(cut, 0, 0); c.globalCompositeOperation = 'source-over'; }
  if (dbg && dl) dl(diff.toDataURL('image/png'), prefix + '-diff-relief.png');
  const heightCanvas = reprojectToUV(diff, mesh, RETEX_SIZE, cam, 4);
  const thumb = document.createElement('canvas'); thumb.width = thumb.height = 96; thumb.getContext('2d').drawImage(diff, 0, 0, 96, 96);
  return buildReliefLayer(mesh, heightCanvas, maskCanvas, name, thumb, cam);
}

// Échantillonnage bilinéaire (luma + alpha) d'un ImageData carré `data` (size²) en UV (0..1).
function sampleBilinear(data, size, u, v) {
  let x = u * (size - 1), y = v * (size - 1);
  if (x < 0) x = 0; else if (x > size - 1) x = size - 1;
  if (y < 0) y = 0; else if (y > size - 1) y = size - 1;
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < size ? x0 + 1 : x0, y1 = y0 + 1 < size ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * size + x0) * 4, i10 = (y0 * size + x1) * 4, i01 = (y1 * size + x0) * 4, i11 = (y1 * size + x1) * 4;
  const lp = (a, b, t) => a + (b - a) * t;
  const g = lp(lp(data[i00], data[i10], fx), lp(data[i01], data[i11], fx), fy);
  const a = lp(lp(data[i00 + 3], data[i10 + 3], fx), lp(data[i01 + 3], data[i11 + 3], fx), fy);
  return { g, a };
}

// Construit un CALQUE de relief depuis une height map (canvas UV, gris centré 128), l'applique à
// l'amplitude par défaut et le renvoie (à pousser dans la liste des calques). Non destructif : le champ
// est mémorisé sur le calque -> amplitude/visibilité/masque réglables ensuite via reapplyReliefLayer.
// `maskCanvas` (canvas UV, alpha=révélation) confine le relief à la zone peinte (optionnel).
// Direction = normale d'origine figée ; coutures soudées (groupMembers) -> pas de fissure.
function buildReliefLayer(mesh, heightCanvas, maskCanvas, name, thumb, cam) {
  const g = mesh.geometry;
  const uvAttr = g.attributes.uv;
  if (!uvAttr) throw new Error('Le maillage n’a pas d’UV — impossible de projeter le relief.');
  const nor = g.attributes.normal.array, uv = uvAttr.array;
  const N = g.attributes.position.count;
  const size = heightCanvas.width;
  const hd = heightCanvas.getContext('2d').getImageData(0, 0, size, size).data;
  const md = maskCanvas ? maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height).data : null;
  const msize = maskCanvas ? maskCanvas.width : 0;
  g.computeBoundingBox(); const bb = new THREE.Vector3(); g.boundingBox.getSize(bb);
  const unit = (bb.length() || 1) * 0.03; // déplacement à amplitude=1 : jusqu'à 3% de la diagonale bbox
  // (relief = détail fin -> volontairement faible ; le curseur d'amplitude couvre 0..3% de la diagonale)

  // 1) Déplacement UNITAIRE (amplitude=1) par vertex (0 si non couvert / hors zone).
  const dispV = new Float32Array(N);
  for (let v = 0; v < N; v++) {
    const s = sampleBilinear(hd, size, uv[v * 2], uv[v * 2 + 1]);
    if (s.a < 2) continue;                       // texel non peint (occlusion / dos / hors-vue)
    let maskA = 1;
    if (md) { maskA = sampleBilinear(md, msize, uv[v * 2], uv[v * 2 + 1]).a / 255; if (maskA <= 0.002) continue; }
    dispV[v] = (s.g / 255 - 0.5) * 2 * unit * (s.a / 255) * maskA;
  }

  // 2) Soudure des coutures : membres coïncidents déplacés du MÊME montant (moyenne) -> pas de fissure.
  const gm = state.groupMembers;
  if (gm && gm.size > 0) {
    gm.forEach((members) => {
      let sum = 0; for (let k = 0; k < members.length; k++) sum += dispV[members[k]];
      const avg = sum / members.length;
      for (let k = 0; k < members.length; k++) dispV[members[k]] = avg;
    });
  }

  // 3) Champ compact : sommets déplacés (moved) + 1-anneau (recIdx, pour les normales) + triangles (tris).
  const idxA = g.index.array, nTri = idxA.length / 3;
  const movedFlag = new Uint8Array(N); const movedList = [];
  for (let v = 0; v < N; v++) if (dispV[v] !== 0) { movedFlag[v] = 1; movedList.push(v); }
  if (!movedList.length) return null;
  const recSet = new Set(); const triList = [];
  for (let t = 0; t < nTri; t++) { const a = idxA[t * 3], b = idxA[t * 3 + 1], c = idxA[t * 3 + 2]; if (movedFlag[a] || movedFlag[b] || movedFlag[c]) { triList.push(t); recSet.add(a); recSet.add(b); recSet.add(c); } }
  const moved = Uint32Array.from(movedList);
  const recIdx = Uint32Array.from(recSet);
  const dir = new Float32Array(moved.length * 3), disp = new Float32Array(moved.length);
  let rmin = Infinity, rmax = -1;
  for (let k = 0; k < moved.length; k++) { const v = moved[k], v3 = v * 3; dir[k * 3] = nor[v3]; dir[k * 3 + 1] = nor[v3 + 1]; dir[k * 3 + 2] = nor[v3 + 2]; disp[k] = dispV[v]; }
  for (let k = 0; k < recIdx.length; k++) { const v = recIdx[k]; if (v < rmin) rmin = v; if (v > rmax) rmax = v; }

  // 4) Calque relief. applied[k] = déplacement déjà appliqué par sommet (0) ; w[k] = masque (1 = plein
  //    relief, 0 = effacé) éditable ensuite au pinceau. reapplyReliefLayer applique l'amplitude de départ.
  const applied = new Float32Array(moved.length);
  const w = new Float32Array(moved.length); w.fill(1);
  const layer = { type: 'relief', name, thumb, cam, visible: true, amplitude: RELIEF_DEFAULT_AMP, vcount: N, moved, dir, disp, applied, w, recIdx, tris: Int32Array.from(triList), rmin, rmax };
  reapplyReliefLayer(mesh, layer, true);
  return layer;
}

document.getElementById('retex-relief').addEventListener('click', async () => {
  const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
  if (!mesh.geometry.attributes.uv) { setStatus('Le maillage n’a pas d’UV (retexture requise).'); return; }
  const key = document.getElementById('retex-apikey').value.trim();
  if (!key) { setStatus('Renseigne ta clé API Gemini.'); return; }
  const prompt = document.getElementById('retex-prompt').value.trim();
  if (!prompt) { setStatus('Écris un prompt (le détail de relief voulu).'); return; }
  localStorage.setItem('geminiApiKey', key);
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Relief IA…');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    recomposeRetex(false);
    const capUrl = captureView(); // capture flat de l'état courant + mémorise la caméra
    const cam = getPendingCam();
    let maskUrl = null;
    if (_retexPendingMask && _retexPendingMask.mask) maskUrl = renderMaskView(mesh, _retexPendingMask.mask, cam, 1024).toDataURL('image/png');
    // Génération COULEUR : l'IA dessine le détail demandé (ex. « cicatrice »). Le relief est ensuite
    // dérivé du DIFF avec la capture (on ne garde pas la couleur ici — relief seul).
    const outUrl = await generateNanoBanana(capUrl, prompt, key, undefined, maskUrl);
    const [aiImg, capImg] = await Promise.all([loadImageURL(outUrl), loadImageURL(capUrl)]);
    const dbg = document.getElementById('retex-debug').checked;
    const dl = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
    if (dbg) { dl(capUrl, 'relief-1-capture.png'); dl(outUrl, 'relief-2-ia.png'); }
    const maskCanvas = _retexPendingMask && _retexPendingMask.mask ? _retexPendingMask.mask : null;
    const layer = reliefLayerFromDiff(mesh, aiImg, capImg, cam, maskCanvas, '⛰️ ' + prompt.slice(0, 12), dbg, dl, 'relief-3');
    if (_retexPendingMask) { _retexPendingMask = null; _retexMaskMode = 'layer'; }
    if (layer) retexLayersOf(mesh).push(layer);
    recomposeRetex(); renderRetexLayers();
    setStatus(layer ? `Calque relief ajouté (${layer.moved.length.toLocaleString('fr-FR')} vertices). Règle l’amplitude dans la liste.` : 'Relief nul : l’IA n’a rien changé (essaie un prompt plus marqué).');
  } catch (err) { console.error(err); setStatus(`Relief IA : ${err.message}`); }
  finally { showLoading(false); }
});

// Texture + Relief (UN seul appel IA) : génération couleur (NANO_SYSTEM) -> calque texture, PUIS le
// relief est dérivé du DIFF entre le rendu couleur et la capture (là où l'IA a changé l'image = où
// sculpter). Nano Banana ne sait pas produire de vraie height map -> pas de 2ᵉ appel. Même caméra
// mémorisée -> couleur et relief alignés. Produit 2 calques (texture + relief) en 1 appel.
document.getElementById('retex-texrelief').addEventListener('click', async () => {
  const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
  if (!mesh.geometry.attributes.uv) { setStatus('Le maillage n’a pas d’UV (retexture requise).'); return; }
  const key = document.getElementById('retex-apikey').value.trim();
  if (!key) { setStatus('Renseigne ta clé API Gemini.'); return; }
  const prompt = document.getElementById('retex-prompt').value.trim();
  if (!prompt) { setStatus('Écris un prompt (ex. « cicatrice sur la joue »).'); return; }
  localStorage.setItem('geminiApiKey', key);
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Texture + Relief…');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    recomposeRetex(false);
    const capUrl = captureView();          // capture flat de l'état courant + mémorise la caméra
    const cam = getPendingCam();
    let maskUrl = null;
    if (_retexPendingMask && _retexPendingMask.mask) maskUrl = renderMaskView(mesh, _retexPendingMask.mask, cam, 1024).toDataURL('image/png');
    const dbg = document.getElementById('retex-debug').checked;
    const dl = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };
    const layers = retexLayersOf(mesh);

    // Appel COULEUR (inpaint si zone peinte)
    const colorUrl = await generateNanoBanana(capUrl, prompt, key, undefined, maskUrl);
    const [colorImg, capImg] = await Promise.all([loadImageURL(colorUrl), loadImageURL(capUrl)]);
    const w = colorImg.naturalWidth || colorImg.width, h = colorImg.naturalHeight || colorImg.height;
    if (dbg) { dl(capUrl, 'tr-1-capture.png'); if (maskUrl) dl(maskUrl, 'tr-1b-mask.png'); dl(colorUrl, 'tr-2-couleur.png'); }

    // Calque TEXTURE : détourage + reprojection
    const cut = erodeMaskCanvas(capImg, 2, w, h);
    const colorDet = document.createElement('canvas'); colorDet.width = w; colorDet.height = h;
    { const c = colorDet.getContext('2d'); c.drawImage(colorImg, 0, 0); c.globalCompositeOperation = 'destination-in'; c.drawImage(cut, 0, 0); c.globalCompositeOperation = 'source-over'; }
    const colorCanvas = reprojectToUV(colorDet, mesh, RETEX_SIZE, cam);
    const colorLayer = { name: 'IA: ' + prompt.slice(0, 14), canvas: colorCanvas, thumb: colorDet, cam, opacity: 1, visible: true };
    const pendingMask = (_retexPendingMask && _retexPendingMask.mask) ? _retexPendingMask.mask : null;
    if (pendingMask) { colorLayer.mask = pendingMask; colorLayer._maskRT = _retexPendingMask._maskRT; }
    layers.push(colorLayer);

    // Calque RELIEF : dérivé du DIFF couleur↔capture (même confinement que la couleur)
    const reliefLayer = reliefLayerFromDiff(mesh, colorImg, capImg, cam, pendingMask, '⛰️ ' + prompt.slice(0, 12), dbg, dl, 'tr-3');
    if (reliefLayer) layers.push(reliefLayer);
    if (_retexPendingMask) { _retexPendingMask = null; _retexMaskMode = 'layer'; }
    recomposeRetex(); renderRetexLayers();
    setStatus(reliefLayer ? `Texture + relief ajoutés (relief : ${reliefLayer.moved.length.toLocaleString('fr-FR')} vertices).` : 'Texture ajoutée ; relief nul (l’IA n’a rien changé géométriquement).');
  } catch (err) { console.error(err); setStatus(`Texture + Relief : ${err.message}`); }
  finally { showLoading(false); }
});

document.getElementById('retex-pregen').addEventListener('click', () => {
  if (_retexMaskMode === 'pregen') { _retexMaskMode = 'layer'; setStatus('Mode masque de calque.'); }
  else { _retexMaskMode = 'pregen'; _retexSelLayer = null; setStatus('Zone d’inpaint — peins la zone (surbrillance) ; « Générer » ne modifiera que cette zone.'); }
  recomposeRetex(); renderRetexLayers();
});
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
async function doUnwrap() {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet à déplier.'); return; }
  if (mesh.userData._wallView) { setStatus('Quitte d’abord la vue épaisseur.'); return; }
  if (isRig(mesh)) { setStatus('Dépliage UV non disponible sur un modèle riggé.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Dépliage UV…');
  const startedAt = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const res = await Promise.resolve().then(() => unwrapUVs(mesh.geometry));
    if (!res || !res.geometry) { setStatus('Dépliage UV impossible.'); return; }
    const newMesh = createObject(res.geometry, baseMatOf(mesh).clone(), mesh.name);
    newMesh.position.copy(mesh.position); newMesh.quaternion.copy(mesh.quaternion); newMesh.scale.copy(mesh.scale); newMesh.updateMatrixWorld(true);
    const old = mesh;
    detachObject(old); setActiveObject(newMesh); renderObjectList();
    setStatus(`UV dépliées — ${res.charts} charts. Le retexturing est maintenant disponible.`);
    pushAction(
      () => { detachObject(newMesh); attachObject(old); setActiveObject(old); renderObjectList(); },
      () => { detachObject(old); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [old, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Dépliage UV : ${err.message}`); }
  finally { const wait = Math.max(0, 250 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
}
{ const u1 = document.getElementById('unwrap-btn'), u2 = document.getElementById('retex-unwrap');
  if (u1) u1.addEventListener('click', doUnwrap); if (u2) u2.addEventListener('click', doUnwrap); }
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
document.getElementById('repair-btn').addEventListener('click', async () => {
  const mesh = state.targetMesh;
  if (!mesh) { setStatus('Aucun objet à réparer.'); return; }
  if (isGizmoActive()) deactivateGizmo();
  showLoading(true, 'Réparation…');
  const startedAt = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const { geometry, stats } = await repairMesh(mesh.geometry, { detail: state.params.cutDetail });
    const newMesh = createObject(geometry, baseMatOf(mesh).clone(), mesh.name);
    newMesh.position.copy(mesh.position); newMesh.updateMatrixWorld(true);
    const old = mesh;
    detachObject(old); setActiveObject(newMesh); renderObjectList();
    const msg = stats.method === 'manifold'
      ? `Réparé (Manifold) — ${stats.verts.toLocaleString()} sommets, genus ${stats.genus}`
      : `Réparé (legacy) — soudés ${stats.welded.toLocaleString()}, îlots ${stats.removedIslands}, trous ${stats.filledHoles}`;
    setStatus(msg);
    pushAction(
      () => { detachObject(newMesh); attachObject(old); setActiveObject(old); renderObjectList(); },
      () => { detachObject(old); attachObject(newMesh); setActiveObject(newMesh); renderObjectList(); },
      () => { for (const m of [old, newMesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
  } catch (err) { console.error(err); setStatus(`Réparation : ${err.message}`); }
  finally { const wait = Math.max(0, 300 - (performance.now() - startedAt)); setTimeout(() => showLoading(false), wait); }
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

// Brosses de sculpt (partagent les mêmes options de brush : taille, intensité, dureté…).
const SCULPT_TOOLS = new Set(['draw', 'smooth', 'flatten', 'inflate', 'pinch', 'crease', 'move']);

// --- Bascule temporaire d'outil en maintenant une touche : Shift => Smooth, Ctrl/Cmd => Masque.
// On bascule VRAIMENT l'outil (état + menu + panneau) via le clic du bouton, puis on rétablit au relâchement.
let _tempTool = null; // { key, prevTool }
const toolBtnFor = (name) => document.querySelector(`.tool-btn[data-tool="${name}"]`);
function activateTempTool(name, key) {
  if (_tempTool || sculpting || isRenderMode()) return;      // pas pendant un stroke / en Rendu
  if (!SCULPT_TOOLS.has(state.params.tool)) return;          // seulement depuis une brosse de sculpt
  const btn = toolBtnFor(name); if (!btn) return;
  _tempTool = { key, prevTool: state.params.tool };
  if (name === 'mask') state.controls.enabled = false; // Mac : Ctrl+clic = clic droit -> couperait l'orbite/pan ; on peint à la place
  btn.click();
}
function restoreTempTool(key) {
  if (!_tempTool || _tempTool.key !== key) return;
  const prev = _tempTool.prevTool; _tempTool = null;
  const btn = toolBtnFor(prev); if (btn) btn.click();
  if (!sculpting) state.controls.enabled = true; // rétablit l'orbite
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  // NB : Shift+clic droit tourne la caméra nativement (OrbitControls inverse pan<->rotate quand Shift est tenu ;
  // le bouton droit = pan par défaut -> Shift+droit = rotation). Ne pas remapper mouseButtons (ça ré-inverserait).
  if (e.key === 'Shift') activateTempTool('smooth', 'Shift');
  else if (e.key === 'Control') activateTempTool('mask', 'Control'); // Ctrl seul (pas Cmd -> pas de conflit avec Cmd+Z sur Mac)
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') restoreTempTool('Shift');
  else if (e.key === 'Control') restoreTempTool('Control');
});
window.addEventListener('blur', () => { if (_tempTool) restoreTempTool(_tempTool.key); }); // sécurité si une touche « coince »

// Panneau de droite : sur Mac, Ctrl+clic = clic droit -> sans ça, le menu contextuel s'ouvre et le bouton
// ne s'active pas. On empêche le menu ET on déclenche le bouton visé, pour pouvoir garder Ctrl (masque)
// tout en cliquant Inverser/Effacer/Annuler…
{
  const panel = document.getElementById('tool-panel');
  if (panel) panel.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const el = e.target.closest('button, .control-btn, label.file-input-label');
    if (el && !el.disabled) el.click();
  });
}
// Affiche/masque chaque option selon l'outil courant : un élément [data-tools] liste les outils
// auxquels il s'applique (token exact, ou l'alias « sculpt » = toutes les brosses de sculpt).
// Les éléments sans data-tools (undo/redo, affichage, wireframe, objets, export) restent visibles.
function applyToolVisibility(tool) {
  document.querySelectorAll('[data-tools]').forEach((el) => {
    const tokens = el.dataset.tools.split(/\s+/).filter(Boolean);
    const show = tokens.some((tk) => tk === tool || (tk === 'sculpt' && SCULPT_TOOLS.has(tool)));
    el.style.display = show ? '' : 'none';
  });
}

const toolButtons = document.querySelectorAll('.tool-btn');
toolButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.params.tool = btn.dataset.tool;
    toolButtons.forEach((b) => b.classList.toggle('active', b === btn));
    const t = state.params.tool, isGizmo = t === 'gizmo', isMask = t === 'mask', isRetex = t === 'retexture', isVP = t === 'vertexpaint';
    applyToolVisibility(t); // n'affiche que les options liées à l'outil sélectionné
    // Mode Rendu = un outil : on y entre en le sélectionnant, on en sort dès qu'on change d'outil.
    if (t === 'render') { if (!isRenderMode()) enterRenderMode(); } else if (isRenderMode()) exitRenderMode();
    if (t === 'split' || t === 'other' || isGizmo || t === 'render') hideBrushCursor(); // retexture garde le cercle d'influence
    if (isGizmo) activateGizmo(state.targetMesh); else deactivateGizmo();
    document.getElementById('gizmo-hint').style.display = isGizmo ? '' : 'none';
    document.getElementById('mask-panel').style.display = isMask ? 'flex' : 'none';
    document.getElementById('retexture-panel').style.display = isRetex ? 'flex' : 'none';
    if (isRetex) { updateRetexUVState(); updateTexturePreview(true); } // sans UV : seul « Déplier les UV » actif ; aperçu (avec UV) affiché
    document.getElementById('vertexpaint-panel').style.display = isVP ? 'flex' : 'none';
    { const rs = document.getElementById('render-settings'); if (rs) rs.style.display = t === 'render' ? 'flex' : 'none'; }
    { const dp = document.getElementById('display-param'); if (dp) dp.style.display = t === 'render' ? 'none' : ''; } // pas de mode d'affichage en Rendu
    const isBones = t === 'bones';
    document.getElementById('bones-panel').style.display = isBones ? 'flex' : 'none';
    if (!isBones) {
      if (isPoseActive()) exitPose(); if (isWeightPaintActive()) exitWeightPaint(); // quitte pose/weight hors outil Bones
      // Bake la pose DÈS la sortie du menu squelette (pas au 1er clic) -> géométrie + BVH prêts pour le hover.
      if (isRig(state.targetMesh) && isPoseDirty(state.targetMesh)) { bakePose(state.targetMesh); setActiveObject(state.targetMesh); }
    }
    if (isBones) {
      renderBonesPanel();
      // Pose active par défaut dès l'entrée dans Bones (pas d'état « Bones sans rien »).
      const bt = bonesTarget();
      if (bt && !isPoseActive() && !isWeightPaintActive()) { enterPose(bt, onPoseSelect); syncBonesModeUI(); }
    }
    if (!isVP) dom.style.cursor = ''; // curseur pipette éventuel réinitialisé hors Vertex Paint
    if (isVP && state.targetMesh) {
      const mVP = state.targetMesh;
      if (!mVP.userData._vpPainted) {
        // 1ʳᵉ entrée (pas encore de couleurs) : pipette + affichage TEXTURE (pour prélever sur la texture).
        _vpPipette = true;
        if (state.params.displayMode !== 'texture') setDisplayMode('texture');
      } else {
        // déjà peint : mode peinture + affichage vertex color à plat.
        _vpPipette = false; ensureColorAttr(mVP);
        if (state.params.displayMode !== 'vcflat') setDisplayMode('vcflat');
      }
      updateVPModeUI(); renderVPPalette();
    }
    document.getElementById('left-layers-section').style.display = isRetex ? 'flex' : 'none'; // liste calques (panneau gauche)
    if (isRetex && state.params.displayMode !== 'texture') setDisplayMode('texture'); // Retexture -> affichage texture
    if (!isRetex && _retexMaskEdit) { _retexMaskEdit = false; if (state.targetMesh) recomposeRetex(); } // quitte l'édition N&B -> restaure la couleur
    if (!isRetex && _reliefMaskEdit) exitReliefMaskEdit(state.targetMesh); // idem pour le masque relief
    refreshBoolTargets(); // section booléens visible seulement dans l'outil « Autres »
    updateCaptureFrame(isRetex);
    updateTexturePreview(isRetex);
    if (isRetex) renderRetexLayers();
    if (isMask && state.targetMesh) {
      ensureMask(state.targetMesh.geometry, state.targetMesh.material);
      const b = state.targetMesh.geometry.userData.maskBlur || 0;
      document.getElementById('maskblur-range').value = b;
      document.getElementById('maskblur-val').textContent = b;
    }
  });
}); // <- fin du toolButtons.forEach (sinon les listeners ci-dessous seraient liés 1×/bouton)
applyToolVisibility(state.params.tool || 'draw'); // état initial : n'affiche que les options de l'outil courant

// ---------- Vertex Paint : palette (pipette) + apply-from-texture + export 3MF MMU ----------
let _vpSel = 0;          // index de la couleur active dans la palette du mesh
let _vpPipette = false;  // mode pipette : le clic prélève au lieu de peindre

// Curseur « pipette » (SVG inline) pointe cyan, hotspot sur la pointe bas-gauche.
const PIPETTE_CURSOR = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2322d3ee' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m19 4-1-1a2 2 0 0 0-3 0l-8 8 4 4 8-8a2 2 0 0 0 0-3z'/><path d='m11 9-6 6'/><path d='m5 15-2 4 4-2'/></svg>\") 2 22, crosshair";
// Indicateur visuel du mode courant (pipette vs peinture) : bouton pipette surligné + libellé + curseur souris.
function updateVPModeUI() {
  const pip = document.getElementById('vp-pipette');
  if (pip) { pip.classList.toggle('active', _vpPipette); pip.textContent = _vpPipette ? '🎯 Pipette ●' : '🎯 Pipette'; }
  dom.style.cursor = (state.params.tool === 'vertexpaint' && _vpPipette) ? PIPETTE_CURSOR : '';
  const md = document.getElementById('vp-mode');
  if (md) {
    md.textContent = _vpPipette ? '🎯 Mode PIPETTE — clique sur le modèle pour prélever une couleur.' : '🖌️ Mode PEINTURE — clique pour peindre la couleur active.';
    md.style.background = _vpPipette ? '#0e3a42' : '#1a2e17';
    md.style.color = _vpPipette ? '#22d3ee' : '#9be29b';
  }
}

function renderVPPalette() {
  const box = document.getElementById('vp-palette'); if (!box) return; box.innerHTML = '';
  const mesh = state.targetMesh;
  if (!mesh) { box.innerHTML = '<div style="font-size:11px;color:#888;">Charge un objet.</div>'; return; }
  const pal = getPalette(mesh);
  if (!pal.length) { box.innerHTML = '<div style="font-size:11px;color:#888;">Palette vide — 🎯 pipette sur le modèle, ou « + ».</div>'; return; }
  if (_vpSel >= pal.length) _vpSel = pal.length - 1;
  pal.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'obj-row' + (i === _vpSel ? ' active' : '');
    const slot = document.createElement('span'); slot.textContent = String(i + 1); slot.title = 'Slot MMU'; slot.style.cssText = 'width:16px;text-align:center;font-size:11px;color:#9a9ac0;';
    const sw = document.createElement('input'); sw.type = 'color'; sw.value = rgbToHex(c.r, c.g, c.b); sw.title = 'Modifier la couleur'; sw.style.cssText = 'width:28px;height:22px;padding:0;border:none;background:none;cursor:pointer;';
    // Modifier une couleur de palette recolore TOUS les vertex qui portaient l'ancienne couleur.
    sw.oninput = () => {
      const rgb = hexToRgb(sw.value);
      const mesh = state.targetMesh, col = mesh && mesh.geometry.attributes.color;
      if (col) {
        const arr = col.array, oR = c.r, oG = c.g, oB = c.b, eps = 0.6 / 255;
        for (let p = 0; p < arr.length; p += 3) {
          if (Math.abs(arr[p] - oR) < eps && Math.abs(arr[p + 1] - oG) < eps && Math.abs(arr[p + 2] - oB) < eps) { arr[p] = rgb.r; arr[p + 1] = rgb.g; arr[p + 2] = rgb.b; }
        }
        col.needsUpdate = true; markDirty();
      }
      c.r = rgb.r; c.g = rgb.g; c.b = rgb.b; name.textContent = sw.value; // c mis à jour -> le prochain input télescope
    };
    const name = document.createElement('span'); name.textContent = rgbToHex(c.r, c.g, c.b); name.className = 'obj-name'; name.style.cssText = 'font-size:11px;cursor:pointer;'; name.onclick = () => { _vpSel = i; renderVPPalette(); };
    const up = document.createElement('button'); up.className = 'obj-btn'; up.textContent = '↑'; up.title = 'Monter (ordre des slots)';
    up.onclick = () => { if (i > 0) { const t = pal[i - 1]; pal[i - 1] = pal[i]; pal[i] = t; if (_vpSel === i) _vpSel = i - 1; else if (_vpSel === i - 1) _vpSel = i; renderVPPalette(); } };
    const del = document.createElement('button'); del.className = 'obj-btn'; del.textContent = '🗑'; del.title = 'Supprimer';
    del.onclick = () => { pal.splice(i, 1); if (_vpSel >= pal.length) _vpSel = Math.max(0, pal.length - 1); renderVPPalette(); };
    row.append(slot, sw, name, up, del);
    box.appendChild(row);
  });
}

function vpPick(hit) {
  const mesh = state.targetMesh; if (!mesh) return;
  const c = eyedropSample(mesh, hit);
  const pal = getPalette(mesh); pal.push({ r: c.r, g: c.g, b: c.b }); _vpSel = pal.length - 1;
  renderVPPalette();
  setStatus(`Couleur prélevée ${rgbToHex(c.r, c.g, c.b)} → slot ${pal.length}.`);
}

// Maintien « i » : pique la couleur sous le curseur et SÉLECTIONNE la couleur de palette la plus proche
// (bascule la couleur active, sans en ajouter). En peinture, la surface montre les couleurs peintes
// (vcflat) -> on échantillonne la couleur du sommet, sinon la texture.
function vpPickSelect(hit) {
  const mesh = state.targetMesh; if (!mesh) return;
  const pal = getPalette(mesh); if (!pal.length) { setStatus('Palette vide.'); return; }
  const col = mesh.geometry.attributes.color;
  let c;
  if (col && hit && hit.face) { const v3 = hit.face.a * 3; c = { r: col.array[v3], g: col.array[v3 + 1], b: col.array[v3 + 2] }; }
  else c = eyedropSample(mesh, hit);
  const idx = nearestPaletteIndex(c.r, c.g, c.b, pal);
  if (idx >= 0 && idx !== _vpSel) { _vpSel = idx; renderVPPalette(); setStatus(`Couleur active : slot ${idx + 1} (${rgbToHex(pal[idx].r, pal[idx].g, pal[idx].b)}).`); }
}
let _vpKeyPick = false; // « i » maintenu : pipette de sélection continue (appui + déplacement)
window.addEventListener('keydown', (e) => {
  if ((e.key !== 'i' && e.key !== 'I') || e.repeat) return;
  if (state.params.tool !== 'vertexpaint' || _vpPipette) return;
  const tag = (e.target && e.target.tagName) || ''; if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  _vpKeyPick = true; dom.style.cursor = PIPETTE_CURSOR; hideBrushCursor();
  const hit = raycastSurface(); if (hit) vpPickSelect(hit); // pique tout de suite à la position courante
});
window.addEventListener('keyup', (e) => {
  if (e.key !== 'i' && e.key !== 'I' || !_vpKeyPick) return;
  _vpKeyPick = false; dom.style.cursor = _vpPipette ? PIPETTE_CURSOR : '';
});

{
  const pipBtn = document.getElementById('vp-pipette');
  // Bascule pipette : la pipette va de pair avec l'affichage TEXTURE (voir les couleurs à prélever) ;
  // la peinture avec l'affichage VERTEX COLOR à plat. On bascule donc aussi le mode d'affichage.
  if (pipBtn) pipBtn.addEventListener('click', () => {
    const mesh = state.targetMesh;
    _vpPipette = !_vpPipette;
    if (_vpPipette) { if (state.params.displayMode !== 'texture') setDisplayMode('texture'); }
    else if (mesh) { ensureColorAttr(mesh); if (state.params.displayMode !== 'vcflat') setDisplayMode('vcflat'); }
    updateVPModeUI();
  });
  const addBtn = document.getElementById('vp-add');
  if (addBtn) addBtn.addEventListener('click', () => { const mesh = state.targetMesh; if (!mesh) return; getPalette(mesh).push({ r: 0.8, g: 0.8, b: 0.8 }); _vpSel = getPalette(mesh).length - 1; renderVPPalette(); });
  const applyBtn = document.getElementById('vp-apply');
  if (applyBtn) applyBtn.addEventListener('click', () => {
    const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
    const n = applyPaletteFromTexture(mesh);
    if (n < 0) { setStatus('Requiert : palette non vide + une texture + des UV.'); return; }
    mesh.userData._vpPainted = true;                 // désormais peint -> ré-entrée en mode peinture
    _vpPipette = false;                              // sortie du mode pipette
    setDisplayMode('vcflat');                        // affichage vertex color à plat
    updateVPModeUI(); markDirty();
    setStatus(`Couleurs appliquées depuis la texture (${n.toLocaleString('fr-FR')} sommets quantifiés). Mode peinture.`);
  });
  const expBtn = document.getElementById('vp-export');
  if (expBtn) expBtn.addEventListener('click', async () => {
    const mesh = state.targetMesh; if (!mesh) { setStatus('Aucun objet.'); return; }
    try {
      showLoading(true, 'Export 3MF (MMU)…');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const blob = await buildVertexPaint3MF(mesh);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (mesh.name || 'vertexpaint') + '.3mf'; a.click(); URL.revokeObjectURL(a.href);
      setStatus('Export 3MF (segmentation MMU) téléchargé.');
    } catch (err) { console.error(err); setStatus(`Export 3MF : ${err.message}`); }
    finally { showLoading(false); }
  });
}

// ---------- Bones : panneau (affichage squelette + lecture/import d'animations) ----------
let _bonesScrubbing = false;
function bonesTarget() { const m = state.targetMesh; return (m && isRig(m)) ? m : null; }
function renderBonesPanel() {
  const empty = document.getElementById('bones-empty'), ctrls = document.getElementById('bones-controls');
  if (!empty || !ctrls) return;
  const obj = bonesTarget();
  if (!obj) { empty.style.display = ''; ctrls.style.display = 'none'; return; }
  empty.style.display = 'none'; ctrls.style.display = 'flex';
  const rig = rigOf(obj);
  const skel = document.getElementById('bones-skel'); if (skel) skel.checked = rig.helper ? rig.helper.visible : true;
  syncBonesModeUI();
  const listBox = document.getElementById('bones-anim-list'); listBox.innerHTML = '';
  const rt = rig.retarget;
  if (!rig.animations.length && !(rt && rt.animations.length)) listBox.innerHTML = '<div style="font-size:11px;color:#888;">Aucune animation — importe un GLB/FBX ci-dessous.</div>';
  // Animations embarquées (lecture directe).
  rig.animations.forEach((clip, i) => {
    const b = document.createElement('div'); b.className = 'obj-row' + (!rig.retargeting && i === rig.clipIndex ? ' active' : '');
    b.style.cssText = 'font-size:11px;cursor:pointer;';
    b.textContent = `▶ ${clip.name || 'clip ' + (i + 1)} (${(clip.duration || 0).toFixed(1)}s)`;
    b.onclick = () => { disposeRetarget(rig); playClip(obj, i); renderBonesPanel(); };
    listBox.appendChild(b);
  });
  // Animations retargetées (mapping d'os).
  if (rt && rt.animations.length) rt.animations.forEach((clip, i) => {
    const b = document.createElement('div'); b.className = 'obj-row' + (rig.retargeting && i === rt.clipIndex ? ' active' : '');
    b.style.cssText = 'font-size:11px;cursor:pointer;';
    b.textContent = `🔗 ${clip.name || 'clip ' + (i + 1)} (${(clip.duration || 0).toFixed(1)}s)`;
    b.title = 'Animation retargetée (mapping d’os)';
    b.onclick = () => { playRetargetClip(obj, i); renderBonesPanel(); };
    listBox.appendChild(b);
  });
  updateBonesTimeUI();
}
function updateBonesTimeUI() {
  const scrub = document.getElementById('bones-scrub'); if (!scrub) return;
  const obj = bonesTarget(); const info = obj ? clipInfo(obj) : null;
  const lbl = document.getElementById('bones-time'), play = document.getElementById('bones-play');
  if (info) {
    if (!_bonesScrubbing) scrub.value = String(Math.round((info.time / (info.duration || 1)) * 1000));
    if (lbl) lbl.textContent = `${info.time.toFixed(2)} / ${info.duration.toFixed(2)}`;
    if (play) play.textContent = info.playing ? '⏸️ Pause' : '⏯️ Play';
  } else { scrub.value = '0'; if (lbl) lbl.textContent = '0.00 / 0.00'; if (play) play.textContent = '⏯️ Play'; }
}
// --- UI d'édition de pose (liste hiérarchique + schéma SVG + rotations), calquée sur GLB-Bones-editor ---
function renderPoseList() {
  const box = document.getElementById('bones-bone-list'); if (!box) return; box.innerHTML = '';
  const bones = poseBones(); if (!bones.length) { box.innerHTML = '<div style="color:#888;">Aucun os</div>'; return; }
  const idxOf = new Map(); bones.forEach((b, i) => idxOf.set(b, i));
  const roots = bones.filter((b) => { let p = b.parent; while (p) { if (idxOf.has(p)) return false; p = p.parent; } return true; });
  const add = (bone, depth) => {
    const i = idxOf.get(bone); if (i === undefined) return;
    const twist = isTwistBone(bone);
    const row = document.createElement('div');
    row.className = 'bone-item' + (i === selectedIndex() ? ' active' : '');
    row.dataset.index = String(i);
    row.style.cssText = `padding:2px 4px; padding-left:${4 + depth * 12}px; cursor:pointer; color:${twist ? '#888' : (i === selectedIndex() ? '#ffd23f' : '#cfd')}; border-radius:3px;` + (i === selectedIndex() ? 'background:#243;' : '');
    row.textContent = (twist ? '↻ ' : '') + (bone.name || `Bone ${i + 1}`);
    row.title = twist ? 'Os Twist — sélectionnable ici, pas au clic souris (rotation Y seule)' : bone.name;
    row.onclick = () => selectByIndex(i); // twist inclus : sélection via la liste autorisée
    box.appendChild(row);
    bone.children.forEach((c) => { if (c.isBone && idxOf.has(c)) add(c, depth + 1); });
  };
  roots.forEach((r) => add(r, 0));
}
function syncPoseRotUI(index) {
  const rot = document.getElementById('bones-rot');
  const name = document.getElementById('bones-sel-name');
  const bone = index >= 0 ? poseBones()[index] : null;
  if (!bone) { if (rot) rot.style.display = 'none'; if (name) name.textContent = 'Aucun os sélectionné'; return; }
  if (name) name.textContent = bone.name || `Bone ${index + 1}`;
  if (rot) rot.style.display = 'flex';
  const d = (a) => Math.round(THREE.MathUtils.radToDeg(bone.rotation[a]));
  for (const a of ['x', 'y', 'z']) { const s = document.getElementById('pose-rot-' + a), v = document.getElementById('pose-rot-' + a + '-v'); if (s) s.value = String(d(a)); if (v) v.textContent = String(d(a)); }
}
// Surlignage partagé (liste + schéma) + auto-scroll. Léger (appelé aussi pendant le drag du gizmo).
let _lastPoseScroll = -1;
function highlightBone(index) {
  const bones = poseBones();
  let selRow = null;
  document.querySelectorAll('#bones-bone-list .bone-item').forEach((row) => {
    const i = parseInt(row.dataset.index), sel = i === index, twist = bones[i] && isTwistBone(bones[i]);
    row.style.background = sel ? '#243' : ''; row.style.color = sel ? '#ffd23f' : (twist ? '#888' : '#cfd');
    if (sel) selRow = row;
  });
  if (selRow && index !== _lastPoseScroll) selRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  _lastPoseScroll = index;
  const selName = index >= 0 ? (bones[index].name || '') : '';
  document.querySelectorAll('#bones-bone-schema .bone-node').forEach((n) => n.setAttribute('fill', n.dataset.bone === selName ? '#ffd23f' : '#4a9aff'));
  const nm = document.getElementById('bones-sel-name'); if (nm) nm.textContent = index >= 0 ? (selName || `Bone ${index + 1}`) : 'Aucun os sélectionné';
}
// Sélection en mode POSE : surlignage + sliders de rotation.
function onPoseSelect(index) { highlightBone(index); syncPoseRotUI(index); }
// Sélection en mode WEIGHT PAINT : surlignage + définit l'os cible + rafraîchit la heatmap.
function onWeightSelect(index) { highlightBone(index); setPaintBone(index >= 0 ? poseBones()[index] : null); }

// Rayon du pinceau weight paint : MÊME zone d'influence que le sculpt (fraction d'écran state.params.sizeFrac,
// donc réglable au slider Taille ET à la touche X, et constante à l'écran quel que soit le zoom).
function wpWorldRadius(worldPoint) { return screenWorldRadius(worldPoint, state.params.sizeFrac); }

// Affiche le cercle d'influence au point `hit` en calant le rayon monde sur sizeFrac. En weight paint,
// on oriente le cercle sur la normale de la face touchée (comme les brosses de sculpt).
function showInfluenceCursor(hit) {
  if (!hit) { hideBrushCursor(); return; }
  syncBrushRadius(hit.point);
  if (isWeightPaintActive()) updateBrushCursor(hit, true, true, state.params.size, hit.face ? hit.face.normal : null);
  else updateBrushCursor(hit);
}

// Affiche/masque les blocs UI selon le mode bones actif (pose vs weight paint) + rebuild liste.
function syncBonesModeUI() {
  const weight = isWeightPaintActive(), pose = isPoseActive() && !weight, sel = pose || weight;
  const g = (id) => document.getElementById(id);
  if (g('bones-sel-ui')) g('bones-sel-ui').style.display = sel ? 'flex' : 'none';
  if (g('bones-pose-only')) g('bones-pose-only').style.display = pose ? 'flex' : 'none';
  if (g('bones-weight-only')) g('bones-weight-only').style.display = weight ? 'flex' : 'none';
  if (weight) syncWpRadiusUI(); // le slider Rayon reflète sizeFrac (partagé avec le sculpt)
  if (g('bones-pose')) g('bones-pose').classList.toggle('active', pose);
  if (g('bones-weight')) g('bones-weight').classList.toggle('active', weight);
  if (sel) { renderPoseList(); highlightBone(selectedIndex()); if (pose) syncPoseRotUI(selectedIndex()); }
}

{
  const skel = document.getElementById('bones-skel');
  if (skel) skel.addEventListener('change', () => { const o = bonesTarget(); if (o) toggleSkeleton(o, skel.checked); });
  const play = document.getElementById('bones-play');
  if (play) play.addEventListener('click', () => {
    const o = bonesTarget(); if (!o) return; const rig = rigOf(o);
    const act = rig.retargeting && rig.retarget ? rig.retarget.action : rig.action;
    if (act) setPlaying(o, !rig.playing);
    else if (rig.animations.length) playClip(o, 0);
    else if (rig.retarget && rig.retarget.animations.length) playRetargetClip(o, 0);
    updateBonesTimeUI();
  });
  const stop = document.getElementById('bones-stop');
  if (stop) stop.addEventListener('click', () => { const o = bonesTarget(); if (o) { stopClip(o); renderBonesPanel(); } });
  const scrub = document.getElementById('bones-scrub');
  if (scrub) {
    scrub.addEventListener('pointerdown', () => { _bonesScrubbing = true; });
    scrub.addEventListener('input', () => { const o = bonesTarget(); const info = o && clipInfo(o); if (info) seekClip(o, (scrub.value / 1000) * info.duration); updateBonesTimeUI(); });
    const end = () => { _bonesScrubbing = false; };
    scrub.addEventListener('pointerup', end); scrub.addEventListener('change', end);
  }
  const poseBtn = document.getElementById('bones-pose'), weightBtn = document.getElementById('bones-weight');
  // Pose et Weight sont les DEUX seuls modes de Bones (pas d'état « rien »). Cliquer Pose (re)active la
  // pose ; ne la désactive jamais tant qu'on reste dans Bones (on sort de la pose seulement en quittant
  // Bones ou en passant en Weight).
  if (poseBtn) poseBtn.addEventListener('click', () => {
    const o = bonesTarget(); if (!o) return;
    if (isPoseActive() && !isWeightPaintActive()) return; // déjà en pose
    const sel = selectedIndex(); // conserve l'os sélectionné au changement de mode
    exitWeightPaint(); enterPose(o, onPoseSelect); if (sel >= 0) selectByIndex(sel);
    setStatus('Pose : clique un os (3D, liste ou schéma) puis tourne/décale. Reclic = os empilé suivant.');
    syncBonesModeUI();
  });
  if (weightBtn) weightBtn.addEventListener('click', () => {
    const o = bonesTarget(); if (!o) return;
    if (isWeightPaintActive()) return; // déjà en weight paint
    const sel = selectedIndex();
    exitPose(); enterPose(o, onWeightSelect, { noGizmo: true }); enterWeightPaint(o); if (sel >= 0) selectByIndex(sel);
    setStatus('Weight paint : clique un os cible, peins sur le mesh (Alt = retirer). La pose est conservée.');
    syncBonesModeUI();
  });
  const poseReset = document.getElementById('bones-pose-reset');
  if (poseReset) poseReset.addEventListener('click', () => { const o = bonesTarget(); if (!o) return; if (isPoseActive()) resetPose(); else resetRigPose(o); if (isWeightPaintActive()) refreshWeights(); setStatus('Pose / skin réinitialisés.'); });
  // Bascule liste / schéma
  const listBtn = document.getElementById('bones-list-btn'), schemaBtn = document.getElementById('bones-schema-btn');
  const listBox = document.getElementById('bones-bone-list'), schemaBox = document.getElementById('bones-bone-schema');
  if (listBtn) listBtn.addEventListener('click', () => { listBox.style.display = ''; schemaBox.style.display = 'none'; listBtn.classList.add('active'); schemaBtn.classList.remove('active'); });
  if (schemaBtn) schemaBtn.addEventListener('click', () => { listBox.style.display = 'none'; schemaBox.style.display = ''; schemaBtn.classList.add('active'); listBtn.classList.remove('active'); });
  // Clic sur le schéma SVG -> sélectionne l'os par nom (ignore les Twist non listés).
  if (schemaBox) schemaBox.addEventListener('click', (e) => {
    const node = e.target.closest('[data-bone]'); if (!node) return;
    const bones = poseBones(); const i = bones.findIndex((b) => b.name === node.dataset.bone);
    if (i >= 0) selectByIndex(i);
  });
  // Bascule gizmo rotation (pose) / translation (offset de joint).
  const grot = document.getElementById('bones-gizmo-rot'), gtr = document.getElementById('bones-gizmo-tr');
  if (grot) grot.addEventListener('click', () => { setGizmoMode('rotate'); grot.classList.add('active'); gtr.classList.remove('active'); });
  if (gtr) gtr.addEventListener('click', () => { setGizmoMode('translate'); gtr.classList.add('active'); grot.classList.remove('active'); });
  // Sliders de rotation de l'os sélectionné.
  for (const a of ['x', 'y', 'z']) {
    const s = document.getElementById('pose-rot-' + a);
    if (s) s.addEventListener('input', () => {
      const b = selectedBone(); if (!b) return;
      b.rotation[a] = THREE.MathUtils.degToRad(parseFloat(s.value));
      const v = document.getElementById('pose-rot-' + a + '-v'); if (v) v.textContent = s.value;
      b.updateMatrixWorld();
      markPoseDirty(state.targetMesh);
    });
  }
  // Sélection d'os en mode pose (capture : avant OrbitControls) — clic sur un marqueur = pas d'orbite.
  dom.addEventListener('pointerdown', (e) => {
    if (state.params.tool !== 'bones' || !isPoseActive() || isWeightPaintActive() || e.button !== 0 || isRenderMode()) return;
    setMouseFromEvent(e);
    if (pickBoneAtMouse(true)) state.controls.enabled = false; // twists cliquables, mais 1er clic = os normal (cyclage ensuite)
  }, true);
  dom.addEventListener('pointerup', () => { if (state.params.tool === 'bones' && isPoseActive() && !isWeightPaintActive()) state.controls.enabled = true; });

  // ---- Weight paint : sélection d'os cible (marqueur) OU peinture sur le mesh (drag) ----
  let _wpPainting = false, _wpErase = false, _wpPt = null, _wpSched = false;
  // Force 0..2 (bien plus douce qu'avant) -> delta par frame ≈ valeur × 0.05.
  const wpStrength = () => (parseFloat(document.getElementById('bones-wp-strength').value) || 0) * 0.05;
  const pushSkin = (rec) => { if (rec) pushAction(() => applySkinRecord(rec, false), () => applySkinRecord(rec, true)); };
  function wpFrame() { _wpSched = false; if (!_wpPainting || !_wpPt) return; wpPaintAt(_wpPt, wpWorldRadius(_wpPt), wpStrength(), _wpErase); _wpPt = null; }
  function wpSchedule() { if (!_wpSched) { _wpSched = true; requestAnimationFrame(wpFrame); } }
  dom.addEventListener('pointerdown', (e) => {
    if (state.params.tool !== 'bones' || !isWeightPaintActive() || e.button !== 0 || isRenderMode()) return;
    setMouseFromEvent(e);
    if (pickBoneAtMouse(true)) { state.controls.enabled = false; return; } // marqueur -> os cible (cyclage twists inclus)
    const hit = wpPickPoint(state.mouse); if (!hit) return; // raycast la surface POSÉE (proxy)
    _wpPainting = true; _wpErase = e.altKey || e.ctrlKey || e.metaKey; state.controls.enabled = false;
    beginWeightStroke(); // undo
    try { dom.setPointerCapture(e.pointerId); } catch (_) {}
    _wpPt = hit.point.clone(); wpSchedule();
  }, true);
  dom.addEventListener('pointermove', (e) => {
    if (!_wpPainting) return; setMouseFromEvent(e); const hit = wpPickPoint(state.mouse); if (hit) { _wpPt = hit.point.clone(); wpSchedule(); }
  });
  const wpEnd = (e) => {
    if (state.params.tool === 'bones' && isWeightPaintActive()) state.controls.enabled = true; // réactive l'orbite (y compris après un clic de sélection d'os)
    if (!_wpPainting) return;
    _wpPainting = false;
    if (e && e.pointerId !== undefined) { try { dom.releasePointerCapture(e.pointerId); } catch (_) {} }
    pushSkin(endWeightStroke());
  };
  dom.addEventListener('pointerup', wpEnd); dom.addEventListener('pointercancel', wpEnd);
  const wpRad = document.getElementById('bones-wp-radius');
  if (wpRad) wpRad.addEventListener('input', () => setBrushSize(parseFloat(wpRad.value))); // pilote la MÊME zone d'influence (sizeFrac)
  const wpStr = document.getElementById('bones-wp-strength');
  if (wpStr) wpStr.addEventListener('input', () => { document.getElementById('bones-wp-strength-v').textContent = wpStr.value; });
  const wpSmoothBtn = document.getElementById('bones-wp-smooth');
  if (wpSmoothBtn) wpSmoothBtn.addEventListener('click', () => { beginWeightStroke(); wpSmooth(); pushSkin(endWeightStroke()); setStatus('Poids lissés.'); });

  const retInput = document.getElementById('bones-retarget-input');
  if (retInput) retInput.addEventListener('change', async (e) => {
    const o = bonesTarget(); const file = e.target.files && e.target.files[0]; if (!o || !file) { return; }
    showLoading(true, 'Import + retarget…');
    try {
      const n = await loadRetargetSource(o, file);
      if (n) { playRetargetClip(o, 0); setStatus(`${n} animation(s) retargetée(s) — mapping d’os appliqué.`); }
      else setStatus('Aucune animation dans ce fichier.');
      renderBonesPanel();
    } catch (err) { console.error(err); setStatus(`Retarget : ${err.message}`); }
    finally { showLoading(false); e.target.value = ''; }
  });
}

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
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    try {
      const res = splitByMask(mesh.geometry, maskSrc, 0.5, state.params.cutDetail);
      if (!res) { setStatus('Rien à séparer (masque vide, total, ou sans frontière nette).'); return; }
      await maybeAddConnectors(res, mesh.geometry); // tenons/mortaises si l'option est cochée
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
bindSlider('size-range', 'size-num', 'sizeFrac', (v) => v.toFixed(3)); // le slider règle la fraction d'écran (state.params.size est dérivé par coup)

// ---------- Mode Rendu : réglages (l'entrée/sortie du mode est gérée par l'outil 'render') ----------
{
  const rangeVal = (id, vid, fn, fmt) => { const r = document.getElementById(id), v = document.getElementById(vid); if (r) r.addEventListener('input', () => { const x = parseFloat(r.value); fn(x); if (v) v.textContent = fmt(x); }); };
  rangeVal('render-ambient', 'render-ambient-v', setAmbient, (x) => x.toFixed(1));
  rangeVal('render-ao', 'render-ao-v', setAOStrength, (x) => x.toFixed(2));
  rangeVal('render-ao-radius', 'render-ao-radius-v', setAORadius, (x) => x.toFixed(3));
  rangeVal('render-shadow-op', 'render-shadow-op-v', setShadowOpacity, (x) => x.toFixed(2));
  rangeVal('render-self-shadow', 'render-self-shadow-v', setSelfShadow, (x) => x.toFixed(2));
  rangeVal('render-contact-blur', 'render-contact-blur-v', setContactBlur, (x) => String(Math.round(x)));
  rangeVal('render-cast-blur', 'render-cast-blur-v', setCastBlur, (x) => String(Math.round(x)));
  rangeVal('render-shadow-az', 'render-shadow-az-v', setShadowAzimuth, (x) => Math.round(x) + '°');
  rangeVal('render-shadow-el', 'render-shadow-el-v', setShadowElevation, (x) => Math.round(x) + '°');
  const ms = document.getElementById('render-model-shadows');
  if (ms) ms.addEventListener('change', () => setModelShadows(ms.checked));
  const cs = document.getElementById('render-contact-shadow');
  if (cs) cs.addEventListener('change', () => setContactShadow(cs.checked));
  const ps = document.getElementById('render-proj-shadow');
  if (ps) ps.addEventListener('change', () => setProjShadow(ps.checked));
  const gi = document.getElementById('render-gi');
  if (gi) gi.addEventListener('change', () => setGI(gi.checked));
  // Synchronise l'UI sur les réglages restaurés du localStorage.
  const p = renderModeParams();
  const setUI = (id, vid, val, fmt) => { const r = document.getElementById(id), v = document.getElementById(vid); if (r) r.value = val; if (v) v.textContent = fmt(val); };
  setUI('render-ambient', 'render-ambient-v', p.ambient, (x) => x.toFixed(1));
  setUI('render-ao', 'render-ao-v', p.ao, (x) => x.toFixed(2));
  setUI('render-ao-radius', 'render-ao-radius-v', p.aoRadius, (x) => x.toFixed(3));
  setUI('render-shadow-op', 'render-shadow-op-v', p.shadowOpacity, (x) => x.toFixed(2));
  setUI('render-self-shadow', 'render-self-shadow-v', p.selfShadow, (x) => x.toFixed(2));
  setUI('render-contact-blur', 'render-contact-blur-v', p.contactBlur, (x) => String(Math.round(x)));
  setUI('render-cast-blur', 'render-cast-blur-v', p.castBlur, (x) => String(Math.round(x)));
  setUI('render-shadow-az', 'render-shadow-az-v', p.azimuth, (x) => Math.round(x) + '°');
  setUI('render-shadow-el', 'render-shadow-el-v', p.elevation, (x) => Math.round(x) + '°');
  if (ms) ms.checked = p.modelShadows;
  if (cs) cs.checked = p.contactShadow;
  if (ps) ps.checked = p.projShadow;
  if (gi) gi.checked = p.gi;
}

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
{ const sc = document.getElementById('split-connectors'); if (sc) sc.addEventListener('change', () => { state.params.splitConnectors = sc.checked; }); }
{
  const LS = 'sculpt-symmetry';
  try { const s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s) { if (s.symmetry) Object.assign(state.params.symmetry, s.symmetry); if (s.space) state.params.symmetrySpace = s.space; if (s.planes !== undefined) state.params.symmetryShowPlanes = s.planes; } } catch (_) { /* corrompu */ }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify({ symmetry: state.params.symmetry, space: state.params.symmetrySpace, planes: state.params.symmetryShowPlanes })); } catch (_) { /* quota/privé */ } };
  document.querySelectorAll('.sym-axis').forEach((b) => {
    const ax = b.dataset.axis;
    b.classList.toggle('active', !!state.params.symmetry[ax]);
    b.addEventListener('click', () => { state.params.symmetry[ax] = !state.params.symmetry[ax]; b.classList.toggle('active', state.params.symmetry[ax]); save(); });
  });
  const spaceBtns = document.querySelectorAll('.sym-space button');
  spaceBtns.forEach((b) => {
    b.classList.toggle('active', b.dataset.space === state.params.symmetrySpace);
    b.addEventListener('click', () => { state.params.symmetrySpace = b.dataset.space; spaceBtns.forEach((x) => x.classList.toggle('active', x === b)); save(); });
  });
  const planesBtn = document.getElementById('sym-planes');
  if (planesBtn) {
    planesBtn.classList.toggle('active', state.params.symmetryShowPlanes);
    planesBtn.addEventListener('click', () => { state.params.symmetryShowPlanes = !state.params.symmetryShowPlanes; planesBtn.classList.toggle('active', state.params.symmetryShowPlanes); save(); });
  }
  // Édition du plan de symétrie local (gizmo). Uniquement en espace Local, sur l'objet actif.
  const editBtn = document.getElementById('sym-edit'), editTools = document.getElementById('sym-edit-tools');
  const syncSymEditUI = () => { const on = isSymEditing(); if (editBtn) editBtn.classList.toggle('active', on); if (editTools) editTools.style.display = on ? 'flex' : 'none'; };
  window.exitSymEditUI = () => { if (isSymEditing()) { exitSymEdit(); syncSymEditUI(); } }; // appelé quand on quitte le sculpt
  if (editBtn) editBtn.addEventListener('click', () => {
    if (isSymEditing()) { exitSymEdit(); }
    else {
      if (state.params.symmetrySpace !== 'local') { setStatus('Édition du plan : passe d’abord en symétrie « Local ».'); return; }
      if (!state.targetMesh) return;
      enterSymEdit(state.targetMesh); setSymGizmoMode('translate');
      const t = editTools && editTools.querySelector('[data-symgz="translate"]'); editTools && editTools.querySelectorAll('[data-symgz]').forEach((x) => x.classList.toggle('active', x === t));
    }
    syncSymEditUI();
  });
  if (editTools) editTools.querySelectorAll('[data-symgz]').forEach((b) => b.addEventListener('click', () => {
    setSymGizmoMode(b.dataset.symgz); editTools.querySelectorAll('[data-symgz]').forEach((x) => x.classList.toggle('active', x === b));
  }));
  const resetBtn = document.getElementById('sym-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => { if (state.targetMesh) resetSymFrame(state.targetMesh); });
}
document.getElementById('wireframe-check').addEventListener('change', (e) => {
  state.params.displayHelper = e.target.checked;
  refreshWireframe();
});

// ---------- Redimensionnement ----------

window.addEventListener('resize', () => {
  state.camera.aspect = window.innerWidth / window.innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(window.innerWidth, window.innerHeight);
  renderModeResize();
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
  if (t === 'split' || t === 'gizmo' || t === 'move' || t === 'other') return; // sans objet de brush
  if (t === 'bones' && !isWeightPaintActive()) return; // en pose : pas de pinceau
  radiusMode = true;
  radiusStartX = lastClientX;
  radiusStartSize = state.params.sizeFrac; // on règle la FRACTION d'écran
  radiusAnchor = isWeightPaintActive() ? wpPickPoint(state.mouse) : raycastSurface(); // point figé sous le curseur (proxy posé en weight paint)
  state.controls.enabled = false;
  if (radiusAnchor) { state.brushMesh.visible = true; showInfluenceCursor(radiusAnchor); }
  setStatus(`Taille : ${state.params.sizeFrac.toFixed(3)} — bouge la souris, relâche X`);
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
  updateRigs(); // met à jour les mixers d'animation des objets riggés en lecture
  if (isPoseActive()) updatePoseMarkers(); // les marqueurs d'os suivent la pose
  if (state.params.tool === 'bones') updateBonesTimeUI(); // scrub/temps suivent la lecture
  { const symActive = !isRenderMode() && (SCULPT_TOOLS.has(state.params.tool) || state.params.tool === 'vertexpaint' || state.params.tool === 'mask');
    if (isSymEditing() && (!symActive || state.params.symmetrySpace !== 'local' || state.targetMesh !== symEditMesh())) window.exitSymEditUI && window.exitSymEditUI();
    updateSymmetryHelper(symActive); updateSymmetryCursor(symActive); } // plans + curseurs miroir

  const now = performance.now();
  const frame = now - perf.lastT;
  perf.lastT = now;

  const r0 = performance.now();
  if (isRenderMode()) renderModeFrame(); else state.renderer.render(state.scene, state.camera);
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
