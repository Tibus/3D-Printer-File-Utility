// Vertex Paint (FDM) : quantifie/peint les couleurs par sommet vers une PALETTE choisie, puis
// exporte en 3MF avec segmentation MMU (1 slot filament par couleur de palette).
//  - Palette : liste de couleurs {r,g,b} (0..1) stockée sur mesh.userData._vpPalette. L'ordre = l'ordre
//    des slots MMU (index 0 -> slot 1, etc.).
//  - Pipette : prélève une couleur sur le modèle (texture à l'UV du point cliqué) -> ajoutée à la palette.
//  - « Appliquer depuis la texture » : échantillonne la texture à l'UV de chaque sommet et QUANTIFIE à
//    la couleur de palette la plus proche (affectation dure, jamais de mélange).
//  - Peinture : voir brush.js (paintColorAt) — écrit la couleur EXACTE (pas de fade).
//  - Export 3MF : couleur dominante par triangle -> slot MMU (slic3rpe:mmu_segmentation), compatible
//    PrusaSlicer/Bambu. Réutilise le format de js/export.js.

import * as THREE from 'three';

// Distance perceptuelle (mêmes poids que le converter racine : 2·dR² + 4·dG² + 3·dB²).
function dist2(r1, g1, b1, r2, g2, b2) { const dr = r1 - r2, dg = g1 - g2, db = b1 - b2; return 2 * dr * dr + 4 * dg * dg + 3 * db * db; }

// Index de la couleur de palette la plus proche de (r,g,b). -1 si palette vide.
export function nearestPaletteIndex(r, g, b, palette) {
  let bi = -1, bd = Infinity;
  for (let i = 0; i < palette.length; i++) { const p = palette[i]; const d = dist2(r, g, b, p.r, p.g, p.b); if (d < bd) { bd = d; bi = i; } }
  return bi;
}

const h2 = (x) => ('0' + Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16)).slice(-2);
export function rgbToHex(r, g, b) { return '#' + h2(r) + h2(g) + h2(b); }
export function hexToRgb(hex) { const m = hex.replace('#', ''); return { r: parseInt(m.slice(0, 2), 16) / 255, g: parseInt(m.slice(2, 4), 16) / 255, b: parseInt(m.slice(4, 6), 16) / 255 }; }

// Palette d'un mesh (créée à la demande). Chaque entrée : { r, g, b } en 0..1.
export function getPalette(mesh) { if (!mesh.userData._vpPalette) mesh.userData._vpPalette = []; return mesh.userData._vpPalette; }

// Crée l'attribut color s'il n'existe pas (rempli en blanc). N'ACTIVE PAS vertexColors sur le matériau
// réel : le mode d'affichage « vcflat » lit l'attribut color directement (RawShaderMaterial), donc les
// modes Texture/Matcap ne doivent pas être teintés par la peinture (ils gardent leur rendu d'origine).
export function ensureColorAttr(mesh, fill = 1) {
  const g = mesh.geometry;
  if (!g.attributes.color) {
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3); arr.fill(fill);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return g.attributes.color;
}

// Lecteur de pixels d'une texture (canvas hors-écran), mis en cache par image source.
const _texReaders = new WeakMap();
function texReader(image) {
  if (!image) return null;
  let r = _texReaders.get(image);
  if (!r) {
    const w = image.width || image.videoWidth || (image.canvas && image.canvas.width);
    const h = image.height || image.videoHeight || (image.canvas && image.canvas.height);
    if (!w || !h) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0, w, h);
    r = { data: ctx.getImageData(0, 0, w, h).data, w, h };
    _texReaders.set(image, r);
  }
  return r;
}

// Échantillonne une map Three à l'UV (u,v) -> { r,g,b } 0..1 (respecte flipY). null si pas d'image.
function sampleMap(map, u, v) {
  if (!map || !map.image) return null;
  const rd = texReader(map.image); if (!rd) return null;
  let uu = u - Math.floor(u), vv = v - Math.floor(v);            // wrap répété (UV hors [0,1])
  if (map.flipY) vv = 1 - vv;                                    // flipY=true -> ligne image inversée
  let x = Math.min(rd.w - 1, Math.max(0, Math.round(uu * (rd.w - 1))));
  let y = Math.min(rd.h - 1, Math.max(0, Math.round(vv * (rd.h - 1))));
  const i = (y * rd.w + x) * 4;
  return { r: rd.data[i] / 255, g: rd.data[i + 1] / 255, b: rd.data[i + 2] / 255 };
}

// Pipette : couleur sous un point de collision (hit du raycaster). Ordre de préférence :
//  1) texture à l'UV du hit ; 2) couleur du sommet le plus proche du triangle ; 3) couleur du matériau.
export function eyedropSample(mesh, hit) {
  const base = mesh.userData.baseMat || mesh.material;
  if (hit && hit.uv && base && base.map) { const c = sampleMap(base.map, hit.uv.x, hit.uv.y); if (c) return c; }
  const g = mesh.geometry, col = g.attributes.color;
  if (col && hit && hit.face) { const v3 = hit.face.a * 3; return { r: col.array[v3], g: col.array[v3 + 1], b: col.array[v3 + 2] }; }
  if (base && base.color) return { r: base.color.r, g: base.color.g, b: base.color.b };
  return { r: 1, g: 1, b: 1 };
}

// Remplit attributes.color en échantillonnant la texture à l'UV de chaque sommet puis en QUANTIFIANT
// à la couleur de palette la plus proche (pas de mélange). Renvoie le nb de sommets écrits, ou -1 si
// pré-requis manquants (palette vide / pas de texture / pas d'UV).
export function applyPaletteFromTexture(mesh) {
  const palette = getPalette(mesh);
  const g = mesh.geometry;
  const base = mesh.userData.baseMat || mesh.material;
  if (!palette.length || !base || !base.map || !g.attributes.uv) return -1;
  const uv = g.attributes.uv.array;
  const col = ensureColorAttr(mesh).array;
  const N = g.attributes.position.count;
  for (let v = 0; v < N; v++) {
    const s = sampleMap(base.map, uv[v * 2], uv[v * 2 + 1]) || { r: 1, g: 1, b: 1 };
    const idx = nearestPaletteIndex(s.r, s.g, s.b, palette);
    const p = palette[idx < 0 ? 0 : idx];
    const v3 = v * 3; col[v3] = p.r; col[v3 + 1] = p.g; col[v3 + 2] = p.b;
  }
  g.attributes.color.needsUpdate = true;
  return N;
}

// Encodage MMU (slic3rpe:mmu_segmentation) par slot 1-based, comme js/export.js. Slot 1 = pas d'attribut.
const MMU = ['1', '4', '8', '0C', '1C', '2C', '3C', '4C'];

// Construit un 3MF (Blob) : couleur dominante par triangle -> slot MMU = index palette + 1.
// Coordonnées en MONDE (matrixWorld bakée) pour respecter la pose gizmo. Requiert JSZip (global) +
// attributes.color. Palette limitée à 8 slots (MMU standard) ; au-delà, tronqué au plus proche 8.
export async function buildVertexPaint3MF(mesh) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip indisponible.');
  const palette = getPalette(mesh);
  if (!palette.length) throw new Error('Palette vide.');
  const g = mesh.geometry;
  const col = g.attributes.color; if (!col) throw new Error('Aucune couleur par sommet (applique/peins d’abord).');
  mesh.updateMatrixWorld(true);
  const M = mesh.matrixWorld;
  const pos = g.attributes.position.array;
  const c = col.array;
  const N = g.attributes.position.count;
  const idx = g.index ? g.index.array : null;
  const nTri = idx ? idx.length / 3 : N / 3;

  // slot 1-based de chaque sommet (quantifié à la palette).
  const slot = new Uint8Array(N);
  for (let v = 0; v < N; v++) { const v3 = v * 3; slot[v] = Math.min(7, nearestPaletteIndex(c[v3], c[v3 + 1], c[v3 + 2], palette)) + 1; }

  // sommets (monde)
  const _v = new THREE.Vector3();
  let verticesXml = '';
  for (let v = 0; v < N; v++) { _v.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]).applyMatrix4(M); verticesXml += `        <vertex x="${_v.x}" y="${_v.y}" z="${_v.z}" />\n`; }

  // triangles : couleur dominante des 3 sommets -> slot MMU
  let trianglesXml = '';
  const tri = (a, b, c2) => {
    let s;                                                        // slot dominant
    if (slot[a] === slot[b] || slot[a] === slot[c2]) s = slot[a];
    else if (slot[b] === slot[c2]) s = slot[b];
    else s = slot[a];                                            // 3 différents -> 1er sommet
    if (s === 1) trianglesXml += `        <triangle v1="${a}" v2="${b}" v3="${c2}" />\n`;
    else trianglesXml += `        <triangle v1="${a}" v2="${b}" v3="${c2}" slic3rpe:mmu_segmentation="${MMU[s]}" />\n`;
  };
  if (idx) { for (let t = 0; t < nTri; t++) tri(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]); }
  else { for (let t = 0; t < nTri; t++) tri(t * 3, t * 3 + 1, t * 3 + 2); }

  // Métadonnées ALIGNÉES sur le converter (js/export.js) : Bambu/Prusa n'interprètent le
  // slic3rpe:mmu_segmentation que si le fichier est reconnu comme un projet PrusaSlicer.
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <metadata name="slic3rpe:Version3mf">1</metadata>
 <metadata name="slic3rpe:MmPaintingVersion">1</metadata>
 <metadata name="Designer"></metadata>
 <metadata name="Description"></metadata>
 <metadata name="Copyright"></metadata>
 <metadata name="LicenseTerms"></metadata>
 <metadata name="Rating"></metadata>
 <metadata name="CreationDate"></metadata>
 <metadata name="ModificationDate"></metadata>
 <metadata name="Application">PrusaSlicer-2.9.2</metadata>
  <resources>
   <object id="1" type="model">
    <mesh>
     <vertices>
${verticesXml}        </vertices>
     <triangles>
${trianglesXml}        </triangles>
     </mesh>
    </object>
  </resources>
 <build>
  <item objectid="1" />
 </build>
</model>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const projectJson = {
    filament_colour: palette.slice(0, 8).map((p) => rgbToHex(p.r, p.g, p.b)),
    filament_colour_type: palette.slice(0, 8).map(() => '1'),
  };

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels').file('.rels', rels);
  zip.folder('3D').file('3dmodel.model', modelXml);
  zip.folder('Metadata').file('project_settings.config', JSON.stringify(projectJson, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
