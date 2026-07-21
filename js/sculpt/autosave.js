// Autosave de la scène en IndexedDB (les géométries pèsent des Mo -> pas localStorage).
// Sauvegarde débouncée après chaque modification + au masquage/fermeture d'onglet ;
// restauration automatique au chargement. Persiste par objet : géométrie (position,
// normal, uv, color, index), matériau (type, couleur, map image en blob, ...), transform,
// nom, visibilité, masque. + méta (caméra, mode d'affichage).

import * as THREE from 'three';
import { addRiggedObject } from './rig.js';
import { buildRigMesh } from './loader.js';

const DB_NAME = 'sculpt-autosave', STORE = 'scene', KEY = 'current', VERSION = 1;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(val) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, KEY); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => { db.close(); rej(tx.error); }; });
}
async function idbGet() {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const rq = tx.objectStore(STORE).get(KEY); rq.onsuccess = () => { db.close(); res(rq.result || null); }; rq.onerror = () => { db.close(); rej(rq.error); }; });
}
async function idbDel() {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(KEY); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => { db.close(); rej(tx.error); }; });
}

// ---------- Sérialisation ----------

function imageToBlob(image) {
  try {
    const w = image.width || image.videoWidth, h = image.height || image.videoHeight;
    if (!w || !h) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(image, 0, 0);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
  } catch (_) { return null; }
}

function copyAttr(attr) { return attr ? attr.array.slice() : null; }

async function serializeMaterial(base) {
  if (Array.isArray(base)) base = base[0];
  return {
    type: base.type,
    color: base.color ? base.color.getHex() : 0xffffff,
    roughness: base.roughness, metalness: base.metalness,
    flatShading: !!base.flatShading, side: base.side, vertexColors: !!base.vertexColors,
    map: base.map && base.map.image ? await imageToBlob(base.map.image) : null,
  };
}

async function serializeObject(mesh) {
  const g = mesh.geometry;
  const geom = {
    pos: copyAttr(g.attributes.position),
    nor: copyAttr(g.attributes.normal),
    uv: copyAttr(g.attributes.uv),
    col: copyAttr(g.attributes.color),
    idx: g.index ? (g.index.array.slice()) : null,
  };
  const mat = await serializeMaterial(mesh.userData.baseMat || mesh.material);
  const mask = g.userData.maskSharp ? { sharp: g.userData.maskSharp.slice(), blur: g.userData.maskBlur | 0 } : null;
  return {
    kind: 'mesh', geom, mat, mask, name: mesh.name, visible: mesh.visible,
    pos: mesh.position.toArray(), quat: mesh.quaternion.toArray(), scale: mesh.scale.toArray(),
  };
}

// Sérialisation RIG complète (auto-suffisante, sans re-parser le fichier) : géométrie COURANTE de chaque
// SkinnedMesh (posée/sculptée, avec skinIndex/skinWeight), arbre d'os + boneInverses + bindMatrix, clips
// d'animation. Reproduit exactement l'état courant (y compris après bakePose/sculpt) au rechargement.
const _mTmp = new THREE.Matrix4();
async function serializeRig(rig) {
  const bones = rig.skeleton ? rig.skeleton.bones : rig.bones;
  const boneIndex = new Map(bones.map((b, i) => [b, i]));
  rig.root.updateWorldMatrix(true, true);
  const invRoot = _mTmp.copy(rig.root.matrixWorld).invert().clone();
  // Os : matrice LOCALE (relative au parent-os) ; si le parent n'est pas un os (armature/root), on stocke
  // la matrice relative au ROOT et on rattachera l'os au root -> l'éventuelle transform d'armature est absorbée.
  const boneData = bones.map((b) => {
    const parent = boneIndex.has(b.parent) ? boneIndex.get(b.parent) : -1;
    const mLocal = parent >= 0 ? b.matrix : new THREE.Matrix4().multiplyMatrices(invRoot, b.matrixWorld);
    return { name: b.name, parent, matrix: mLocal.toArray() };
  });
  const boneInverses = (rig.skeleton ? rig.skeleton.boneInverses : []).map((m) => m.toArray());
  const meshes = [];
  for (const sm of rig.skinned) {
    const g = sm.geometry;
    sm.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4().multiplyMatrices(invRoot, sm.matrixWorld);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    local.decompose(p, q, s);
    meshes.push({
      name: sm.name, visible: sm.visible,
      geom: {
        pos: copyAttr(g.attributes.position), nor: copyAttr(g.attributes.normal),
        uv: copyAttr(g.attributes.uv), col: copyAttr(g.attributes.color),
        skinIndex: copyAttr(g.attributes.skinIndex), skinWeight: copyAttr(g.attributes.skinWeight),
        idx: g.index ? g.index.array.slice() : null,
      },
      mat: await serializeMaterial(sm.userData.baseMat || sm.material),
      bindMatrix: sm.bindMatrix.toArray(),
      pos: p.toArray(), quat: q.toArray(), scale: s.toArray(),
    });
  }
  const animations = (rig.animations || []).map((c) => THREE.AnimationClip.toJSON(c));
  const rp = rig.root.position, rq = rig.root.quaternion, rsc = rig.root.scale;
  return {
    kind: 'rig', name: rig.root.name,
    root: { pos: rp.toArray(), quat: rq.toArray(), scale: rsc.toArray() },
    bones: boneData, boneInverses, meshes, animations,
  };
}

export async function saveScene(objects, meta) {
  if (!objects.length) { await clearScene(); return; }
  const serialized = [];
  const seenRigs = new Set(); // un rig = plusieurs SkinnedMesh partageant le même `rig` -> sérialisé UNE fois
  for (const m of objects) {
    const rig = m.userData && m.userData.rig;
    if (rig) { if (!seenRigs.has(rig)) { seenRigs.add(rig); serialized.push(await serializeRig(rig)); } }
    else serialized.push(await serializeObject(m));
  }
  await idbPut({ v: 1, savedAt: meta.now || 0, objects: serialized, meta });
}

// ---------- Désérialisation ----------

function blobToTexture(blob) {
  return createImageBitmap(blob).then((bmp) => {
    const tex = new THREE.Texture(bmp);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

async function deserializeMaterial(d) {
  let m;
  if (d.type === 'MeshLambertMaterial') m = new THREE.MeshLambertMaterial({ vertexColors: d.vertexColors, side: d.side });
  else m = new THREE.MeshStandardMaterial({ roughness: d.roughness ?? 0.7, metalness: d.metalness ?? 0, flatShading: d.flatShading, side: d.side, vertexColors: d.vertexColors });
  if (m.color && d.color != null) m.color.setHex(d.color);
  if (d.map) { try { m.map = await blobToTexture(d.map); m.needsUpdate = true; } catch (_) { /* skip texture */ } }
  return m;
}

function deserializeGeometry(d) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
  if (d.nor) g.setAttribute('normal', new THREE.Float32BufferAttribute(d.nor, 3));
  if (d.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
  if (d.col) g.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3));
  if (d.skinIndex) g.setAttribute('skinIndex', new THREE.BufferAttribute(d.skinIndex, 4)); // rig : conserve le type (Uint16/Uint8)
  if (d.skinWeight) g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(d.skinWeight, 4));
  if (d.idx) g.setIndex(new THREE.BufferAttribute(d.idx, 1));
  if (!d.nor) g.computeVertexNormals();
  g.attributes.position.setUsage(THREE.DynamicDrawUsage);
  if (g.attributes.normal) g.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  return g;
}

// Reconstruit un rig complet à partir des données sérialisées (auto-suffisant) et l'enregistre dans la
// scène + state.objects (via addRiggedObject, sans re-normaliser : le transform est déjà sauvegardé).
export async function restoreRig(d) {
  const root = new THREE.Group();
  root.position.fromArray(d.root.pos); root.quaternion.fromArray(d.root.quat); root.scale.fromArray(d.root.scale);
  // 1) arbre d'os
  const bones = d.bones.map((bd) => { const b = new THREE.Bone(); b.name = bd.name; _mTmp.fromArray(bd.matrix).decompose(b.position, b.quaternion, b.scale); return b; });
  d.bones.forEach((bd, i) => { if (bd.parent >= 0) bones[bd.parent].add(bones[i]); else root.add(bones[i]); });
  root.updateMatrixWorld(true);
  // 2) squelette (boneInverses restaurés tels quels -> skinning identique à la sauvegarde)
  const boneInverses = (d.boneInverses || []).map((a) => new THREE.Matrix4().fromArray(a));
  const skeleton = new THREE.Skeleton(bones, boneInverses.length ? boneInverses : undefined);
  // 3) SkinnedMeshes
  for (const md of d.meshes) {
    const geometry = deserializeGeometry(md.geom);
    const material = await deserializeMaterial(md.mat);
    const sm = new THREE.SkinnedMesh(geometry, material);
    sm.name = md.name; sm.visible = md.visible !== false;
    sm.position.fromArray(md.pos); sm.quaternion.fromArray(md.quat); sm.scale.fromArray(md.scale);
    root.add(sm);
    sm.bind(skeleton, new THREE.Matrix4().fromArray(md.bindMatrix));
  }
  root.updateMatrixWorld(true);
  const animations = (d.animations || []).map((j) => THREE.AnimationClip.parse(j));
  // fit:false -> garde le transform sauvegardé ; buildRigMesh sans reorder (géométrie déjà ordonnée).
  return addRiggedObject(root, d.name, animations, (sm) => buildRigMesh(sm, false), { fit: false });
}

// Retourne { objects: [{ geometry, material, mask, name, visible, pos, quat, scale }], meta } ou null.
export async function loadScene() {
  let rec;
  try { rec = await idbGet(); } catch (_) { return null; }
  if (!rec || !rec.objects || !rec.objects.length) return null;
  const objects = [];
  for (const o of rec.objects) {
    if (o.kind === 'rig') { objects.push({ kind: 'rig', data: o }); continue; } // rebâti par restoreRig (voir main.js)
    objects.push({
      kind: 'mesh',
      geometry: deserializeGeometry(o.geom),
      material: await deserializeMaterial(o.mat),
      mask: o.mask, name: o.name, visible: o.visible !== false,
      pos: o.pos, quat: o.quat, scale: o.scale,
    });
  }
  return { objects, meta: rec.meta || {} };
}

export async function clearScene() { try { await idbDel(); } catch (_) { /* noop */ } }
