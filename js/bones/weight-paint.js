// Mode "Weight Paint" : visualisation des poids par vertex coloring,
// brush qui ajoute/retire de l'influence d'un bone sur les vertex sous le pinceau,
// avec re-normalisation à 1.0 garantie.

import * as THREE from 'three';
import { state } from './state.js';
import { weightToHeatmap } from './utils.js';
import { updateInfo } from './ui.js';
import { attachGizmoTo } from './bones.js';
import { toggleRestPose } from './animation.js';

// ---------- Vertex colors ----------

// ---------- Indexation des vertices par position (groupes de jumeaux) ----------
// Un vertex peut être dupliqué dans le buffer (UV seams, normal splits…). On les
// regroupe par position 3D pour qu'ils soient traités comme UN SEUL vertex en
// weight paint : peindre l'un d'eux applique les mêmes weights à tous ses jumeaux.

function buildVertexGroups(geometry) {
  const posAttr = geometry.attributes.position;
  const count = posAttr.count;
  const positionToGroup = new Map();
  const vertexToGroup = new Int32Array(count);
  const groups = [];

  for (let i = 0; i < count; i++) {
    // Clé : position 3D arrondie à 5 décimales (gère les imprécisions float)
    const key = `${posAttr.getX(i).toFixed(5)}|${posAttr.getY(i).toFixed(5)}|${posAttr.getZ(i).toFixed(5)}`;
    let groupId = positionToGroup.get(key);
    if (groupId === undefined) {
      groupId = groups.length;
      positionToGroup.set(key, groupId);
      groups.push([]);
    }
    groups[groupId].push(i);
    vertexToGroup[i] = groupId;
  }
  return { vertexToGroup, groups };
}

function ensureVertexGroups(mesh) {
  if (!state.vertexGroups.has(mesh.uuid)) {
    state.vertexGroups.set(mesh.uuid, buildVertexGroups(mesh.geometry));
  }
  return state.vertexGroups.get(mesh.uuid);
}

// Propage les 4 slots (skinIndex/skinWeight) du vertex source à tous ses jumeaux
// (vertices avec la même position 3D).
function propagateToVertexGroup(mesh, vertexIdx) {
  const groups = state.vertexGroups.get(mesh.uuid);
  if (!groups) return;
  const groupId = groups.vertexToGroup[vertexIdx];
  const group = groups.groups[groupId];
  if (group.length <= 1) return;
  const W = mesh.geometry.attributes.skinWeight;
  const I = mesh.geometry.attributes.skinIndex;
  const wArr = W.array;
  const iArr = I.array;
  const srcBase = vertexIdx * 4;
  for (const otherIdx of group) {
    if (otherIdx === vertexIdx) continue;
    const dstBase = otherIdx * 4;
    for (let k = 0; k < 4; k++) {
      iArr[dstBase + k] = iArr[srcBase + k];
      wArr[dstBase + k] = wArr[srcBase + k];
    }
  }
}

function ensureColorAttribute(geometry) {
  const posCount = geometry.attributes.position.count;
  let color = geometry.attributes.color;
  if (!color || color.count !== posCount) {
    const arr = new Float32Array(posCount * 3);
    for (let i = 0; i < posCount; i++) {
      arr[i * 3] = 0;
      arr[i * 3 + 1] = 0;
      arr[i * 3 + 2] = 1;
    }
    color = new THREE.BufferAttribute(arr, 3);
    geometry.setAttribute('color', color);
  }
  return color;
}

// ShaderMaterial qui calcule un ombrage indépendant des lumières de la scène :
// on multiplie la vertex color par |normal_view.z|, ce qui donne plus sombre sur
// les bords (faces de profil) et plus clair sur les faces frontales — toujours
// le même résultat quelle que soit l'orientation des lights.
function makeShadingPaintMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    defines: { USE_SKINNING: '' },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>

      attribute vec3 color;
      varying vec3 vColor;
      varying vec3 vNormalView;

      void main() {
        vColor = color;

        vec3 objectNormal = vec3(normal);
        vec3 transformed = vec3(position);

        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <skinning_vertex>

        vNormalView = normalize(normalMatrix * objectNormal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying vec3 vNormalView;

      void main() {
        // Ombrage fixe basé sur l'orientation de la normale par rapport à la caméra.
        // Plus brillant face caméra (vNormalView.z proche de ±1), plus sombre de profil.
        float sh = abs(vNormalView.z) * 0.65 + 0.35;
        gl_FragColor = vec4(vColor * sh, 1.0);
      }
    `,
  });
}

// Récupère (ou crée) le material de paint pour un mesh, en fonction du flag shading.
// Cache : Map<mesh.uuid, { basic: MeshBasicMaterial, lambert: ShaderMaterial }>
function getPaintMaterial(mesh, withShading) {
  let cache = state.paintMaterials.get(mesh.uuid);
  if (!cache || cache.basic === undefined) {
    cache = { basic: null, lambert: null };
    state.paintMaterials.set(mesh.uuid, cache);
  }
  const key = withShading ? 'lambert' : 'basic';
  if (!cache[key]) {
    if (withShading) {
      const geom = mesh.geometry;
      if (!geom.attributes.normal) geom.computeVertexNormals();
      cache[key] = makeShadingPaintMaterial();
    } else {
      cache[key] = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      });
    }
  }
  return cache[key];
}

function swapToPaintMaterials() {
  state.skinnedMeshes.forEach((mesh) => {
    if (!state.originalMaterials.has(mesh.uuid)) {
      state.originalMaterials.set(mesh.uuid, mesh.material);
    }
    ensureColorAttribute(mesh.geometry);
    mesh.material = getPaintMaterial(mesh, state.weightPaintShowShading);
  });
}

function restoreOriginalMaterials() {
  state.skinnedMeshes.forEach((mesh) => {
    const orig = state.originalMaterials.get(mesh.uuid);
    if (orig) mesh.material = orig;
  });
}

// Toggle shading on/off pendant le mode paint : swap chaque material entre cached.
export function setPaintShading(enabled) {
  state.weightPaintShowShading = enabled;
  if (!state.weightPaintMode) return;
  state.skinnedMeshes.forEach((mesh) => {
    mesh.material = getPaintMaterial(mesh, enabled);
  });
}

export function refreshWeightColorsForMesh(mesh) {
  const geom = mesh.geometry;
  const color = ensureColorAttribute(geom);
  const skinIndex = geom.attributes.skinIndex;
  const skinWeight = geom.attributes.skinWeight;
  if (!skinIndex || !skinWeight) return;

  const vertexCount = geom.attributes.position.count;
  const rgb = [0, 0, 0];

  let boneIdx = -1;
  if (state.selectedBone && state.weightPaintMode) {
    boneIdx = mesh.skeleton.bones.indexOf(state.selectedBone);
  }

  // Vertex sélectionnés (mode sélection rectangle) → highlight jaune
  const selected = state.selectedVertexGroups.get(mesh.uuid);
  const vg = state.vertexGroups.get(mesh.uuid);

  for (let i = 0; i < vertexCount; i++) {
    if (selected && vg && selected.has(vg.vertexToGroup[i])) {
      // Jaune vif pour les vertex sélectionnés
      color.setXYZ(i, 1, 1, 0);
      continue;
    }
    let w = 0;
    if (boneIdx >= 0) {
      for (let k = 0; k < 4; k++) {
        if (skinIndex.getComponent(i, k) === boneIdx) {
          w += skinWeight.getComponent(i, k);
        }
      }
    }
    weightToHeatmap(w, rgb);
    color.setXYZ(i, rgb[0], rgb[1], rgb[2]);
  }
  color.needsUpdate = true;
}

export function refreshWeightColors() {
  state.skinnedMeshes.forEach(refreshWeightColorsForMesh);
}

// ---------- Bounding sphere "hack" pour fiabiliser le raycast ----------

function inflateBoundingForRaycast(mesh) {
  const geom = mesh.geometry;
  if (!geom.boundingSphere) geom.computeBoundingSphere();
  if (geom.boundingSphere) geom.boundingSphere.radius = 1e6;
  if (geom.boundingBox) {
    geom.boundingBox.min.set(-1e6, -1e6, -1e6);
    geom.boundingBox.max.set(1e6, 1e6, 1e6);
  }
}

// ---------- Skinning manuel d'un vertex ----------

const _sIdx4 = new THREE.Vector4();
const _sW4 = new THREE.Vector4();
const _basePos = new THREE.Vector3();
const _boneMatT = new THREE.Matrix4();
const _tempV = new THREE.Vector3();

// Équivalent de SkinnedMesh.applyBoneTransform mais robuste aux indices invalides.
function customGetVertexPosition(mesh, idx, target) {
  const skel = mesh.skeleton;
  const geom = mesh.geometry;
  const skinIdxAttr = geom.attributes.skinIndex;
  const skinWAttr = geom.attributes.skinWeight;
  const posAttr = geom.attributes.position;

  if (!skel || !skinIdxAttr || !skinWAttr) {
    target.fromBufferAttribute(posAttr, idx);
    return target;
  }

  _sIdx4.fromBufferAttribute(skinIdxAttr, idx);
  _sW4.fromBufferAttribute(skinWAttr, idx);
  _basePos.fromBufferAttribute(posAttr, idx);
  if (mesh.bindMatrix) _basePos.applyMatrix4(mesh.bindMatrix);

  target.set(0, 0, 0);
  let totalW = 0;
  const bonesLen = skel.bones.length;

  for (let k = 0; k < 4; k++) {
    const w = _sW4.getComponent(k);
    if (!w || !isFinite(w)) continue;
    const bi = _sIdx4.getComponent(k);
    if (bi < 0 || bi >= bonesLen) continue;
    const bone = skel.bones[bi];
    const inv = skel.boneInverses[bi];
    if (!bone || !inv) continue;
    _boneMatT.multiplyMatrices(bone.matrixWorld, inv);
    target.addScaledVector(_tempV.copy(_basePos).applyMatrix4(_boneMatT), w);
    totalW += w;
  }

  if (totalW < 0.001) target.copy(_basePos);
  if (mesh.bindMatrixInverse) target.applyMatrix4(mesh.bindMatrixInverse);
  return target;
}

export function rebuildWorldPositionCache(mesh) {
  const posAttr = mesh.geometry.attributes.position;
  if (!posAttr) return;
  const vc = posAttr.count;
  let arr = state.cachedWorldPositions.get(mesh.uuid);
  if (!arr || arr.length !== vc * 3) {
    arr = new Float32Array(vc * 3);
    state.cachedWorldPositions.set(mesh.uuid, arr);
  }
  const tmp = new THREE.Vector3();
  for (let i = 0; i < vc; i++) {
    customGetVertexPosition(mesh, i, tmp);
    tmp.applyMatrix4(mesh.matrixWorld);
    if (!isFinite(tmp.x) || !isFinite(tmp.y) || !isFinite(tmp.z)) {
      arr[i * 3] = 0; arr[i * 3 + 1] = 0; arr[i * 3 + 2] = 0;
    } else {
      arr[i * 3] = tmp.x; arr[i * 3 + 1] = tmp.y; arr[i * 3 + 2] = tmp.z;
    }
  }
}

// ---------- Raycasting custom contre les SkinnedMesh ----------

const _vRayA = new THREE.Vector3();
const _vRayB = new THREE.Vector3();
const _vRayC = new THREE.Vector3();
const _vRayHit = new THREE.Vector3();

function customRaycastSkinnedMeshes(raycaster) {
  const intersects = [];
  const ray = raycaster.ray;
  for (const mesh of state.skinnedMeshes) {
    const geom = mesh.geometry;
    const indexAttr = geom.index;
    if (!indexAttr) continue;
    const arr = state.cachedWorldPositions.get(mesh.uuid);
    if (!arr) continue;
    const triCount = (indexAttr.count / 3) | 0;
    for (let i = 0; i < triCount; i++) {
      const j = i * 3;
      const a = indexAttr.getX(j), b = indexAttr.getX(j + 1), c = indexAttr.getX(j + 2);
      const a3 = a * 3, b3 = b * 3, c3 = c * 3;
      _vRayA.set(arr[a3], arr[a3 + 1], arr[a3 + 2]);
      _vRayB.set(arr[b3], arr[b3 + 1], arr[b3 + 2]);
      _vRayC.set(arr[c3], arr[c3 + 1], arr[c3 + 2]);
      const result = ray.intersectTriangle(_vRayA, _vRayB, _vRayC, false, _vRayHit);
      if (result) {
        intersects.push({
          distance: ray.origin.distanceTo(_vRayHit),
          point: _vRayHit.clone(),
          object: mesh,
          faceIndex: i,
        });
      }
    }
  }
  intersects.sort((a, b) => a.distance - b.distance);
  return intersects;
}

// ---------- Enter / Exit ----------

export function enterWeightPaintMode() {
  if (!state.skinnedMeshes.length) {
    updateInfo('Aucun mesh skinné — impossible de passer en weight paint.');
    return;
  }
  state.weightPaintMode = true;
  state.transformControls.detach();
  document.getElementById('rotation-controls').classList.remove('visible');
  document.getElementById('weight-paint-controls').classList.add('visible');
  document.getElementById('mode-pose-btn').classList.remove('active');
  document.getElementById('mode-paint-btn').classList.add('active');

  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  state.skinnedMeshes.forEach((mesh) => {
    const geom = mesh.geometry;
    if (geom.boundingSphere) {
      state.originalBoundingSpheres.set(mesh.uuid, {
        center: geom.boundingSphere.center.clone(),
        radius: geom.boundingSphere.radius,
      });
    }
    if (geom.boundingBox) {
      state.originalBoundingBoxes.set(mesh.uuid, {
        min: geom.boundingBox.min.clone(),
        max: geom.boundingBox.max.clone(),
      });
    }
    inflateBoundingForRaycast(mesh);
    rebuildWorldPositionCache(mesh);
    ensureVertexGroups(mesh);
  });

  swapToPaintMaterials();
  refreshWeightColors();
  updatePaintBoneName();
}

export function exitWeightPaintMode() {
  // Si la pose au repos est active, on la désactive avant de quitter le mode
  // (le bouton vit dans le panneau de peinture, donc il doit être OFF en sortant).
  if (state.atRestPose) toggleRestPose();

  state.weightPaintMode = false;
  state.isPainting = false;
  state.controls.enabled = true;
  state.brushHelper.visible = false;
  document.getElementById('weight-paint-controls').classList.remove('visible');
  document.getElementById('mode-paint-btn').classList.remove('active');
  document.getElementById('mode-pose-btn').classList.add('active');
  restoreOriginalMaterials();

  state.cachedWorldPositions.clear();

  state.skinnedMeshes.forEach((mesh) => {
    const geom = mesh.geometry;
    const sph = state.originalBoundingSpheres.get(mesh.uuid);
    if (sph && geom.boundingSphere) {
      geom.boundingSphere.center.copy(sph.center);
      geom.boundingSphere.radius = sph.radius;
    }
    const box = state.originalBoundingBoxes.get(mesh.uuid);
    if (box && geom.boundingBox) {
      geom.boundingBox.min.copy(box.min);
      geom.boundingBox.max.copy(box.max);
    }
  });
  state.originalBoundingSpheres.clear();
  state.originalBoundingBoxes.clear();

  if (state.mixer) state.mixer.timeScale = 1;
  if (state.mixerFbx) state.mixerFbx.timeScale = 1;

  if (state.selectedBone) {
    document.getElementById('rotation-controls').classList.add('visible');
    state.transformControls.setMode('rotate');
    state.transformControls.setSpace('local');
    attachGizmoTo(state.selectedBone);
  }
}

// ---------- Brush UI helper ----------

export function updateBrushHelper(event) {
  if (!state.weightPaintMode) {
    state.brushHelper.visible = false;
    return null;
  }
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);

  const markerHits = state.raycaster.intersectObjects(state.selectableBoneMarkers, false);
  if (markerHits.length > 0) {
    state.brushHelper.visible = false;
    return null;
  }

  const hits = customRaycastSkinnedMeshes(state.raycaster);
  if (hits.length === 0) {
    state.brushHelper.visible = false;
    return null;
  }
  const hit = hits[0];
  state.brushHelper.position.copy(hit.point);
  state.brushHelper.lookAt(state.camera.position);
  state.brushHelper.scale.setScalar(state.brushRadius);
  state.brushHelper.visible = true;
  return hit;
}

export function updatePaintBoneName() {
  const el = document.getElementById('paint-bone-name');
  if (!el) return;
  el.textContent = state.selectedBone
    ? (state.selectedBone.name || `Bone ${state.selectedBoneIndex + 1}`)
    : 'Aucun bone sélectionné';
}

// ---------- Application des poids avec re-normalisation à 1.0 ----------

function applyWeightDelta(mesh, vertexIdx, boneIdx, delta) {
  const W = mesh.geometry.attributes.skinWeight;
  const I = mesh.geometry.attributes.skinIndex;
  const wArr = W.array;
  const iArr = I.array;
  const itemSize = W.itemSize;
  const base = vertexIdx * itemSize;

  // 1. Trouver le slot existant pour boneIdx
  let slot = -1;
  for (let k = 0; k < 4; k++) {
    if (iArr[base + k] === boneIdx && wArr[base + k] > 0) { slot = k; break; }
  }

  if (slot === -1) {
    if (delta <= 0) return; // retrait sur un bone non présent → no-op
    // Insertion : remplacer le slot avec le plus petit poids
    let minK = 0;
    let minW = wArr[base];
    for (let k = 1; k < 4; k++) {
      if (wArr[base + k] < minW) { minW = wArr[base + k]; minK = k; }
    }
    slot = minK;
    iArr[base + slot] = boneIdx;
    wArr[base + slot] = 0;
  }

  // 2. Appliquer delta + clamp
  let newW = wArr[base + slot] + delta;
  if (newW < 0) newW = 0;
  if (newW > 1) newW = 1;
  wArr[base + slot] = newW;

  // 3. Re-normaliser : sum(weights) doit rester = 1
  const remaining = 1 - newW;
  let otherSum = 0;
  for (let k = 0; k < 4; k++) {
    if (k !== slot) otherSum += wArr[base + k];
  }

  if (otherSum > 1e-6) {
    const scale = remaining / otherSum;
    for (let k = 0; k < 4; k++) {
      if (k !== slot) wArr[base + k] *= scale;
    }
  } else {
    // Pas d'autres bones → on remet le slot courant à 1 pour garder sum = 1
    wArr[base + slot] = 1;
  }

  // Propage aux vertices jumeaux (même position 3D, splits UV/normales)
  propagateToVertexGroup(mesh, vertexIdx);
}

// ---------- Smooth weights (lisse les poids du bone sélectionné) ----------

// Adjacence géodésique par groupe : pour chaque arête du mesh on stocke la
// distance euclidienne entre les deux groupes connectés. Sert à calculer la
// distance géodésique (le long de la surface) depuis un point cliqué.
function ensureGeodesicAdjacency(mesh) {
  const vg = ensureVertexGroups(mesh);
  if (vg.geodesicAdj) return vg;

  const indexAttr = mesh.geometry.index;
  const groupCount = vg.groups.length;

  // Position monde par groupe (utilise le cache du raycast skinné si dispo)
  const cachedPos = state.cachedWorldPositions.get(mesh.uuid);
  const posAttr = mesh.geometry.attributes.position;
  const groupPositions = new Float32Array(groupCount * 3);
  for (let g = 0; g < groupCount; g++) {
    const vi = vg.groups[g][0];
    if (cachedPos) {
      groupPositions[g * 3]     = cachedPos[vi * 3];
      groupPositions[g * 3 + 1] = cachedPos[vi * 3 + 1];
      groupPositions[g * 3 + 2] = cachedPos[vi * 3 + 2];
    } else {
      groupPositions[g * 3]     = posAttr.getX(vi);
      groupPositions[g * 3 + 1] = posAttr.getY(vi);
      groupPositions[g * 3 + 2] = posAttr.getZ(vi);
    }
  }

  const adj = new Array(groupCount);
  for (let g = 0; g < groupCount; g++) adj[g] = [];

  const addEdge = (g1, g2) => {
    if (g1 === g2) return;
    // Évite doublons (chaque arête peut apparaître dans 2 triangles)
    for (const e of adj[g1]) if (e.neighbor === g2) return;
    const dx = groupPositions[g1 * 3]     - groupPositions[g2 * 3];
    const dy = groupPositions[g1 * 3 + 1] - groupPositions[g2 * 3 + 1];
    const dz = groupPositions[g1 * 3 + 2] - groupPositions[g2 * 3 + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    adj[g1].push({ neighbor: g2, dist: d });
    adj[g2].push({ neighbor: g1, dist: d });
  };

  if (indexAttr) {
    const triCount = (indexAttr.count / 3) | 0;
    for (let t = 0; t < triCount; t++) {
      const a = indexAttr.getX(t * 3);
      const b = indexAttr.getX(t * 3 + 1);
      const c = indexAttr.getX(t * 3 + 2);
      const ga = vg.vertexToGroup[a];
      const gb = vg.vertexToGroup[b];
      const gc = vg.vertexToGroup[c];
      addEdge(ga, gb);
      addEdge(ga, gc);
      addEdge(gb, gc);
    }
  }

  vg.geodesicAdj = adj;
  vg.groupPositions = groupPositions;
  return vg;
}

// Trouve le groupe dont la position est la plus proche du point monde cliqué.
function findNearestGroupTo(mesh, point) {
  const vg = ensureGeodesicAdjacency(mesh);
  const gp = vg.groupPositions;
  let bestG = -1;
  let bestD2 = Infinity;
  for (let g = 0; g < vg.groups.length; g++) {
    const dx = gp[g * 3]     - point.x;
    const dy = gp[g * 3 + 1] - point.y;
    const dz = gp[g * 3 + 2] - point.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestG = g; }
  }
  return { groupId: bestG, dist: Math.sqrt(bestD2) };
}

// Dijkstra depuis un groupe initial, s'arrête dès qu'on dépasse maxDist.
// Retourne un Float32Array de distances (Infinity = non atteint).
function dijkstraFromGroup(mesh, startGroupId, startDist, maxDist) {
  const vg = ensureGeodesicAdjacency(mesh);
  const adj = vg.geodesicAdj;
  const n = vg.groups.length;
  const distances = new Float32Array(n);
  distances.fill(Infinity);
  distances[startGroupId] = startDist;

  // PQ array linéaire — suffisant pour des radii modestes
  const pq = [[startDist, startGroupId]];
  const visited = new Uint8Array(n);

  while (pq.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i][0] < pq[minIdx][0]) minIdx = i;
    }
    const [d, g] = pq[minIdx];
    pq[minIdx] = pq[pq.length - 1];
    pq.pop();

    if (visited[g]) continue;
    visited[g] = 1;
    if (d > maxDist) continue;

    for (const { neighbor, dist } of adj[g]) {
      const newD = d + dist;
      if (newD < distances[neighbor] && newD <= maxDist) {
        distances[neighbor] = newD;
        pq.push([newD, neighbor]);
      }
    }
  }
  return distances;
}

// Adjacence par GROUPE de vertices (pas par vertex individuel) — respecte les
// jumeaux UV/normales : deux vertices à la même position 3D sont logiquement un.
function ensureGroupAdjacency(mesh) {
  const vg = ensureVertexGroups(mesh);
  if (vg.groupAdjacency) return vg.groupAdjacency;

  const indexAttr = mesh.geometry.index;
  const adj = new Map();
  for (let g = 0; g < vg.groups.length; g++) adj.set(g, new Set());

  if (indexAttr) {
    const triCount = (indexAttr.count / 3) | 0;
    for (let t = 0; t < triCount; t++) {
      const a = indexAttr.getX(t * 3);
      const b = indexAttr.getX(t * 3 + 1);
      const c = indexAttr.getX(t * 3 + 2);
      const ga = vg.vertexToGroup[a];
      const gb = vg.vertexToGroup[b];
      const gc = vg.vertexToGroup[c];
      if (ga !== gb) { adj.get(ga).add(gb); adj.get(gb).add(ga); }
      if (ga !== gc) { adj.get(ga).add(gc); adj.get(gc).add(ga); }
      if (gb !== gc) { adj.get(gb).add(gc); adj.get(gc).add(gb); }
    }
  }
  vg.groupAdjacency = adj;
  return adj;
}

// Lisse les poids du bone par groupe — applyWeightDelta sur le premier vertex
// du groupe propage automatiquement aux jumeaux (cf. propagateToVertexGroup).
function smoothBoneWeightsOnMesh(mesh, boneIdx) {
  const geom = mesh.geometry;
  const skinIndex = geom.attributes.skinIndex;
  const skinWeight = geom.attributes.skinWeight;
  if (!skinIndex || !skinWeight) return 0;

  const vg = ensureVertexGroups(mesh);
  const groupAdj = ensureGroupAdjacency(mesh);
  const groupCount = vg.groups.length;

  // Poids actuel du bone par groupe (lu sur le 1er vertex du groupe)
  const current = new Float32Array(groupCount);
  for (let g = 0; g < groupCount; g++) {
    const vi = vg.groups[g][0];
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (skinIndex.getComponent(vi, k) === boneIdx) {
        w += skinWeight.getComponent(vi, k);
      }
    }
    current[g] = w;
  }

  // Moyenne avec les groupes voisins
  const target = new Float32Array(groupCount);
  for (let g = 0; g < groupCount; g++) {
    let sum = current[g];
    let count = 1;
    const neighbors = groupAdj.get(g);
    if (neighbors) for (const n of neighbors) { sum += current[n]; count++; }
    target[g] = sum / count;
  }

  let touched = 0;
  for (let g = 0; g < groupCount; g++) {
    const delta = target[g] - current[g];
    if (Math.abs(delta) < 1e-6) continue;
    applyWeightDelta(mesh, vg.groups[g][0], boneIdx, delta);
    touched++;
  }
  return touched;
}

// Smooth global par groupe : moyenne chaque bone avec ses voisins (au niveau
// des groupes de jumeaux), garde les 4 plus gros poids par groupe, et écrit
// le résultat dans tous les vertices du groupe.
function smoothAllWeightsOnMesh(mesh) {
  const geom = mesh.geometry;
  const skinIndex = geom.attributes.skinIndex;
  const skinWeight = geom.attributes.skinWeight;
  if (!skinIndex || !skinWeight) return 0;

  const boneCount = mesh.skeleton.bones.length;
  const vg = ensureVertexGroups(mesh);
  const groupAdj = ensureGroupAdjacency(mesh);
  const groupCount = vg.groups.length;

  // 1. Weights par groupe (lu sur le 1er vertex du groupe)
  const current = new Array(groupCount);
  for (let g = 0; g < groupCount; g++) {
    const vi = vg.groups[g][0];
    const map = new Map();
    for (let k = 0; k < 4; k++) {
      const bi = skinIndex.getComponent(vi, k);
      const w = skinWeight.getComponent(vi, k);
      if (w > 0 && bi >= 0 && bi < boneCount) {
        map.set(bi, (map.get(bi) || 0) + w);
      }
    }
    current[g] = map;
  }

  const wArr = skinWeight.array;
  const iArr = skinIndex.array;

  for (let g = 0; g < groupCount; g++) {
    // Moyenne avec les groupes voisins
    const accum = new Map();
    for (const [bi, w] of current[g]) accum.set(bi, w);
    let count = 1;
    const neighbors = groupAdj.get(g);
    if (neighbors) {
      for (const n of neighbors) {
        for (const [bi, w] of current[n]) {
          accum.set(bi, (accum.get(bi) || 0) + w);
        }
        count++;
      }
    }
    for (const bi of accum.keys()) accum.set(bi, accum.get(bi) / count);

    // Garde top-4 + renormalise somme = 1
    const sorted = [...accum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, w] of sorted) sum += w;
    if (sum < 1e-6) continue;
    const scale = 1 / sum;

    // Écrit le résultat sur TOUS les vertices du groupe
    for (const vi of vg.groups[g]) {
      const base = vi * 4;
      for (let k = 0; k < 4; k++) {
        if (k < sorted.length) {
          iArr[base + k] = sorted[k][0];
          wArr[base + k] = sorted[k][1] * scale;
        } else {
          iArr[base + k] = 0;
          wArr[base + k] = 0;
        }
      }
    }
  }
  return groupCount;
}

export function smoothAllWeights() {
  if (!state.weightPaintMode) {
    updateInfo('Smooth disponible uniquement en mode Weight Paint.');
    return;
  }
  if (state.skinnedMeshes.length === 0) return;

  let totalTouched = 0;
  for (const mesh of state.skinnedMeshes) {
    const touched = smoothAllWeightsOnMesh(mesh);
    if (touched > 0) {
      mesh.geometry.attributes.skinWeight.needsUpdate = true;
      mesh.geometry.attributes.skinIndex.needsUpdate = true;
      refreshWeightColorsForMesh(mesh);
      totalTouched += touched;
    }
  }
  updateInfo(`💧 Smooth All : ${totalTouched} vertices lissés sur tous les bones.`);
}

// ---------- Mode sélection rectangle ----------

const _selProj = new THREE.Vector3();

// Sélectionne tous les groupes dont la projection écran tombe dans le rectangle.
export function selectVerticesInScreenRect(x1, y1, x2, y2, additive = false) {
  const camera = state.camera;
  const dom = state.renderer.domElement;
  const rect = dom.getBoundingClientRect();

  for (const mesh of state.skinnedMeshes) {
    const vg = ensureVertexGroups(mesh);
    let selected = state.selectedVertexGroups.get(mesh.uuid);
    if (!selected) {
      selected = new Set();
      state.selectedVertexGroups.set(mesh.uuid, selected);
    }
    if (!additive) selected.clear();

    const cachedPos = state.cachedWorldPositions.get(mesh.uuid);
    const posAttr = mesh.geometry.attributes.position;

    for (let g = 0; g < vg.groups.length; g++) {
      const vi = vg.groups[g][0];
      if (cachedPos) {
        _selProj.set(cachedPos[vi * 3], cachedPos[vi * 3 + 1], cachedPos[vi * 3 + 2]);
      } else {
        _selProj.set(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi));
        _selProj.applyMatrix4(mesh.matrixWorld);
      }
      // Projection NDC puis écran
      _selProj.project(camera);
      // Si le point est derrière la caméra (z < -1 ou > 1 en NDC), on skip
      if (_selProj.z < -1 || _selProj.z > 1) continue;
      const sx = (_selProj.x + 1) * 0.5 * rect.width + rect.left;
      const sy = (-_selProj.y + 1) * 0.5 * rect.height + rect.top;
      if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) {
        selected.add(g);
      }
    }
    refreshWeightColorsForMesh(mesh);
  }
}

export function clearVertexSelection() {
  state.selectedVertexGroups.clear();
  refreshWeightColors();
}

// Set le poids du bone sélectionné à `targetWeight` pour tous les vertices sélectionnés.
// Utilise applyWeightDelta pour préserver la normalisation (somme = 1).
export function applyWeightToSelection(targetWeight) {
  if (!state.selectedBone) {
    updateInfo("Sélectionne un bone d'abord.");
    return;
  }
  const w = Math.max(0, Math.min(1, targetWeight));
  let totalTouched = 0;
  for (const mesh of state.skinnedMeshes) {
    const boneIdx = mesh.skeleton.bones.indexOf(state.selectedBone);
    if (boneIdx < 0) continue;
    const selected = state.selectedVertexGroups.get(mesh.uuid);
    if (!selected || selected.size === 0) continue;
    const vg = state.vertexGroups.get(mesh.uuid);
    if (!vg) continue;

    const W = mesh.geometry.attributes.skinWeight;
    const I = mesh.geometry.attributes.skinIndex;

    for (const g of selected) {
      const vi = vg.groups[g][0];
      // Lit le poids actuel du bone sur ce vertex (somme des slots)
      let current = 0;
      for (let k = 0; k < 4; k++) {
        if (I.getComponent(vi, k) === boneIdx) current += W.getComponent(vi, k);
      }
      const delta = w - current;
      if (Math.abs(delta) < 1e-6) continue;
      applyWeightDelta(mesh, vi, boneIdx, delta);
      totalTouched++;
    }
    W.needsUpdate = true;
    I.needsUpdate = true;
    refreshWeightColorsForMesh(mesh);
  }
  updateInfo(`✅ Poids ${w.toFixed(2)} appliqué sur ${totalTouched} vertices (${state.selectedBone.name}).`);
}

export function smoothSelectedBoneWeights() {
  if (!state.weightPaintMode) {
    updateInfo('Smooth disponible uniquement en mode Weight Paint.');
    return;
  }
  if (!state.selectedBone) {
    updateInfo("Sélectionne d'abord un bone à lisser.");
    return;
  }

  let totalTouched = 0;
  for (const mesh of state.skinnedMeshes) {
    const boneIdx = mesh.skeleton.bones.indexOf(state.selectedBone);
    if (boneIdx < 0) continue;
    const touched = smoothBoneWeightsOnMesh(mesh, boneIdx);
    if (touched > 0) {
      mesh.geometry.attributes.skinWeight.needsUpdate = true;
      mesh.geometry.attributes.skinIndex.needsUpdate = true;
      refreshWeightColorsForMesh(mesh);
      totalTouched += touched;
    }
  }

  if (totalTouched > 0) {
    updateInfo(`💧 Smooth : ${totalTouched} vertices lissés sur "${state.selectedBone.name}".`);
  } else {
    updateInfo("Aucun vertex à lisser pour ce bone.");
  }
}

function findBoneIndexAcrossMeshes(bone) {
  for (const m of state.skinnedMeshes) {
    const idx = m.skeleton.bones.indexOf(bone);
    if (idx >= 0) return { mesh: m, boneIdx: idx };
  }
  return null;
}

export function paintAtPointer(event) {
  if (!state.weightPaintMode) return;
  if (!state.selectedBone) {
    updateInfo("⚠️ Sélectionne d'abord un bone (clic sur un marker).");
    return;
  }

  const found = findBoneIndexAcrossMeshes(state.selectedBone);
  if (!found) {
    updateInfo(`⚠️ Le bone "${state.selectedBone.name}" n'est dans aucune skeleton (non-deformer). Choisis un bone qui déforme la peau.`);
    return;
  }

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);

  const markerHits = state.raycaster.intersectObjects(state.selectableBoneMarkers, false);
  if (markerHits.length > 0) return;

  const hits = customRaycastSkinnedMeshes(state.raycaster);
  if (hits.length === 0) {
    updateInfo('⚠️ Pas de hit sur le mesh.');
    return;
  }

  let hit = null, mesh = null, boneIdx = -1;
  for (const h of hits) {
    if (!h.object.isSkinnedMesh) continue;
    const idx = h.object.skeleton.bones.indexOf(state.selectedBone);
    if (idx >= 0) { hit = h; mesh = h.object; boneIdx = idx; break; }
  }
  if (!hit) {
    updateInfo(`⚠️ Le mesh touché n'utilise pas le bone "${state.selectedBone.name}".`);
    return;
  }

  const hitPoint = hit.point;
  const sign = state.brushSubtract ? -1 : 1;
  const stepStrength = state.brushStrength * 0.25;

  // Adjacence + positions des groupes (utilisées par les deux modes)
  const vg = ensureGeodesicAdjacency(mesh);
  const gp = vg.groupPositions;

  let touched = 0;

  if (state.brushGeodesic) {
    // Mode géodésique : Dijkstra le long des arêtes depuis le groupe le plus
    // proche du hit point. Évite que le brush "saute" d'un membre à l'autre.
    const { groupId: startGroup, dist: startDist } = findNearestGroupTo(mesh, hitPoint);
    if (startGroup < 0) {
      updateInfo('⚠️ Pas d\'adjacence géodésique.');
      return;
    }
    if (startDist > state.brushRadius) return;

    const distances = dijkstraFromGroup(mesh, startGroup, startDist, state.brushRadius);

    for (let g = 0; g < vg.groups.length; g++) {
      const dist = distances[g];
      if (!isFinite(dist) || dist > state.brushRadius) continue;

      const t = 1 - (dist / state.brushRadius);
      const falloff = state.brushFalloff <= 0 ? 1 : Math.pow(t, state.brushFalloff);
      const delta = sign * stepStrength * falloff;
      if (delta === 0) continue;

      applyWeightDelta(mesh, vg.groups[g][0], boneIdx, delta);
      touched++;
    }
  } else {
    // Mode euclidien : distance 3D directe groupe → hitPoint (mode antérieur).
    const r2 = state.brushRadius * state.brushRadius;
    for (let g = 0; g < vg.groups.length; g++) {
      const dx = gp[g * 3]     - hitPoint.x;
      const dy = gp[g * 3 + 1] - hitPoint.y;
      const dz = gp[g * 3 + 2] - hitPoint.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;

      const dist = Math.sqrt(d2);
      const t = 1 - (dist / state.brushRadius);
      const falloff = state.brushFalloff <= 0 ? 1 : Math.pow(t, state.brushFalloff);
      const delta = sign * stepStrength * falloff;
      if (delta === 0) continue;

      applyWeightDelta(mesh, vg.groups[g][0], boneIdx, delta);
      touched++;
    }
  }

  if (touched > 0) {
    mesh.geometry.attributes.skinWeight.needsUpdate = true;
    mesh.geometry.attributes.skinIndex.needsUpdate = true;
    refreshWeightColorsForMesh(mesh);
    updateInfo(`🎨 ${state.selectedBone.name} : ${touched} vertices peints (${state.brushSubtract ? '−' : '+'}).`);
  } else {
    updateInfo(`⚠️ Aucun vertex dans le rayon (${state.brushRadius.toFixed(2)}). Augmente le rayon.`);
  }
}
