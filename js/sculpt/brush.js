// Logique de sculpture : collecte des vertices sous le brush via BVH shapecast,
// puis application selon l'outil (draw, smooth, flatten, move/grab).
//
// Hot path sans allocation ni Set : collecte en tableaux typés (dédup par
// "stamp"), maths en accès brut sur les Float32Array. Conscient de la carte de
// soudure (state.rep / groupMembers) : coutures déplacées ensemble (chemin rare).

import * as THREE from 'three';
import { CONTAINED, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';
import { state } from './state.js';

const _raycaster = new THREE.Raycaster();
_raycaster.firstHitOnly = true;

const _sphere = new THREE.Sphere();
const _tempVec = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);
const _localCenter = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _rayTarget = new THREE.Vector3();

// Collecte (réutilisée) : vertices dédupliqués + triangles (uniques par
// construction) en tableaux typés ; nœuds BVH en Set (petit, requis par refit).
let _idxArr = new Int32Array(0);
let _idxCount = 0;
let _triArr = new Int32Array(0);
let _triCount = 0;
const _nodes = new Set();

// Marquage sans alloc (dédup collecte + normales)
let _stamp = null;
let _stampId = 0;
let _touchedList = new Int32Array(0);
let _touchedCount = 0;

// Chemin coutures (rare)
const _reps = new Set();
const _doneReps = new Set();

const CURSOR_NORMAL_FACTOR = 0.4;
// Amplitude par coup de brush à 100% d'intensité (l'accumulation vient du spacing).
// strength = intensité/100 (donc 1.0 à 100%, 2.0 à 200%).
const DRAW_OFFSET = 0.05;   // ajout par coup (fraction du rayon) à 100%
const FLATTEN_STR = 0.25;   // fraction de la distance au plan rattrapée
const BUILD_HEIGHT = 0.5;   // "genou" de résistance du draw (× rayon × force) — pas un plafond dur

// Accumulation du draw par stroke : résistance asymptotique (ne s'arrête jamais,
// mais ralentit en montant) pour accumuler sans pyramide rapide. Réinit via _accId.
let _accBuf = new Float32Array(0);
let _accStamp = new Int32Array(0);
let _accId = 0;
export function beginStroke() { _accId++; }

// Repère tangent du brush (une fois par stamp) pour projeter les vertices dans
// l'empreinte carrée de l'alpha.
let _tx = 0, _ty = 0, _tz = 0, _bx = 0, _by = 0, _bz = 0;
function brushFrame(nx, ny, nz) {
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(ny) > 0.99) { ux = 1; uy = 0; uz = 0; }
  let tx = ny * uz - nz * uy, ty = nz * ux - nx * uz, tz = nx * uy - ny * ux;
  const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  _tx = tx; _ty = ty; _tz = tz;
  _bx = ny * tz - nz * ty; _by = nz * tx - nx * tz; _bz = nx * ty - ny * tx;
}

export function raycastSurface() {
  if (!state.targetMesh) return null;
  _raycaster.setFromCamera(state.mouse, state.camera);
  const hits = _raycaster.intersectObject(state.targetMesh, false);
  return hits.length ? hits[0] : null;
}

export function updateBrushCursor(hit, orient = true) {
  const brush = state.brushMesh;
  if (!hit) { brush.visible = false; return; }
  brush.visible = true;
  brush.position.copy(hit.point);
  brush.scale.setScalar(state.params.size);
  if (!orient) return;

  const radius = state.params.size * CURSOR_NORMAL_FACTOR;
  const smoothed = averageNormalWorld(hit.point, radius);
  if (smoothed) {
    brush.quaternion.setFromUnitVectors(_up, smoothed);
  } else if (hit.face) {
    _tempVec.copy(hit.face.normal).transformDirection(state.targetMesh.matrixWorld);
    brush.quaternion.setFromUnitVectors(_up, _tempVec);
  }
}

function averageNormalWorld(worldPoint, radius) {
  const nor = state.targetMesh.geometry.attributes.normal.array;
  toLocal(worldPoint, _localCenter);
  collectInSphere(_localCenter, radius);
  if (!_idxCount) return null;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < _idxCount; i++) {
    const v3 = _idxArr[i] * 3;
    x += nor[v3]; y += nor[v3 + 1]; z += nor[v3 + 2];
  }
  _normal.set(x, y, z);
  if (_normal.lengthSq() === 0) return null;
  _normal.normalize();
  return _normal.clone().transformDirection(state.targetMesh.matrixWorld);
}

function toLocal(worldPoint, out) {
  _inv.copy(state.targetMesh.matrixWorld).invert();
  return out.copy(worldPoint).applyMatrix4(_inv);
}

function ensureArrays(geometry) {
  const vc = geometry.attributes.position.count;
  const tc = geometry.index.count / 3;
  if (_idxArr.length < vc) _idxArr = new Int32Array(vc);
  if (_triArr.length < tc) _triArr = new Int32Array(tc);
  if (_touchedList.length < vc) _touchedList = new Int32Array(vc);
  if (!_stamp || _stamp.length < vc) _stamp = new Int32Array(vc);
  if (_accBuf.length < vc) { _accBuf = new Float32Array(vc); _accStamp = new Int32Array(vc); }
}

// Remplit _idxArr/_idxCount (vertices, dédup), _triArr/_triCount (triangles),
// _nodes (Set BVH). Aucun Set pour les vertices/triangles → pas de churn GC.
function collectInSphere(localCenter, radius) {
  const geometry = state.targetMesh.geometry;
  const bvh = geometry.boundsTree;
  const idx = geometry.index.array;
  ensureArrays(geometry);
  const stamp = _stamp;
  const id = ++_stampId;
  _idxCount = 0;
  _triCount = 0;
  _nodes.clear();

  _sphere.center.copy(localCenter);
  _sphere.radius = radius;

  bvh.shapecast({
    intersectsBounds: (box, _isLeaf, _score, _depth, nodeIndex) => {
      if (!_sphere.intersectsBox(box)) return NOT_INTERSECTED;
      // Seulement les nœuds intersectants (sinon refit force des sous-arbres → O(n)).
      _nodes.add(nodeIndex);
      const { min, max } = box;
      for (let x = 0; x <= 1; x++) {
        for (let y = 0; y <= 1; y++) {
          for (let z = 0; z <= 1; z++) {
            _tempVec.set(x ? max.x : min.x, y ? max.y : min.y, z ? max.z : min.z);
            if (!_sphere.containsPoint(_tempVec)) return INTERSECTED;
          }
        }
      }
      return CONTAINED;
    },
    intersectsTriangle: (tri, index, contained) => {
      const i3 = index * 3;
      const va = idx[i3], vb = idx[i3 + 1], vc = idx[i3 + 2];
      let touched = false;
      if (contained || _sphere.containsPoint(tri.a)) { if (stamp[va] !== id) { stamp[va] = id; _idxArr[_idxCount++] = va; } touched = true; }
      if (contained || _sphere.containsPoint(tri.b)) { if (stamp[vb] !== id) { stamp[vb] = id; _idxArr[_idxCount++] = vb; } touched = true; }
      if (contained || _sphere.containsPoint(tri.c)) { if (stamp[vc] !== id) { stamp[vc] = id; _idxArr[_idxCount++] = vc; } touched = true; }
      if (touched) _triArr[_triCount++] = index;
      return false;
    },
  });
}

// ---------- Strokes surfaciques (draw / flatten / smooth) ----------

export function performStroke(worldPoint, opts = {}) {
  if (!state.targetMesh) return;
  const { size, intensity, symmetryX } = state.params;
  const tool = opts.tool || state.params.tool;
  const invert = opts.invert !== undefined ? opts.invert : state.params.invert;

  applyStrokeAt(worldPoint, size, tool, intensity, invert);

  if (symmetryX) {
    _tempVec.set(-worldPoint.x, worldPoint.y, worldPoint.z);
    applyStrokeAt(_tempVec, size, tool, intensity, invert);
  }
}

const _range = { min: Infinity, max: -1 };
function resetRange() { _range.min = Infinity; _range.max = -1; }
function track(i) { if (i < _range.min) _range.min = i; if (i > _range.max) _range.max = i; }

function applyStrokeAt(worldPoint, size, tool, intensity, invert) {
  const geometry = state.targetMesh.geometry;
  const posAttr = geometry.attributes.position;
  const normalAttr = geometry.attributes.normal;
  const pos = posAttr.array;
  const nor = normalAttr.array;
  const neighbors = state.vertexNeighbors;
  const hasSeams = state.groupMembers.size > 0;

  const P = typeof window !== 'undefined' && window.__perf;
  let t0 = P ? performance.now() : 0;

  toLocal(worldPoint, _localCenter);
  collectInSphere(_localCenter, size);
  if (!_idxCount) return;
  if (P) { P.collect += performance.now() - t0; t0 = performance.now(); }

  if (hasSeams) {
    applySeamStroke(pos, nor, tool, size, intensity, invert);
  } else {
    applyFastStroke(pos, nor, tool, size, intensity, invert, neighbors);
  }
  if (_range.max < 0) return;
  const posMin = _range.min, posMax = _range.max;
  if (P) { P.apply += performance.now() - t0; t0 = performance.now(); }

  updateNormalsFromTriangles(_triArr, _triCount);

  if (hasSeams) {
    markUpdateRange(posAttr, posMin, posMax);
    markUpdateRange(normalAttr, _range.min, _range.max);
  } else {
    const runs = buildRuns(_touchedList.subarray(0, _touchedCount));
    addRuns(posAttr, runs);
    addRuns(normalAttr, runs);
  }
  if (P) { P.normals += performance.now() - t0; t0 = performance.now(); }

  geometry.boundsTree.refit(_nodes);
  if (P) { P.refit += performance.now() - t0; P.count++; P.affected = _idxCount; P.tris = _triCount; P.nodes = _nodes.size; }
}

// Chemin rapide (pas de coutures) : tout en accès brut sur les Float32Array.
function applyFastStroke(pos, nor, tool, size, intensity, invert, neighbors) {
  // Normale + point moyens
  let nx = 0, ny = 0, nz = 0, px = 0, py = 0, pz = 0;
  for (let i = 0; i < _idxCount; i++) {
    const v3 = _idxArr[i] * 3;
    nx += nor[v3]; ny += nor[v3 + 1]; nz += nor[v3 + 2];
    px += pos[v3]; py += pos[v3 + 1]; pz += pos[v3 + 2];
  }
  let nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const inv = 1 / _idxCount;
  px *= inv; py *= inv; pz *= inv;

  const lcx = _localCenter.x, lcy = _localCenter.y, lcz = _localCenter.z;
  const sign = invert ? -1 : 1;
  const strength = intensity / 100;
  const maxOffset = size * DRAW_OFFSET * strength;
  const flattenStr = strength * FLATTEN_STR;
  const invSize = 1 / size;
  brushFrame(nx, ny, nz);
  const tx = _tx, ty = _ty, tz = _tz, bx = _bx, by = _by, bz = _bz;
  const alpha = state.alpha, an = alpha.n, agrid = alpha.grid;
  const flut = state.falloff, fn1 = flut.length - 1;
  const maxHeight = size * BUILD_HEIGHT * strength;
  const accBuf = _accBuf, accStamp = _accStamp, accId = _accId;

  resetRange();
  for (let i = 0; i < _idxCount; i++) {
    const v = _idxArr[i];
    const v3 = v * 3;
    let x = pos[v3], y = pos[v3 + 1], z = pos[v3 + 2];
    const rx = x - lcx, ry = y - lcy, rz = z - lcz;
    const uu = (rx * tx + ry * ty + rz * tz) * invSize * 0.5 + 0.5;
    const vv = (rx * bx + ry * by + rz * bz) * invSize * 0.5 + 0.5;
    if (uu < 0 || uu >= 1 || vv < 0 || vv >= 1) continue;
    const du = uu - 0.5, dv = vv - 0.5;
    let rr = Math.sqrt(du * du + dv * dv) * 2; if (rr > 1) rr = 1;
    const f = agrid[((vv * an) | 0) * an + ((uu * an) | 0)] * flut[(rr * fn1) | 0];
    if (f <= 0) continue;

    if (tool === 'draw') {
      // Résistance asymptotique : accumule sans limite mais ralentit en montant
      // (pas de pyramide rapide, pas d'arrêt net).
      const acc = accStamp[v] === accId ? accBuf[v] : 0;
      const room = 1 / (1 + Math.abs(acc) / maxHeight);
      const s = maxOffset * f * sign * room;
      accBuf[v] = acc + s; accStamp[v] = accId;
      x += nx * s; y += ny * s; z += nz * s;
    } else if (tool === 'flatten') {
      const d = nx * (x - px) + ny * (y - py) + nz * (z - pz);
      const s = -d * f * flattenStr;
      x += nx * s; y += ny * s; z += nz * s;
    } else if (tool === 'smooth') {
      const nb = neighbors[v];
      const len = nb.length;
      if (len) {
        let ax = 0, ay = 0, az = 0;
        for (let k = 0; k < len; k++) { const n3 = nb[k] * 3; ax += pos[n3]; ay += pos[n3 + 1]; az += pos[n3 + 2]; }
        const li = 1 / len;
        const w = f * strength;
        x += (ax * li - x) * w; y += (ay * li - y) * w; z += (az * li - z) * w;
      }
    }

    pos[v3] = x; pos[v3 + 1] = y; pos[v3 + 2] = z;
    if (v < _range.min) _range.min = v;
    if (v > _range.max) _range.max = v;
  }
}

// Chemin coutures : opère sur les représentants, écrit sur tous les membres.
function applySeamStroke(pos, nor, tool, size, intensity, invert) {
  const rep = state.rep;
  const groupMembers = state.groupMembers;
  _reps.clear();
  for (let i = 0; i < _idxCount; i++) _reps.add(rep[_idxArr[i]]);

  let nx = 0, ny = 0, nz = 0, px = 0, py = 0, pz = 0;
  _reps.forEach((r) => {
    const v3 = r * 3;
    nx += nor[v3]; ny += nor[v3 + 1]; nz += nor[v3 + 2];
    px += pos[v3]; py += pos[v3 + 1]; pz += pos[v3 + 2];
  });
  let nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const inv = 1 / _reps.size;
  px *= inv; py *= inv; pz *= inv;

  const lcx = _localCenter.x, lcy = _localCenter.y, lcz = _localCenter.z;
  const sign = invert ? -1 : 1;
  const strength = intensity / 100;
  const maxOffset = size * DRAW_OFFSET * strength;
  const flattenStr = strength * FLATTEN_STR;
  const invSize = 1 / size;
  brushFrame(nx, ny, nz);
  const tx = _tx, ty = _ty, tz = _tz, bx = _bx, by = _by, bz = _bz;
  const alpha = state.alpha, an = alpha.n, agrid = alpha.grid;
  const flut = state.falloff, fn1 = flut.length - 1;
  const maxHeight = size * BUILD_HEIGHT * strength;
  const accBuf = _accBuf, accStamp = _accStamp, accId = _accId;

  resetRange();
  _reps.forEach((r) => {
    const v3 = r * 3;
    let x = pos[v3], y = pos[v3 + 1], z = pos[v3 + 2];
    const rx = x - lcx, ry = y - lcy, rz = z - lcz;
    const uu = (rx * tx + ry * ty + rz * tz) * invSize * 0.5 + 0.5;
    const vv = (rx * bx + ry * by + rz * bz) * invSize * 0.5 + 0.5;
    if (uu < 0 || uu >= 1 || vv < 0 || vv >= 1) return;
    const du = uu - 0.5, dv = vv - 0.5;
    let rr = Math.sqrt(du * du + dv * dv) * 2; if (rr > 1) rr = 1;
    const f = agrid[((vv * an) | 0) * an + ((uu * an) | 0)] * flut[(rr * fn1) | 0];
    if (f <= 0) return;

    if (tool === 'draw') {
      const acc = accStamp[r] === accId ? accBuf[r] : 0;
      const room = 1 / (1 + Math.abs(acc) / maxHeight);
      const s = maxOffset * f * sign * room;
      accBuf[r] = acc + s; accStamp[r] = accId;
      x += nx * s; y += ny * s; z += nz * s;
    } else if (tool === 'flatten') {
      const d = nx * (x - px) + ny * (y - py) + nz * (z - pz);
      const s = -d * f * flattenStr;
      x += nx * s; y += ny * s; z += nz * s;
    } else if (tool === 'smooth') {
      const nb = smoothNeighbors(r);
      if (nb && nb.length) {
        let ax = 0, ay = 0, az = 0;
        for (let k = 0; k < nb.length; k++) { const n3 = nb[k] * 3; ax += pos[n3]; ay += pos[n3 + 1]; az += pos[n3 + 2]; }
        const li = 1 / nb.length, w = f * strength;
        x += (ax * li - x) * w; y += (ay * li - y) * w; z += (az * li - z) * w;
      }
    }

    const members = groupMembers.get(r);
    if (members) {
      for (let k = 0; k < members.length; k++) { const m3 = members[k] * 3; pos[m3] = x; pos[m3 + 1] = y; pos[m3 + 2] = z; track(members[k]); }
    } else {
      pos[v3] = x; pos[v3 + 1] = y; pos[v3 + 2] = z; track(r);
    }
  });
}

function smoothNeighbors(r) {
  const rn = state.repNeighbors.get(r);
  return rn || state.vertexNeighbors[r];
}

// ---------- Outil Move / Grab ----------

export function startGrab(hit) {
  const geometry = state.targetMesh.geometry;
  const pos = geometry.attributes.position.array;
  const idxAttr = geometry.index.array;
  const { size } = state.params;
  const rep = state.rep;
  const groupMembers = state.groupMembers;
  const hasSeams = groupMembers.size > 0;

  toLocal(hit.point, _localCenter);
  collectInSphere(_localCenter, size);
  if (!_idxCount) return false;

  // Ensemble affecté (+ membres coïncidents si coutures)
  const affected = new Set();
  for (let i = 0; i < _idxCount; i++) {
    const v = _idxArr[i];
    if (hasSeams) {
      const members = groupMembers.get(rep[v]);
      if (members) { for (let k = 0; k < members.length; k++) affected.add(members[k]); continue; }
    }
    affected.add(v);
  }

  const arr = Int32Array.from(affected);
  const weights = new Float32Array(arr.length);
  const startPositions = new Float32Array(arr.length * 3);
  const lcx = _localCenter.x, lcy = _localCenter.y, lcz = _localCenter.z;
  for (let k = 0; k < arr.length; k++) {
    const v3 = arr[k] * 3;
    const x = pos[v3], y = pos[v3 + 1], z = pos[v3 + 2];
    startPositions[k * 3] = x; startPositions[k * 3 + 1] = y; startPositions[k * 3 + 2] = z;
    const dx = x - lcx, dy = y - lcy, dz = z - lcz;
    let f = 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / size;
    f = Math.max(0, f);
    weights[k] = f * f * (3 - 2 * f);
  }

  // Triangles touchés (snapshot) pour recalcul des normales pendant le drag
  const triangles = _triArr.slice(0, _triCount);

  // Runs d'upload précalculés (vertices des triangles touchés)
  const touched = new Set();
  for (let t = 0; t < _triCount; t++) {
    const o = _triArr[t] * 3;
    touched.add(idxAttr[o]); touched.add(idxAttr[o + 1]); touched.add(idxAttr[o + 2]);
  }
  const ranges = buildRuns(touched);

  const camDir = new THREE.Vector3();
  state.camera.getWorldDirection(camDir);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, hit.point);

  state.grab = {
    active: true, plane, startPoint: hit.point.clone(),
    indices: arr, weights, startPositions, ranges,
    triangles, nodes: new Set(_nodes),
  };
  return true;
}

export function moveGrab() {
  const g = state.grab;
  if (!g.active) return;
  const geometry = state.targetMesh.geometry;
  const posAttr = geometry.attributes.position;
  const pos = posAttr.array;
  const P = typeof window !== 'undefined' && window.__perf;
  let t0 = P ? performance.now() : 0;

  _raycaster.setFromCamera(state.mouse, state.camera);
  if (!_raycaster.ray.intersectPlane(g.plane, _rayTarget)) return;

  const dx = _rayTarget.x - g.startPoint.x;
  const dy = _rayTarget.y - g.startPoint.y;
  const dz = _rayTarget.z - g.startPoint.z;

  const arr = g.indices, w = g.weights, sp = g.startPositions;
  for (let k = 0; k < arr.length; k++) {
    const wk = w[k];
    const i3 = arr[k] * 3;
    pos[i3] = sp[k * 3] + dx * wk;
    pos[i3 + 1] = sp[k * 3 + 1] + dy * wk;
    pos[i3 + 2] = sp[k * 3 + 2] + dz * wk;
  }
  // Pendant le drag : uniquement la position (runs). Les normales (coûteuses) et
  // le refit sont reportés à endGrab — un move est une translation, le shading
  // peut se recaler au relâcher. Bonus : pas d'upload de normales -> stall réduit.
  addRuns(posAttr, g.ranges);
  if (P) { P.apply += performance.now() - t0; P.count++; P.affected = arr.length; P.tris = g.triangles.length; }

  g.needsRefit = true;
}

export function endGrab() {
  const g = state.grab;
  if (g.active && g.needsRefit && state.targetMesh) {
    const geometry = state.targetMesh.geometry;
    updateNormalsFromTriangles(g.triangles, g.triangles.length); // recale les normales
    addRuns(geometry.attributes.normal, g.ranges);
    geometry.boundsTree.refit(g.nodes);
    g.needsRefit = false;
  }
  g.active = false;
}

// ---------- Normales (accès tableau brut) ----------

function updateNormalsFromTriangles(triArr, triCount) {
  const geometry = state.targetMesh.geometry;
  const pos = geometry.attributes.position.array;
  const nor = geometry.attributes.normal.array;
  const idx = geometry.index.array;
  const count = geometry.attributes.position.count;

  if (!_stamp || _stamp.length < count) _stamp = new Int32Array(count);
  if (_touchedList.length < count) _touchedList = new Int32Array(count);
  const stamp = _stamp;
  const id = ++_stampId;
  let tc = 0;

  for (let t = 0; t < triCount; t++) {
    const o = triArr[t] * 3;
    for (let k = 0; k < 3; k++) {
      const v = idx[o + k];
      if (stamp[v] !== id) { stamp[v] = id; const v3 = v * 3; nor[v3] = 0; nor[v3 + 1] = 0; nor[v3 + 2] = 0; _touchedList[tc++] = v; }
    }
  }

  for (let t = 0; t < triCount; t++) {
    const o = triArr[t] * 3;
    const a = idx[o] * 3, b = idx[o + 1] * 3, c = idx[o + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const e1x = pos[b] - ax, e1y = pos[b + 1] - ay, e1z = pos[b + 2] - az;
    const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
    nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
    nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
  }

  resetRange();
  for (let i = 0; i < tc; i++) {
    const v = _touchedList[i], v3 = v * 3;
    const x = nor[v3], y = nor[v3 + 1], z = nor[v3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) { const iv = 1 / len; nor[v3] = x * iv; nor[v3 + 1] = y * iv; nor[v3 + 2] = z * iv; }
    track(v);
  }
  _touchedCount = tc;

  if (state.groupMembers.size > 0) averageGroupNormals(nor, tc);
}

function averageGroupNormals(nor, tc) {
  const rep = state.rep;
  const groupMembers = state.groupMembers;
  _doneReps.clear();
  for (let i = 0; i < tc; i++) {
    const r = rep[_touchedList[i]];
    if (_doneReps.has(r)) continue;
    _doneReps.add(r);
    const members = groupMembers.get(r);
    if (!members) continue;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < members.length; k++) { const m3 = members[k] * 3; x += nor[m3]; y += nor[m3 + 1]; z += nor[m3 + 2]; }
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) { const iv = 1 / len; x *= iv; y *= iv; z *= iv; }
    for (let k = 0; k < members.length; k++) { const m = members[k], m3 = m * 3; nor[m3] = x; nor[m3 + 1] = y; nor[m3 + 2] = z; track(m); }
  }
}

// ---------- Upload GPU ----------

function markUpdateRange(attr, vMin, vMax) {
  const start = vMin * attr.itemSize;
  const count = (vMax - vMin + 1) * attr.itemSize;
  if (typeof attr.addUpdateRange === 'function') attr.addUpdateRange(start, count);
  else if (attr.updateRange) { attr.updateRange.offset = start; attr.updateRange.count = count; }
  attr.needsUpdate = true;
}

function addRuns(attr, runs) {
  const dim = attr.itemSize;
  if (typeof attr.addUpdateRange === 'function') {
    for (let i = 0; i < runs.length; i += 2) attr.addUpdateRange(runs[i] * dim, runs[i + 1] * dim);
  } else if (attr.updateRange) {
    attr.updateRange.offset = runs[0] * dim;
    attr.updateRange.count = (runs[runs.length - 2] + runs[runs.length - 1] - runs[0]) * dim;
  }
  attr.needsUpdate = true;
}

function buildRuns(indexSet, maxGap = 32) {
  const sorted = Int32Array.from(indexSet).sort();
  const runs = [];
  if (!sorted.length) return runs;
  let s = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - prev <= maxGap) { prev = sorted[i]; continue; }
    runs.push(s, prev - s + 1);
    s = sorted[i]; prev = sorted[i];
  }
  runs.push(s, prev - s + 1);
  return runs;
}
