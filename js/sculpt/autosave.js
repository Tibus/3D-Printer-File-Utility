// Autosave de la scène en IndexedDB (les géométries pèsent des Mo -> pas localStorage).
// Sauvegarde débouncée après chaque modification + au masquage/fermeture d'onglet ;
// restauration automatique au chargement. Persiste par objet : géométrie (position,
// normal, uv, color, index), matériau (type, couleur, map image en blob, ...), transform,
// nom, visibilité, masque. + méta (caméra, mode d'affichage).

import * as THREE from 'three';

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

async function serializeObject(mesh) {
  const g = mesh.geometry;
  const geom = {
    pos: copyAttr(g.attributes.position),
    nor: copyAttr(g.attributes.normal),
    uv: copyAttr(g.attributes.uv),
    col: copyAttr(g.attributes.color),
    idx: g.index ? (g.index.array.slice()) : null,
  };
  const base = mesh.userData.baseMat || mesh.material;
  const mat = {
    type: base.type,
    color: base.color ? base.color.getHex() : 0xffffff,
    roughness: base.roughness, metalness: base.metalness,
    flatShading: !!base.flatShading, side: base.side, vertexColors: !!base.vertexColors,
    map: base.map && base.map.image ? await imageToBlob(base.map.image) : null,
  };
  const mask = g.userData.maskSharp ? { sharp: g.userData.maskSharp.slice(), blur: g.userData.maskBlur | 0 } : null;
  return {
    geom, mat, mask, name: mesh.name, visible: mesh.visible,
    pos: mesh.position.toArray(), quat: mesh.quaternion.toArray(), scale: mesh.scale.toArray(),
  };
}

export async function saveScene(objects, meta) {
  // Les objets riggés (squelette) ne sont pas sérialisés par l'autosave (skin/anim complexes) -> ignorés.
  const saveable = objects.filter((m) => !(m.userData && m.userData.isRig));
  if (!saveable.length) { await clearScene(); return; }
  const serialized = [];
  for (const m of saveable) serialized.push(await serializeObject(m));
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
  if (d.idx) g.setIndex(new THREE.BufferAttribute(d.idx, 1));
  if (!d.nor) g.computeVertexNormals();
  g.attributes.position.setUsage(THREE.DynamicDrawUsage);
  if (g.attributes.normal) g.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  return g;
}

// Retourne { objects: [{ geometry, material, mask, name, visible, pos, quat, scale }], meta } ou null.
export async function loadScene() {
  let rec;
  try { rec = await idbGet(); } catch (_) { return null; }
  if (!rec || !rec.objects || !rec.objects.length) return null;
  const objects = [];
  for (const o of rec.objects) {
    objects.push({
      geometry: deserializeGeometry(o.geom),
      material: await deserializeMaterial(o.mat),
      mask: o.mask, name: o.name, visible: o.visible !== false,
      pos: o.pos, quat: o.quat, scale: o.scale,
    });
  }
  return { objects, meta: rec.meta || {} };
}

export async function clearScene() { try { await idbDel(); } catch (_) { /* noop */ } }
