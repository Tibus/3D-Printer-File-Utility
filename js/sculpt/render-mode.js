// Mode « Rendu » (preview) : look présentation, activable/désactivable sans quitter la scène.
//   - fond blanc, PAS d'environnement/IBL ni tone mapping (l'IBL délavait les vertex colors) ;
//   - éclairage : AmbientLight (fill) + DirectionalLight forte (modelé + auto-ombrage du modèle) ;
//   - matériaux Lambert (comme viewer.html) : texture si présente, sinon vertex colors (linéarisés) ;
//   - occlusion ambiante (GTAO) via EffectComposer ;
//   - OMBRE AU SOL = contact shadow : silhouette du modèle vue de dessus, floutée (2 passes gaussiennes)
//     et projetée sur le plan de sol -> ombre douce et propre (pas de shadow map hachée) ;
//   - masque les helpers d'édition. Réglages persistés en localStorage.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { state } from './state.js';

let _active = false;
let _composer = null, _gtao = null, _renderPass = null, _output = null;
let _shadowLight = null, _ambient = null;
let _ground = null, _groundMat = null;                 // plan de sol + shader d'ombre projetée
let _csCam = null, _csRT = null, _csBlurRT = null, _silMat = null, _fsq = null, _hBlur = null, _vBlur = null;
let _projCam = null, _projRT = null;                    // ombre de PROJECTION (dans l'axe de la lumière)
const _projVP = new THREE.Matrix4();
const _depthMat = new THREE.MeshBasicMaterial({ colorWrite: false }); // passe profondeur du modèle (overlay du sol)
let _saved = null, _hidden = [], _savedMats = [], _savedLights = [];
let _span = 2, _center = new THREE.Vector3(), _minY = -1;
const _CS = 1024; // résolution des textures d'ombre au sol
const _params = { ao: 1.6, aoRadius: 0.12, ambient: 1.3, shadowOpacity: 0.35, contactBlur: 10, castBlur: 6, azimuth: 45, elevation: 60, modelShadows: true, projShadow: true };

// Persistance des réglages de rendu dans localStorage (chargés à l'init, sauvés à chaque changement).
const _LS_KEY = 'sculpt-render-params';
function saveParams() { try { localStorage.setItem(_LS_KEY, JSON.stringify(_params)); } catch (_) { /* quota/privé */ } }
try { const s = JSON.parse(localStorage.getItem(_LS_KEY) || 'null'); if (s && typeof s === 'object') Object.assign(_params, s); } catch (_) { /* corrompu */ }

export function isRenderMode() { return _active; }
export function renderModeParams() { return _params; }

// Matériau de rendu = MeshLambertMaterial, comme le viewer.html (non-PBR -> couleurs franches, reçoit
// lumière + ombres). Texture (map) si présente, sinon vertex colors (linéarisés : ils sont stockés en
// valeurs d'affichage sRGB, sinon le pipeline les ré-encode et les éclaircit -> « voile blanc »).
const _vcMatCache = new WeakMap();
function renderMat(m) {
  const base = m.userData.baseMat || m.material;
  const map = base.map || (m.material && m.material.map) || null;
  const wantVC = !map && !!(m.geometry.attributes && m.geometry.attributes.color);
  let mat = _vcMatCache.get(base);
  if (!mat || mat.map !== map || mat.vertexColors !== wantVC) {
    mat = new THREE.MeshLambertMaterial({ map: map || null, color: 0xffffff, vertexColors: wantVC, side: base.side !== undefined ? base.side : THREE.FrontSide });
    if (wantVC) mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb = pow( diffuseColor.rgb, vec3( 2.2 ) );'); };
    _vcMatCache.set(base, mat);
  }
  return mat;
}

function sceneBounds() {
  const box = new THREE.Box3();
  let has = false;
  for (const o of state.objects) { if (o.visible) { box.expandByObject(o); has = true; } }
  return has ? box : null;
}

function aoParams() {
  return { radius: Math.max(0.005, _span * _params.aoRadius), distanceExponent: 1, thickness: 1, scale: _params.ao, samples: 16, distanceFallOff: 1, screenSpaceRadius: false };
}

function buildComposer() {
  const w = window.innerWidth, h = window.innerHeight;
  _composer = new EffectComposer(state.renderer);
  _composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _composer.setSize(w, h);
  _renderPass = new RenderPass(state.scene, state.camera);
  _composer.addPass(_renderPass);
  _gtao = new GTAOPass(state.scene, state.camera, w, h);
  _gtao.output = GTAOPass.OUTPUT.Default;
  _gtao.updateGtaoMaterial(aoParams());
  _composer.addPass(_gtao);
  _output = new OutputPass();
  _composer.addPass(_output);
}

// Pénombre de l'auto-ombrage : le rayon PCF seul ne floute quasi pas (kernel plafonné) ; on baisse aussi
// la résolution de la shadow map (texels plus larges = bords plus doux) proportionnellement au flou.
function applyCastBlur() {
  if (!_shadowLight) return;
  const b = _params.castBlur;
  const size = Math.max(512, Math.round(2048 / (1 + b * 0.12)));
  _shadowLight.shadow.mapSize.set(size, size);
  _shadowLight.shadow.radius = 1 + b * 0.5;
  _shadowLight.shadow.normalBias = _span * (0.004 + b * 0.0012); // plus le flou est fort, plus la map est basse rés -> plus de normalBias pour éviter les stries
  if (_shadowLight.shadow.map) { _shadowLight.shadow.map.dispose(); _shadowLight.shadow.map = null; } // régénère à la nouvelle taille
}

// Oriente la DIRECTIONNELLE (auto-ombrage du modèle) selon azimut/hauteur.
function placeLight() {
  if (!_shadowLight) return;
  const az = THREE.MathUtils.degToRad(_params.azimuth), el = THREE.MathUtils.degToRad(_params.elevation);
  const ch = Math.cos(el), d = Math.max(1e-3, _span * 3);
  _shadowLight.position.set(_center.x + d * ch * Math.cos(az), _minY + d * Math.sin(el) + _span * 0.1, _center.z + d * ch * Math.sin(az));
  _shadowLight.target.position.copy(_center);
  _shadowLight.target.updateMatrixWorld(true);
  updateProjCam();
}

// Caméra de l'ombre de PROJECTION : alignée sur la lumière (regarde le centre depuis la position de la
// lumière). Sa matrice VP sert à projeter la silhouette floutée sur le sol dans l'axe de la lumière.
function updateProjCam() {
  if (!_projCam || !_shadowLight) return;
  _projCam.position.copy(_shadowLight.position);
  _projCam.up.set(0, 1, 0);
  _projCam.lookAt(_center);
  _projCam.updateMatrixWorld(true);
  _projVP.multiplyMatrices(_projCam.projectionMatrix, _projCam.matrixWorldInverse);
  if (_groundMat) _groundMat.uniforms.uProjVP.value.copy(_projVP);
}

function buildShadow(box) {
  const size = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(2, 2, 2);
  _center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  _minY = box ? box.min.y : -1;
  _span = Math.max(size.x, size.y, size.z) || 2;

  // Fill = HemisphereLight (dégradé ciel/sol) : approximation de GLOBAL ILLUMINATION compatible avec les
  // matériaux Lambert (l'IBL n'agit pas dessus), + directionnelle FORTE (modelé + auto-ombrage du modèle).
  _ambient = new THREE.HemisphereLight(0xffffff, 0x8a8674, _params.ambient);
  state.scene.add(_ambient);
  _shadowLight = new THREE.DirectionalLight(0xffffff, 3.0);
  _shadowLight.castShadow = true;
  const cam = _shadowLight.shadow.camera;
  const r = _span * 2.0;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 0.01; cam.far = _span * 10;
  _shadowLight.shadow.mapSize.set(2048, 2048);
  _shadowLight.shadow.bias = -0.0004;
  applyCastBlur(); // pénombre de l'auto-ombrage : mapSize + rayon PCF + normalBias selon castBlur
  state.scene.add(_shadowLight);
  state.scene.add(_shadowLight.target);
  placeLight();

  buildContactShadow(size);

  for (const o of state.objects) o.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = _params.modelShadows; } });
}

// --- Ombre de contact au sol : silhouette du modèle vue de dessus -> texture floutée -> projetée sur le sol.
function buildContactShadow(size) {
  const halfW = (size.x || _span) * 0.5 + _span * 0.35; // marge pour que le flou ne soit pas coupé
  const halfD = (size.z || _span) * 0.5 + _span * 0.35;
  _csCam = new THREE.OrthographicCamera(-halfW, halfW, halfD, -halfD, 0.001, _span * 3);
  _csCam.position.set(_center.x, _minY + _span * 1.5, _center.z);
  _csCam.up.set(0, 0, -1);
  _csCam.lookAt(_center.x, _minY, _center.z);
  _csCam.updateMatrixWorld(true);

  const rtOpts = { depthBuffer: true, stencilBuffer: false };
  _csRT = new THREE.WebGLRenderTarget(_CS, _CS, rtOpts);
  _projRT = new THREE.WebGLRenderTarget(_CS, _CS, rtOpts);
  _csBlurRT = new THREE.WebGLRenderTarget(_CS, _CS, { depthBuffer: false });
  _silMat = new THREE.MeshBasicMaterial({ color: 0x000000 }); // silhouette : noir opaque (alpha=1 où il y a de la matière)
  _fsq = new FullScreenQuad();
  _hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); _hBlur.depthTest = false;
  _vBlur = new THREE.ShaderMaterial(VerticalBlurShader); _vBlur.depthTest = false;

  // Caméra de projection (axe lumière), ortho large (l'ombre s'étire aux faibles hauteurs).
  const pr = _span * 2.2;
  _projCam = new THREE.OrthographicCamera(-pr, pr, pr, -pr, 0.01, _span * 8);

  // Plan de sol : combine 2 ombres projetées (silhouettes floutées) -> alpha = max(contact, projection).
  //  - CONTACT : vue de dessus (_csCam) ; toujours active (rend l'ombre douce type AO sous l'objet).
  //  - PROJECTION : axe de la lumière (_projCam) ; activable (uProjOn).
  _groundMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uContactTex: { value: _csRT.texture },
      uContactVP: { value: new THREE.Matrix4().multiplyMatrices(_csCam.projectionMatrix, _csCam.matrixWorldInverse) },
      uProjTex: { value: _projRT.texture },
      uProjVP: { value: new THREE.Matrix4() },
      uProjOn: { value: _params.projShadow ? 1.0 : 0.0 },
      uOpacity: { value: _params.shadowOpacity },
    },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: [
      'varying vec3 vW;',
      'uniform sampler2D uContactTex; uniform mat4 uContactVP;',
      'uniform sampler2D uProjTex; uniform mat4 uProjVP; uniform float uProjOn;',
      'uniform float uOpacity;',
      'float sampleShadow(sampler2D t, mat4 vp){ vec4 c = vp * vec4(vW,1.0); vec2 uv = c.xy/c.w*0.5+0.5; if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) return 0.0; return texture2D(t, uv).a; }',
      'void main(){',
      '  float a = sampleShadow(uContactTex, uContactVP);',
      '  a = max(a, uProjOn * sampleShadow(uProjTex, uProjVP));',
      '  gl_FragColor = vec4(0.0,0.0,0.0, a*uOpacity);',
      '}',
    ].join('\n'),
  });
  _ground = new THREE.Mesh(new THREE.PlaneGeometry(_span * 16, _span * 16), _groundMat);
  _ground.rotation.x = -Math.PI / 2;
  _ground.position.set(_center.x, _minY - _span * 0.002, _center.z);
  state.scene.add(_ground);
  updateProjCam();
}

// Rend la silhouette du modèle vue par `cam` dans `rt`, puis la floute (`iters` passes H+V gaussiennes,
// amplitude `amt` en UV). Contact = gros flou doux ; projection = flou léger (proche de l'ombre objet).
function renderSilhouette(cam, rt, r, s, amt, iters) {
  s.overrideMaterial = _silMat;
  r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear();
  r.render(s, cam);
  s.overrideMaterial = null;
  for (let i = 0; i < iters; i++) {
    _hBlur.uniforms.tDiffuse.value = rt.texture; _hBlur.uniforms.h.value = amt;
    _fsq.material = _hBlur; r.setRenderTarget(_csBlurRT); r.clear(); _fsq.render(r);
    _vBlur.uniforms.tDiffuse.value = _csBlurRT.texture; _vBlur.uniforms.v.value = amt;
    _fsq.material = _vBlur; r.setRenderTarget(rt); r.clear(); _fsq.render(r);
  }
}

// Met à jour les textures d'ombre au sol (contact + projection). Appelé chaque frame avant le composer.
function updateContactShadow() {
  if (!_csRT) return;
  const r = state.renderer, s = state.scene;
  _ground.visible = false;
  const prevBg = s.background, prevRT = r.getRenderTarget();
  const prevCC = r.getClearColor(new THREE.Color()), prevCA = r.getClearAlpha(), prevAuto = r.autoClear;
  s.background = null; r.autoClear = true;
  renderSilhouette(_csCam, _csRT, r, s, Math.max(0.0001, _params.contactBlur / 512), 2);        // contact : gros flou doux (façon AO)
  if (_params.projShadow) renderSilhouette(_projCam, _projRT, r, s, Math.max(0.0001, _params.castBlur / 2200), 1); // projection : flou LÉGER (proche de l'ombre objet)
  r.setRenderTarget(prevRT); r.setClearColor(prevCC, prevCA); r.autoClear = prevAuto;
  s.background = prevBg;
  _ground.visible = true;
}

function hideHelpers() {
  _hidden = [];
  const hide = (obj) => { if (obj) { _hidden.push({ obj, vis: obj.visible }); obj.visible = false; } };
  hide(state.grid); hide(state.brushMesh); hide(state.brushDot);
  state.scene.traverse((o) => {
    if (o.name === 'skeletonHelper' || o.name === 'wireframe' || o.name === 'poseMarkers') hide(o);
    else if (o.isTransformControls || o.type === 'TransformControls') hide(o);
  });
}

export function enterRenderMode() {
  if (_active) return;
  _active = true;
  const r = state.renderer, s = state.scene;
  _saved = { background: s.background, environment: s.environment, toneMapping: r.toneMapping, exposure: r.toneMappingExposure, shadow: r.shadowMap.enabled, shadowType: r.shadowMap.type };

  s.background = new THREE.Color(0xffffff);
  s.environment = null;
  r.toneMapping = THREE.NoToneMapping;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap; // pénombre douce SANS rétrécissement (VSM rétrécissait l'ombre)

  buildShadow(sceneBounds());
  _savedLights = [];
  state.scene.traverse((o) => { if (o.isLight && o !== _shadowLight && o !== _ambient) { _savedLights.push({ o, vis: o.visible }); o.visible = false; } });
  hideHelpers();
  _savedMats = [];
  for (const m of state.objects) { if (!m.isMesh) continue; const t = renderMat(m); if (m.material !== t) { _savedMats.push({ m, mat: m.material }); m.material = t; } }
  buildComposer();
}

export function exitRenderMode() {
  if (!_active) return;
  _active = false;
  const r = state.renderer, s = state.scene;

  if (_composer) { _composer.passes.forEach((p) => p.dispose && p.dispose()); _composer = null; _gtao = _renderPass = _output = null; }
  if (_shadowLight) { s.remove(_shadowLight.target); s.remove(_shadowLight); _shadowLight.dispose && _shadowLight.dispose(); _shadowLight = null; }
  if (_ambient) { s.remove(_ambient); _ambient.dispose && _ambient.dispose(); _ambient = null; }
  if (_ground) { s.remove(_ground); _ground.geometry.dispose(); _ground.material.dispose(); _ground = null; _groundMat = null; }
  if (_csRT) { _csRT.dispose(); _csRT = null; }
  if (_projRT) { _projRT.dispose(); _projRT = null; }
  if (_csBlurRT) { _csBlurRT.dispose(); _csBlurRT = null; }
  _projCam = null;
  if (_fsq) { _fsq.dispose(); _fsq = null; }
  if (_silMat) { _silMat.dispose(); _silMat = null; }
  _csCam = _hBlur = _vBlur = null;
  for (const o of state.objects) o.traverse((n) => { if (n.isMesh) { n.castShadow = false; n.receiveShadow = false; } });

  for (const sm of _savedMats) sm.m.material = sm.mat;
  _savedMats = [];
  for (const l of _savedLights) l.o.visible = l.vis;
  _savedLights = [];
  for (const h of _hidden) h.obj.visible = h.vis;
  _hidden = [];

  if (_saved) {
    s.background = _saved.background; s.environment = _saved.environment;
    r.toneMapping = _saved.toneMapping; r.toneMappingExposure = _saved.exposure;
    r.shadowMap.enabled = _saved.shadow; r.shadowMap.type = _saved.shadowType;
    _saved = null;
  }
  r.autoClear = true;
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

export function renderFrame() {
  if (!_composer) return;
  const r = state.renderer, s = state.scene;
  updateContactShadow();           // met à jour les textures d'ombre au sol (sol masqué à l'intérieur)

  // Composer = MODÈLE seul (sol masqué) -> l'AO ne s'applique qu'aux objets, pas au sol ni au fond.
  _ground.visible = false;
  _composer.render();

  // Overlay : le SOL (ombres projetées) par-dessus l'image, occulté par la profondeur du modèle.
  const bg = s.background; s.background = null;
  r.autoClear = false;
  r.clearDepth();
  s.overrideMaterial = _depthMat;  // 1) profondeur du modèle (sans couleur)
  r.render(s, state.camera);
  s.overrideMaterial = null;
  const vis = state.objects.map((o) => o.visible);
  for (const o of state.objects) o.visible = false;
  _ground.visible = true;
  r.render(s, state.camera);       // 2) le sol, occulté par le modèle
  r.autoClear = true;
  s.background = bg;
  state.objects.forEach((o, i) => { o.visible = vis[i]; });
}

export function onResize() {
  if (!_active || !_composer) return;
  const w = window.innerWidth, h = window.innerHeight;
  _composer.setSize(w, h);
  if (_gtao) _gtao.setSize(w, h);
}

// Réglages live depuis l'UI (persistés dans localStorage).
export function setAOStrength(v) { _params.ao = v; if (_gtao) _gtao.updateGtaoMaterial(aoParams()); saveParams(); }
export function setAORadius(v) { _params.aoRadius = v; if (_gtao) _gtao.updateGtaoMaterial(aoParams()); saveParams(); }
export function setAmbient(v) { _params.ambient = v; if (_ambient) _ambient.intensity = v; saveParams(); }
export function setShadowOpacity(v) { _params.shadowOpacity = v; if (_groundMat) _groundMat.uniforms.uOpacity.value = v; saveParams(); }
// Flou de l'ombre de CONTACT au sol (façon AO) — appliqué chaque frame dans updateContactShadow.
export function setContactBlur(v) { _params.contactBlur = v; saveParams(); }
// Flou de l'ombre PORTÉE : au sol (projection) ET sur les objets (pénombre PCF).
export function setCastBlur(v) { _params.castBlur = v; applyCastBlur(); saveParams(); }
export function setProjShadow(on) { _params.projShadow = !!on; if (_groundMat) _groundMat.uniforms.uProjOn.value = on ? 1.0 : 0.0; saveParams(); }
export function setShadowAzimuth(v) { _params.azimuth = v; placeLight(); saveParams(); }
export function setShadowElevation(v) { _params.elevation = v; placeLight(); saveParams(); }
export function setModelShadows(on) {
  _params.modelShadows = !!on;
  for (const o of state.objects) o.traverse((n) => { if (n.isMesh) { n.receiveShadow = !!on; if (n.material) n.material.needsUpdate = true; } });
  saveParams();
}
