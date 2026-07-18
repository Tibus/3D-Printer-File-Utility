// Manager du split : raycast des parois (main, via BVH) + calcul lourd déporté.
// Si SharedArrayBuffer dispo (cross-origin isolated) -> POOL de N workers en
// parallèle (classification + patches par plages). Sinon -> 1 worker (copie).
// Fusion des partiels + parois sur le main. API async avec progression.

import * as THREE from 'three';

const POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
let _pool = null;
let _single = null;
const mkWorker = () => new Worker(new URL('./split-worker.js', import.meta.url), { type: 'module' });
function getPool() { if (!_pool) _pool = Array.from({ length: POOL_SIZE }, mkWorker); return _pool; }
function getSingle() { if (!_single) _single = mkWorker(); return _single; }

// Détruit les workers en cache (après un timeout : le thread peut être bloqué
// dans une boucle -> terminate() le tue et le prochain appel recrée du neuf).
function resetPool() { if (_pool) { for (const w of _pool) w.terminate(); _pool = null; } }
function resetSingle() { if (_single) { _single.terminate(); _single = null; } }

// Timeouts (ms) : garde-fous contre un worker qui ne répond jamais (ex. CDT du
// cap qui boucle sur une coupe dégénérée). Sans ça : spinner infini.
const TO_CLASSIFY = 30000, TO_PATCHES = 30000, TO_FULL = 45000, TO_RETOPO = 20000;

// Attend UN message du worker. `timeout`>0 : rejette après ce délai (et appelle
// onTimeout, typiquement pour tuer le worker bloqué).
function once(worker, { timeout = 0, label = 'worker', onTimeout } = {}) {
  return new Promise((res, rej) => {
    let timer = null;
    const cleanup = () => {
      worker.removeEventListener('message', h);
      worker.removeEventListener('error', eh);
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const h = (e) => { cleanup(); res(e.data); };
    const eh = (e) => { cleanup(); rej(new Error(e.message || `${label} error`)); };
    worker.addEventListener('message', h);
    worker.addEventListener('error', eh);
    if (timeout > 0) timer = setTimeout(() => { cleanup(); if (onTimeout) onTimeout(); rej(new Error(`${label} timeout (${timeout} ms)`)); }, timeout);
  });
}

function toSAB(typedArr) {
  const sab = new SharedArrayBuffer(typedArr.byteLength);
  new typedArr.constructor(sab).set(typedArr);
  return sab;
}

function toGeometryMerged(parts, hasNor, hasUV, hasColor) {
  let vc = 0, ic = 0;
  for (const p of parts) { vc += p.position.length / 3; ic += p.index.length; }
  const pos = new Float32Array(vc * 3);
  const nor = hasNor ? new Float32Array(vc * 3) : null;
  const uv = hasUV ? new Float32Array(vc * 2) : null;
  const col = hasColor ? new Float32Array(vc * 3) : null;
  const idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.position, vo * 3);
    if (nor && p.normal) nor.set(p.normal, vo * 3);
    if (uv && p.uv) uv.set(p.uv, vo * 2);
    if (col && p.color) col.set(p.color, vo * 3);
    for (let k = 0; k < p.index.length; k++) idx[io + k] = p.index[k] + vo;
    vo += p.position.length / 3; io += p.index.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  if (!nor) g.computeVertexNormals();
  return g;
}

// Rééchantillonne le lasso à un pas régulier (px) : plus de colonnes pour le
// raycast -> panneaux fins -> pas de trous sur le concave (la forme est
// identique, on ajoute juste des points le long des segments).
function resampleLasso(pts, step) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segs = Math.max(1, Math.round(Math.hypot(dx, dy) / step));
    for (let s = 0; s < segs; s++) { const t = s / segs; out.push({ x: a.x + dx * t, y: a.y + dy * t }); }
  }
  return out;
}

// Lisse le lasso fermé (moyenne glissante 1-2-1) : supprime le tremblement du
// tracé main qui, près des silhouettes, fait basculer les intervalles et crée
// des pics/trous dans les parois. Conserve le nombre de points.
function smoothLasso(pts, iters) {
  let p = pts.map((q) => ({ x: q.x, y: q.y }));
  const n = p.length;
  if (n < 5) return p;
  for (let it = 0; it < iters; it++) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      out[i] = { x: (a.x + 2 * b.x + c.x) * 0.25, y: (a.y + 2 * b.y + c.y) * 0.25 };
    }
    p = out;
  }
  return p;
}

// Soude les sommets coïncidents (par position) : la surface (patches) et le cap
// partagent alors les mêmes sommets au bord -> maillage manifold, indispensable
// pour re-découper le résultat. Normales moyennées aux sommets fusionnés.
function weldByPosition(g) {
  const pos = g.attributes.position.array;
  const nor = g.attributes.normal ? g.attributes.normal.array : null;
  const uv = g.attributes.uv ? g.attributes.uv.array : null;
  const col = g.attributes.color ? g.attributes.color.array : null;
  const idx = g.index.array;
  const vc = pos.length / 3;
  // vue bit-à-bit des positions : les croisements coïncidents (cap/surface) sont
  // calculés à l'identique -> bit-identiques -> fusionnés sans arrondi ni string.
  const iv = new Int32Array(pos.buffer, pos.byteOffset, pos.length);
  const remap = new Uint32Array(vc);
  const buckets = new Map();               // hash int32 -> liste d'index représentants
  const rep = new Int32Array(vc);          // nouvel index -> ancien index représentant
  let cnt = 0;
  for (let i = 0; i < vc; i++) {
    const x = iv[i * 3], y = iv[i * 3 + 1], z = iv[i * 3 + 2];
    const h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & 0x7fffffff;
    let b = buckets.get(h), found = -1;
    if (b) { for (let k = 0; k < b.length; k++) { const r = b[k]; if (iv[r * 3] === x && iv[r * 3 + 1] === y && iv[r * 3 + 2] === z) { found = b[k]; break; } } }
    if (found >= 0) { remap[i] = remap[found]; }
    else { if (!b) { b = []; buckets.set(h, b); } b.push(i); rep[cnt] = i; remap[i] = cnt++; }
  }
  const nP = new Float32Array(cnt * 3), nN = nor ? new Float32Array(cnt * 3) : null, nU = uv ? new Float32Array(cnt * 2) : null, nC = col ? new Float32Array(cnt * 3) : null;
  for (let v = 0; v < cnt; v++) {
    const i = rep[v];
    nP[v * 3] = pos[i * 3]; nP[v * 3 + 1] = pos[i * 3 + 1]; nP[v * 3 + 2] = pos[i * 3 + 2];
    if (nU) { nU[v * 2] = uv[i * 2]; nU[v * 2 + 1] = uv[i * 2 + 1]; }
    if (nC) { nC[v * 3] = col[i * 3]; nC[v * 3 + 1] = col[i * 3 + 1]; nC[v * 3 + 2] = col[i * 3 + 2]; }
  }
  // normales : accumule (moyenne aux sommets fusionnés) puis normalise
  if (nN) { for (let i = 0; i < vc; i++) { const v = remap[i]; nN[v * 3] += nor[i * 3]; nN[v * 3 + 1] += nor[i * 3 + 1]; nN[v * 3 + 2] += nor[i * 3 + 2]; } for (let v = 0; v < cnt; v++) { const l = Math.hypot(nN[v * 3], nN[v * 3 + 1], nN[v * 3 + 2]) || 1; nN[v * 3] /= l; nN[v * 3 + 1] /= l; nN[v * 3 + 2] /= l; } }
  const nIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) nIdx[i] = remap[idx[i]];
  const g2 = new THREE.BufferGeometry();
  g2.setAttribute('position', new THREE.BufferAttribute(nP, 3));
  if (nN) g2.setAttribute('normal', new THREE.BufferAttribute(nN, 3));
  if (nU) g2.setAttribute('uv', new THREE.BufferAttribute(nU, 2));
  if (nC) g2.setAttribute('color', new THREE.BufferAttribute(nC, 3));
  g2.setIndex(new THREE.BufferAttribute(nIdx, 1));
  return g2;
}

// Raycast des colonnes du lasso (via BVH, DoubleSide). La profondeur `d` de
// chaque impact est mesurée le long de l'AXE CAMÉRA (profondeur vue), pas le
// long du rayon : ainsi une même surface a une profondeur stable d'une colonne
// à l'autre, même quand le lasso zigzague (rayons de directions différentes).
function raycastColumns(geometry, lassoPx, U, vw, vh, camPos, camFwd) {
  const bvh = geometry.boundsTree;
  if (!bvh) return null;
  const nearV = new THREE.Vector3(), farV = new THREE.Vector3();
  const ray = new THREE.Ray();
  const cols = [];
  for (let i = 0; i < lassoPx.length; i++) {
    const ndcx = (lassoPx[i].x / vw) * 2 - 1, ndcy = -(lassoPx[i].y / vh) * 2 + 1;
    nearV.set(ndcx, ndcy, -1).applyMatrix4(U);
    farV.set(ndcx, ndcy, 1).applyMatrix4(U);
    ray.origin.copy(nearV);
    ray.direction.copy(farV).sub(nearV).normalize();
    const hits = bvh.raycast(ray, THREE.DoubleSide);
    const mapped = hits.map((h) => ({
      p: [h.point.x, h.point.y, h.point.z],
      d: (h.point.x - camPos.x) * camFwd.x + (h.point.y - camPos.y) * camFwd.y + (h.point.z - camPos.z) * camFwd.z,
    }));
    mapped.sort((a, b) => a.d - b.d);
    cols.push(mapped);
  }
  return cols;
}

// Intervalles intérieurs (pair-impair) d'une colonne, avec leur plage de
// profondeur le long du rayon : {e, x, d0, d1}.
function intervalsOf(hits) {
  const out = [];
  for (let k = 0; k + 1 < hits.length; k += 2) {
    out.push({ e: hits[k].p, x: hits[k + 1].p, d0: hits[k].d, d1: hits[k + 1].d });
  }
  return out;
}

// Partiel "parois" : relie deux intervalles de colonnes adjacentes uniquement
// s'ils SE RECOUVRENT EN PROFONDEUR (le long du rayon). Un intervalle peut
// se connecter à plusieurs (scission/fusion du tube), et jamais à un intervalle
// éloigné -> pas de trou aux transitions ET pas de triangle parasite/pic.
function buildWallPartial(cols, detail, hasUV, hasColor) {
  const pos = [], idx = [];
  const uv = hasUV ? [] : null, col = hasColor ? [] : null;
  let count = 0;
  const vert = (x, y, z) => { pos.push(x, y, z); if (uv) uv.push(0, 0); if (col) col.push(0.8, 0.8, 0.8); return count++; };
  const panel = (a, b) => {
    let prevA = -1, prevB = -1;
    for (let r = 0; r <= detail; r++) {
      const t = r / detail;
      const va = vert(a.e[0] + (a.x[0] - a.e[0]) * t, a.e[1] + (a.x[1] - a.e[1]) * t, a.e[2] + (a.x[2] - a.e[2]) * t);
      const vb = vert(b.e[0] + (b.x[0] - b.e[0]) * t, b.e[1] + (b.x[1] - b.e[1]) * t, b.e[2] + (b.x[2] - b.e[2]) * t);
      if (r > 0) { idx.push(prevA, prevB, vb); idx.push(prevA, vb, va); }
      prevA = va; prevB = vb;
    }
  };

  // Score d'appariement : recouvrement en profondeur si positif (correspondance
  // sûre), sinon proximité des profondeurs (négatif, toujours < tout recouvrement).
  const md = (iv) => (iv.d0 + iv.d1) * 0.5;
  const score = (a, b) => {
    const ov = Math.min(a.d1, b.d1) - Math.max(a.d0, b.d0);
    return ov > 0 ? ov : -Math.abs(md(a) - md(b)) - 1e9;
  };
  const best = (iv, list) => {
    let bi = -1, bs = -Infinity;
    for (let j = 0; j < list.length; j++) { const s = score(iv, list[j]); if (s > bs) { bs = s; bi = j; } }
    return bi;
  };

  const nl = cols.length;
  for (let i = 0; i < nl; i++) {
    const A = intervalsOf(cols[i]);
    const B = intervalsOf(cols[(i + 1) % nl]);
    if (!A.length || !B.length) continue;
    const done = new Set();
    // chaque intervalle de A rejoint son meilleur dans B, et réciproquement :
    // tout intervalle est relié (pas de trou), en privilégiant le recouvrement (pas de pic).
    for (let a = 0; a < A.length; a++) { const b = best(A[a], B); if (b >= 0) { done.add(a + '|' + b); panel(A[a], B[b]); } }
    for (let b = 0; b < B.length; b++) { const a = best(B[b], A); if (a >= 0 && !done.has(a + '|' + b)) panel(A[a], B[b]); }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return {
    position: g.attributes.position.array,
    normal: g.attributes.normal.array,
    uv: uv ? new Float32Array(uv) : null,
    color: col ? new Float32Array(col) : null,
    index: new Uint32Array(idx),
  };
}

async function splitPooled(bufs, M, lasso, vw, vh, onProgress) {
  const pool = getPool();
  const N = pool.length;
  const { posArr, norArr, uvArr, colArr, idxArr, vCount } = bufs;

  const posSAB = toSAB(posArr);
  const norSAB = norArr ? toSAB(norArr) : null;
  const uvSAB = uvArr ? toSAB(uvArr) : null;
  const colSAB = colArr ? toSAB(colArr) : null;
  const idx32 = idxArr instanceof Uint32Array;
  const idxSAB = toSAB(idxArr);
  const insideSAB = new SharedArrayBuffer(vCount);
  const sxSAB = new SharedArrayBuffer(vCount * 4);
  const sySAB = new SharedArrayBuffer(vCount * 4);
  if (onProgress) onProgress(0.2);

  // Phase 1 : classification (plages de vertices)
  const vChunk = Math.ceil(vCount / N);
  const cTasks = [];
  for (let i = 0; i < N; i++) {
    const start = i * vChunk, end = Math.min(vCount, (i + 1) * vChunk);
    if (start >= end) break;
    pool[i].postMessage({ type: 'classify', posSAB, M, lasso, vw, vh, insideSAB, sxSAB, sySAB, start, end });
    cTasks.push(once(pool[i], { timeout: TO_CLASSIFY, label: 'classify', onTimeout: resetPool }));
  }
  await Promise.all(cTasks);
  if (onProgress) onProgress(0.55);

  // Phase 2 : patches (plages de triangles)
  const triTotal = idxArr.length;
  const triChunk = Math.max(3, Math.ceil(triTotal / N / 3) * 3);
  const pTasks = [];
  for (let i = 0; i < N; i++) {
    const start = i * triChunk, end = Math.min(triTotal, (i + 1) * triChunk);
    if (start >= end) break;
    pool[i].postMessage({ type: 'patches', posSAB, norSAB, uvSAB, colSAB, idxSAB, idx32, insideSAB, sxSAB, sySAB, lasso, vCount, start, end });
    pTasks.push(once(pool[i], { timeout: TO_PATCHES, label: 'patches', onTimeout: resetPool }));
  }
  const results = await Promise.all(pTasks);
  if (onProgress) onProgress(0.9);
  return results.map((r) => ({ A: r.A, B: r.B, cutKA: r.cutKA, cutKB: r.cutKB, cutPos: r.cutPos }));
}

async function splitSingle(bufs, M, lasso, vw, vh) {
  const w = getSingle();
  const { posArr, norArr, uvArr, colArr, idxArr } = bufs;
  w.postMessage({ type: 'full', position: posArr, normal: norArr, uv: uvArr, color: colArr, index: idxArr, M, lasso, vw, vh });
  const r = await once(w, { timeout: TO_FULL, label: 'split', onTimeout: resetSingle });
  if (r.type === 'error') throw new Error(r.message);
  return [{ A: r.A, B: r.B, cutKA: r.cutKA, cutKB: r.cutKB, cutPos: r.cutPos }];
}

// Arc-length d'un pixel projeté sur la polyligne du lasso (fermée).
function makeArcLength(lasso) {
  const n = lasso.length;
  const cum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = lasso[i], b = lasso[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return (px, py) => {
    let bs = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = lasso[i], b = lasso[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy || 1e-9;
      let t = ((px - a.x) * dx + (py - a.y) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a.x + dx * t, qy = a.y + dy * t;
      const dist = (px - qx) ** 2 + (py - qy) ** 2;
      if (dist < bd) { bd = dist; bs = cum[i] + t * (cum[i + 1] - cum[i]); }
    }
    return bs;
  };
}

// Reconstruit les boucles frontière à partir des arêtes de coupe des workers.
// Retourne { pos, S, D, loops } : positions 3D des croisements (dédupliqués),
// leur (s = arc-length lasso, d = profondeur vue), et les boucles (listes d'ids).
function buildCutLoops(partials, Marr, lasso, vw, vh, camPos, camFwd) {
  const idOf = new Map();          // edgeKey -> id
  const posX = [], posY = [], posZ = [];
  const arc = makeArcLength(lasso);
  const e = Marr;
  const getId = (key, x, y, z) => {
    let id = idOf.get(key);
    if (id !== undefined) return id;
    id = posX.length; idOf.set(key, id);
    posX.push(x); posY.push(y); posZ.push(z);
    return id;
  };
  const adjA = [], adjB = [];       // jusqu'à 2 voisins par croisement
  const addAdj = (u, v) => { if (adjA[u] === undefined) adjA[u] = v; else if (adjB[u] === undefined) adjB[u] = v; };

  for (const p of partials) {
    const kA = p.cutKA, kB = p.cutKB, cp = p.cutPos;
    if (!kA) continue;
    for (let i = 0; i < kA.length; i++) {
      const o = i * 6;
      const a = getId(kA[i], cp[o], cp[o + 1], cp[o + 2]);
      const b = getId(kB[i], cp[o + 3], cp[o + 4], cp[o + 5]);
      addAdj(a, b); addAdj(b, a);
    }
  }

  const nc = posX.length;
  const S = new Float32Array(nc), D = new Float32Array(nc);
  for (let i = 0; i < nc; i++) {
    const x = posX[i], y = posY[i], z = posZ[i];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const ndcx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
    const ndcy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
    S[i] = arc((ndcx * 0.5 + 0.5) * vw, (-ndcy * 0.5 + 0.5) * vh);
    D[i] = (x - camPos.x) * camFwd.x + (y - camPos.y) * camFwd.y + (z - camPos.z) * camFwd.z;
  }

  // trace les boucles (chaque croisement a degré 2 si le maillage est manifold)
  const seen = new Uint8Array(nc);
  const loops = [];
  let deg1 = 0, degBad = 0;
  for (let i = 0; i < nc; i++) if (adjB[i] === undefined) deg1++;
  for (let start = 0; start < nc; start++) {
    if (seen[start] || adjA[start] === undefined) continue;
    const loop = []; let prev = -1, cur = start, guard = 0;
    while (cur !== undefined && !seen[cur] && guard++ < nc + 1) {
      seen[cur] = 1; loop.push(cur);
      const nx = (adjA[cur] !== prev && adjA[cur] !== undefined && !seen[adjA[cur]]) ? adjA[cur]
        : (adjB[cur] !== prev && adjB[cur] !== undefined && !seen[adjB[cur]]) ? adjB[cur] : undefined;
      prev = cur; cur = nx;
    }
    if (loop.length >= 3) loops.push(loop); else degBad++;
  }

  let L = 0;
  for (let i = 0; i < lasso.length; i++) { const a = lasso[i], b = lasso[(i + 1) % lasso.length]; L += Math.hypot(b.x - a.x, b.y - a.y); }

  const pos = new Float32Array(nc * 3);
  for (let i = 0; i < nc; i++) { pos[i * 3] = posX[i]; pos[i * 3 + 1] = posY[i]; pos[i * 3 + 2] = posZ[i]; }
  return {
    pos, S, D, loops, L,
    stats: { crossings: nc, loops: loops.length, deg1, degBad, loopLens: loops.map((l) => l.length).sort((a, b) => b - a).slice(0, 8) },
  };
}

// Triangule les parois à partir des boucles de coupe (sommets = croisements
// exacts, partagés avec la surface -> étanche). Cas traité : boucles qui font
// le TOUR du lasso (bandes), appariées par profondeur et cousues (zip).
// Retourne un partiel {position,...} ou null si non applicable.
// Construit un partiel paroi depuis positions + triangles (sommets = croisements).
function wallPartial(pos, tris, hasUV, hasColor) {
  if (!tris.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(tris);
  g.computeVertexNormals();
  const uv = hasUV ? new Float32Array((pos.length / 3) * 2) : null;
  const col = hasColor ? new Float32Array(pos.length).fill(0.8) : null;
  return { position: pos, normal: g.attributes.normal.array, uv, color: col, index: new Uint32Array(tris) };
}

// Cas rapide : boucles qui font le TOUR du lasso (bandes), cousues par zip.
function wrapZipWalls(loopData, hasUV, hasColor) {
  const { pos, S, D, loops, L } = loopData;
  const tris = [];

  // classe chaque boucle : "wrapping" (fait le tour) ou "bubble" (locale)
  const wrap = [];
  for (const loop of loops) {
    let ds = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      let d = S[b] - S[a];
      if (d > L * 0.5) d -= L; else if (d < -L * 0.5) d += L;
      ds += d;
    }
    if (Math.abs(Math.abs(ds) - L) < L * 0.25) { // fait ~un tour
      const sorted = loop.slice().sort((x, y) => S[x] - S[y]);
      wrap.push(sorted);
    }
  }
  if (wrap.length < 2 || wrap.length % 2 !== 0) return null; // cas non géré -> fallback

  // profondeur d'une boucle wrapping à une abscisse s (interp linéaire)
  const dAtS = (sorted, s) => {
    let lo = sorted[0], hi = sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length; i++) {
      if (S[sorted[i]] <= s) lo = sorted[i];
      if (S[sorted[i]] >= s) { hi = sorted[i]; break; }
    }
    const sl = S[lo], sh = S[hi]; const t = sh > sl ? (s - sl) / (sh - sl) : 0;
    return D[lo] + (D[hi] - D[lo]) * t;
  };
  const refS = S[wrap[0][0]];
  wrap.sort((a, b) => dAtS(a, refS) - dAtS(b, refS));

  // apparie (0,1),(2,3),... = intervalles intérieurs pair-impair, et coud
  for (let k = 0; k + 1 < wrap.length; k += 2) {
    const lower = wrap[k], upper = wrap[k + 1];
    // fusion par s des sommets des deux bords -> bande de triangles
    const merged = [];
    for (const id of lower) merged.push({ id, s: S[id], side: 0 });
    for (const id of upper) merged.push({ id, s: S[id], side: 1 });
    merged.sort((a, b) => a.s - b.s);
    let curL = lower[0], curU = upper[0];
    const startL = curL, startU = curU;
    for (const m of merged) {
      if (m.id === startL || m.id === startU) continue;
      if (m.side === 0) { tris.push(curL, m.id, curU); curL = m.id; }
      else { tris.push(curU, curL, m.id); curU = m.id; }
    }
    // ferme le tour
    tris.push(curL, startL, curU);
    tris.push(startL, startU, curU);
  }

  return wallPartial(pos, tris, hasUV, hasColor);
}

// Cas général : balayage en s. Suit exactement les arêtes de coupe ; à chaque
// tranche, pair-impair des arêtes actives -> intervalles intérieurs -> quads.
// Gère bandes + bulles + concave (le pants). Sommets sur les arêtes exactes.
function sweepFillWalls(loopData, hasUV, hasColor) {
  const { pos, S, D, loops, L } = loopData;
  const half = L * 0.5;
  const EA = [], EB = [];
  for (const loop of loops) for (let i = 0; i < loop.length; i++) { EA.push(loop[i]); EB.push(loop[(i + 1) % loop.length]); }
  const ne = EA.length;
  if (ne === 0) return null;

  // endpoints s de chaque arête, dans un repère sans saut (wrap-aware)
  const sA = new Float32Array(ne), sB = new Float32Array(ne), lo = new Float32Array(ne), hi = new Float32Array(ne);
  for (let e = 0; e < ne; e++) {
    let a = S[EA[e]], b = S[EB[e]];
    if (b - a > half) b -= L; else if (a - b > half) b += L;
    sA[e] = a; sB[e] = b; lo[e] = Math.min(a, b); hi[e] = Math.max(a, b);
  }
  const paramAt = (e, s) => {
    let ss = s; if (ss < lo[e] - 1e-4) ss += L; else if (ss > hi[e] + 1e-4) ss -= L;
    if (ss < lo[e] - 1e-4 || ss > hi[e] + 1e-4) return -1;
    return (ss - sA[e]) / (sB[e] - sA[e]);
  };

  // colonnes = abscisses s uniques des croisements
  const sset = new Set(); for (const loop of loops) for (const id of loop) sset.add(S[id]);
  const scol = Array.from(sset).sort((a, b) => a - b);
  const cols = [scol[0]];
  for (let i = 1; i < scol.length; i++) if (scol[i] - cols[cols.length - 1] > 1e-4) cols.push(scol[i]);
  const nCol = cols.length;
  if (nCol < 2) return null;

  // sommets paroi dédupliqués par (arête, colonne)
  const vmap = new Map(); const P = []; let vc = 0;
  const vert = (e, col) => {
    const key = e * nCol + col;
    let v = vmap.get(key); if (v !== undefined) return v;
    let t = paramAt(e, cols[col]); t = t < 0 ? 0 : t > 1 ? 1 : t;
    const a = EA[e], b = EB[e];
    P.push(pos[a * 3] + (pos[b * 3] - pos[a * 3]) * t,
      pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t,
      pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t);
    v = vc++; vmap.set(key, v); return v;
  };

  const tris = [];
  const emit = (c0, c1, sMid) => {
    const act = [];
    for (let e = 0; e < ne; e++) { const t = paramAt(e, sMid); if (t > 1e-5 && t < 1 - 1e-5) act.push([D[EA[e]] + (D[EB[e]] - D[EA[e]]) * t, e]); }
    act.sort((x, y) => x[0] - y[0]);
    for (let k = 0; k + 1 < act.length; k += 2) {
      const eL = act[k][1], eH = act[k + 1][1];
      const l0 = vert(eL, c0), l1 = vert(eL, c1), h0 = vert(eH, c0), h1 = vert(eH, c1);
      tris.push(l0, l1, h1, l0, h1, h0);
    }
  };
  for (let c = 0; c + 1 < nCol; c++) emit(c, c + 1, (cols[c] + cols[c + 1]) * 0.5);
  emit(nCol - 1, 0, ((cols[nCol - 1] + cols[0] + L) * 0.5) % L); // referme le tour

  return wallPartial(new Float32Array(P), tris, hasUV, hasColor);
}

// Lance le retopo du cap (Delaunay + CDT) dans un worker -> ne gèle pas l'UI.
async function retopoInWorker(loopData, ctx) {
  const w = getSingle();
  const loopsFlat = [], loopLens = [];
  for (const loop of loopData.loops) { loopLens.push(loop.length); for (const id of loop) loopsFlat.push(id); }
  const lassoXY = new Float32Array(ctx.lasso.length * 2);
  for (let i = 0; i < ctx.lasso.length; i++) { lassoXY[i * 2] = ctx.lasso[i].x; lassoXY[i * 2 + 1] = ctx.lasso[i].y; }
  w.postMessage({
    type: 'retopo',
    pos: loopData.pos, S: loopData.S, D: loopData.D,
    loopsFlat: Int32Array.from(loopsFlat), loopLens: Int32Array.from(loopLens), L: loopData.L,
    lassoXY, U: new Float32Array(ctx.U.elements),
    camPos: { x: ctx.camPos.x, y: ctx.camPos.y, z: ctx.camPos.z }, camFwd: { x: ctx.camFwd.x, y: ctx.camFwd.y, z: ctx.camFwd.z },
    vw: ctx.vw, vh: ctx.vh, detail: ctx.detail,
  });
  try {
    const r = await once(w, { timeout: TO_RETOPO, label: 'retopo', onTimeout: resetSingle });
    if (r.type === 'error') throw new Error(r.message);
    return r.position ? { position: r.position, index: r.index, failed: r.failed, repaired: r.repaired, capStats: r.capStats } : null;
  } catch (err) {
    // Timeout (CDT bloqué) : on renvoie null -> parois par fallback géométrique.
    if (/timeout/.test(err.message)) { globalThis.__wallDebug = { ...(globalThis.__wallDebug || {}), retopoTimeout: true }; return null; }
    throw err;
  }
}

// Partiel cap (avec normales) depuis la sortie brute du worker.
function capPartialFromRaw(raw, hasUV, hasColor) {
  if (!raw || !raw.index.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(raw.position, 3));
  g.setIndex(new THREE.BufferAttribute(raw.index, 1));
  g.computeVertexNormals();
  const uv = hasUV ? new Float32Array((raw.position.length / 3) * 2) : null;
  const col = hasColor ? new Float32Array(raw.position.length).fill(0.8) : null;
  return { position: raw.position, normal: g.attributes.normal.array, uv, color: col, index: raw.index };
}

export async function lassoSplitAsync(geometry, lassoPx, camera, matrixWorld, vw, vh, detail, onProgress) {
  if (lassoPx.length < 3) return null;
  camera.updateMatrixWorld();
  const M = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(matrixWorld);
  const U = new THREE.Matrix4().multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);

  // Densifie puis lisse le lasso (anti-tremblement). Le MÊME lasso lissé sert
  // aux parois (raycast) ET à la classification -> couture cohérente, pas de pic.
  const T = (typeof performance !== 'undefined') ? () => performance.now() : () => 0;
  const st = {}; let t0 = T();
  const lassoSmooth = smoothLasso(resampleLasso(lassoPx, 3), 4);
  const camPos = new THREE.Vector3(); camera.getWorldPosition(camPos);
  const camFwd = new THREE.Vector3(); camera.getWorldDirection(camFwd);
  if (onProgress) onProgress(0.05);

  const g = geometry;
  const hasNor = !!g.attributes.normal, hasUV = !!g.attributes.uv, hasColor = !!g.attributes.color;

  const bufs = {
    posArr: g.attributes.position.array,
    norArr: hasNor ? g.attributes.normal.array : null,
    uvArr: hasUV ? g.attributes.uv.array : null,
    colArr: hasColor ? g.attributes.color.array : null,
    idxArr: g.index.array,
    vCount: g.attributes.position.count,
  };
  const lasso = lassoSmooth.map((p) => ({ x: p.x, y: p.y }));
  const Marr = M.elements;

  let partials;
  const canSAB = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated;
  if (canSAB && POOL_SIZE > 1) {
    partials = await splitPooled(bufs, Marr, lasso, vw, vh, onProgress);
  } else {
    partials = await splitSingle(bufs, Marr, lasso, vw, vh);
    if (onProgress) onProgress(0.9);
  }
  st.classifyPatches = T() - t0; t0 = T();

  // Reconstruction des parois. Le retopo lourd (Delaunay + CDT du cap) tourne
  // dans un WORKER -> l'UI ne gèle pas pendant le calcul.
  let wallFinal = null;
  try {
    const loopData = buildCutLoops(partials, Marr, lasso, vw, vh, camPos, camFwd);
    globalThis.__wallDebug = loopData.stats;
    if (onProgress) onProgress(0.93);
    const ctx = { lasso: lassoSmooth, U, camPos, camFwd, vw, vh, detail };
    const raw = await retopoInWorker(loopData, ctx);
    wallFinal = capPartialFromRaw(raw, hasUV, hasColor);
    if (!wallFinal) wallFinal = wrapZipWalls(loopData, hasUV, hasColor) || sweepFillWalls(loopData, hasUV, hasColor);
    globalThis.__wallDebug.mode = raw ? 'worker-cdt' : (wallFinal ? 'fallback' : 'none');
    if (raw) { globalThis.__wallDebug.capFailed = raw.failed; globalThis.__wallDebug.repaired = raw.repaired; globalThis.__wallDebug.capStats = raw.capStats; }
  } catch (err) { globalThis.__wallDebug = { error: String(err && err.message || err) }; }
  st.walls = T() - t0; t0 = T();

  // Dernier recours : parois raycast si tout le reste a échoué.
  if (!wallFinal) {
    const cols = raycastColumns(geometry, lassoSmooth, U, vw, vh, camPos, camFwd);
    if (cols) wallFinal = buildWallPartial(cols, Math.max(1, detail | 0), hasUV, hasColor);
  }
  if (!wallFinal) return null;

  const inside0 = toGeometryMerged(partials.map((p) => p.A).concat([wallFinal]), hasNor, hasUV, hasColor);
  const outside0 = toGeometryMerged(partials.map((p) => p.B).concat([wallFinal]), hasNor, hasUV, hasColor);
  st.merge = T() - t0; t0 = T();
  // soudure par position -> maillage manifold (surface + cap partagent le bord),
  // nécessaire pour pouvoir re-découper le résultat.
  const inside = weldByPosition(inside0);
  const outside = weldByPosition(outside0);
  st.weld = T() - t0;
  globalThis.__splitTimes = st;
  if (onProgress) onProgress(1);

  if (inside.index.count === 0 || outside.index.count === 0) return null;
  return { inside, outside };
}
