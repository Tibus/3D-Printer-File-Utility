// ============================================================================
// 3D Viewer with Three.js
// ============================================================================

const CAMERA_STORAGE_KEY = 'objColorClamper_cameraState';
const VIEWER_SETTINGS_KEY = 'objColorClamper_viewerSettings';
let cameraFitDistance = null; // distance computed by fitCameraToObject
let cameraSaveTimer = null;
let settingsSaveTimer = null;

function saveCameraState() {
  if (!viewer3D.controls || !viewer3D.camera || !cameraFitDistance) return;
  const azimuth = viewer3D.controls.getAzimuthalAngle();
  const polar = viewer3D.controls.getPolarAngle();
  const dist = viewer3D.camera.position.distanceTo(viewer3D.controls.target);
  const distRatio = dist / cameraFitDistance;
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({ azimuth, polar, distRatio }));
  } catch { /* ignore */ }
}

function saveCameraStateDebounced() {
  clearTimeout(cameraSaveTimer);
  cameraSaveTimer = setTimeout(saveCameraState, 300);
}

function loadCameraState() {
  try {
    const stored = localStorage.getItem(CAMERA_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function saveViewerSettings() {
  const aoSlider = document.getElementById('aoStrengthSlider');
  const opacitySlider = document.getElementById('shadowOpacitySlider');
  const spreadSlider = document.getElementById('shadowSpreadSlider');
  const brightnessSlider = document.getElementById('brightnessSlider');
  const contrastSlider = document.getElementById('contrastSlider');
  const saturationSlider = document.getElementById('saturationSlider');
  const temperatureSlider = document.getElementById('temperatureSlider');
  const fdmLayerHeightSlider = document.getElementById('fdmLayerHeightSlider');
  const fdmLayerStrengthSlider = document.getElementById('fdmLayerStrengthSlider');
  const fdmContaminationSlider = document.getElementById('fdmContaminationSlider');
  const settings = {
    aoEnabled: viewer3D.aoEnabled,
    shadowEnabled: viewer3D.shadowEnabled,
    aoStrength: aoSlider ? parseFloat(aoSlider.value) : 0.7,
    shadowOpacity: opacitySlider ? parseFloat(opacitySlider.value) : 0.12,
    shadowSpread: spreadSlider ? parseFloat(spreadSlider.value) : 100,
    brightness: brightnessSlider ? parseFloat(brightnessSlider.value) : 1.0,
    contrast: contrastSlider ? parseFloat(contrastSlider.value) : 1.0,
    saturation: saturationSlider ? parseFloat(saturationSlider.value) : 1.0,
    temperature: temperatureSlider ? parseFloat(temperatureSlider.value) : 0.0,
    wireframeEnabled: viewer3D.wireframeEnabled,
    fdmEnabled: viewer3D.fdmEnabled,
    fdmLayerHeight: fdmLayerHeightSlider ? parseFloat(fdmLayerHeightSlider.value) : 0.2,
    fdmLayerStrength: fdmLayerStrengthSlider ? parseFloat(fdmLayerStrengthSlider.value) : 0.5,
    fdmContamination: fdmContaminationSlider ? parseFloat(fdmContaminationSlider.value) : 0.3,
  };
  try {
    localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

function saveViewerSettingsDebounced() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(saveViewerSettings, 300);
}

function loadViewerSettings() {
  try {
    const stored = localStorage.getItem(VIEWER_SETTINGS_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Shader Constants
// ============================================================================

const AO_VERTEX_SHADER = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

const AO_FRAGMENT_SHADER = [
  '#define NUM_DIRS 12',
  '#define NUM_STEPS 3',
  'uniform sampler2D tDiffuse;',
  'uniform sampler2D tDepth;',
  'uniform float cameraFar;',
  'uniform vec2 resolution;',
  'uniform float kernelRadius;',
  'uniform float aoStrength;',
  'uniform float minDistance;',
  'uniform float maxDistance;',
  'uniform float proj00;',
  'uniform float proj11;',
  'uniform float aoDebug;',
  'uniform float brightness;',
  'uniform float contrast;',
  'uniform float saturation;',
  'uniform float temperature;',
  'varying vec2 vUv;',
  '',
  'float logDepthToViewZ(float d) {',
  '  return 1.0 - pow(2.0, d * log2(cameraFar + 1.0));',
  '}',
  '',
  'vec3 viewPosAt(vec2 uv) {',
  '  float d = texture2D(tDepth, uv).x;',
  '  if (d >= 1.0) return vec3(0.0, 0.0, 1.0);',
  '  float vz = logDepthToViewZ(d);',
  '  vec2 ndc = (uv - 0.5) * 2.0;',
  '  return vec3(ndc.x * (-vz) / proj00, ndc.y * (-vz) / proj11, vz);',
  '}',
  '',
  'float hash12(vec2 p) {',
  '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
  '  p3 += dot(p3, p3.yzx + 33.33);',
  '  return fract((p3.x + p3.y) * p3.z);',
  '}',
  '',
  'void main() {',
  '  vec4 color = texture2D(tDiffuse, vUv);',
  '  float d = texture2D(tDepth, vUv).x;',
  '  if (d >= 1.0) {',
  '    gl_FragColor = (aoDebug > 0.5) ? vec4(1.0) : color;',
  '    return;',
  '  }',
  '',
  '  vec3 pos = viewPosAt(vUv);',
  '  vec2 texel = 1.0 / resolution;',
  '',
  '  // Bilateral normal reconstruction',
  '  vec3 posL = viewPosAt(vUv - vec2(texel.x, 0.0));',
  '  vec3 posR = viewPosAt(vUv + vec2(texel.x, 0.0));',
  '  vec3 posD = viewPosAt(vUv - vec2(0.0, texel.y));',
  '  vec3 posU = viewPosAt(vUv + vec2(0.0, texel.y));',
  '  vec3 dx = (abs(posR.z - pos.z) < abs(posL.z - pos.z)) ? (posR - pos) : (pos - posL);',
  '  vec3 dy = (abs(posU.z - pos.z) < abs(posD.z - pos.z)) ? (posU - pos) : (pos - posD);',
  '  vec3 normal = normalize(cross(dx, dy));',
  '',
  '  float ao = 0.0;',
  '  float total = 0.0;',
  '  float rnd = hash12(gl_FragCoord.xy);',
  '  float angleStep = 6.283185 / float(NUM_DIRS);',
  '',
  '  for (int i = 0; i < NUM_DIRS; i++) {',
  '    float angle = (float(i) + rnd) * angleStep;',
  '    vec2 dir = vec2(cos(angle), sin(angle));',
  '    for (int j = 1; j <= NUM_STEPS; j++) {',
  '      float t = float(j) / float(NUM_STEPS);',
  '      vec2 sampleUv = vUv + dir * t * kernelRadius * texel;',
  '      if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) { total += 1.0; continue; }',
  '      vec3 sp = viewPosAt(sampleUv);',
  '      if (sp.z > -0.001) { total += 1.0; continue; }',
  '      vec3 diff = sp - pos;',
  '      float dist = length(diff);',
  '      if (dist < minDistance || dist > maxDistance) { total += 1.0; continue; }',
  '      ao += max(0.0, dot(normal, normalize(diff)));',
  '      total += 1.0;',
  '    }',
  '  }',
  '',
  '  if (total > 0.0) ao /= total;',
  '  float occlusion = clamp(1.0 - ao * aoStrength, 0.0, 1.0);',
  '  if (aoDebug > 0.5) {',
  '    gl_FragColor = vec4(vec3(occlusion), 1.0);',
  '  } else {',
  '    vec3 lit = color.rgb * occlusion * brightness;',
  '    lit = (lit - 0.5) * contrast + 0.5;',
  '    float lum = dot(lit, vec3(0.2126, 0.7152, 0.0722));',
  '    lit = mix(vec3(lum), lit, saturation);',
  '    lit.r += temperature * 0.5;',
  '    lit.b -= temperature * 0.5;',
  '    lit = clamp(lit, 0.0, 1.0);',
  '    gl_FragColor = vec4(lit, color.a);',
  '  }',
  '}'
].join('\n');

// ============================================================================
// FDM Print Simulation Shader
// ============================================================================

const FDM_FRAGMENT_SHADER = [
  'uniform sampler2D tDiffuse;',
  'uniform sampler2D tDepth;',
  'uniform vec2 resolution;',
  'uniform float cameraFar;',
  'uniform float proj00;',
  'uniform float proj11;',
  'uniform mat4 invViewMatrix;',
  'uniform float layerHeight;',
  'uniform float layerStrength;',
  'uniform float contamination;',
  'uniform float fdmEnabled;',
  'varying vec2 vUv;',
  '',
  'float fdmLogDepthToViewZ(float d) {',
  '  return 1.0 - pow(2.0, d * log2(cameraFar + 1.0));',
  '}',
  '',
  'vec3 fdmViewPosAt(vec2 uv) {',
  '  float d = texture2D(tDepth, uv).x;',
  '  if (d >= 1.0) return vec3(0.0, 0.0, 1e5);',
  '  float vz = fdmLogDepthToViewZ(d);',
  '  vec2 ndc = (uv - 0.5) * 2.0;',
  '  return vec3(ndc.x * (-vz) / proj00, ndc.y * (-vz) / proj11, vz);',
  '}',
  '',
  'void main() {',
  '  vec4 color = texture2D(tDiffuse, vUv);',
  '  float d = texture2D(tDepth, vUv).x;',
  '  if (fdmEnabled < 0.5 || d >= 1.0) {',
  '    gl_FragColor = color;',
  '    return;',
  '  }',
  '',
  '  vec2 texel = 1.0 / resolution;',
  '  vec3 viewPos = fdmViewPosAt(vUv);',
  '  vec3 worldPos = (invViewMatrix * vec4(viewPos, 1.0)).xyz;',
  '',
  '  // === Layer Lines ===',
  '  float lh = max(layerHeight, 0.0001);',
  '  float layerFrac = fract(worldPos.y / lh);',
  '  // Groove at layer boundaries (bottom 15% and top 15%)',
  '  float groove = smoothstep(0.0, 0.15, layerFrac) * smoothstep(1.0, 0.85, layerFrac);',
  '  // Subtle bead roundness within each layer',
  '  float bead = 1.0 + 0.015 * sin(layerFrac * 3.14159);',
  '  float layerMul = mix(1.0, groove * bead, layerStrength);',
  '',
  '  // === Color Contamination ===',
  '  vec3 result = color.rgb;',
  '  if (contamination > 0.01) {',
  '    vec3 sumDiff = vec3(0.0);',
  '    float wTotal = 0.0;',
  '    float radius = 3.0;',
  '    for (int i = 0; i < 8; i++) {',
  '      float angle = float(i) * 0.7854;',
  '      vec2 off = vec2(cos(angle), sin(angle)) * texel * radius;',
  '      float sd = texture2D(tDepth, vUv + off).x;',
  '      if (sd >= 1.0) continue;',
  '      vec3 sc = texture2D(tDiffuse, vUv + off).rgb;',
  '      float cdiff = length(sc - color.rgb);',
  '      if (cdiff > 0.05) {',
  '        sumDiff += sc * cdiff;',
  '        wTotal += cdiff;',
  '      }',
  '    }',
  '    if (wTotal > 0.01) {',
  '      result = mix(color.rgb, sumDiff / wTotal, contamination * 0.25);',
  '    }',
  '  }',
  '',
  '  // === Edge Rounding (silhouette softening) ===',
  '  float edge = 0.0;',
  '  for (int i = 0; i < 8; i++) {',
  '    float angle = float(i) * 0.7854;',
  '    vec2 off = vec2(cos(angle), sin(angle)) * texel * 2.0;',
  '    float sd = texture2D(tDepth, vUv + off).x;',
  '    if (sd >= 1.0) edge += 1.0;',
  '  }',
  '  edge /= 8.0;',
  '  float edgeDarken = mix(1.0, 0.88, edge * layerStrength);',
  '',
  '  result = clamp(result * layerMul * edgeDarken, 0.0, 1.0);',
  '  gl_FragColor = vec4(result, color.a);',
  '}'
].join('\n');

const COMPOSITE_FRAGMENT_SHADER = [
  'uniform sampler2D tModel;',
  'uniform sampler2D tShadow;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec4 model = texture2D(tModel, vUv);',
  '  vec4 shadow = texture2D(tShadow, vUv);',
  '  float s = shadow.a;',
  '  vec3 rgb = model.rgb * (1.0 - s);',
  '  float a = model.a + s * (1.0 - model.a);' +
  '  if(model.a < 0.01) {' +
  '    rgb = vec3(0.0);' +
  '  }' +
  '  gl_FragColor = vec4(rgb, a);',
  '}'
].join('\n');

// ============================================================================
// Global Viewer Objects
// ============================================================================

let viewer3D = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  mesh: null,
  container: null,
  animationId: null,
  vertices: null,
  faces: null,
  beautyRT: null,
  aoRT: null,
  shadowRT: null,
  aoMaterial: null,
  fxaaMaterial: null,
  compositeMaterial: null,
  fsQuad: null,
  fsScene: null,
  fsCamera: null,
  aoEnabled: true,
  aoDebug: false,
  shadowEnabled: true,
  wireframeEnabled: false,
  directionalLight: null,
  groundPlane: null,
  shadowBaseSpread: null
};

let processViewer3D = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  mesh: null,
  container: null,
  animationId: null,
  vertices: null,
  faces: null,
  beautyRT: null,
  aoRT: null,
  shadowRT: null,
  aoMaterial: null,
  fxaaMaterial: null,
  compositeMaterial: null,
  fsQuad: null,
  fsScene: null,
  fsCamera: null,
  aoEnabled: true,
  aoDebug: false,
  shadowEnabled: true,
  directionalLight: null,
  groundPlane: null,
  shadowBaseSpread: null
};

// ============================================================================
// Shared AO Pipeline Functions
// ============================================================================

/**
 * Sets up the full AO rendering pipeline for a viewer object.
 * @param {object} viewer - The viewer state object to populate
 * @param {string} containerId - DOM container ID
 * @param {object} opts - Options: { preserveDrawingBuffer, saveCameraOnChange }
 */
function setupAOPipeline(viewer, containerId, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return false;

  viewer.container = container;
  container.innerHTML = '';

  // Create scene
  viewer.scene = new THREE.Scene();
  viewer.scene.background = new THREE.Color(0xffffff);

  // Create camera
  const width = container.clientWidth || 400;
  const height = container.clientHeight || 300;
  viewer.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  viewer.camera.position.set(0, 0, 5);

  // Create renderer
  viewer.renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    alpha: true,
    premultipliedAlpha: false,
    logarithmicDepthBuffer: true
  });
  viewer.renderer.setSize(width, height);
  viewer.renderer.setPixelRatio(window.devicePixelRatio);
  viewer.renderer.shadowMap.enabled = true;
  viewer.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(viewer.renderer.domElement);

  // Add OrbitControls
  viewer.controls = new THREE.OrbitControls(viewer.camera, viewer.renderer.domElement);
  viewer.controls.enableDamping = true;
  viewer.controls.dampingFactor = 0.05;
  if (opts.saveCameraOnChange) {
    viewer.controls.addEventListener('change', saveCameraStateDebounced);
  }

  // Add lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  viewer.scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.3);
  directionalLight.position.set(5, 10, 7);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 256;
  directionalLight.shadow.mapSize.height = 256;
  directionalLight.shadow.camera.near = 0.1;
  directionalLight.shadow.camera.far = 200;
  directionalLight.shadow.camera.left = -20;
  directionalLight.shadow.camera.right = 20;
  directionalLight.shadow.camera.top = 20;
  directionalLight.shadow.camera.bottom = -20;
  directionalLight.shadow.radius = 100;
  directionalLight.shadow.bias = -0.0001;
  viewer.scene.add(directionalLight);
  viewer.directionalLight = directionalLight;

  // Render targets (2x supersampled)
  const ssW = width * 2, ssH = height * 2;

  // Beauty render target with depth texture
  viewer.beautyRT = new THREE.WebGLRenderTarget(ssW, ssH, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
  });
  viewer.beautyRT.depthTexture = new THREE.DepthTexture();
  viewer.beautyRT.depthTexture.type = THREE.UnsignedIntType;

  // AO output render target
  viewer.aoRT = new THREE.WebGLRenderTarget(ssW, ssH, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
  });

  // Full-screen quad for post-processing passes
  viewer.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  viewer.fsScene = new THREE.Scene();
  viewer.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  viewer.fsScene.add(viewer.fsQuad);

  // AO shader material
  viewer.aoMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: viewer.beautyRT.depthTexture },
      cameraFar: { value: 1000.0 },
      resolution: { value: new THREE.Vector2(ssW, ssH) },
      kernelRadius: { value: 20.0 },
      aoStrength: { value: 0.7 },
      minDistance: { value: 0.001 },
      maxDistance: { value: 100.1 },
      proj00: { value: 1.0 },
      proj11: { value: 1.0 },
      aoDebug: { value: 0.0 },
      brightness: { value: 1.0 },
      contrast: { value: 1.0 },
      saturation: { value: 1.0 },
      temperature: { value: 0.0 }
    },
    vertexShader: AO_VERTEX_SHADER,
    fragmentShader: AO_FRAGMENT_SHADER,
    depthWrite: false,
    depthTest: false
  });

  // FXAA material
  viewer.fxaaMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(THREE.FXAAShader.uniforms),
    vertexShader: THREE.FXAAShader.vertexShader,
    fragmentShader: THREE.FXAAShader.fragmentShader,
    depthWrite: false,
    depthTest: false
  });
  viewer.fxaaMaterial.uniforms['resolution'].value.set(1.0 / ssW, 1.0 / ssH);

  // Shadow render target (for PNG export compositing)
  viewer.shadowRT = new THREE.WebGLRenderTarget(ssW, ssH, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
  });

  // Composite material: merges model + shadow for correct transparent PNG
  viewer.compositeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tModel: { value: null },
      tShadow: { value: null }
    },
    vertexShader: AO_VERTEX_SHADER,
    fragmentShader: COMPOSITE_FRAGMENT_SHADER,
    depthWrite: false,
    depthTest: false
  });

  // FDM simulation render target
  viewer.fdmRT = new THREE.WebGLRenderTarget(ssW, ssH, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
  });

  // FDM simulation material
  viewer.fdmMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: viewer.beautyRT.depthTexture },
      resolution: { value: new THREE.Vector2(ssW, ssH) },
      cameraFar: { value: 1000.0 },
      proj00: { value: 1.0 },
      proj11: { value: 1.0 },
      invViewMatrix: { value: new THREE.Matrix4() },
      layerHeight: { value: 0.2 },
      layerStrength: { value: 0.5 },
      contamination: { value: 0.3 },
      fdmEnabled: { value: 0.0 }
    },
    vertexShader: AO_VERTEX_SHADER,
    fragmentShader: FDM_FRAGMENT_SHADER,
    depthWrite: false,
    depthTest: false
  });

  // Default state
  viewer.aoEnabled = true;
  viewer.aoDebug = false;
  viewer.shadowEnabled = true;
  viewer.fdmEnabled = false;

  return true;
}

/**
 * Render the full AO pipeline for a viewer.
 */
function renderAOPipeline(viewer, background) {
  const r = viewer.renderer;
  const scene = viewer.scene;
  const camera = viewer.camera;

  // Temporarily set scene background (null = transparent for PNG export)
  const savedBg = scene.background;
  scene.background = background;

  // Step 1: Render scene to beautyRT (with depth) — hide ground so AO only affects mesh
  if (viewer.groundPlane) viewer.groundPlane.visible = false;
  r.setRenderTarget(viewer.beautyRT);
  r.setClearColor(background || 0xFFFFFF, background ? 1 : 0);
  r.clear();
  r.render(scene, camera);

  // Step 2: AO + gamma pass (always runs for gamma; aoStrength=0 when AO disabled)
  {
    const ao = viewer.aoMaterial;
    ao.uniforms.tDiffuse.value = viewer.beautyRT.texture;
    ao.uniforms.cameraFar.value = camera.far;
    ao.uniforms.proj00.value = camera.projectionMatrix.elements[0];
    ao.uniforms.proj11.value = camera.projectionMatrix.elements[5];
    ao.uniforms.aoDebug.value = (viewer.aoEnabled && viewer.aoDebug) ? 1.0 : 0.0;
    // When AO is disabled, force aoStrength to 0 so only gamma is applied
    if (!viewer.aoEnabled) {
      ao.uniforms.aoStrength.value = 0.0;
    } else {
      const aoSlider = document.getElementById('aoStrengthSlider');
      ao.uniforms.aoStrength.value = aoSlider ? parseFloat(aoSlider.value) : 0.7;
    }

    viewer.fsQuad.material = ao;
    r.setRenderTarget(viewer.aoRT);
    r.render(viewer.fsScene, viewer.fsCamera);
  }

  // Step 2.5: FDM simulation pass
  if (viewer.fdmEnabled && viewer.fdmMaterial) {
    const fdm = viewer.fdmMaterial;
    fdm.uniforms.tDiffuse.value = viewer.aoRT.texture;
    fdm.uniforms.cameraFar.value = camera.far;
    fdm.uniforms.proj00.value = camera.projectionMatrix.elements[0];
    fdm.uniforms.proj11.value = camera.projectionMatrix.elements[5];
    fdm.uniforms.invViewMatrix.value.copy(camera.matrixWorld);
    fdm.uniforms.fdmEnabled.value = 1.0;

    viewer.fsQuad.material = fdm;
    r.setRenderTarget(viewer.fdmRT);
    r.render(viewer.fsScene, viewer.fsCamera);
  }

  // Step 3: FXAA pass
  const source = (viewer.fdmEnabled && viewer.fdmRT) ? viewer.fdmRT : viewer.aoRT;
  viewer.fxaaMaterial.uniforms['tDiffuse'].value = source.texture;
  viewer.fsQuad.material = viewer.fxaaMaterial;

  if (!background && viewer.shadowEnabled && viewer.groundPlane && viewer.mesh) {
    // PNG export path: render model to RT, shadow to RT, then composite
    // Step 3a: FXAA → modelRT (write to the RT that FXAA is NOT reading from)
    const modelRT = viewer.aoEnabled ? viewer.beautyRT : viewer.aoRT;
    r.setRenderTarget(modelRT);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(viewer.fsScene, viewer.fsCamera);

    // Step 4a: Shadow → shadowRT (black clear for correct black-transparent shadow)
    viewer.groundPlane.visible = true;
    scene.background = null;
    r.setRenderTarget(viewer.shadowRT);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;

    // Depth pass: mesh only (for occlusion)
    viewer.mesh.material.colorWrite = false;
    r.render(scene, camera);
    viewer.mesh.material.colorWrite = true;

    // Shadow pass: ground only
    viewer.mesh.visible = false;
    r.render(scene, camera);
    viewer.mesh.visible = true;
    r.autoClear = true;
    r.shadowMap.autoUpdate = true;

    // Step 5: Composite model + shadow → screen
    viewer.compositeMaterial.uniforms.tModel.value = modelRT.texture;
    viewer.compositeMaterial.uniforms.tShadow.value = viewer.shadowRT.texture;
    viewer.fsQuad.material = viewer.compositeMaterial;
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(viewer.fsScene, viewer.fsCamera);
  } else {
    // Normal screen path
    r.setRenderTarget(null);
    r.setClearColor(background || 0xFFFFFF, background ? 1 : 0);
    r.clear();
    r.render(viewer.fsScene, viewer.fsCamera);

    // Step 4: Ground plane overlay with shadow (direct blending on screen)
    if (viewer.shadowEnabled && viewer.groundPlane && viewer.mesh) {
      viewer.groundPlane.visible = true;
      scene.background = null;
      r.autoClear = false;
      r.shadowMap.autoUpdate = false;

      r.clearDepth();
      viewer.mesh.material.colorWrite = false;
      r.render(scene, camera);
      viewer.mesh.material.colorWrite = true;

      viewer.mesh.visible = false;
      r.render(scene, camera);

      viewer.mesh.visible = true;
      r.autoClear = true;
      r.shadowMap.autoUpdate = true;
    }
  }

  // Restore scene background
  scene.background = savedBg;
}

/**
 * Load a model into an AO viewer.
 */
function loadModelToAOViewer(viewer, vertices, faces, faceColors) {
  if (!viewer.scene) return;

  // Store for raycasting
  viewer.vertices = vertices;
  viewer.faces = faces;

  // Remove existing mesh
  if (viewer.mesh) {
    viewer.scene.remove(viewer.mesh);
    viewer.mesh.geometry.dispose();
    viewer.mesh.material.dispose();
    viewer.mesh = null;
  }

  // Create geometry
  const geometry = new THREE.BufferGeometry();

  // Flatten vertices for triangles (each face becomes triangles)
  const positions = [];
  const colors = [];
  const trueColors = []; // Original colors (without min lift) for accurate picking

  for (let fIdx = 0; fIdx < faces.length; fIdx++) {
    const face = faces[fIdx];
    const faceIndices = face.vertices || face;
    const fColor = faceColors ? faceColors[fIdx] : null;

    // Fan triangulation for faces with more than 3 vertices
    for (let i = 1; i < faceIndices.length - 1; i++) {
      const i0 = faceIndices[0];
      const i1 = faceIndices[i];
      const i2 = faceIndices[i + 1];

      const v0 = vertices[i0];
      const v1 = vertices[i1];
      const v2 = vertices[i2];

      // Positions
      positions.push(v0.x, v0.y, v0.z);
      positions.push(v1.x, v1.y, v1.z);
      positions.push(v2.x, v2.y, v2.z);

      // Colors - lift pure black to dark gray for visible shading
      const MIN_C = 0.12;
      if (fColor) {
        trueColors.push(fColor.r, fColor.g, fColor.b);
        trueColors.push(fColor.r, fColor.g, fColor.b);
        trueColors.push(fColor.r, fColor.g, fColor.b);
        colors.push(Math.max(fColor.r, MIN_C), Math.max(fColor.g, MIN_C), Math.max(fColor.b, MIN_C));
        colors.push(Math.max(fColor.r, MIN_C), Math.max(fColor.g, MIN_C), Math.max(fColor.b, MIN_C));
        colors.push(Math.max(fColor.r, MIN_C), Math.max(fColor.g, MIN_C), Math.max(fColor.b, MIN_C));
      } else {
        const c0 = v0.color || new Color(0.5, 0.5, 0.5);
        const c1 = v1.color || new Color(0.5, 0.5, 0.5);
        const c2 = v2.color || new Color(0.5, 0.5, 0.5);

        trueColors.push(c0.r, c0.g, c0.b);
        trueColors.push(c1.r, c1.g, c1.b);
        trueColors.push(c2.r, c2.g, c2.b);
        colors.push(Math.max(c0.r, MIN_C), Math.max(c0.g, MIN_C), Math.max(c0.b, MIN_C));
        colors.push(Math.max(c1.r, MIN_C), Math.max(c1.g, MIN_C), Math.max(c1.b, MIN_C));
        colors.push(Math.max(c2.r, MIN_C), Math.max(c2.g, MIN_C), Math.max(c2.b, MIN_C));
      }
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('trueColor', new THREE.Float32BufferAttribute(trueColors, 3));
  geometry.computeVertexNormals();

  // Create material with vertex colors
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide
  });

  viewer.mesh = new THREE.Mesh(geometry, material);
  viewer.mesh.castShadow = true;

  // Rotate -90deg on X to convert Z-up (3MF/STL) to Y-up (Three.js)
  viewer.mesh.rotation.x = -Math.PI / 2;

  viewer.scene.add(viewer.mesh);

  // Add wireframe overlay
  if (viewer.wireframe) {
    viewer.scene.remove(viewer.wireframe);
    viewer.wireframe.geometry.dispose();
    viewer.wireframe.material.dispose();
    viewer.wireframe = null;
  }
  const isDecimator = typeof getPageType === 'function' && getPageType() === 'decimator';
  if (isDecimator || viewer.wireframeEnabled) {
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    viewer.wireframe = new THREE.Mesh(geometry, wireMat);
    viewer.wireframe.rotation.x = -Math.PI / 2;
    viewer.wireframe.renderOrder = 1;
    viewer.scene.add(viewer.wireframe);
  }

  // Remove previous shadow ground
  if (viewer.groundPlane) {
    viewer.scene.remove(viewer.groundPlane);
    viewer.groundPlane.geometry.dispose();
    viewer.groundPlane.material.dispose();
    viewer.groundPlane = null;
  }

  // Add shadow ground plane beneath the model
  const box = new THREE.Box3().setFromObject(viewer.mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const groundSize = maxDim * 4;

  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
  const savedOpacity = loadViewerSettings();
  const groundMat = new THREE.ShadowMaterial({
    opacity: (savedOpacity && savedOpacity.shadowOpacity != null) ? savedOpacity.shadowOpacity : 0.12,
  });
  viewer.groundPlane = new THREE.Mesh(groundGeo, groundMat);
  viewer.groundPlane.rotation.x = -Math.PI / 2;
  viewer.groundPlane.position.set(center.x, box.min.y, center.z);
  viewer.groundPlane.receiveShadow = true;
  viewer.groundPlane.renderOrder = 0;
  viewer.scene.add(viewer.groundPlane);

  // Update shadow light
  if (viewer.directionalLight) {
    viewer.directionalLight.position.set(center.x, center.y + maxDim * 4, center.z + maxDim * 0.5);
    viewer.directionalLight.target.position.copy(center);
    viewer.scene.add(viewer.directionalLight.target);
    viewer.shadowBaseSpread = maxDim;
    const spreadSlider = document.getElementById('shadowSpreadSlider');
    const spreadScale = spreadSlider ? parseFloat(spreadSlider.value) / 100 : 1.0;
    const s = maxDim * 6 * spreadScale;
    viewer.directionalLight.shadow.camera.left = -s;
    viewer.directionalLight.shadow.camera.right = s;
    viewer.directionalLight.shadow.camera.top = s;
    viewer.directionalLight.shadow.camera.bottom = -s;
    viewer.directionalLight.shadow.camera.far = maxDim * 10;
    viewer.directionalLight.shadow.camera.updateProjectionMatrix();
  }

  // Auto-fit camera
  const savedState = loadCameraState();
  fitCameraToAOViewer(viewer, viewer.mesh, savedState);

  // Trigger resize
  requestAnimationFrame(() => {
    resizeAOViewer(viewer);
  });
}

/**
 * Update ground plane and shadow light for a viewer after rotation.
 */
function updateGroundAndShadowForViewer(viewer) {
  if (!viewer.mesh || !viewer.groundPlane) return;

  const box = new THREE.Box3().setFromObject(viewer.mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  // Reposition ground plane at the bottom of the rotated model
  viewer.groundPlane.position.set(center.x, box.min.y, center.z);
  const groundSize = maxDim * 4;
  viewer.groundPlane.geometry.dispose();
  viewer.groundPlane.geometry = new THREE.PlaneGeometry(groundSize, groundSize);

  // Update shadow light
  if (viewer.directionalLight) {
    viewer.directionalLight.position.set(center.x, center.y + maxDim * 4, center.z + maxDim * 0.5);
    viewer.directionalLight.target.position.copy(center);

    viewer.shadowBaseSpread = maxDim;
    const spreadSlider = document.getElementById('shadowSpreadSlider');
    const spreadScale = spreadSlider ? parseFloat(spreadSlider.value) / 100 : 1.0;
    const s = maxDim * 6 * spreadScale;
    viewer.directionalLight.shadow.camera.left = -s;
    viewer.directionalLight.shadow.camera.right = s;
    viewer.directionalLight.shadow.camera.top = s;
    viewer.directionalLight.shadow.camera.bottom = -s;
    viewer.directionalLight.shadow.camera.far = maxDim * 10;
    viewer.directionalLight.shadow.camera.updateProjectionMatrix();
  }

  // Recenter camera & controls, preserving current viewing direction
  const fov = viewer.camera.fov * (Math.PI / 180);
  let fitDist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.5;
  if (viewer === viewer3D) cameraFitDistance = fitDist;
  viewer.camera.far = fitDist * 20;
  viewer.camera.updateProjectionMatrix();

  const offset = viewer.camera.position.clone().sub(viewer.controls.target).normalize().multiplyScalar(fitDist);
  viewer.controls.target.copy(center);
  viewer.camera.position.copy(center).add(offset);
  viewer.camera.lookAt(center);
  viewer.controls.update();
}

/**
 * Fit camera to object bounds for an AO viewer.
 */
function fitCameraToAOViewer(viewer, object, savedState) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = viewer.camera.fov * (Math.PI / 180);
  let fitDist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.5;

  if (viewer === viewer3D) cameraFitDistance = fitDist;

  viewer.camera.far = fitDist * 20;
  viewer.camera.updateProjectionMatrix();

  viewer.controls.target.copy(center);

  // Restore saved camera orientation, or use default (front view)
  if (savedState) {
    const dist = fitDist * (savedState.distRatio || 1);
    const phi = savedState.polar;
    const theta = savedState.azimuth;
    viewer.camera.position.set(
      center.x + dist * Math.sin(phi) * Math.sin(theta),
      center.y + dist * Math.cos(phi),
      center.z + dist * Math.sin(phi) * Math.cos(theta),
    );
  } else {
    viewer.camera.position.set(center.x, center.y, center.z + fitDist);
  }

  viewer.camera.lookAt(center);
  viewer.controls.update();
}

/**
 * Resize handler for an AO viewer.
 */
function resizeAOViewer(viewer) {
  if (!viewer.container || !viewer.camera || !viewer.renderer) return;

  const width = viewer.container.clientWidth;
  const height = viewer.container.clientHeight;

  viewer.camera.aspect = width / height;
  viewer.camera.updateProjectionMatrix();
  viewer.renderer.setSize(width, height);

  const ssW = width * 2, ssH = height * 2;
  if (viewer.beautyRT) viewer.beautyRT.setSize(ssW, ssH);
  if (viewer.aoRT) viewer.aoRT.setSize(ssW, ssH);
  if (viewer.shadowRT) viewer.shadowRT.setSize(ssW, ssH);
  if (viewer.fdmRT) viewer.fdmRT.setSize(ssW, ssH);
  if (viewer.aoMaterial) viewer.aoMaterial.uniforms.resolution.value.set(ssW, ssH);
  if (viewer.fdmMaterial) viewer.fdmMaterial.uniforms.resolution.value.set(ssW, ssH);
  if (viewer.fxaaMaterial) viewer.fxaaMaterial.uniforms['resolution'].value.set(1.0 / ssW, 1.0 / ssH);
}

/**
 * Clear mesh and ground plane from an AO viewer.
 */
function clearAOViewer(viewer) {
  if (viewer.mesh && viewer.scene) {
    viewer.scene.remove(viewer.mesh);
    viewer.mesh.geometry.dispose();
    viewer.mesh.material.dispose();
    viewer.mesh = null;
  }
  if (viewer.wireframe && viewer.scene) {
    viewer.scene.remove(viewer.wireframe);
    viewer.wireframe.geometry.dispose();
    viewer.wireframe.material.dispose();
    viewer.wireframe = null;
  }
  if (viewer.groundPlane && viewer.scene) {
    viewer.scene.remove(viewer.groundPlane);
    viewer.groundPlane.geometry.dispose();
    viewer.groundPlane.material.dispose();
    viewer.groundPlane = null;
  }
  viewer.vertices = null;
  viewer.faces = null;
}

/**
 * Sync current slider settings to a viewer's AO material, ground plane, and shadow.
 */
function syncSettingsToViewer(viewer) {
  if (!viewer.aoMaterial) return;

  const aoSlider = document.getElementById('aoStrengthSlider');
  const brightnessSlider = document.getElementById('brightnessSlider');
  const contrastSlider = document.getElementById('contrastSlider');
  const saturationSlider = document.getElementById('saturationSlider');
  const temperatureSlider = document.getElementById('temperatureSlider');

  if (aoSlider) viewer.aoMaterial.uniforms.aoStrength.value = parseFloat(aoSlider.value);
  if (brightnessSlider) viewer.aoMaterial.uniforms.brightness.value = parseFloat(brightnessSlider.value);
  if (contrastSlider) viewer.aoMaterial.uniforms.contrast.value = parseFloat(contrastSlider.value);
  if (saturationSlider) viewer.aoMaterial.uniforms.saturation.value = parseFloat(saturationSlider.value);
  if (temperatureSlider) viewer.aoMaterial.uniforms.temperature.value = parseFloat(temperatureSlider.value);

  // Sync AO/shadow enabled state from main viewer
  viewer.aoEnabled = viewer3D.aoEnabled;
  viewer.shadowEnabled = viewer3D.shadowEnabled;

  // Sync ground plane opacity
  if (viewer.groundPlane) {
    const opacitySlider = document.getElementById('shadowOpacitySlider');
    if (opacitySlider) viewer.groundPlane.material.opacity = parseFloat(opacitySlider.value);
  }

  // Sync shadow spread
  if (viewer.directionalLight && viewer.shadowBaseSpread) {
    const spreadSlider = document.getElementById('shadowSpreadSlider');
    if (spreadSlider) {
      const val = Math.max(parseFloat(spreadSlider.value), 10);
      const s = viewer.shadowBaseSpread * 6 * (val / 100);
      viewer.directionalLight.shadow.camera.left = -s;
      viewer.directionalLight.shadow.camera.right = s;
      viewer.directionalLight.shadow.camera.top = s;
      viewer.directionalLight.shadow.camera.bottom = -s;
      viewer.directionalLight.shadow.camera.updateProjectionMatrix();
    }
  }
}

// ============================================================================
// Main Viewer (Viewer Tab)
// ============================================================================

function initViewer3D(containerId) {
  if (!setupAOPipeline(viewer3D, containerId, { preserveDrawingBuffer: true, saveCameraOnChange: true })) {
    return false;
  }

  // Restore saved viewer settings
  const savedSettings = loadViewerSettings();

  // AO toggle button
  viewer3D.aoEnabled = savedSettings ? savedSettings.aoEnabled : true;
  processViewer3D.aoEnabled = viewer3D.aoEnabled;
  const toggleAoBtn = document.getElementById('toggleAoBtn');
  if (toggleAoBtn) {
    toggleAoBtn.classList.toggle('active', viewer3D.aoEnabled);
    toggleAoBtn.addEventListener('click', () => {
      viewer3D.aoEnabled = !viewer3D.aoEnabled;
      processViewer3D.aoEnabled = viewer3D.aoEnabled;
      toggleAoBtn.classList.toggle('active', viewer3D.aoEnabled);
      saveViewerSettings();
    });
  }

  // Shadow toggle button
  viewer3D.shadowEnabled = savedSettings ? savedSettings.shadowEnabled : true;
  processViewer3D.shadowEnabled = viewer3D.shadowEnabled;
  const toggleShadowBtn = document.getElementById('toggleShadowBtn');
  if (toggleShadowBtn) {
    toggleShadowBtn.classList.toggle('active', viewer3D.shadowEnabled);
    toggleShadowBtn.addEventListener('click', () => {
      viewer3D.shadowEnabled = !viewer3D.shadowEnabled;
      processViewer3D.shadowEnabled = viewer3D.shadowEnabled;
      toggleShadowBtn.classList.toggle('active', viewer3D.shadowEnabled);
      saveViewerSettings();
    });
  }

  // Wireframe toggle button
  viewer3D.wireframeEnabled = savedSettings ? !!savedSettings.wireframeEnabled : false;
  const toggleWireframeBtn = document.getElementById('toggleWireframeBtn');
  if (toggleWireframeBtn) {
    toggleWireframeBtn.classList.toggle('active', viewer3D.wireframeEnabled);
    toggleWireframeBtn.addEventListener('click', () => {
      viewer3D.wireframeEnabled = !viewer3D.wireframeEnabled;
      toggleWireframeBtn.classList.toggle('active', viewer3D.wireframeEnabled);
      // Add or remove wireframe from scene
      if (viewer3D.wireframeEnabled && viewer3D.mesh && !viewer3D.wireframe) {
        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x000000,
          wireframe: true,
          transparent: true,
          opacity: 0.15,
        });
        viewer3D.wireframe = new THREE.Mesh(viewer3D.mesh.geometry, wireMat);
        viewer3D.wireframe.rotation.x = viewer3D.mesh.rotation.x;
        viewer3D.wireframe.renderOrder = 1;
        viewer3D.scene.add(viewer3D.wireframe);
      } else if (!viewer3D.wireframeEnabled && viewer3D.wireframe) {
        viewer3D.scene.remove(viewer3D.wireframe);
        viewer3D.wireframe.geometry = null; // shared with mesh, don't dispose
        viewer3D.wireframe.material.dispose();
        viewer3D.wireframe = null;
      }
      saveViewerSettings();
    });
  }

  // FDM toggle button
  viewer3D.fdmEnabled = savedSettings ? !!savedSettings.fdmEnabled : false;
  const toggleFdmBtn = document.getElementById('toggleFdmBtn');
  const fdmSettings = document.querySelectorAll('.fdm-setting');
  function updateFdmSettingsVisibility() {
    fdmSettings.forEach(el => { el.style.display = viewer3D.fdmEnabled ? '' : 'none'; });
  }
  if (toggleFdmBtn) {
    toggleFdmBtn.classList.toggle('active', viewer3D.fdmEnabled);
    updateFdmSettingsVisibility();
    toggleFdmBtn.addEventListener('click', () => {
      viewer3D.fdmEnabled = !viewer3D.fdmEnabled;
      toggleFdmBtn.classList.toggle('active', viewer3D.fdmEnabled);
      updateFdmSettingsVisibility();
      saveViewerSettings();
    });
  }

  // Zoom fit button — reposition camera at fit distance keeping current orientation
  const zoomFitBtn = document.getElementById('zoomFitBtn');
  if (zoomFitBtn) {
    zoomFitBtn.addEventListener('click', () => {
      if (!viewer3D.mesh || !viewer3D.camera || !viewer3D.controls) return;
      const cam = viewer3D.camera;
      const box = new THREE.Box3().setFromObject(viewer3D.mesh);
      const center = box.getCenter(new THREE.Vector3());

      // Get the 8 corners of the bounding box
      const corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      ];

      // Current camera direction
      const direction = new THREE.Vector3().subVectors(cam.position, viewer3D.controls.target).normalize();

      // Place camera temporarily at a known distance to measure projected size
      const tempDist = cam.position.distanceTo(viewer3D.controls.target);
      const tempPos = new THREE.Vector3().copy(center).addScaledVector(direction, tempDist);
      cam.position.copy(tempPos);
      viewer3D.controls.target.copy(center);
      cam.lookAt(center);
      cam.updateMatrixWorld();

      // Project all corners to NDC (-1 to 1) and find the bounding rect
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of corners) {
        const ndc = c.clone().project(cam);
        minX = Math.min(minX, ndc.x);
        maxX = Math.max(maxX, ndc.x);
        minY = Math.min(minY, ndc.y);
        maxY = Math.max(maxY, ndc.y);
      }

      // Current object size in NDC space (range is -1 to 1, so full viewport = 2)
      const ndcW = maxX - minX;
      const ndcH = maxY - minY;
      const currentFill = Math.max(ndcW, ndcH) / 2; // fraction of viewport (0-1)

      // We want it to fill exactly 3/4, so scale the distance
      const targetFill = 0.75;
      const newDist = tempDist * (currentFill / targetFill);

      cam.position.copy(center).addScaledVector(direction, newDist);
      cam.lookAt(center);
      viewer3D.controls.update();
      saveCameraStateDebounced();
    });
  }

  // Grid overlay toggle
  const toggleGridBtn = document.getElementById('toggleGridBtn');
  const gridOverlay = document.getElementById('viewerGridOverlay');
  if (toggleGridBtn && gridOverlay) {
    toggleGridBtn.addEventListener('click', () => {
      gridOverlay.classList.toggle('active');
      toggleGridBtn.classList.toggle('active', gridOverlay.classList.contains('active'));
    });
  }

  // FDM Layer Height slider
  const fdmLayerHeightSlider = document.getElementById('fdmLayerHeightSlider');
  const fdmLayerHeightValue = document.getElementById('fdmLayerHeightValue');
  if (fdmLayerHeightSlider) {
    if (savedSettings && savedSettings.fdmLayerHeight != null) {
      fdmLayerHeightSlider.value = savedSettings.fdmLayerHeight;
      fdmLayerHeightValue.textContent = savedSettings.fdmLayerHeight.toFixed(2) + ' mm';
      viewer3D.fdmMaterial.uniforms.layerHeight.value = savedSettings.fdmLayerHeight;
    }
    fdmLayerHeightSlider.addEventListener('input', () => {
      const val = parseFloat(fdmLayerHeightSlider.value);
      viewer3D.fdmMaterial.uniforms.layerHeight.value = val;
      fdmLayerHeightValue.textContent = val.toFixed(2) + ' mm';
      saveViewerSettingsDebounced();
    });
  }

  // FDM Layer Strength slider
  const fdmLayerStrengthSlider = document.getElementById('fdmLayerStrengthSlider');
  const fdmLayerStrengthValue = document.getElementById('fdmLayerStrengthValue');
  if (fdmLayerStrengthSlider) {
    if (savedSettings && savedSettings.fdmLayerStrength != null) {
      fdmLayerStrengthSlider.value = savedSettings.fdmLayerStrength;
      fdmLayerStrengthValue.textContent = savedSettings.fdmLayerStrength.toFixed(2);
      viewer3D.fdmMaterial.uniforms.layerStrength.value = savedSettings.fdmLayerStrength;
    }
    fdmLayerStrengthSlider.addEventListener('input', () => {
      const val = parseFloat(fdmLayerStrengthSlider.value);
      viewer3D.fdmMaterial.uniforms.layerStrength.value = val;
      fdmLayerStrengthValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // FDM Contamination slider
  const fdmContaminationSlider = document.getElementById('fdmContaminationSlider');
  const fdmContaminationValue = document.getElementById('fdmContaminationValue');
  if (fdmContaminationSlider) {
    if (savedSettings && savedSettings.fdmContamination != null) {
      fdmContaminationSlider.value = savedSettings.fdmContamination;
      fdmContaminationValue.textContent = savedSettings.fdmContamination.toFixed(2);
      viewer3D.fdmMaterial.uniforms.contamination.value = savedSettings.fdmContamination;
    }
    fdmContaminationSlider.addEventListener('input', () => {
      const val = parseFloat(fdmContaminationSlider.value);
      viewer3D.fdmMaterial.uniforms.contamination.value = val;
      fdmContaminationValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // Settings panel toggle
  const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
  const settingsPanel = document.getElementById('viewerSettings');
  if (toggleSettingsBtn && settingsPanel) {
    toggleSettingsBtn.addEventListener('click', () => {
      settingsPanel.classList.toggle('show');
      toggleSettingsBtn.classList.toggle('active', settingsPanel.classList.contains('show'));
    });
  }

  // AO Strength slider
  const aoStrengthSlider = document.getElementById('aoStrengthSlider');
  const aoStrengthValue = document.getElementById('aoStrengthValue');
  if (aoStrengthSlider) {
    if (savedSettings && savedSettings.aoStrength != null) {
      aoStrengthSlider.value = savedSettings.aoStrength;
      aoStrengthValue.textContent = savedSettings.aoStrength.toFixed(2);
      viewer3D.aoMaterial.uniforms.aoStrength.value = savedSettings.aoStrength;
    }
    aoStrengthSlider.addEventListener('input', () => {
      const val = parseFloat(aoStrengthSlider.value);
      viewer3D.aoMaterial.uniforms.aoStrength.value = val;
      if (processViewer3D.aoMaterial) processViewer3D.aoMaterial.uniforms.aoStrength.value = val;
      aoStrengthValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // Shadow Opacity slider
  const shadowOpacitySlider = document.getElementById('shadowOpacitySlider');
  const shadowOpacityValue = document.getElementById('shadowOpacityValue');
  if (shadowOpacitySlider) {
    if (savedSettings && savedSettings.shadowOpacity != null) {
      shadowOpacitySlider.value = savedSettings.shadowOpacity;
      shadowOpacityValue.textContent = savedSettings.shadowOpacity.toFixed(2);
    }
    shadowOpacitySlider.addEventListener('input', () => {
      const val = parseFloat(shadowOpacitySlider.value);
      if (viewer3D.groundPlane) viewer3D.groundPlane.material.opacity = val;
      if (processViewer3D.groundPlane) processViewer3D.groundPlane.material.opacity = val;
      shadowOpacityValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // Shadow Spread slider
  const shadowSpreadSlider = document.getElementById('shadowSpreadSlider');
  const shadowSpreadValue = document.getElementById('shadowSpreadValue');
  if (shadowSpreadSlider) {
    if (savedSettings && savedSettings.shadowSpread != null) {
      shadowSpreadSlider.value = savedSettings.shadowSpread;
      shadowSpreadValue.textContent = savedSettings.shadowSpread;
    }
    shadowSpreadSlider.addEventListener('input', () => {
      let val = parseFloat(shadowSpreadSlider.value);
      val = Math.max(val, 10);
      if (viewer3D.directionalLight && viewer3D.shadowBaseSpread) {
        const s = viewer3D.shadowBaseSpread * 6 * (val / 100);
        viewer3D.directionalLight.shadow.camera.left = -s;
        viewer3D.directionalLight.shadow.camera.right = s;
        viewer3D.directionalLight.shadow.camera.top = s;
        viewer3D.directionalLight.shadow.camera.bottom = -s;
        viewer3D.directionalLight.shadow.camera.updateProjectionMatrix();
      }
      if (processViewer3D.directionalLight && processViewer3D.shadowBaseSpread) {
        const s = processViewer3D.shadowBaseSpread * 6 * (val / 100);
        processViewer3D.directionalLight.shadow.camera.left = -s;
        processViewer3D.directionalLight.shadow.camera.right = s;
        processViewer3D.directionalLight.shadow.camera.top = s;
        processViewer3D.directionalLight.shadow.camera.bottom = -s;
        processViewer3D.directionalLight.shadow.camera.updateProjectionMatrix();
      }
      shadowSpreadValue.textContent = val;
      saveViewerSettingsDebounced();
    });
  }

  // Brightness slider
  const brightnessSlider = document.getElementById('brightnessSlider');
  const brightnessValue = document.getElementById('brightnessValue');
  if (brightnessSlider) {
    if (savedSettings && savedSettings.brightness != null) {
      brightnessSlider.value = savedSettings.brightness;
      brightnessValue.textContent = savedSettings.brightness.toFixed(2);
      viewer3D.aoMaterial.uniforms.brightness.value = savedSettings.brightness;
    }
    brightnessSlider.addEventListener('input', () => {
      const val = parseFloat(brightnessSlider.value);
      viewer3D.aoMaterial.uniforms.brightness.value = val;
      if (processViewer3D.aoMaterial) processViewer3D.aoMaterial.uniforms.brightness.value = val;
      brightnessValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // Contrast slider
  const contrastSlider = document.getElementById('contrastSlider');
  const contrastValue = document.getElementById('contrastValue');
  if (contrastSlider) {
    if (savedSettings && savedSettings.contrast != null) {
      contrastSlider.value = savedSettings.contrast;
      contrastValue.textContent = savedSettings.contrast.toFixed(2);
      viewer3D.aoMaterial.uniforms.contrast.value = savedSettings.contrast;
    }
    contrastSlider.addEventListener('input', () => {
      const val = parseFloat(contrastSlider.value);
      viewer3D.aoMaterial.uniforms.contrast.value = val;
      if (processViewer3D.aoMaterial) processViewer3D.aoMaterial.uniforms.contrast.value = val;
      contrastValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // Saturation slider
  const saturationSlider = document.getElementById('saturationSlider');
  const saturationValue = document.getElementById('saturationValue');
  if (saturationSlider) {
    if (savedSettings && savedSettings.saturation != null) {
      saturationSlider.value = savedSettings.saturation;
      saturationValue.textContent = savedSettings.saturation.toFixed(2);
      viewer3D.aoMaterial.uniforms.saturation.value = savedSettings.saturation;
    }
    saturationSlider.addEventListener('input', () => {
      const val = parseFloat(saturationSlider.value);
      viewer3D.aoMaterial.uniforms.saturation.value = val;
      if (processViewer3D.aoMaterial) processViewer3D.aoMaterial.uniforms.saturation.value = val;
      saturationValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // Temperature slider
  const temperatureSlider = document.getElementById('temperatureSlider');
  const temperatureValue = document.getElementById('temperatureValue');
  if (temperatureSlider) {
    if (savedSettings && savedSettings.temperature != null) {
      temperatureSlider.value = savedSettings.temperature;
      temperatureValue.textContent = savedSettings.temperature.toFixed(2);
      viewer3D.aoMaterial.uniforms.temperature.value = savedSettings.temperature;
    }
    temperatureSlider.addEventListener('input', () => {
      const val = parseFloat(temperatureSlider.value);
      viewer3D.aoMaterial.uniforms.temperature.value = val;
      if (processViewer3D.aoMaterial) processViewer3D.aoMaterial.uniforms.temperature.value = val;
      temperatureValue.textContent = val.toFixed(2);
      saveViewerSettingsDebounced();
    });
  }

  // Rotation buttons (affect both viewers)
  const halfPi = Math.PI / 2;
  function syncWireframeRotation(viewer) {
    if (viewer.wireframe && viewer.mesh) {
      viewer.wireframe.rotation.copy(viewer.mesh.rotation);
    }
  }
  document.getElementById('rotateX')?.addEventListener('click', () => {
    if (!viewer3D.mesh) return;
    viewer3D.mesh.rotation.x += halfPi;
    syncWireframeRotation(viewer3D);
    updateGroundAndShadowForViewer(viewer3D);
    if (processViewer3D.mesh) {
      processViewer3D.mesh.rotation.x += halfPi;
      syncWireframeRotation(processViewer3D);
      updateGroundAndShadowForViewer(processViewer3D);
    }
  });
  document.getElementById('rotateY')?.addEventListener('click', () => {
    if (!viewer3D.mesh) return;
    viewer3D.mesh.rotation.y += halfPi;
    syncWireframeRotation(viewer3D);
    updateGroundAndShadowForViewer(viewer3D);
    if (processViewer3D.mesh) {
      processViewer3D.mesh.rotation.y += halfPi;
      syncWireframeRotation(processViewer3D);
      updateGroundAndShadowForViewer(processViewer3D);
    }
  });
  document.getElementById('rotateZ')?.addEventListener('click', () => {
    if (!viewer3D.mesh) return;
    viewer3D.mesh.rotation.z += halfPi;
    syncWireframeRotation(viewer3D);
    updateGroundAndShadowForViewer(viewer3D);
    if (processViewer3D.mesh) {
      processViewer3D.mesh.rotation.z += halfPi;
      syncWireframeRotation(processViewer3D);
      updateGroundAndShadowForViewer(processViewer3D);
    }
  });

  // Handle resize
  window.addEventListener('resize', onViewerResize);

  // Start animation loop
  animate();

  return true;
}

function animate() {
  viewer3D.animationId = requestAnimationFrame(animate);

  // Skip rendering when not on viewer page or viewer tab
  const page = typeof getPageType === 'function' ? getPageType() : null;
  if (!page && typeof activeTab !== 'undefined' && activeTab !== 'viewer') return;

  if (viewer3D.controls) {
    viewer3D.controls.update();
  }

  if (viewer3D.beautyRT && viewer3D.renderer && viewer3D.scene && viewer3D.camera) {
    renderAOPipeline(viewer3D, viewer3D.scene.background);
  } else if (viewer3D.renderer && viewer3D.scene && viewer3D.camera) {
    viewer3D.renderer.render(viewer3D.scene, viewer3D.camera);
  }
}

function onViewerResize() {
  resizeAOViewer(viewer3D);
}

function loadModelToViewer(vertices, faces, faceColors) {
  loadModelToAOViewer(viewer3D, vertices, faces, faceColors);

  // Show tab bar and switch to viewer tab
  const tabBar = document.getElementById('tabBar');
  if (tabBar) tabBar.style.display = '';
  switchTab('viewer');

  // Show viewer card
  const viewerCard = document.getElementById('viewerCard');
  if (viewerCard) viewerCard.style.display = 'block';
}

function updateGroundAndShadow() {
  updateGroundAndShadowForViewer(viewer3D);
  if (processViewer3D.mesh) {
    updateGroundAndShadowForViewer(processViewer3D);
  }
}

function fitCameraToObject(object) {
  const saved = loadCameraState();
  fitCameraToAOViewer(viewer3D, object, saved);
}

function clearViewer() {
  clearAOViewer(viewer3D);
}

function getViewerMesh() {
  return viewer3D.mesh;
}

function getViewerData() {
  return {
    vertices: viewer3D.vertices,
    faces: viewer3D.faces
  };
}

function getViewerRenderer() {
  return viewer3D.renderer;
}

function getViewerCamera() {
  return viewer3D.camera;
}

async function exportViewerPNG(baseName) {
  if (!viewer3D.renderer || !viewer3D.scene || !viewer3D.camera) return;

  // Render full pipeline with transparent background
  renderAOPipeline(viewer3D, null);

  // Capture blob immediately while the transparent frame is still on the canvas
  const canvas = viewer3D.renderer.domElement;
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${baseName}.png`,
        types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // User cancelled
    }
  }

  // Fallback for browsers without File System Access API
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.png`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// Process Viewer (Process Tab)
// ============================================================================

function initProcessViewer3D(containerId) {
  if (!setupAOPipeline(processViewer3D, containerId, {})) {
    return false;
  }

  // Sync settings from current slider values
  syncSettingsToViewer(processViewer3D);

  // Handle resize
  window.addEventListener('resize', onProcessViewerResize);

  // Start animation loop
  animateProcessViewer();

  return true;
}

function animateProcessViewer() {
  processViewer3D.animationId = requestAnimationFrame(animateProcessViewer);

  // Skip rendering when not on converter page or process tab
  const page = typeof getPageType === 'function' ? getPageType() : null;
  if (!page && typeof activeTab !== 'undefined' && activeTab !== 'process') return;

  if (processViewer3D.controls) {
    processViewer3D.controls.update();
  }

  if (processViewer3D.beautyRT && processViewer3D.renderer && processViewer3D.scene && processViewer3D.camera) {
    renderAOPipeline(processViewer3D, processViewer3D.scene.background);
  } else if (processViewer3D.renderer && processViewer3D.scene && processViewer3D.camera) {
    processViewer3D.renderer.render(processViewer3D.scene, processViewer3D.camera);
  }
}

function onProcessViewerResize() {
  resizeAOViewer(processViewer3D);
}

function loadModelToProcessViewer(vertices, faces, faceColors) {
  loadModelToAOViewer(processViewer3D, vertices, faces, faceColors);

  // Sync settings after model load (for ground plane opacity, shadow spread, etc.)
  syncSettingsToViewer(processViewer3D);

  // Show process viewer card
  const processViewerCard = document.getElementById('processViewerCard');
  if (processViewerCard) processViewerCard.style.display = 'block';

  // Show picked palette card
  const pickedPaletteCard = document.getElementById('pickedPaletteCard');
  if (pickedPaletteCard) pickedPaletteCard.style.display = 'block';
}

function clearProcessViewer() {
  clearAOViewer(processViewer3D);
}

function getProcessViewerMesh() {
  return processViewer3D.mesh;
}

function getProcessViewerRenderer() {
  return processViewer3D.renderer;
}

function getProcessViewerCamera() {
  return processViewer3D.camera;
}

// ============================================================================
// Result Viewer (for processed model)
// ============================================================================

let resultViewer3D = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  mesh: null,
  container: null,
  animationId: null
};

function initResultViewer3D(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return false;

  resultViewer3D.container = container;

  // Clear any existing content
  container.innerHTML = '';

  // Create scene
  resultViewer3D.scene = new THREE.Scene();
  resultViewer3D.scene.background = new THREE.Color(0x1a1a2e);

  // Create camera
  const width = container.clientWidth || 400;
  const height = container.clientHeight || 300;
  resultViewer3D.camera = new THREE.PerspectiveCamera(45, width / height, 1, 1000);
  resultViewer3D.camera.position.set(0, 0, 5);

  // Create renderer
  resultViewer3D.renderer = new THREE.WebGLRenderer({ antialias: true });
  resultViewer3D.renderer.setSize(width, height);
  resultViewer3D.renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(resultViewer3D.renderer.domElement);

  // Add OrbitControls
  resultViewer3D.controls = new THREE.OrbitControls(resultViewer3D.camera, resultViewer3D.renderer.domElement);
  resultViewer3D.controls.enableDamping = true;
  resultViewer3D.controls.dampingFactor = 0.05;

  // Add lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  resultViewer3D.scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 5, 5);
  resultViewer3D.scene.add(directionalLight);

  // Handle resize
  window.addEventListener('resize', onResultViewerResize);

  // Start animation loop
  animateResultViewer();

  return true;
}

function onResultViewerResize() {
  if (!resultViewer3D.container || !resultViewer3D.camera || !resultViewer3D.renderer) return;

  const width = resultViewer3D.container.clientWidth;
  const height = resultViewer3D.container.clientHeight;

  if (width === 0 || height === 0) return;

  resultViewer3D.camera.aspect = width / height;
  resultViewer3D.camera.updateProjectionMatrix();
  resultViewer3D.renderer.setSize(width, height);
}

function animateResultViewer() {
  resultViewer3D.animationId = requestAnimationFrame(animateResultViewer);

  // Skip rendering when not on converter page or process tab
  const page = typeof getPageType === 'function' ? getPageType() : null;
  if (!page && typeof activeTab !== 'undefined' && activeTab !== 'process') return;

  if (resultViewer3D.controls) {
    resultViewer3D.controls.update();
  }

  if (resultViewer3D.renderer && resultViewer3D.scene && resultViewer3D.camera) {
    resultViewer3D.renderer.render(resultViewer3D.scene, resultViewer3D.camera);
  }
}

function loadResultToViewer(vertices, faces) {
  if (!resultViewer3D.scene) return;

  // Store for highlighting
  resultViewer3D.vertices = vertices;
  resultViewer3D.faces = faces;
  resultViewer3D.originalColors = null;

  // Remove existing mesh
  if (resultViewer3D.mesh) {
    resultViewer3D.scene.remove(resultViewer3D.mesh);
    resultViewer3D.mesh.geometry.dispose();
    resultViewer3D.mesh.material.dispose();
    resultViewer3D.mesh = null;
  }

  // Create geometry
  const geometry = new THREE.BufferGeometry();

  // Flatten vertices for triangles (each face becomes triangles)
  const positions = [];
  const colors = [];

  for (const face of faces) {
    // Support both formats: face.vertices (from parser) or face as array
    const faceIndices = face.vertices || face;

    // Fan triangulation for faces with more than 3 vertices
    for (let i = 1; i < faceIndices.length - 1; i++) {
      const i0 = faceIndices[0];
      const i1 = faceIndices[i];
      const i2 = faceIndices[i + 1];

      const v0 = vertices[i0];
      const v1 = vertices[i1];
      const v2 = vertices[i2];

      // Positions
      positions.push(v0.x, v0.y, v0.z);
      positions.push(v1.x, v1.y, v1.z);
      positions.push(v2.x, v2.y, v2.z);

      // Colors
      const c0 = v0.color || new Color(0.5, 0.5, 0.5);
      const c1 = v1.color || new Color(0.5, 0.5, 0.5);
      const c2 = v2.color || new Color(0.5, 0.5, 0.5);

      colors.push(c0.r, c0.g, c0.b);
      colors.push(c1.r, c1.g, c1.b);
      colors.push(c2.r, c2.g, c2.b);
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  // Create material with vertex colors
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    side: THREE.FrontSide,
    transparent: true,
  });

  resultViewer3D.mesh = new THREE.Mesh(geometry, material);
  resultViewer3D.mesh.renderOrder = 1;

  // Rotate -90deg on X to convert Z-up to Y-up (same as main viewer)
  resultViewer3D.mesh.rotation.x = -Math.PI / 2;

  resultViewer3D.scene.add(resultViewer3D.mesh);

  // Add wireframe overlay on decimator page
  if (resultViewer3D.wireframe) {
    resultViewer3D.scene.remove(resultViewer3D.wireframe);
    resultViewer3D.wireframe.geometry.dispose();
    resultViewer3D.wireframe.material.dispose();
    resultViewer3D.wireframe = null;
  }
  if (typeof getPageType === 'function' && getPageType() === 'decimator') {
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    resultViewer3D.wireframe = new THREE.Mesh(geometry, wireMat);
    resultViewer3D.wireframe.rotation.x = -Math.PI / 2;
    resultViewer3D.wireframe.renderOrder = 2;
    resultViewer3D.scene.add(resultViewer3D.wireframe);
  }

  // Auto-fit camera to bounds
  fitResultCameraToObject(resultViewer3D.mesh);

  // Update size after card becomes visible
  requestAnimationFrame(() => {
    onResultViewerResize();
  });
}

function fitResultCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = resultViewer3D.camera.fov * (Math.PI / 180);
  let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));

  cameraZ *= 1.5; // Add some padding

  resultViewer3D.camera.position.set(center.x, center.y, center.z + cameraZ);
  resultViewer3D.camera.lookAt(center);

  resultViewer3D.controls.target.copy(center);
  resultViewer3D.controls.update();
}

function clearResultViewer() {
  if (resultViewer3D.mesh && resultViewer3D.scene) {
    resultViewer3D.scene.remove(resultViewer3D.mesh);
    resultViewer3D.mesh.geometry.dispose();
    resultViewer3D.mesh.material.dispose();
    resultViewer3D.mesh = null;
  }
  if (resultViewer3D.wireframe && resultViewer3D.scene) {
    resultViewer3D.scene.remove(resultViewer3D.wireframe);
    resultViewer3D.wireframe.geometry.dispose();
    resultViewer3D.wireframe.material.dispose();
    resultViewer3D.wireframe = null;
  }
  resultViewer3D.originalColors = null;
  resultViewer3D.vertices = null;
  resultViewer3D.faces = null;
}

/**
 * Highlight vertices of a specific color on the result model
 * @param {Color} targetColor - The color to highlight
 */
function highlightResultColor(targetColor) {
  if (!resultViewer3D.mesh || !resultViewer3D.vertices || !resultViewer3D.faces) return;

  const geometry = resultViewer3D.mesh.geometry;
  const colorAttribute = geometry.getAttribute('color');

  // Store original colors if not already stored
  if (!resultViewer3D.originalColors) {
    resultViewer3D.originalColors = new Float32Array(colorAttribute.array);
  }

  const colors = colorAttribute.array;
  const vertices = resultViewer3D.vertices;
  const faces = resultViewer3D.faces;

  // Tolerance for color matching
  const tolerance = 0.05;

  let colorIndex = 0;
  for (const face of faces) {
    const faceIndices = face.vertices || face;

    for (let i = 1; i < faceIndices.length - 1; i++) {
      const indices = [faceIndices[0], faceIndices[i], faceIndices[i + 1]];

      for (const idx of indices) {
        const v = vertices[idx];
        const vc = v.color || { r: 0.5, g: 0.5, b: 0.5 };

        // Check if this vertex matches the target color
        const isMatch = Math.abs(vc.r - targetColor.r) < tolerance &&
                        Math.abs(vc.g - targetColor.g) < tolerance &&
                        Math.abs(vc.b - targetColor.b) < tolerance;

        if (isMatch) {
          // Brighten matched color
          colors[colorIndex] = 1;
          colors[colorIndex + 1] = 1;
          colors[colorIndex + 2] = 1;
        } else {
          // Dim non-matched colors
          colors[colorIndex] = 0;
          colors[colorIndex + 1] = 0;
          colors[colorIndex + 2] = 0;
        }

        colorIndex += 3;
      }
    }
  }

  colorAttribute.needsUpdate = true;
}

/**
 * Restore original colors on the result model
 */
function resetResultColors() {
  if (!resultViewer3D.mesh || !resultViewer3D.originalColors) return;

  const geometry = resultViewer3D.mesh.geometry;
  const colorAttribute = geometry.getAttribute('color');

  // Copy original colors back
  colorAttribute.array.set(resultViewer3D.originalColors);
  colorAttribute.needsUpdate = true;
}
