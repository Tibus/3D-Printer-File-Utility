// Retexturing / compositing de la texture de couleur.
//  - captureView() : screenshot de la vue caméra + mémorise les matrices caméra (pour
//    reprojeter plus tard une image éditée par IA à l'extérieur).
//  - reprojectToUV(image, mesh) : projette une image "vue caméra" dans l'espace UV de la
//    texture de l'objet (projective texture mapping rendu DANS l'atlas UV). L'image n'est
//    donc pas dépliée : on la reprojette via les matrices caméra capturées.
//  - compositeLayers(...) : empile base + calques (UV) -> texture finale (canvas) -> map.

import * as THREE from 'three';
import { state } from './state.js';

let _pendingCam = null; // { viewProj, pos } capturés au dernier screenshot

export const CAPTURE_SIZE = 1024; // image de capture CARRÉE (1:1) — important pour l'IA

export function hasPendingCam() { return !!_pendingCam; }

// Côté (en pixels écran) du carré de capture 1:1 centré dans la vue.
export function captureSquareSidePx() {
  const s = state.renderer.getSize(new THREE.Vector2());
  return Math.min(s.x, s.y);
}

// Caméra CARRÉE (aspect 1:1) centrée sur la vue courante, cadrant le carré centré de côté
// min(largeur, hauteur). Renvoie une PerspectiveCamera prête à rendre.
function squareCamera() {
  const cam = state.camera; cam.updateMatrixWorld(true);
  const size = state.renderer.getSize(new THREE.Vector2());
  const S = Math.min(size.x, size.y);
  const vfov = THREE.MathUtils.degToRad(cam.fov);
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan((S / size.y) * Math.tan(vfov / 2)));
  const sq = new THREE.PerspectiveCamera(fov, 1, cam.near, cam.far);
  sq.position.setFromMatrixPosition(cam.matrixWorld);
  sq.quaternion.setFromRotationMatrix(cam.matrixWorld);
  sq.updateMatrixWorld(true); sq.updateProjectionMatrix();
  sq.matrixWorldInverse.copy(sq.matrixWorld).invert();
  return sq;
}

// Capture la vue en 1:1 : renvoie un dataURL PNG CARRÉ (CAPTURE_SIZE²) et mémorise les
// matrices de la caméra carrée (pour reprojeter ensuite l'image éditée). Grille + curseurs
// masqués (ils ne doivent pas être capturés ni reprojetés).
export function captureView() {
  const renderer = state.renderer;
  const sq = squareCamera();
  const hidden = [];
  for (const o of [state.grid, state.brushMesh, state.brushDot]) { if (o && o.visible) { o.visible = false; hidden.push(o); } }

  // Rendu FLAT (albédo pur) : matériau non éclairé (MeshBasicMaterial) le temps de la capture,
  // pour que l'image envoyée à l'IA ne contienne ni matcap ni ombrage — juste la couleur.
  const swapped = [];
  for (const o of state.objects) {
    if (!o.isMesh || !o.visible) continue;
    const base = o.userData.baseMat || o.material;
    const flat = new THREE.MeshBasicMaterial({
      map: base.map || null,
      color: base.color ? base.color.clone() : new THREE.Color(0xffffff),
      vertexColors: !!base.vertexColors,
      side: base.side !== undefined ? base.side : THREE.FrontSide,
    });
    swapped.push({ o, mat: o.material }); o.material = flat;
  }

  const rt = new THREE.WebGLRenderTarget(CAPTURE_SIZE, CAPTURE_SIZE);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x0e0e1a, 1); renderer.clear();
  renderer.render(state.scene, sq);
  renderer.setRenderTarget(prevRT);
  for (const s of swapped) { s.o.material.dispose(); s.o.material = s.mat; }
  for (const o of hidden) o.visible = true;
  renderer.render(state.scene, state.camera); // restaure l'affichage écran

  const buf = new Uint8Array(CAPTURE_SIZE * CAPTURE_SIZE * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE, buf);
  rt.dispose();
  const cv = document.createElement('canvas'); cv.width = cv.height = CAPTURE_SIZE;
  const ctx = cv.getContext('2d'); const im = ctx.createImageData(CAPTURE_SIZE, CAPTURE_SIZE);
  const row = CAPTURE_SIZE * 4;
  for (let y = 0; y < CAPTURE_SIZE; y++) { const s = (CAPTURE_SIZE - 1 - y) * row, d = y * row; im.data.set(buf.subarray(s, s + row), d); }
  ctx.putImageData(im, 0, 0);

  const viewProj = new THREE.Matrix4().multiplyMatrices(sq.projectionMatrix, sq.matrixWorldInverse);
  // On mémorise AUSSI la pose (matrixWorld) de l'objet actif au moment de la capture : le
  // screenshot correspond à cette pose. Si l'objet est ensuite déplacé (gizmo) avant l'import,
  // la reprojection doit utiliser la pose de capture, pas la pose courante.
  let meshMatrix = null;
  if (state.targetMesh) { state.targetMesh.updateMatrixWorld(true); meshMatrix = state.targetMesh.matrixWorld.clone(); }
  _pendingCam = { cam: sq, viewProj: viewProj.clone(), pos: sq.position.clone(), meshMatrix };
  return cv.toDataURL('image/png');
}

const VERT = `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec2 p = uv * 2.0 - 1.0;      // rendu DANS l'atlas UV
    gl_Position = vec4(p, 0.0, 1.0);
  }
`;
const FRAG = `
  precision highp float;
  uniform mat4 camViewProj;
  uniform vec3 camPos;
  uniform sampler2D projImage;
  uniform sampler2D camDepth;   // profondeur (distance caméra) depuis la vue capturée
  uniform float depthBias;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 clip = camViewProj * vec4(vWorld, 1.0);
    if (clip.w <= 0.0) discard;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) discard;
    vec3 viewDir = normalize(camPos - vWorld);
    if (dot(normalize(vNormal), viewDir) <= 0.0) discard; // faces dos-tournées
    // Occlusion : ne peindre que la surface la plus proche de la caméra à cet endroit.
    float fragEye = clip.w;                       // distance du point à la caméra
    float storedEye = texture2D(camDepth, suv).x; // distance de la surface visible
    if (storedEye > 0.0 && fragEye > storedEye + depthBias) discard; // caché derrière
    gl_FragColor = texture2D(projImage, suv);
  }
`;
// Dilatation (edge padding) : étale la couleur des texels peints dans le vide voisin, pour
// que les coutures / bords d'îlots UV soient bien colorés (sinon liseré noir au filtrage).
const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const DILATE_FRAG = `
  precision highp float;
  uniform sampler2D tex; uniform vec2 texel; varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tex, vUv);
    if (c.a > 0.001) { gl_FragColor = c; return; }     // texel déjà peint : inchangé
    vec3 sum = vec3(0.0); float n = 0.0;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      vec4 s = texture2D(tex, vUv + vec2(float(dx), float(dy)) * texel);
      if (s.a > 0.001) { sum += s.rgb; n += 1.0; }
    }
    gl_FragColor = n > 0.0 ? vec4(sum / n, 1.0) : vec4(0.0); // remplit depuis les voisins peints
  }
`;

// Passe de profondeur : distance (eye) de chaque point à la caméra capturée.
const DEPTH_VERT = `
  varying float vEye;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vEye = -(viewMatrix * wp).z;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const DEPTH_FRAG = `
  varying float vEye;
  void main() { gl_FragColor = vec4(vEye, 0.0, 0.0, 1.0); }
`;

// Reprojette `image` (HTMLImageElement/Canvas) dans l'UV de mesh. Retourne un canvas texSize².
// Occlusion : seules les faces RÉELLEMENT visibles de la caméra capturée sont peintes (passe
// de profondeur préalable depuis cette caméra).
export function reprojectToUV(image, mesh, texSize = 2048, cam = _pendingCam, pad = 8) {
  if (!cam || !cam.cam) throw new Error('Capture la vue d’abord (bouton 📷).');
  const renderer = state.renderer;
  const prevRT0 = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()); const prevAlpha = renderer.getClearAlpha();
  // Pose de l'objet À LA CAPTURE (le screenshot y correspond) ; fallback = pose courante.
  const meshMatrix = cam.meshMatrix || mesh.matrixWorld;

  // 1) Passe de profondeur depuis la caméra capturée -> distance de la surface visible.
  const DSZ = 1024;
  const depthRT = new THREE.WebGLRenderTarget(DSZ, DSZ, { type: THREE.HalfFloatType });
  const depthMat = new THREE.ShaderMaterial({ vertexShader: DEPTH_VERT, fragmentShader: DEPTH_FRAG, side: THREE.DoubleSide });
  const dscn = new THREE.Scene();
  const dmesh = new THREE.Mesh(mesh.geometry, depthMat);
  dmesh.matrixAutoUpdate = false; dmesh.matrixWorldAutoUpdate = false; dmesh.matrixWorld.copy(meshMatrix); // pose de capture
  dscn.add(dmesh);
  renderer.setRenderTarget(depthRT); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(dscn, cam.cam);
  renderer.setRenderTarget(prevRT0);

  // biais d'occlusion ~ 1% de la taille de l'objet (évite l'auto-occlusion / z-fighting)
  mesh.geometry.computeBoundingBox(); const bs = new THREE.Vector3(); mesh.geometry.boundingBox.getSize(bs);
  const depthBias = Math.max(bs.x, bs.y, bs.z) * 0.01;

  const srcTex = new THREE.Texture(image);
  srcTex.colorSpace = THREE.SRGBColorSpace; srcTex.flipY = true;
  srcTex.minFilter = THREE.LinearFilter; srcTex.magFilter = THREE.LinearFilter;
  srcTex.needsUpdate = true;

  const mat = new THREE.ShaderMaterial({
    uniforms: { camViewProj: { value: cam.viewProj }, camPos: { value: cam.pos }, projImage: { value: srcTex }, camDepth: { value: depthRT.texture }, depthBias: { value: depthBias } },
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
  });

  const rt = new THREE.WebGLRenderTarget(texSize, texSize);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const scn = new THREE.Scene();
  const proj = new THREE.Mesh(mesh.geometry, mat);
  proj.matrixAutoUpdate = false; proj.matrixWorldAutoUpdate = false; proj.matrixWorld.copy(meshMatrix); // pose de capture
  scn.add(proj);

  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(scn, new THREE.Camera()); // caméra factice : le VS ignore la projection

  // Dilatation (edge padding) en ping-pong GPU : comble les coutures/bords d'îlots UV.
  let readRT = rt, rtA = null, rtB = null, dilMat = null, quadGeo = null;
  if (pad > 0) {
    rtA = new THREE.WebGLRenderTarget(texSize, texSize); rtA.texture.colorSpace = THREE.SRGBColorSpace;
    rtB = new THREE.WebGLRenderTarget(texSize, texSize); rtB.texture.colorSpace = THREE.SRGBColorSpace;
    dilMat = new THREE.ShaderMaterial({ uniforms: { tex: { value: null }, texel: { value: new THREE.Vector2(1 / texSize, 1 / texSize) } }, vertexShader: FS_VERT, fragmentShader: DILATE_FRAG });
    quadGeo = new THREE.PlaneGeometry(2, 2);
    const quadScn = new THREE.Scene(); quadScn.add(new THREE.Mesh(quadGeo, dilMat));
    const dummy = new THREE.Camera();
    dilMat.uniforms.tex.value = rt.texture; renderer.setRenderTarget(rtA); renderer.render(quadScn, dummy); // passe 0 : rt -> rtA
    let src = rtA, dst = rtB;
    for (let i = 1; i < pad; i++) {
      dilMat.uniforms.tex.value = src.texture; renderer.setRenderTarget(dst); renderer.render(quadScn, dummy);
      const t = src; src = dst; dst = t;
    }
    readRT = src;
  }

  renderer.setRenderTarget(prevRT0);
  renderer.setClearColor(prevClear, prevAlpha);

  const buf = new Uint8Array(texSize * texSize * 4);
  renderer.readRenderTargetPixels(readRT, 0, 0, texSize, texSize, buf);
  rt.dispose(); mat.dispose(); srcTex.dispose(); depthRT.dispose(); depthMat.dispose();
  if (dilMat) { dilMat.dispose(); quadGeo.dispose(); rtA.dispose(); rtB.dispose(); }

  // Le bake rend en espace UV (gl_Position=uv*2-1) : buf ligne 0 = bas du RT = v=0. On copie
  // SANS inverser -> le canvas est en orientation UV standard (row 0 = v=0), cohérent avec
  // applyTextureCanvas (flipY=false) et la texture glTF d'origine. Pas de flip export/import.
  const cv = document.createElement('canvas'); cv.width = cv.height = texSize;
  const ctx = cv.getContext('2d');
  const imgData = ctx.createImageData(texSize, texSize);
  const row = texSize * 4;
  for (let y = 0; y < texSize; y++) {
    const src = y * row, dst = y * row;
    imgData.data.set(buf.subarray(src, src + row), dst);
  }
  ctx.putImageData(imgData, 0, 0);
  return cv;
}

// Compose base (image/canvas ou null) + calques UV (canvas, avec opacity/visible/mask) -> canvas.
// mask (canvas, alpha = révélation) module l'alpha du calque (destination-in).
export function compositeLayers(baseImage, layers, texSize = 2048) {
  const cv = document.createElement('canvas'); cv.width = cv.height = texSize;
  const ctx = cv.getContext('2d');
  if (baseImage) ctx.drawImage(baseImage, 0, 0, texSize, texSize);
  else { ctx.fillStyle = '#b8b8b8'; ctx.fillRect(0, 0, texSize, texSize); }
  for (const l of layers) {
    if (!l.visible || !l.canvas) continue;
    let src = l.canvas;
    if (l.mask) { // applique le masque alpha : garde le calque seulement là où mask.alpha > 0
      const tmp = document.createElement('canvas'); tmp.width = tmp.height = texSize; const t = tmp.getContext('2d');
      t.drawImage(l.canvas, 0, 0, texSize, texSize);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(l.mask, 0, 0, texSize, texSize);
      src = tmp;
    }
    ctx.globalAlpha = l.opacity != null ? l.opacity : 1;
    ctx.drawImage(src, 0, 0, texSize, texSize);
  }
  ctx.globalAlpha = 1;
  return cv;
}

// ---------- Peinture de masque alpha par calque (brush 3D -> UV) ----------
const MASK_FRAG = `
  precision highp float;
  uniform vec3 brushPos; uniform float radius; uniform float hardness; uniform float strength; uniform vec3 camPos;
  varying vec3 vWorld; varying vec3 vNormal;
  void main() {
    float d = distance(vWorld, brushPos);
    if (d > radius) discard;
    if (dot(normalize(vNormal), normalize(camPos - vWorld)) <= 0.0) discard; // faces vues seulement
    float t = d / radius;
    float a = (1.0 - smoothstep(hardness, 1.0, t)) * strength;
    gl_FragColor = vec4(a, a, a, a);
  }
`;

// RT persistante du masque d'un calque (créée + vidée à 0 au 1er usage : tout masqué).
function ensureLayerMaskRT(layer, texSize) {
  if (!layer._maskRT) {
    layer._maskRT = new THREE.WebGLRenderTarget(texSize, texSize);
    layer._maskRT.texture.colorSpace = THREE.NoColorSpace;
    const r = state.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(layer._maskRT); r.setClearColor(0x000000, 0); r.clear(); r.setRenderTarget(prev);
  }
  return layer._maskRT;
}

// Un « dab » de peinture de masque : rend l'objet en UV, accumule (add) ou efface (subtract)
// l'alpha dans la RT du calque selon la distance 3D au pinceau.
export function paintMaskDab(mesh, layer, worldPoint, radius, hardness, strength, erase, texSize = 2048, meshMatrix = null) {
  const renderer = state.renderer;
  ensureLayerMaskRT(layer, texSize);
  const mat = new THREE.ShaderMaterial({
    uniforms: { brushPos: { value: worldPoint }, radius: { value: radius }, hardness: { value: hardness }, strength: { value: strength }, camPos: { value: state.camera.position.clone() } },
    vertexShader: VERT, fragmentShader: MASK_FRAG, side: THREE.DoubleSide,
    transparent: true, blending: THREE.CustomBlending,
    blendEquation: erase ? THREE.ReverseSubtractEquation : THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: erase ? THREE.ReverseSubtractEquation : THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    depthTest: false, depthWrite: false,
  });
  const scn = new THREE.Scene();
  const m = new THREE.Mesh(mesh.geometry, mat);
  m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false; m.matrixWorld.copy(meshMatrix || mesh.matrixWorld);
  scn.add(m);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(layer._maskRT);
  renderer.render(scn, new THREE.Camera());
  renderer.setRenderTarget(prev);
  mat.dispose();
}

// Lit la RT du masque -> canvas (alpha = révélation) pour le compositing.
export function readMaskCanvas(layer, texSize = 2048) {
  if (!layer._maskRT) return null;
  const renderer = state.renderer;
  const buf = new Uint8Array(texSize * texSize * 4);
  renderer.readRenderTargetPixels(layer._maskRT, 0, 0, texSize, texSize, buf);
  const cv = layer.mask && layer.mask.width === texSize ? layer.mask : Object.assign(document.createElement('canvas'), { width: texSize, height: texSize });
  const ctx = cv.getContext('2d'); const img = ctx.createImageData(texSize, texSize); const d = img.data;
  for (let i = 0; i < texSize * texSize; i++) { const a = buf[i * 4]; d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; d[i * 4 + 3] = a; }
  ctx.putImageData(img, 0, 0);
  layer.mask = cv;
  return cv;
}

export function disposeLayerMask(layer) { if (layer._maskRT) { layer._maskRT.dispose(); layer._maskRT = null; } layer.mask = null; }

// ---------- Nano Banana (Gemini 2.5 Flash Image) : édition d'image par prompt ----------
// BYOK : la clé est celle de l'utilisateur (jamais stockée côté serveur). Appel direct
// à l'API Gemini depuis le navigateur (CORS OK). Renvoie un dataURL de l'image éditée.
const NANO_MODEL = 'gemini-2.5-flash-image';
// Prompt SYSTÈME (dans le code) : cadre la tâche pour que la sortie reste reprojetable.
const NANO_SYSTEM = [
  'You edit the surface appearance (texture/material/color) of a 3D model shown in a flat, unlit screenshot.',
  'CRITICAL: keep the EXACT same silhouette, geometry, pose, camera framing and composition as the input image — do not move, rotate, rescale, crop or reframe anything. The output must align pixel-for-pixel with the input so it can be reprojected onto the model.',
  'Only change the appearance as requested. Keep it flat/even lighting, no added shadows, highlights or background.',
  'Return a single edited image, same resolution and framing as the input.',
].join(' ');
export async function generateNanoBanana(imageDataURL, prompt, apiKey, model = NANO_MODEL) {
  const b64 = imageDataURL.split(',')[1];
  const mime = (imageDataURL.match(/^data:([^;]+);/) || [, 'image/png'])[1];
  const body = {
    systemInstruction: { parts: [{ text: NANO_SYSTEM }] },
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    // Force la sortie image : sans ça le modèle peut ne renvoyer que du texte.
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`API ${res.status} ${t.slice(0, 300)}`); }
  const data = await res.json();
  const cand = (data.candidates && data.candidates[0]) || null;
  const parts = (cand && cand.content && cand.content.parts) || [];
  const p = parts.find((x) => x.inlineData || x.inline_data);
  if (!p) {
    // Pas d'image : surface la vraie raison (blocage sécurité, quota de tokens, refus…).
    const txt = parts.map((x) => x.text).filter(Boolean).join(' ');
    const block = data.promptFeedback && data.promptFeedback.blockReason;
    const finish = cand && cand.finishReason;
    const why = block ? `bloqué : ${block}` : (finish && finish !== 'STOP') ? `finishReason : ${finish}` : txt ? txt.slice(0, 200) : 'réponse vide';
    throw new Error(`Pas d’image renvoyée (${why})`);
  }
  const inl = p.inlineData || p.inline_data;
  return `data:${inl.mimeType || inl.mime_type || 'image/png'};base64,${inl.data}`;
}

// Applique un canvas comme map de couleur de l'objet (baseMat + affichage dérivé).
export function applyTextureCanvas(mesh, canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  // Convention glTF : flipY=false. Le canvas de composite est en orientation UV standard
  // (voir la copie non-inversée du bake) -> pas de flip vertical à l'import/export.
  tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.needsUpdate = true;
  const base = mesh.userData.baseMat || mesh.material;
  if (base.map && base.map !== tex) base.map.dispose();
  base.map = tex; base.needsUpdate = true;
  // matériau affiché (ex. matcap texturé) : sa map dérive de baseMat.map -> on la met à jour aussi
  if (mesh.material && mesh.material !== base && 'map' in mesh.material) { mesh.material.map = tex; mesh.material.needsUpdate = true; }
  return tex;
}
