// Dépliage UV automatique (sans dépendance) : découpe le maillage en « charts » QUASI-PLANS (croissance de
// région par similarité de normale + adjacence, bornée par la normale de départ -> pas d'enroulement/repli),
// projette chaque chart sur son plan moyen (projection planaire -> pas de recouvrement dans un chart), puis
// empaquette tous les charts SERRÉS (binary-tree, façon lightmap) dans le carré UV avec une échelle UNIFORME
// (densité de texels homogène, pas de distorsion). Sortie = géométrie NON INDEXÉE (uv par coin) -> bijective.
//
// La géométrie est dé-indexée (3 sommets par triangle) : le sculpt re-soude logiquement par position
// (buildTopology) pour les normales lisses et les brosses. Positions/normales/couleurs sont préservées.

import * as THREE from 'three';

const _EPS = 1e-9;

// Soudure par position (quantifiée) -> id de sommet logique, pour l'adjacence de faces.
function weldIndex(pos, count) {
  const map = new Map(), rep = new Int32Array(count), Q = 1e4;
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[i * 3] * Q)},${Math.round(pos[i * 3 + 1] * Q)},${Math.round(pos[i * 3 + 2] * Q)}`;
    const r = map.get(key);
    if (r === undefined) { map.set(key, i); rep[i] = i; } else rep[i] = r;
  }
  return rep;
}

// Renvoie une nouvelle BufferGeometry NON INDEXÉE avec un attribut `uv`, ou null si échec.
export function unwrapUVs(geometry, opts = {}) {
  const angleDeg = opts.angle != null ? opts.angle : 35;   // écart max face voisine / normale moyenne du chart
  const seedDeg = opts.seed != null ? opts.seed : 65;      // écart max face / normale de départ (empêche le chart de s'enrouler -> pas de repli/recouvrement)
  const cosThr = Math.cos(THREE.MathUtils.degToRad(angleDeg));
  const cosSeed = Math.cos(THREE.MathUtils.degToRad(seedDeg));
  const src = geometry;
  const posAttr = src.attributes.position;
  if (!posAttr) return null;

  // Triangles (indices de sommets d'origine).
  const idx = src.index ? src.index.array : null;
  const triCount = idx ? idx.length / 3 : posAttr.count / 3;
  if (triCount < 1) return null;
  const corner = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k); // index de sommet d'origine du coin k du tri t

  const pos = posAttr.array;
  const rep = weldIndex(pos, posAttr.count);

  // Normales de face + adjacence par arête (sur sommets soudés).
  const fN = new Float32Array(triCount * 3);
  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  const edgeMap = new Map(); // "a_b" (a<b) -> [face,...]
  const faceEdges = [];
  for (let t = 0; t < triCount; t++) {
    const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
    ax.fromArray(pos, a * 3); bx.fromArray(pos, b * 3); cx.fromArray(pos, c * 3);
    e1.subVectors(bx, ax); e2.subVectors(cx, ax); nrm.crossVectors(e1, e2);
    if (nrm.lengthSq() < _EPS) nrm.set(0, 1, 0); else nrm.normalize();
    nrm.toArray(fN, t * 3);
    const ra = rep[a], rb = rep[b], rc = rep[c];
    const es = [[ra, rb], [rb, rc], [rc, ra]];
    faceEdges.push(es);
    for (const [u, v] of es) { const key = u < v ? u + '_' + v : v + '_' + u; let arr = edgeMap.get(key); if (!arr) edgeMap.set(key, arr = []); arr.push(t); }
  }
  const neighbors = (t) => {
    const out = [];
    for (const [u, v] of faceEdges[t]) { const key = u < v ? u + '_' + v : v + '_' + u; const arr = edgeMap.get(key); if (arr) for (const f of arr) if (f !== t) out.push(f); }
    return out;
  };

  // Croissance de région : charts de faces à normale cohérente.
  const chartOf = new Int32Array(triCount).fill(-1);
  const charts = []; // { faces:[], n:Vector3 }
  const stack = [];
  for (let s = 0; s < triCount; s++) {
    if (chartOf[s] !== -1) continue;
    const ci = charts.length;
    const cN = new THREE.Vector3().fromArray(fN, s * 3);
    const seedN = cN.clone();
    const chart = { faces: [], n: cN };
    charts.push(chart);
    chartOf[s] = ci; chart.faces.push(s); stack.length = 0; stack.push(s);
    const fn = new THREE.Vector3();
    while (stack.length) {
      const t = stack.pop();
      for (const nb of neighbors(t)) {
        if (chartOf[nb] !== -1) continue;
        fn.fromArray(fN, nb * 3);
        // proche de la normale MOYENNE du chart ET pas trop loin de la normale de DÉPART (évite l'enroulement -> repli).
        if (fn.dot(chart.n) >= cosThr && fn.dot(seedN) >= cosSeed) { chartOf[nb] = ci; chart.faces.push(nb); chart.n.add(fn).normalize(); stack.push(nb); }
      }
    }
  }

  // Projection planaire par chart + bbox 2D.
  const T = new THREE.Vector3(), B = new THREE.Vector3(), helper = new THREE.Vector3(), p = new THREE.Vector3();
  const cornerUV = new Float32Array(triCount * 3 * 2); // uv brut (plan du chart) par coin
  for (const ch of charts) {
    const N = ch.n;
    helper.set(Math.abs(N.x) < 0.9 ? 1 : 0, Math.abs(N.x) < 0.9 ? 0 : 1, 0);
    T.crossVectors(helper, N); if (T.lengthSq() < _EPS) T.set(1, 0, 0); else T.normalize();
    B.crossVectors(N, T).normalize();
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const t of ch.faces) {
      for (let k = 0; k < 3; k++) {
        p.fromArray(pos, corner(t, k) * 3);
        const u = p.dot(T), v = p.dot(B);
        const o = (t * 3 + k) * 2; cornerUV[o] = u; cornerUV[o + 1] = v;
        if (u < minU) minU = u; if (v < minV) minV = v; if (u > maxU) maxU = u; if (v > maxV) maxV = v;
      }
    }
    ch.min = [minU, minV]; ch.w = Math.max(maxU - minU, 1e-5); ch.h = Math.max(maxV - minV, 1e-5);
  }

  // Empaquetage SERRÉ (binary-tree, façon lightmap) puis normalisation NON UNIFORME -> remplit tout le
  // carré UV (maximise l'usage de la texture), avec une petite marge par chart contre le bleeding.
  let area = 0; for (const ch of charts) area += ch.w * ch.h;
  const pad = (Math.sqrt(area) || 1) * 0.02;
  const list = charts.slice().sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
  for (const ch of list) { ch.rw = ch.w + pad; ch.rh = ch.h + pad; }
  const findNode = (node, w, h) => {
    if (node.used) return findNode(node.right, w, h) || findNode(node.down, w, h);
    if (w <= node.w && h <= node.h) return node;
    return null;
  };
  const splitNode = (node, w, h) => {
    node.used = true;
    node.down = { x: node.x, y: node.y + h, w: node.w, h: node.h - h, used: false };
    node.right = { x: node.x + w, y: node.y, w: node.w - w, h, used: false };
    return node;
  };
  let root = { x: 0, y: 0, w: list[0].rw, h: list[0].rh, used: false };
  const growRight = (w, h) => { root = { used: true, x: 0, y: 0, w: root.w + w, h: root.h, down: root, right: { x: root.w, y: 0, w, h: root.h, used: false } }; const n = findNode(root, w, h); return n ? splitNode(n, w, h) : null; };
  const growDown = (w, h) => { root = { used: true, x: 0, y: 0, w: root.w, h: root.h + h, right: root, down: { x: 0, y: root.h, w: root.w, h, used: false } }; const n = findNode(root, w, h); return n ? splitNode(n, w, h) : null; };
  const growNode = (w, h) => {
    const canDown = w <= root.w, canRight = h <= root.h;
    if (canRight && root.h >= root.w + w) return growRight(w, h);
    if (canDown && root.w >= root.h + h) return growDown(w, h);
    if (canRight) return growRight(w, h);
    if (canDown) return growDown(w, h);
    return null;
  };
  for (const ch of list) {
    let node = findNode(root, ch.rw, ch.rh);
    node = node ? splitNode(node, ch.rw, ch.rh) : growNode(ch.rw, ch.rh);
    ch.px = node ? node.x : 0; ch.py = node ? node.y : 0;
  }
  const s = 1 / (Math.max(root.w, root.h) || 1); // UNIFORME -> pas de distorsion (le bin binary-tree est ~carré)

  // Géométrie de sortie NON INDEXÉE : position/normal/color d'origine + uv empaquetée, par coin.
  const V = triCount * 3;
  const outPos = new Float32Array(V * 3);
  const srcNor = src.attributes.normal ? src.attributes.normal.array : null;
  const srcCol = src.attributes.color ? src.attributes.color.array : null;
  const outNor = srcNor ? new Float32Array(V * 3) : null;
  const outCol = srcCol ? new Float32Array(V * 3) : null;
  const outUV = new Float32Array(V * 2);
  for (let t = 0; t < triCount; t++) {
    const ch = charts[chartOf[t]];
    for (let k = 0; k < 3; k++) {
      const srcI = corner(t, k), vi = t * 3 + k;
      outPos[vi * 3] = pos[srcI * 3]; outPos[vi * 3 + 1] = pos[srcI * 3 + 1]; outPos[vi * 3 + 2] = pos[srcI * 3 + 2];
      if (outNor) { outNor[vi * 3] = srcNor[srcI * 3]; outNor[vi * 3 + 1] = srcNor[srcI * 3 + 1]; outNor[vi * 3 + 2] = srcNor[srcI * 3 + 2]; }
      if (outCol) { outCol[vi * 3] = srcCol[srcI * 3]; outCol[vi * 3 + 1] = srcCol[srcI * 3 + 1]; outCol[vi * 3 + 2] = srcCol[srcI * 3 + 2]; }
      const o = vi * 2;
      outUV[o] = ((cornerUV[o] - ch.min[0]) + ch.px) * s;
      outUV[o + 1] = ((cornerUV[o + 1] - ch.min[1]) + ch.py) * s;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outNor) g.setAttribute('normal', new THREE.BufferAttribute(outNor, 3));
  if (outCol) g.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(outUV, 2));
  if (!outNor) g.computeVertexNormals();
  return { geometry: g, charts: charts.length };
}
