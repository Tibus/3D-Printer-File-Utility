// ============================================================================
// Path-traced renderer (render.html)
// ============================================================================
// A real GPU path tracer rather than a screen-space approximation: lighting,
// shadows and occlusion all fall out of the ray simulation, so there is nothing
// to fake or composite by hand.
//
// Runs on its own three.js 0.180 — the app's parsers are plain JS and touch no
// three at all, so this page never loads the r128 build the viewer uses.
//
// Stack: three 0.180 + three-mesh-bvh + three-gpu-pathtracer (all MIT), pinned
// in the import map of render.html.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { WebGLPathTracer, GradientEquirectTexture, DenoiseMaterial } from 'three-gpu-pathtracer';

// Samples accumulate for as long as the page stays open — the image only keeps
// getting cleaner. This number is purely the progress bar's reference point:
// past it the picture is visually converged and the bar stays full.
//
// Counted in *full* passes over the image. One renderSample() call is one tile:
// the tracer splits the frame 3x3 so no single GPU command runs long enough to
// trip the driver watchdog, and nine of them make one pass. Counting the calls
// instead — as this did — overstates convergence ninefold.
const CONVERGED_REFERENCE = 200;

// Convergence is throughput-bound, not frame-bound. A tile costs about 5ms, so
// firing exactly one per animation frame leaves the card idle for two thirds of
// every 16ms vsync — the GPU can do roughly three times the work it was being
// given. So run a batch per frame instead, sized from how long the last frames
// actually took, and let it settle wherever the hardware tops out.
const FRAME_TARGET_MS = 26;
const MAX_BATCH = 48;

// --- Studio lighting --------------------------------------------------------
// The key light lives *inside the environment map*, as a bright disc painted
// into an otherwise uniform sky, rather than as a light in the scene.
//
// A source at infinity lights a flat plane perfectly evenly, so the backdrop
// comes out a flat, gradient-free white and the only thing left on it is the
// model's shadow. A light with a position cannot do that: its 1/r² falloff
// darkens the floor toward the horizon — measured at 30% across the frame even
// with the light parked 120 model-lengths away.
const ENV_WIDTH = 512;
const ENV_HEIGHT = 256;

// Radiance the unshadowed floor is always normalised to. It is a constant on
// purpose: the backdrop of a product shot is a lit white sweep, not something
// that dims when you change the key light, so no control is allowed to touch it.
//
// The margin above 1.0 matters. At 1.02 the floor sat right on the clipping
// point and the denoiser, averaging samples that straddle it, pulled patches
// down to 244 — a backdrop that reads faintly dirty rather than white. Measured:
// 1.02 leaves the darkest backdrop pixel at 244, 1.2 and up hold a solid 255.
// Past that the gain only eats into the penumbra (shadow core 37 -> 50 from
// 1.02 to 1.8), so this sits just inside the knee.
const FLOOR_TARGET = 1.3;
// Measured off the render rather than derived: a white Lambertian floor comes
// back at 84% of its nominal albedo here. Trimmed so the floor and the backdrop
// land on the same white and no horizon shows.
const FLOOR_ALBEDO = 0.845;
// Angular radius of the sun disc: the shadow's penumbra is its direct image.
const SUN_MIN_DEG = 1.5;
const SUN_MAX_DEG = 16;
// The floor has to run past the frame on every side, or its edge shows up as a
// horizon line.
const FLOOR_EXTENT = 400;

// How long the raster stand-in stays up after the last slider movement, before
// the trace is allowed to take the canvas back.
const TURNTABLE_AXIS = new THREE.Vector3(0, 1, 0);

// How far the host page's camera may drift, as a fraction of the model size,
// before the trace is considered invalid. Well under a pixel on screen.
const CAMERA_EPSILON = 1e-4;

const PREVIEW_HOLD_MS = 400;
// Radiance the stand-in's floor is dosed to, and the share of it that is
// ambient — which is what the shadow reads as. Low enough to place the shadow at
// a glance, high enough that the model does not go black on its shaded side.
const PREVIEW_TARGET = 1.15;
const PREVIEW_AMBIENT = 0.3;

// The cutout mask is rasterised at this multiple of the canvas and averaged down
// on the CPU. Multisampling the target instead would be the obvious route, but a
// multisampled target cannot be read back — readRenderTargetPixels returns an
// unresolved buffer — and the whole point of the mask is to read it back. Three
// samples per axis give nine coverage levels along an edge, which is enough for
// the cutout to read as smooth.
const MASK_SUPERSAMPLE = 3;

const state = {
  renderer: null,
  pathTracer: null,
  scene: null,
  camera: null,
  controls: null,
  mesh: null,
  floor: null,
  container: null,
  animationId: null,
  batch: 1,
  lastFrame: 0,
  embedded: false,
  interacting: false,
  turntable: null,
  previewScene: null,
  previewLight: null,
  previewAmbient: null,
  previewUntil: 0,
  skipDisplay: false,
  paused: false,
  modelCenter: new THREE.Vector3(),
  modelSize: 1
};

const TILES_PER_SAMPLE = 9;

// Denoising buys sample count: an edge-aware blur makes an 8 sample image read
// like a far more converged one. It fades out as samples accumulate so a long
// render keeps every bit of detail — slowly, because the bright sun disc leaves
// a fine grain on the backdrop that takes several hundred samples to settle.
//
// `threshold` is what decides whether two neighbouring pixels count as the same
// surface or as an edge, and it is compared against *linear* radiance, not the
// 0..1 of a displayed image. Path-traced noise at low sample counts swings far
// wider than that: at the filter's own default of 0.03 every speck reads as an
// edge and the pass does nothing at all. It has to be up around 1 to bite.
const DENOISE_MAX_SIGMA = 4;       // kernel radius, in pixels, at full strength
const DENOISE_MAX_THRESHOLD = 1.2;
const DENOISE_FADE_SAMPLES = 110;

const settings = {
  denoise: 0.6,
  // Softness of the shadow: the sun is a disc, and how wide it looks from the
  // ground decides how blurred the shadow edge gets.
  shadowBlur: 0.35,
  // How bright the subject sits against the backdrop. The backdrop itself is
  // pinned white whatever this is, so it acts on the model alone — it scales its
  // albedo, which for an object under fixed lighting is the same thing as
  // exposing it up or down.
  exposure: 1,
  // Well off to the side of the default camera: a light lined up with the lens
  // throws the shadow behind the model, where none of it can be seen.
  lightAzimuth: 145,
  lightElevation: 40,
  // Share of the floor's light coming from the uniform sky rather than the sun.
  // Low values give a contrasty, deep shadow; high values a flat, soft one.
  envIntensity: 0.3,
  bounces: 3,
  // PNG export cuts the model out and turns the shadow into alpha
  alphaExport: true
};

const SETTINGS_KEY = 'renderSettings';
// Bump whenever a key changes meaning, so a stored value from an older build is
// dropped instead of restored into a control it no longer fits.
const SETTINGS_VERSION = 1;

/** Overlay whatever was stored last time, ignoring anything we no longer know. */
function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!stored || stored.version !== SETTINGS_VERSION) return;
    for (const key of Object.keys(settings)) {
      if (typeof stored[key] === typeof settings[key]) settings[key] = stored[key];
    }
  } catch (e) {
    // private mode, quota, corrupted entry — the defaults are fine
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
    } catch (e) {
      // nothing worth interrupting the render for
    }
  }, 300);
}

loadSettings();

/**
 * File colours are sRGB; three 0.152+ wants vertex colours in linear space.
 */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * @param {HTMLElement} container
 * @param {{ controls?: boolean }} [options]
 *   controls: false leaves the camera to the host page — the viewer already has
 *   an OrbitControls, a saved camera state and a Fit button, and two sets of
 *   controls fighting over one model is worse than none.
 */
function init(container, options = {}) {
  state.container = container;
  state.embedded = options.controls === false;

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  state.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  state.renderer.setSize(width, height);
  state.renderer.setPixelRatio(1);   // the path tracer resolves its own aliasing
  state.renderer.toneMapping = THREE.NoToneMapping;
  // only ever used by the raster stand-in below; the tracer has no use for them
  state.renderer.shadowMap.enabled = true;
  state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(state.renderer.domElement);

  state.scene = new THREE.Scene();

  // Environment: uniform sky plus a sun disc, repainted whenever the light moves
  state.envData = new Float32Array(ENV_WIDTH * ENV_HEIGHT * 4);
  state.scene.environmentIntensity = 1;   // the intensity is baked into the map

  // The backdrop the camera sees is a separate, plain white map — the sun disc
  // itself would otherwise show up as a blown blob in the frame. Its brightness
  // is matched to the floor in applyLighting(), so no horizon line appears.
  const backdrop = new GradientEquirectTexture();
  backdrop.topColor.set(0xffffff);
  backdrop.bottomColor.set(0xffffff);
  backdrop.update();
  state.scene.background = backdrop;

  state.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
  state.camera.position.set(0, 0, 5);

  if (!state.embedded) {
    state.controls = new OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = false;   // see the note in viewer3D.js
    // any camera move invalidates the accumulated samples
    state.controls.addEventListener('change', restart);
    watchInteraction(state.renderer.domElement);
  }

  state.pathTracer = new WebGLPathTracer(state.renderer);
  state.pathTracer.renderScale = 1;
  state.pathTracer.bounces = settings.bounces;
  // what the tracer shows while the trace is still too noisy — during an orbit,
  // and for the first frames after any change
  state.pathTracer.rasterizeSceneCallback = () => drawPreview();

  applyLighting();   // fills the environment map; needs the tracer to exist

  // The tracer normally draws its own quad straight to the canvas. Route that
  // through an intermediate buffer instead so the denoiser can run last, while
  // the tracer's own colour handling stays untouched.
  state.displayTarget = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.HalfFloatType
  });
  state.denoiseQuad = new FullScreenQuad(new DenoiseMaterial({
    blending: THREE.NoBlending,
    depthWrite: false,
    depthTest: false
  }));

  state.pathTracer.renderToCanvasCallback = (target, renderer, quad) => {
    // Mid-batch: the accumulation buffer is what matters, and compositing it to
    // the canvas would only be overwritten by the next tile. The denoiser is a
    // full-screen filter with an 80-tap kernel, so skipping it here is most of
    // what the batching buys.
    if (state.skipDisplay) return;

    // Still cross-fading out of the raster stand-in. The tracer has set the quad
    // up to blend over what is already on the canvas at a partial opacity, so
    // let it do exactly that. Routing it through the buffer below instead would
    // composite a half-transparent image onto an empty target and then hand the
    // result to the denoiser — which is why every camera move used to be
    // followed by half a second of noticeably darkened image.
    if (quad.material.opacity < 1) {
      renderer.setRenderTarget(null);
      quad.render(renderer);
      return;
    }

    const strength = denoiseStrength();

    if (strength <= 0) {
      renderer.setRenderTarget(null);
      quad.render(renderer);
      return;
    }

    // the tracer's own colour handling first, into a buffer we can post-process
    renderer.setRenderTarget(state.displayTarget);
    quad.render(renderer);

    const material = state.denoiseQuad.material;
    material.map = state.displayTarget.texture;
    material.sigma = 1 + DENOISE_MAX_SIGMA * strength;
    material.threshold = 0.05 + DENOISE_MAX_THRESHOLD * strength;
    material.kSigma = 1;
    renderer.setRenderTarget(null);
    state.denoiseQuad.render(renderer);
  };

  window.addEventListener('resize', resize);
  animate();
}

/**
 * Build the scene from the app's parser output: { vertices, faces, faceColors }.
 * Returns how long the BVH build took — it is the one slow step (seconds on a
 * 600k triangle model) and the caller shows it.
 */
function setModel(parsed, onProgress) {
  const { vertices, faces, faceColors } = parsed;

  // The card is hidden when init() runs, so the canvas was sized against a
  // collapsed container: resync before building anything, or the render comes
  // out with an unrendered band.
  resize();

  if (state.mesh) {
    state.scene.remove(state.mesh);
    state.mesh.geometry.dispose();
    state.mesh.material.dispose();
  }

  // Non-indexed triangles with per-vertex colour, fan-triangulating any polygon
  const positions = [];
  const colours = [];
  // RGBA, not RGB: the tracer merges every geometry in the scene into one buffer
  // and the floor has no colours of its own, so the merge has to invent an
  // attribute for it. When the two itemSizes disagree the merged attribute comes
  // back neutral and the model renders flat grey — a three-component colour here
  // is enough to lose every vertex colour in the render.
  const push = (v, c) => {
    positions.push(v.x, v.y, v.z);
    colours.push(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b), 1);
  };
  const fallback = { r: 0.8, g: 0.8, b: 0.8 };

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f].vertices || faces[f];
    const faceColour = faceColors ? faceColors[f] : null;
    for (let i = 1; i < face.length - 1; i++) {
      const tri = [vertices[face[0]], vertices[face[i]], vertices[face[i + 1]]];
      for (const v of tri) push(v, faceColour || v.color || fallback);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 4));
  geometry.computeVertexNormals();

  state.mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.65,
    metalness: 0,
    side: THREE.DoubleSide
  }));
  // Z-up (3MF/STL) to Y-up
  state.mesh.rotation.x = -Math.PI / 2;
  state.scene.add(state.mesh);

  placeFloor();
  frameCamera();
  buildPreviewScene();
  applyLighting();

  if (onProgress) onProgress('Building acceleration structure...');
  const t0 = performance.now();
  state.pathTracer.setScene(state.scene, state.camera);
  // setScene alone keeps the previous model's material data: loading a second
  // file rendered it in flat white, whatever its colours. Re-uploading the
  // materials after the scene is what actually refreshes them.
  state.pathTracer.updateMaterials();
  const buildMs = Math.round(performance.now() - t0);

  return { triangles: positions.length / 9, buildMs };
}

/** Measure the model where it currently sits and sit the floor under it. */
function placeFloor() {
  const box = new THREE.Box3().setFromObject(state.mesh);
  box.getCenter(state.modelCenter);
  const size = box.getSize(new THREE.Vector3());
  state.modelSize = Math.max(size.x, size.y, size.z) || 1;

  if (state.floor) {
    state.scene.remove(state.floor);
    state.floor.geometry.dispose();
    state.floor.material.dispose();
  }
  const extent = state.modelSize * FLOOR_EXTENT;
  state.floor = new THREE.Mesh(
    new THREE.PlaneGeometry(extent, extent),
    // Lambertian on purpose: the specular lobe of a standard material is view
    // dependent and puts a gradient back on the backdrop.
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, specularIntensity: 0 })
  );
  state.floor.rotation.x = -Math.PI / 2;
  state.floor.position.set(state.modelCenter.x, box.min.y, state.modelCenter.z);
  state.scene.add(state.floor);
}

/**
 * Re-orient the model. The viewer's rotate buttons turn its own mesh, and this
 * mirrors that onto the traced one — which means the acceleration structure has
 * to be rebuilt, so it is deliberately not something to call on a drag.
 */
function setModelRotation(euler) {
  if (!state.mesh) return;
  state.mesh.rotation.set(euler.x, euler.y, euler.z);
  state.mesh.updateMatrixWorld(true);
  placeFloor();
  buildPreviewScene();
  state.pathTracer.setScene(state.scene, state.camera);
  state.pathTracer.updateMaterials();
  applyLighting();
}

/** Stop sampling while the host page is showing something else. */
function setPaused(paused) {
  state.paused = paused;
  if (!paused) restart();
}

/**
 * A plain rasterised stand-in for the traced image: flat lighting and a single
 * hard shadow map.
 *
 * The tracer already swaps in a rasterised scene while the trace is too noisy to
 * look at, but it draws the traced scene as-is — which has no lights in it at
 * all, only an environment map, so the one thing you are usually trying to place
 * while dragging is the one thing missing from it. This puts a solid shadow on
 * the floor instead, at the same angle the sun disc will cast it.
 */
function buildPreviewScene() {
  if (state.previewScene) {
    state.previewScene.traverse(o => { if (o.isMesh) o.material.dispose(); });
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const mesh = new THREE.Mesh(state.mesh.geometry, new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    side: THREE.DoubleSide
  }));
  mesh.rotation.copy(state.mesh.rotation);
  mesh.castShadow = true;
  scene.add(mesh);

  const floor = new THREE.Mesh(state.floor.geometry, new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0
  }));
  floor.rotation.copy(state.floor.rotation);
  floor.position.copy(state.floor.position);
  floor.receiveShadow = true;
  scene.add(floor);

  state.previewAmbient = new THREE.AmbientLight(0xffffff, 1);
  scene.add(state.previewAmbient);

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.0005;
  light.target.position.copy(state.modelCenter);
  scene.add(light);
  scene.add(light.target);

  state.previewScene = scene;
  state.previewLight = light;
  syncPreviewLight();
}

/** Put the stand-in's light where the sun disc is, and dose it to a white floor. */
function syncPreviewLight() {
  const light = state.previewLight;
  if (!light) return;

  const azimuth = THREE.MathUtils.degToRad(settings.lightAzimuth);
  const elevation = THREE.MathUtils.degToRad(settings.lightElevation);
  const r = state.modelSize * 4;
  light.position.set(
    state.modelCenter.x + r * Math.cos(elevation) * Math.sin(azimuth),
    state.modelCenter.y + r * Math.sin(elevation),
    state.modelCenter.z + r * Math.cos(elevation) * Math.cos(azimuth)
  );
  light.target.position.copy(state.modelCenter);
  light.target.updateMatrixWorld();

  // Lands the unshadowed floor on white whatever height the light is at, so only
  // the shadow moves. The PI is three's Lambert BRDF: a light's intensity is an
  // irradiance and the surface reflects albedo/PI of it.
  state.previewAmbient.intensity = PREVIEW_AMBIENT * PREVIEW_TARGET * Math.PI;
  light.intensity = (1 - PREVIEW_AMBIENT) * PREVIEW_TARGET * Math.PI /
    Math.max(0.2, Math.sin(elevation));

  // the shadow camera only has to cover the model and the shadow it throws
  const extent = state.modelSize * 1.6;
  const cam = light.shadow.camera;
  cam.left = -extent; cam.right = extent;
  cam.top = extent; cam.bottom = -extent;
  cam.near = r * 0.05;
  cam.far = r * 3;
  cam.updateProjectionMatrix();
}

/** Draw the stand-in straight to the canvas, leaving the trace untouched. */
function drawPreview() {
  if (!state.previewScene) return;
  state.renderer.setRenderTarget(null);
  state.renderer.render(state.previewScene, state.camera);
}

function frameCamera() {
  const d = state.modelSize;
  state.camera.far = d * 60;
  state.camera.near = d / 1000;
  state.camera.updateProjectionMatrix();
  if (state.controls) {
    state.controls.target.copy(state.modelCenter);
    state.camera.position.set(
      state.modelCenter.x + d * 0.9,
      state.modelCenter.y + d * 0.5,
      state.modelCenter.z + d * 1.3
    );
    state.camera.lookAt(state.modelCenter);
    state.controls.update();
  }
}

/**
 * Take the camera pose from the host page. Cheap to call every frame: the trace
 * is only invalidated when the pose actually moved, so a still camera keeps
 * accumulating.
 */
function setCameraPose(source) {
  const camera = state.camera;
  if (!camera) return;

  // Compared with a tolerance, and only applied when it is exceeded. An exact
  // comparison would catch the last sub-pixel twitches of a camera coming to
  // rest and throw the accumulated image away for each one; leaving the pose
  // alone below the threshold means the drift is measured against the last pose
  // actually used, so it still restarts as soon as it adds up to anything.
  const tolerance = CAMERA_EPSILON * state.modelSize;
  const moved =
    camera.position.distanceTo(source.position) > tolerance ||
    Math.abs(camera.quaternion.dot(source.quaternion)) < 1 - 1e-7 ||
    camera.fov !== source.fov;

  if (!moved) return;

  camera.position.copy(source.position);
  camera.quaternion.copy(source.quaternion);
  camera.fov = source.fov;
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  restart();
}

/**
 * Hold the raster stand-in for as long as the camera is being dragged.
 *
 * Tracing under a moving camera is wasted work — every frame throws the last one
 * away — and what it puts on screen in the meantime is a one-sample image, which
 * is noise. The stand-in is both cheaper and more readable, so the trace waits
 * for the mouse to come back up.
 *
 * The wheel has no release to wait for, so zooming falls back on the same timed
 * hold the sliders use.
 */
function watchInteraction(element) {
  element.addEventListener('pointerdown', () => setInteracting(true));
  element.addEventListener('wheel', () => holdPreview(), { passive: true });
  // on the window, not the element: a drag very often ends outside it
  window.addEventListener('pointerup', () => setInteracting(false));
  window.addEventListener('pointercancel', () => setInteracting(false));
  // a lost pointer capture would otherwise leave the trace held forever
  window.addEventListener('blur', () => setInteracting(false));
}

function setInteracting(interacting) {
  if (state.interacting === interacting) return;
  state.interacting = interacting;
  if (!interacting) restart();
}

function holdPreview() {
  if (state.mesh) state.previewUntil = performance.now() + PREVIEW_HOLD_MS;
}

/**
 * Turn the world around the model instead of turning the model: rotating the
 * mesh would invalidate the acceleration structure and cost a full rebuild per
 * frame. Spinning the camera and the light together by the same angle gives the
 * identical image for a fraction of the work.
 */
function beginTurntable() {
  state.turntable = {
    position: state.camera.position.clone(),
    quaternion: state.camera.quaternion.clone(),
    azimuth: settings.lightAzimuth
  };
}

function setTurntableAngle(radians) {
  const base = state.turntable;
  if (!base) return;

  // the model spinning by +angle is the world spinning by -angle
  const spin = new THREE.Quaternion().setFromAxisAngle(TURNTABLE_AXIS, -radians);
  state.camera.position.copy(base.position)
    .sub(state.modelCenter).applyQuaternion(spin).add(state.modelCenter);
  state.camera.quaternion.copy(spin).multiply(base.quaternion);
  state.camera.updateMatrixWorld(true);

  settings.lightAzimuth = base.azimuth - THREE.MathUtils.radToDeg(radians);
  applyLighting();   // repaints the sun into the map, and restarts
}

function endTurntable() {
  const base = state.turntable;
  if (!base) return;
  state.camera.position.copy(base.position);
  state.camera.quaternion.copy(base.quaternion);
  state.camera.updateMatrixWorld(true);
  settings.lightAzimuth = base.azimuth;
  state.turntable = null;
  applyLighting();
}

/**
 * Paint the environment map: a uniform sky with a sun disc in it.
 *
 * The two radiances are solved from the look we want rather than dialled in by
 * hand: whatever the sun's size or height, the sky and the disc are scaled so
 * that a Lambertian floor reflects exactly `target`. What the floor reflects
 * does not depend on where you stand — which is the whole point of putting the
 * light at infinity — so the backdrop comes out flat white everywhere the model
 * does not shadow it.
 */
function applyLighting() {
  const azimuth = THREE.MathUtils.degToRad(settings.lightAzimuth);
  const elevation = THREE.MathUtils.degToRad(settings.lightElevation);
  const sunX = Math.cos(elevation) * Math.sin(azimuth);
  const sunY = Math.sin(elevation);
  const sunZ = Math.cos(elevation) * Math.cos(azimuth);

  const radius = THREE.MathUtils.degToRad(
    SUN_MIN_DEG + (SUN_MAX_DEG - SUN_MIN_DEG) * settings.shadowBlur
  );
  const target = FLOOR_TARGET;
  const ambient = Math.min(0.95, Math.max(0, settings.envIntensity));

  // Feather the rim over a twentieth of the radius: a hard-edged disc aliases
  // badly against the sampling grid the tracer builds from this map.
  const cosOuter = Math.cos(radius * 1.05);
  const cosInner = Math.cos(radius * 0.95);

  // First pass: the disc's coverage, and the irradiance each source would put on
  // a horizontal floor at unit radiance. Summing it over the texels rather than
  // working it out on paper keeps the exposure exact whatever the sun's size or
  // height — the discretisation of the disc is then part of the measurement.
  const data = state.envData;
  const texelSolid = (2 * Math.PI / ENV_WIDTH) * (Math.PI / ENV_HEIGHT);
  let skyFlux = 0;
  let sunFlux = 0;

  for (let j = 0; j < ENV_HEIGHT; j++) {
    // the tracer's equirect: u = atan2(z, x) / 2PI + 0.5, v = 1 - acos(y) / PI
    const polar = Math.PI * (1 - (j + 0.5) / ENV_HEIGHT);
    const y = Math.cos(polar);
    const ring = Math.sin(polar);
    // solid angle of one texel in this row, times the floor's cosine
    const weight = y > 0 ? texelSolid * ring * y : 0;
    skyFlux += weight * ENV_WIDTH;

    for (let i = 0; i < ENV_WIDTH; i++) {
      const theta = ((i + 0.5) / ENV_WIDTH - 0.5) * 2 * Math.PI;
      const cosAngle = ring * Math.cos(theta) * sunX + y * sunY +
        ring * Math.sin(theta) * sunZ;

      let t = (cosAngle - cosOuter) / (cosInner - cosOuter);
      t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

      data[(j * ENV_WIDTH + i) * 4] = t;
      sunFlux += weight * t;
    }
  }

  // A Lambertian floor under irradiance E reflects albedo * E / PI, so the
  // radiances that land it exactly on the target fall straight out.
  const sky = skyFlux > 0 ? ambient * target * Math.PI / (FLOOR_ALBEDO * skyFlux) : 0;
  const sun = sunFlux > 0 ? (1 - ambient) * target * Math.PI / (FLOOR_ALBEDO * sunFlux) : 0;

  for (let o = 0; o < data.length; o += 4) {
    const value = sky + sun * data[o];
    data[o] = value;
    data[o + 1] = value;
    data[o + 2] = value;
    data[o + 3] = 1;
  }

  // The tracer rebuilds the sampling tables it needs only when scene.environment
  // is a *different* object — repainting the pixels of the one it already holds
  // is silently ignored and the lighting never changes. So hand it a fresh
  // texture over the same buffer every time.
  if (state.envTexture) state.envTexture.dispose();
  state.envTexture = new THREE.DataTexture(
    data, ENV_WIDTH, ENV_HEIGHT, THREE.RGBAFormat, THREE.FloatType
  );
  state.envTexture.mapping = THREE.EquirectangularReflectionMapping;
  state.envTexture.minFilter = THREE.LinearFilter;
  state.envTexture.magFilter = THREE.LinearFilter;
  state.envTexture.wrapS = THREE.RepeatWrapping;
  state.envTexture.generateMipmaps = false;
  state.envTexture.colorSpace = THREE.LinearSRGBColorSpace;
  state.envTexture.needsUpdate = true;
  state.scene.environment = state.envTexture;
  // the backdrop tracks the floor, so lowering the exposure greys both together
  state.scene.backgroundIntensity = target;

  state.pathTracer.bounces = settings.bounces;

  syncPreviewLight();

  if (state.mesh) {
    state.mesh.material.color.setScalar(settings.exposure);
    state.pathTracer.updateMaterials();
    state.pathTracer.updateEnvironment();
  }
  restart();
}

/** Full passes accumulated so far — the tracer's own count, fractional. */
function currentSamples() {
  return state.pathTracer ? state.pathTracer.samples : 0;
}

/**
 * Full strength on the first frames, nothing left once the image has converged
 * on its own — so the filter never costs detail on a long render.
 */
function denoiseStrength() {
  if (settings.denoise <= 0) return 0;
  const fade = Math.max(0, 1 - currentSamples() / DENOISE_FADE_SAMPLES);
  return settings.denoise * fade;
}

/**
 * Any change to the scene or the camera invalidates the accumulated image.
 */
function restart() {
  if (!state.pathTracer) return;
  state.pathTracer.updateCamera();
}

/**
 * Apply a setting to the stand-in only: the light moves and the raster preview
 * is redrawn, but the accumulated trace is left alone. This is what a slider
 * calls while it is being dragged — restarting on every pixel of travel would
 * throw the image away dozens of times for one adjustment and show nothing but
 * noise the whole way.
 *
 * The hold expires on its own, so a drag that never reports a release (or a
 * setting changed from the console) recovers by itself instead of leaving the
 * canvas stuck on the preview.
 */
function previewSetting(key, value) {
  if (!(key in settings)) return;
  settings[key] = value;
  if (!state.mesh) return;
  syncPreviewLight();
  state.previewUntil = performance.now() + PREVIEW_HOLD_MS;
  drawPreview();
}

function setSetting(key, value) {
  if (!(key in settings)) return;
  settings[key] = value;
  state.previewUntil = 0;
  saveSettings();
  // display-only: these must not throw away the accumulated samples
  if (key === 'denoise' || key === 'alphaExport') return;
  if (state.mesh) applyLighting();
}

function resize() {
  if (!state.container || !state.renderer) return;
  const width = state.container.clientWidth;
  const height = state.container.clientHeight;
  if (!width || !height) return;
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(width, height);
  if (state.displayTarget) state.displayTarget.setSize(width, height);
  if (state.pathTracer) state.pathTracer.updateCamera();
}

function animate() {
  state.animationId = requestAnimationFrame(animate);
  if (!state.mesh || state.paused) return;
  if (state.controls) state.controls.update();

  // The camera is being dragged, a slider is being moved, or the wheel just
  // turned: hold the stand-in up rather than tracing a frame that is about to be
  // thrown away
  if (state.interacting || performance.now() < state.previewUntil) {
    drawPreview();
    return;
  }

  // Grow the batch while frames come back quick, shrink it when they drag. The
  // frame time is the only honest measure of how much the GPU actually got
  // through: the draw calls themselves return long before the work is done.
  const now = performance.now();
  const frameMs = state.lastFrame ? now - state.lastFrame : FRAME_TARGET_MS;
  state.lastFrame = now;
  if (frameMs < FRAME_TARGET_MS * 0.75) state.batch = Math.min(MAX_BATCH, state.batch + 1);
  else if (frameMs > FRAME_TARGET_MS) state.batch = Math.max(1, state.batch - 1);

  renderBatch(state.batch);
  if (state.onSample) state.onSample(Math.floor(currentSamples()), CONVERGED_REFERENCE);
}

/**
 * Accumulate `count` tiles, compositing only once at the end.
 */
function renderBatch(tiles) {
  for (let i = 0; i < tiles; i++) {
    state.skipDisplay = i < tiles - 1;
    state.pathTracer.renderSample();
  }
  state.skipDisplay = false;
}

/**
 * Render up to `samples` in one go — used before grabbing a still.
 *
 * The tracer normally holds a rasterised preview on the canvas for the first
 * 100ms and then cross-fades the traced image in over half a second, both timed
 * off the wall clock. A synchronous loop leaves the clock where it was, so
 * without this the canvas would still be showing the raster preview when the
 * export grabs it. Drop the delays for the duration of the burst.
 */
function renderTo(samples) {
  if (!state.mesh) return;

  const tracer = state.pathTracer;
  const delay = tracer.renderDelay;
  const fade = tracer.fadeDuration;
  const min = tracer.minSamples;
  tracer.renderDelay = 0;
  tracer.fadeDuration = 0;
  tracer.minSamples = 1;

  try {
    const missing = samples - currentSamples();
    if (missing > 0) renderBatch(Math.ceil(missing * TILES_PER_SAMPLE));
  } finally {
    tracer.renderDelay = delay;
    tracer.fadeDuration = fade;
    tracer.minSamples = min;
  }
}

/**
 * Draw the object coverage (model white, everything else black) into the mask
 * target. A plain raster render in a scene of its own: touching the traced
 * scene makes the path tracer re-read it and the render goes dark.
 */
function renderMaskTarget(target) {
  const { renderer, camera, mesh } = state;

  // A scene of its own: the path tracer re-reads whatever it is handed, and
  // touching the traced scene here made the whole render go dark.
  const maskScene = new THREE.Scene();
  maskScene.background = new THREE.Color(0x000000);
  const maskMesh = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  maskMesh.position.copy(mesh.position);
  maskMesh.rotation.copy(mesh.rotation);
  maskMesh.scale.copy(mesh.scale);
  maskScene.add(maskMesh);

  const savedTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(maskScene, camera);
  renderer.setRenderTarget(savedTarget);

  maskMesh.material.dispose();
}

/**
 * Object coverage for the alpha export: the model in white, everything else
 * black, rasterised MASK_SUPERSAMPLE times oversampled so the caller can average
 * it down into fractional coverage along the silhouette.
 *
 * Built on demand and thrown away — at 3x a 900px frame it is a 29MB readback,
 * which is fine once per export and not worth holding on to between them.
 * Rows come back bottom-up, the way WebGL reads them.
 */
function renderMask() {
  const { renderer } = state;
  if (!state.mesh) return null;

  const canvas = renderer.domElement;
  const width = canvas.width * MASK_SUPERSAMPLE;
  const height = canvas.height * MASK_SUPERSAMPLE;
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });

  renderMaskTarget(target);
  const buffer = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, buffer);
  target.dispose();

  return { buffer, width, height, scale: MASK_SUPERSAMPLE };
}

function getCanvas() {
  return state.renderer ? state.renderer.domElement : null;
}

function getSamples() {
  return Math.floor(currentSamples());
}

window.PathRender = {
  init,
  setModel,
  setSetting,
  previewSetting,
  settings,
  denoiseStrength,
  restart,
  renderTo,
  renderMask,
  getCanvas,
  getSamples,
  frameCamera,
  setCameraPose,
  setInteracting,
  holdPreview,
  setModelRotation,
  setPaused,
  beginTurntable,
  setTurntableAngle,
  endTurntable,
  CONVERGED_REFERENCE,
  _state: state
};

export default window.PathRender;
