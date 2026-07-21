// Chargement de modèles arbitraires (GLB/GLTF, OBJ, STL, FBX, 3MF).
// Trois rendus (choisis automatiquement) :
//  - texturé  : préserve UV + matériau/texture (MeshStandardMaterial + map).
//  - couleurs : préserve les vertex colors, rendu comme le viewer3D
//               (MeshLambertMaterial vertexColors + DoubleSide, black-lift 0.12).
//  - clay     : soudure position-only, peu de vertices, meilleures perfs.
//
// Une carte de soudure par position co-déplace les vertices coïncidents (coutures
// UV / frontières de couleur) pour éviter les fissures pendant la sculpture.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { pushAction, clearHistory } from './history.js';
import { displayMaterial } from './display.js';
import { state } from './state.js';
import { setStatus, showLoading, refreshWireframe } from './ui.js';
import { extractRig, addRiggedObject, disposeRig } from './rig.js';

// Patch prototypes three-mesh-bvh (idempotent)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
// SkinnedMesh a son propre raycast (skinning CPU par sommet, O(n)) qui masque le raycast BVH hérité de
// Mesh -> picking très lent sur un mesh riggé. On force le raycast accéléré (BVH sur la géométrie bind ;
// on sculpte/pique en pose de repos, donc cohérent).
THREE.SkinnedMesh.prototype.raycast = acceleratedRaycast;

const CLAY_COLOR = 0xb7bcc8;
const MIN_C = 0.12; // black-lift (identique au viewer) pour garder du shading

export async function loadModelFromFile(file) {
  showLoading(true);
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    let geometry;
    let material;

    if (ext === '3mf') {
      geometry = await load3MF(file);
      material = vertexColorMaterial();
    } else {
      const url = URL.createObjectURL(file);
      let root;
      let loadedAnimations = [];
      try {
        switch (ext) {
          case 'glb':
          case 'gltf': {
            const gltf = await new GLTFLoader().loadAsync(url);
            root = gltf.scene; loadedAnimations = gltf.animations || [];
            break;
          }
          case 'fbx':
            root = await new FBXLoader().loadAsync(url); loadedAnimations = root.animations || [];
            break;
          case 'obj':
            root = await new OBJLoader().loadAsync(url);
            break;
          case 'stl': {
            const geom = await new STLLoader().loadAsync(url);
            root = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
            break;
          }
          default:
            throw new Error(`Format non supporté : .${ext}`);
        }
      } finally {
        URL.revokeObjectURL(url);
      }

      // Modèle RIGGÉ (squelette) : on préserve le graphe natif (skin + bones + clips) au lieu de
      // l'aplatir -> chemin séparé (mode Bones). La sculpture ne s'y applique pas comme sur un mesh normal.
      if (ext === 'glb' || ext === 'gltf' || ext === 'fbx') {
        const rig = extractRig(root);
        if (rig) {
          const obj = addRiggedObject(root, file.name.replace(/\.[^.]+$/, ''), loadedAnimations, (sm) => buildRigMesh(sm, true));
          setActiveObject(obj);
          frameAll();
          _onObjectsChanged();
          setStatus(`${file.name} — modèle riggé : ${rig.bones.length} os, ${loadedAnimations.length} animation(s). Sculpt/retexture OK (pose de repos), outil Bones dispo.`);
          return;
        }
      }

      const texturedMat = findTexturedMaterial(root);
      const colored = hasVertexColors(root);
      const rotateZUp = ext === 'stl';

      if (texturedMat) {
        geometry = prepareRichGeometry(root, { keepColor: colored, rotateZUp });
        material = buildTexturedMaterial(texturedMat, colored);
      } else if (colored) {
        geometry = prepareRichGeometry(root, { keepColor: true, rotateZUp });
        applyBlackLift(geometry.attributes.color);
        material = vertexColorMaterial();
      } else {
        geometry = prepareGeometryFromObject(root, rotateZUp);
        material = clayMaterial();
      }
    }

    installMesh(geometry, material);
    const kind = material.map ? ' · texturé' : (material.vertexColors ? ' · vertex colors' : '');
    setStatus(`${file.name} — ${geometry.attributes.position.count.toLocaleString()} vertices, ${(geometry.index.count / 3).toLocaleString()} triangles${kind}`);
  } catch (err) {
    console.error(err);
    setStatus(`Erreur : ${err.message}`);
  } finally {
    showLoading(false);
  }
}

// ---------- Détection ----------

function findTexturedMaterial(root) {
  let found = null;
  root.traverse((o) => {
    if (found || !o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m && m.map) { found = m; return; }
  });
  return found;
}

function hasVertexColors(root) {
  let found = false;
  root.traverse((o) => {
    if (o.isMesh && o.geometry && o.geometry.attributes.color) found = true;
  });
  return found;
}

// ---------- Matériaux ----------

function clayMaterial() {
  // flatShading : la normale est calculée par fragment (dérivées de la position),
  // donc l'ombrage suit les déformations en live sans recalcul des normales de
  // sommets pendant le drag — et fait mieux ressortir les détails sculptés.
  return new THREE.MeshStandardMaterial({
    color: CLAY_COLOR, roughness: 0.65, metalness: 0.0, flatShading: true,
  });
}

// Rendu vertex colors identique au viewer3D.
function vertexColorMaterial() {
  return new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
}

function buildTexturedMaterial(src, withVertexColors) {
  const m = new THREE.MeshStandardMaterial();
  if (src) {
    if (src.map) { m.map = src.map; m.map.colorSpace = THREE.SRGBColorSpace; }
    if (src.normalMap) m.normalMap = src.normalMap;
    if (src.color) m.color.copy(src.color);
    m.roughness = src.roughness ?? 0.85;
    m.metalness = src.metalness ?? 0.0;
    m.side = src.side ?? THREE.FrontSide;
    if (src.emissive) m.emissive.copy(src.emissive);
  }
  m.vertexColors = !!withVertexColors;
  m.flatShading = false;
  return m;
}

function applyBlackLift(colorAttr) {
  if (!colorAttr) return;
  const a = colorAttr.array;
  for (let i = 0; i < a.length; i++) if (a[i] < MIN_C) a[i] = MIN_C;
  colorAttr.needsUpdate = true;
}

// ---------- 3MF (parseur du viewer, couleurs par face) ----------

async function load3MF(file) {
  if (typeof window.parse3MF !== 'function') {
    throw new Error('Parseur 3MF non chargé (Color.js / 3mfParser.js manquants)');
  }
  const buffer = await file.arrayBuffer();
  const parsed = await window.parse3MF(buffer);
  if (!parsed || !parsed.vertices?.length || !parsed.faces?.length) {
    throw new Error('3MF vide ou illisible');
  }

  const { vertices, faces, faceColors } = parsed;
  const hasFaceColors = faceColors && faceColors.length === faces.length;
  const positions = new Float32Array(faces.length * 9);
  const colors = new Float32Array(faces.length * 9);

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const o = f * 9;
    for (let k = 0; k < 3; k++) {
      const v = vertices[face[k]];
      positions[o + k * 3] = v.x;
      positions[o + k * 3 + 1] = v.y;
      positions[o + k * 3 + 2] = v.z;
      const c = hasFaceColors ? faceColors[f] : (v.color || { r: 0.8, g: 0.8, b: 0.8 });
      colors[o + k * 3] = Math.max(c.r, MIN_C);
      colors[o + k * 3 + 1] = Math.max(c.g, MIN_C);
      colors[o + k * 3 + 2] = Math.max(c.b, MIN_C);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.rotateX(-Math.PI / 2); // Z-up -> Y-up (comme le viewer)
  normalizeTransform(g);
  g.computeVertexNormals();
  g.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  return g;
}

// ---------- Chemin clay (sans couleur ni texture) ----------

function prepareGeometryFromObject(root, rotateZUp) {
  const geometries = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry && obj.geometry.attributes.position) {
      const g = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
      g.applyMatrix4(obj.matrixWorld);
      const posOnly = new THREE.BufferGeometry();
      posOnly.setAttribute('position', g.attributes.position.clone());
      geometries.push(posOnly);
    }
  });
  if (!geometries.length) throw new Error('Aucun mesh trouvé dans le fichier');

  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
  const g = mergeVertices(merged, 1e-5);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  if (rotateZUp) g.rotateX(-Math.PI / 2);
  normalizeTransform(g);
  g.computeVertexNormals();
  g.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  return g;
}

// ---------- Chemin riche (garde UV et/ou couleurs) ----------

function prepareRichGeometry(root, { keepColor, rotateZUp }) {
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o);
  });
  if (!meshes.length) throw new Error('Aucun mesh trouvé dans le fichier');

  let geometry;
  if (meshes.length === 1) {
    geometry = cleanGeometry(meshes[0], keepColor);
  } else {
    const geoms = meshes.map((m) => {
      const g = cleanGeometry(m, keepColor);
      return g.index ? g.toNonIndexed() : g;
    });
    geometry = mergeGeometries(geoms, false);
  }

  if (rotateZUp) geometry.rotateX(-Math.PI / 2);
  normalizeTransform(geometry);
  geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  return geometry;
}

// Clone en gardant position/normal/uv (+ color si keepColor), matrice bakée.
function cleanGeometry(mesh, keepColor) {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  if (src.index) g.setIndex(src.index.clone());
  if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone());
  if (src.attributes.uv) g.setAttribute('uv', src.attributes.uv.clone());
  if (keepColor) {
    if (src.attributes.color) g.setAttribute('color', src.attributes.color.clone());
    else {
      const n = src.attributes.position.count;
      const c = new Float32Array(n * 3).fill(0.8);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
  }
  g.applyMatrix4(mesh.matrixWorld);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  return g;
}

// Centre, normalise à ~1.4 u, pose sur la grille (positions uniquement).
function normalizeTransform(g) {
  g.center();
  g.computeBoundingBox();
  const size = new THREE.Vector3();
  g.boundingBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1.4 / maxDim;
  g.scale(scale, scale, scale);
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  g.attributes.position.setUsage(THREE.DynamicDrawUsage);
}

// ---------- Objets (multi) + topologie ----------

let _onObjectsChanged = () => {};
export function setOnObjectsChanged(fn) { _onObjectsChanged = fn; }

// Crée un objet sculptable depuis une géométrie (reorder + BVH + wireframe) et
// l'ajoute à la scène et à state.objects. Ne le rend pas actif.
export function createObject(geometry, material, label, reorder = true) {
  if (reorder) reorderSpatially(geometry); // locality mémoire -> upload GPU partiel efficace
  // (restauration autosave : géométrie déjà ordonnée + masque aligné -> ne PAS réordonner)
  geometry.computeBoundsTree({ setBoundingBox: false });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = label || `Objet ${++state.objectSeq}`;
  mesh.userData.baseMat = material; // matériau réel ; l'affichage courant en dérive
  mesh.material = displayMaterial(material, state.params.displayMode || 'texture');

  const wire = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.15 }),
  );
  wire.name = 'wireframe';
  wire.visible = state.params.displayHelper;
  wire.frustumCulled = false;
  mesh.add(wire);

  state.scene.add(mesh);
  state.objects.push(mesh);
  return mesh;
}

// Rend un objet actif (cible du sculpt) et reconstruit sa topologie.
export function setActiveObject(mesh) {
  state.targetMesh = mesh;
  if (!mesh) {
    state.vertexNeighbors = state.rep = state.groupMembers = state.repNeighbors = null;
    return;
  }
  const topo = buildTopology(mesh.geometry);
  state.vertexNeighbors = topo.neighbors;
  state.rep = topo.rep;
  state.groupMembers = topo.groupMembers;
  state.repNeighbors = topo.repNeighbors;
  mesh.geometry.userData.neighbors = topo.neighbors; // pour le flou du masque
  refreshWireframe();
}

export function disposeObject(mesh) {
  if (mesh.userData && mesh.userData.isRig) { disposeRig(mesh); return; } // rig : + helper + mixer
  mesh.traverse((o) => {
    if (o.isMesh) {
      if (o.geometry.boundsTree) o.geometry.disposeBoundsTree();
      o.geometry.dispose();
      o.material.dispose();
    }
  });
  state.scene.remove(mesh);
}

// Retire de la scène + liste SANS libérer (pour pouvoir le restaurer via undo).
export function detachObject(mesh) {
  if (mesh.userData && mesh.userData.isRig) { // rig = unité : on retire tout le squelette
    const rig = mesh.userData.rig;
    for (let i = state.objects.length - 1; i >= 0; i--) { const o = state.objects[i]; if (o.userData && o.userData.rig === rig) state.objects.splice(i, 1); }
    if (rig.root) state.scene.remove(rig.root);
    if (rig.helper) state.scene.remove(rig.helper);
    if (state.targetMesh && state.targetMesh.userData && state.targetMesh.userData.rig === rig) setActiveObject(state.objects.find((o) => o.visible) || state.objects[0] || null);
    _onObjectsChanged();
    return;
  }
  const i = state.objects.indexOf(mesh);
  if (i >= 0) state.objects.splice(i, 1);
  state.scene.remove(mesh);
  if (state.targetMesh === mesh) setActiveObject(state.objects.find((o) => o.visible) || state.objects[0] || null);
  _onObjectsChanged();
}

// Ré-ajoute un mesh précédemment détaché.
export function attachObject(mesh) {
  if (mesh.userData && mesh.userData.isRig) {
    const rig = mesh.userData.rig;
    if (rig.root) state.scene.add(rig.root);
    if (rig.helper) state.scene.add(rig.helper);
    for (const sm of rig.skinned) if (!state.objects.includes(sm)) state.objects.push(sm);
    _onObjectsChanged();
    return;
  }
  if (state.objects.includes(mesh)) return;
  state.scene.add(mesh);
  state.objects.push(mesh);
  _onObjectsChanged();
}

// Sépare l'objet actif en plusieurs objets selon ses composantes connexes
// (parties non reliées en 3D). Soudure par position pour ignorer les doublons
// de sommets aux coutures. Annulable.
export function separateComponents() {
  const src = state.targetMesh;
  if (!src) return;
  const geo = src.geometry;
  const idx = geo.index.array;
  const posAttr = geo.attributes.position;
  const vCount = posAttr.count;
  const pos = posAttr.array;

  // 1) groupes de position (soudure) — coïncidents = même groupe
  const map = new Map(); const posGroup = new Int32Array(vCount); let ng = 0; const K = 1e4;
  for (let i = 0; i < vCount; i++) {
    const key = Math.round(pos[i * 3] * K) + '_' + Math.round(pos[i * 3 + 1] * K) + '_' + Math.round(pos[i * 3 + 2] * K);
    let g = map.get(key); if (g === undefined) { g = ng++; map.set(key, g); }
    posGroup[i] = g;
  }
  // 2) union-find des groupes via les triangles
  const parent = new Int32Array(ng); for (let i = 0; i < ng; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let t = 0; t < idx.length; t += 3) { const a = posGroup[idx[t]], b = posGroup[idx[t + 1]], c = posGroup[idx[t + 2]]; union(a, b); union(b, c); }
  // 3) indice de composante par triangle
  const compOf = new Map(); const triComp = new Int32Array(idx.length / 3); let nc = 0;
  for (let t = 0; t < idx.length; t += 3) { const r = find(posGroup[idx[t]]); let ci = compOf.get(r); if (ci === undefined) { ci = nc++; compOf.set(r, ci); } triComp[t / 3] = ci; }
  if (nc <= 1) { setStatus('Aucune partie indépendante à séparer.'); return; }

  // 4) construit une géométrie par composante
  const hasNor = !!geo.attributes.normal, hasUV = !!geo.attributes.uv, hasCol = !!geo.attributes.color;
  const N = hasNor ? geo.attributes.normal.array : null, U = hasUV ? geo.attributes.uv.array : null, C = hasCol ? geo.attributes.color.array : null;
  const builders = [];
  for (let i = 0; i < nc; i++) builders.push({ pos: [], nor: hasNor ? [] : null, uv: hasUV ? [] : null, col: hasCol ? [] : null, idx: [], cnt: 0 });
  const remap = new Int32Array(vCount), stamp = new Int32Array(vCount).fill(-1); // partagé (mémoire bornée)
  const vmap = (ci, b, v) => {
    if (stamp[v] === ci) return remap[v];
    stamp[v] = ci; const ni = b.cnt++; remap[v] = ni;
    b.pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    if (b.nor) b.nor.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
    if (b.uv) b.uv.push(U[v * 2], U[v * 2 + 1]);
    if (b.col) b.col.push(C[v * 3], C[v * 3 + 1], C[v * 3 + 2]);
    return ni;
  };
  for (let t = 0; t < idx.length; t += 3) { const ci = triComp[t / 3], b = builders[ci]; b.idx.push(vmap(ci, b, idx[t]), vmap(ci, b, idx[t + 1]), vmap(ci, b, idx[t + 2])); }

  const mat = src.userData.baseMat || src.material;
  const created = builders.map((b, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    if (b.nor) g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    if (b.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    if (b.col) g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.setIndex(b.idx);
    if (!b.nor) g.computeVertexNormals();
    g.attributes.position.setUsage(THREE.DynamicDrawUsage);
    g.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    return createObject(g, mat.clone(), `${src.name} · ${i + 1}`);
  });

  detachObject(src);
  setActiveObject(created[0]);
  _onObjectsChanged();
  setStatus(`Séparé en ${nc} objets.`);
  pushAction(
    () => { for (const m of created) detachObject(m); attachObject(src); setActiveObject(src); },
    () => { detachObject(src); for (const m of created) attachObject(m); setActiveObject(created[0]); },
    () => { for (const m of [src, ...created]) if (!state.objects.includes(m)) disposeObject(m); },
  );
}

export function removeObject(mesh) {
  const i = state.objects.indexOf(mesh);
  if (i < 0) return;
  disposeObject(mesh);
  state.objects.splice(i, 1);
  if (state.targetMesh === mesh) {
    setActiveObject(state.objects.find((o) => o.visible) || state.objects[0] || null);
  }
  _onObjectsChanged();
}

export function objectsChanged() { _onObjectsChanged(); }

function disposeAllObjects() {
  clearHistory();
  for (const m of state.objects) disposeObject(m);
  state.objects.length = 0;
  state.targetMesh = null;
}

// Cadre la caméra sur l'ensemble des objets de la scène.
function frameAll() {
  const box = new THREE.Box3();
  let any = false;
  for (const o of state.objects) {
    o.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(o);
    if (!b.isEmpty()) { box.union(b); any = true; }
  }
  if (!any) return;
  const center = new THREE.Vector3();
  box.getCenter(center);
  state.controls.target.copy(center);
  state.controls.update();
}

// Charge un modèle : l'AJOUTE à la scène (décalé à droite des objets existants pour
// éviter le chevauchement, chaque objet étant recentré à l'origine au chargement).
function installMesh(geometry, material) {
  const existing = state.objects.slice();
  const mesh = createObject(geometry, material);
  if (existing.length) {
    let maxX = -Infinity;
    for (const o of existing) { o.geometry.computeBoundingBox(); maxX = Math.max(maxX, o.position.x + o.geometry.boundingBox.max.x); }
    mesh.geometry.computeBoundingBox();
    mesh.position.x = maxX + 0.3 - mesh.geometry.boundingBox.min.x; // bord gauche à maxX + gap
    mesh.updateMatrixWorld(true);
  }
  setActiveObject(mesh);
  frameAll();
  _onObjectsChanged();
}

// Prépare une SkinnedMesh d'un rig pour le sculpt : normales, réordonnancement spatial (upload GPU
// partiel — permute aussi skinIndex/skinWeight), BVH, matériau d'affichage dérivé du matériau réel, et
// wireframe skinné lié au même squelette. `reorder=false` à la restauration autosave (géométrie déjà
// ordonnée quand elle a été sauvée). Exporté pour être réutilisé par la restauration (autosave.js).
// Uniformise skinIndex/skinWeight entre sommets de MÊME position (mêmes groupes que la soudure logique du
// sculpt, Q=1e4). Beaucoup de GLB ont des sommets coïncidents non soudés avec des poids DIFFÉRENTS -> ils
// se séparent sous déformation (trous aux coutures quand on bouge un os). On ne touche PAS la topologie
// (coutures UV préservées) : on force juste chaque groupe à partager les mêmes poids -> déformation solidaire.
function unifySkinWeights(geometry) {
  const si = geometry.attributes.skinIndex, sw = geometry.attributes.skinWeight;
  if (!si || !sw) return 0;
  const pos = geometry.attributes.position, count = pos.count, Q = 1e4;
  const map = new Map(), groups = new Map();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
    let r = map.get(key); if (r === undefined) { map.set(key, i); r = i; }
    let arr = groups.get(r); if (!arr) { arr = []; groups.set(r, arr); } arr.push(i);
  }
  let fixed = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const acc = new Map(); // os -> poids cumulé sur le groupe
    for (const v of members) for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > 0) { const b = si.getComponent(v, k); acc.set(b, (acc.get(b) || 0) + w); } }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4); // 4 influences dominantes
    let sum = 0; for (const e of top) sum += e[1]; if (sum <= 0) continue;
    const bi = [0, 0, 0, 0], bw = [0, 0, 0, 0];
    for (let k = 0; k < top.length; k++) { bi[k] = top[k][0]; bw[k] = top[k][1] / sum; } // renormalisé à 1
    for (const v of members) for (let k = 0; k < 4; k++) { si.setComponent(v, k, bi[k]); sw.setComponent(v, k, bw[k]); }
    fixed++;
  }
  si.needsUpdate = true; sw.needsUpdate = true;
  return fixed;
}

export function buildRigMesh(sm, reorder = true) {
  if (!sm.geometry.attributes.normal) sm.geometry.computeVertexNormals(); // brosse/curseur exigent des normales
  if (reorder) unifySkinWeights(sm.geometry); // chargement d'un GLB : soude le skin des coutures (pas à la restauration autosave, déjà soudé)
  if (reorder) reorderSpatially(sm.geometry);
  if (!sm.geometry.boundsTree) sm.geometry.computeBoundsTree({ setBoundingBox: false });
  sm.userData.baseMat = sm.material;                                  // matériau réel (skinné) ; l'affichage en dérive
  sm.material = displayMaterial(sm.material, state.params.displayMode || 'texture');
  const wire = new THREE.SkinnedMesh(sm.geometry, new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.15 }));
  wire.name = 'wireframe'; wire.frustumCulled = false; wire.visible = state.params.displayHelper;
  wire.bind(sm.skeleton, sm.bindMatrix);
  sm.add(wire);
}

// Convertit un rig POSÉ en mesh(es) statique(s) : on baake les positions MONDE skinnées (via
// applyBoneTransform · matrixWorld — mêmes positions que le raycast weight paint, donc fiables) dans une
// géométrie plane, sans squelette. Le rig est retiré, remplacé par des Mesh sculptables normaux à la pose
// courante. Renvoie le mesh correspondant à `activeSm`. Utilisé au 1er sculpt/retexture d'un rig posé.
export function bakeRiggedToStatic(activeSm) {
  const rig = activeSm.userData && activeSm.userData.rig; if (!rig) return activeSm;
  rig.root.updateWorldMatrix(true, true);
  const v = new THREE.Vector3();
  let newActive = null; const created = [];
  for (const sm of rig.skinned) {
    const src = sm.geometry, n = src.attributes.position.count, posW = new Float32Array(n * 3);
    sm.updateMatrixWorld(true);
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(src.attributes.position, i); sm.applyBoneTransform(i, v); v.applyMatrix4(sm.matrixWorld); posW[i * 3] = v.x; posW[i * 3 + 1] = v.y; posW[i * 3 + 2] = v.z; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(posW, 3));
    if (src.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(src.attributes.uv.array.slice(), 2));
    if (src.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(src.attributes.color.array.slice(), 3));
    if (src.index) { const ia = src.index.array; g.setIndex(new THREE.BufferAttribute(ia.slice ? ia.slice() : new Uint32Array(ia), 1)); }
    g.computeVertexNormals();
    const baseMat = sm.userData.baseMat || sm.material;
    const plain = createObject(g, baseMat && baseMat.clone ? baseMat.clone() : new THREE.MeshStandardMaterial(), sm.name || 'Posé');
    created.push(plain);
    if (sm === activeSm) newActive = plain;
  }
  disposeRig(activeSm); // retire root + helper + toutes les skinned meshes du rig de la scène/liste
  _onObjectsChanged();
  return newActive || created[0] || null;
}

// Vide la scène (bouton "Nouvelle scène").
export function newScene() {
  disposeAllObjects();
  _onObjectsChanged();
  setStatus('Nouvelle scène — chargez un modèle pour commencer.');
}

// Réordonne les vertices par code de Morton (Z-order) pour que les vertices
// spatialement proches soient contigus dans le buffer. Conséquence : la plage
// min→max d'un coup de brush devient petite -> l'upload GPU partiel ne renvoie
// qu'un mince segment au lieu de presque tout le buffer (gros gain, surtout move
// sur un STL dont l'ordre des triangles n'a aucune localité spatiale).
function reorderSpatially(geometry) {
  if (!geometry.index) {
    const n0 = geometry.attributes.position.count;
    const idx = new Uint32Array(n0);
    for (let i = 0; i < n0; i++) idx[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  }

  const pos = geometry.attributes.position;
  const count = pos.count;
  if (count < 2) return;

  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const sx = (bb.max.x - bb.min.x) || 1;
  const sy = (bb.max.y - bb.min.y) || 1;
  const sz = (bb.max.z - bb.min.z) || 1;

  const codes = new Float64Array(count);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const nx = clamp10((pos.getX(i) - bb.min.x) / sx);
    const ny = clamp10((pos.getY(i) - bb.min.y) / sy);
    const nz = clamp10((pos.getZ(i) - bb.min.z) / sz);
    codes[i] = morton3(nx, ny, nz);
    order[i] = i;
  }
  order.sort((a, b) => codes[a] - codes[b]);

  const remap = new Uint32Array(count);
  for (let n = 0; n < count; n++) remap[order[n]] = n;

  reorderAttribute(geometry, 'position', order);
  // skinIndex/skinWeight/tangent DOIVENT être permutés avec les positions pour ne pas casser le skin.
  for (const a of ['normal', 'uv', 'uv2', 'color', 'skinIndex', 'skinWeight', 'tangent']) {
    if (geometry.attributes[a]) reorderAttribute(geometry, a, order);
  }

  const idx = geometry.index.array;
  for (let i = 0; i < idx.length; i++) idx[i] = remap[idx[i]];
  geometry.index.needsUpdate = true;
}

function clamp10(t) {
  const v = Math.floor(t * 1023);
  return v < 0 ? 0 : (v > 1023 ? 1023 : v);
}

function part1by2(n) {
  n &= 0x3ff;
  n = (n | (n << 16)) & 0x30000ff;
  n = (n | (n << 8)) & 0x300f00f;
  n = (n | (n << 4)) & 0x30c30c3;
  n = (n | (n << 2)) & 0x9249249;
  return n;
}

function morton3(x, y, z) {
  return part1by2(x) | (part1by2(y) << 1) | (part1by2(z) << 2);
}

function reorderAttribute(geometry, name, order) {
  const attr = geometry.attributes[name];
  const dim = attr.itemSize;
  const src = attr.array;
  const dst = new src.constructor(src.length);
  for (let n = 0; n < order.length; n++) {
    const o = order[n];
    for (let d = 0; d < dim; d++) dst[n * dim + d] = src[o * dim + d];
  }
  const na = new THREE.BufferAttribute(dst, dim, attr.normalized);
  na.setUsage(attr.usage);
  geometry.setAttribute(name, na);
}

// Voisins (lissage) + carte de soudure par position (rep / groupMembers /
// repNeighbors) pour co-déplacer les coutures / frontières de couleur.
export function buildTopology(geometry) {
  if (!geometry.index) {
    const n = geometry.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  }

  const index = geometry.index.array;
  const pos = geometry.attributes.position;
  const count = pos.count;

  const nSets = Array.from({ length: count }, () => new Set());
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    nSets[a].add(b); nSets[a].add(c);
    nSets[b].add(a); nSets[b].add(c);
    nSets[c].add(a); nSets[c].add(b);
  }
  const neighbors = nSets.map((s) => Int32Array.from(s));

  // Soudure logique par position (quantifiée)
  const rep = new Int32Array(count);
  const map = new Map();
  const Q = 1e4;
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
    const r = map.get(key);
    if (r === undefined) { map.set(key, i); rep[i] = i; }
    else rep[i] = r;
  }

  const tmpGroups = new Map();
  for (let i = 0; i < count; i++) {
    const r = rep[i];
    if (r !== i) {
      let arr = tmpGroups.get(r);
      if (!arr) { arr = [r]; tmpGroups.set(r, arr); }
      arr.push(i);
    }
  }

  const groupMembers = new Map();
  const repNeighbors = new Map();
  for (const [r, membersArr] of tmpGroups) {
    groupMembers.set(r, Int32Array.from(membersArr));
    const set = new Set();
    for (const mIdx of membersArr) {
      const nb = neighbors[mIdx];
      for (let k = 0; k < nb.length; k++) set.add(nb[k]);
    }
    repNeighbors.set(r, Int32Array.from(set));
  }

  return { neighbors, rep, groupMembers, repNeighbors };
}

// ---------- Subdivision ----------

export function subdivideTarget() {
  if (!state.targetMesh) return;
  const geometry = state.targetMesh.geometry;
  const triCount = geometry.index.count / 3;
  if (triCount > 250000) {
    setStatus('Trop de triangles pour subdiviser (> 250k). Sculptez plutôt directement.');
    return;
  }

  const sourceMat = state.targetMesh.userData.baseMat || state.targetMesh.material;
  showLoading(true);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const pos = geometry.attributes.position;
    const uvAttr = geometry.attributes.uv || null;
    const colAttr = geometry.attributes.color || null;
    const index = geometry.index.array;
    const outPos = [];
    const outUV = uvAttr ? [] : null;
    const outCol = colAttr ? [] : null;

    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), bc = new THREE.Vector3(), ca = new THREE.Vector3();

    const lerpAttr = (attr, i, j, out, dim) => {
      for (let d = 0; d < dim; d++) out[d] = (attr.array[i * dim + d] + attr.array[j * dim + d]) * 0.5;
    };
    const emitP = (v) => outPos.push(v.x, v.y, v.z);
    const emitU = (i) => { for (let d = 0; d < 2; d++) outUV.push(uvAttr.array[i * 2 + d]); };
    const emitUmid = (m) => outUV.push(m[0], m[1]);
    const emitC = (i) => { for (let d = 0; d < 3; d++) outCol.push(colAttr.array[i * 3 + d]); };
    const emitCmid = (m) => outCol.push(m[0], m[1], m[2]);

    const uab = [0, 0], ubc = [0, 0], uca = [0, 0];
    const cab = [0, 0, 0], cbc = [0, 0, 0], cca = [0, 0, 0];

    for (let i = 0; i < index.length; i += 3) {
      const i0 = index[i], i1 = index[i + 1], i2 = index[i + 2];
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      ab.copy(a).add(b).multiplyScalar(0.5);
      bc.copy(b).add(c).multiplyScalar(0.5);
      ca.copy(c).add(a).multiplyScalar(0.5);
      emitP(a); emitP(ab); emitP(ca);
      emitP(ab); emitP(b); emitP(bc);
      emitP(ca); emitP(bc); emitP(c);
      emitP(ab); emitP(bc); emitP(ca);

      if (outUV) {
        lerpAttr(uvAttr, i0, i1, uab, 2); lerpAttr(uvAttr, i1, i2, ubc, 2); lerpAttr(uvAttr, i2, i0, uca, 2);
        emitU(i0); emitUmid(uab); emitUmid(uca);
        emitUmid(uab); emitU(i1); emitUmid(ubc);
        emitUmid(uca); emitUmid(ubc); emitU(i2);
        emitUmid(uab); emitUmid(ubc); emitUmid(uca);
      }
      if (outCol) {
        lerpAttr(colAttr, i0, i1, cab, 3); lerpAttr(colAttr, i1, i2, cbc, 3); lerpAttr(colAttr, i2, i0, cca, 3);
        emitC(i0); emitCmid(cab); emitCmid(cca);
        emitCmid(cab); emitC(i1); emitCmid(cbc);
        emitCmid(cca); emitCmid(cbc); emitC(i2);
        emitCmid(cab); emitCmid(cbc); emitCmid(cca);
      }
    }

    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
    if (outUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(outUV, 2));
    if (outCol) g.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));

    // Sans UV ni couleur : soudure position-only (peu de vertices).
    if (!outUV && !outCol) g = mergeVertices(g, 1e-5);

    g.computeVertexNormals();
    g.attributes.position.setUsage(THREE.DynamicDrawUsage);
    g.attributes.normal.setUsage(THREE.DynamicDrawUsage);

    // Remplace uniquement l'objet actif (garde les autres). Annulable.
    const oldMesh = state.targetMesh;
    const mesh = createObject(g, sourceMat.clone());
    detachObject(oldMesh);
    setActiveObject(mesh);
    objectsChanged();
    pushAction(
      () => { detachObject(mesh); attachObject(oldMesh); setActiveObject(oldMesh); },
      () => { detachObject(oldMesh); attachObject(mesh); setActiveObject(mesh); },
      () => { for (const m of [oldMesh, mesh]) if (!state.objects.includes(m)) disposeObject(m); },
    );
    setStatus(`Subdivisé — ${g.attributes.position.count.toLocaleString()} vertices, ${(g.index.count / 3).toLocaleString()} triangles`);
    showLoading(false);
  }));
}
