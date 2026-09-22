// ============================================================================
// Raytracing mode for the viewer (viewer.html)
// ============================================================================
// The viewer runs three r128 as a global; the path tracer needs three 0.180 as
// a module. The two cannot share a scene graph — their BufferGeometry, Material
// and Matrix4 are different classes, and three-mesh-bvh rejects the older ones.
//
// So the two renderers are not merged, they are *fed the same thing*: both take
// the parser's { vertices, faces, faceColors }. Two canvases sit stacked in the
// viewer container, the toggle picks which one is visible, and the tracer's
// camera is copied from the viewer's every frame — one set of OrbitControls,
// one saved camera state, one Fit button, driving both.

// Enough to read as a finished frame without making a 72 frame turn take all
// afternoon. The modal measures the machine and quotes a real time anyway.
const RT_TURNTABLE_SAMPLES = 32;

// Viewer controls that describe the raster pipeline and mean nothing to the
// tracer, which brings its own lighting.
const RT_HIDDEN_BUTTONS = ['toggleAoBtn', 'toggleShadowBtn', 'toggleWireframeBtn', 'toggleFdmBtn'];

const RaytraceMode = (function () {
  let engine = null;
  let active = false;
  let built = false;
  let syncId = null;

  /** The module registers itself asynchronously; the button may be quicker. */
  async function waitForEngine() {
    for (let i = 0; i < 200 && !window.PathRender; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!window.PathRender) throw new Error('path tracer failed to load');
    return window.PathRender;
  }

  function isActive() {
    return active;
  }

  function rasterCanvas() {
    return viewer3D.renderer ? viewer3D.renderer.domElement : null;
  }

  /**
   * Hand the viewer's camera to the tracer once per frame. The tracer only
   * throws its accumulated image away when the pose actually changed, so a
   * still camera keeps converging.
   */
  function syncLoop() {
    syncId = requestAnimationFrame(syncLoop);
    if (!active || !engine || !viewer3D.camera) return;
    engine.setCameraPose(viewer3D.camera);
    updateProgress();
  }

  /** Sample counter, live while the tracer has the canvas. */
  function updateProgress() {
    const text = document.getElementById('rtProgressText');
    const fill = document.getElementById('rtProgressFill');
    if (!text || !engine) return;

    const samples = engine.getSamples();
    const reference = engine.CONVERGED_REFERENCE;
    text.textContent = samples >= reference
      ? `${samples.toLocaleString()} samples — converged`
      : `${samples} / ${reference} samples`;
    if (fill) fill.style.width = Math.min(100, Math.round(samples / reference * 100)) + '%';
  }

  function showPanelRows() {
    const progress = document.getElementById('rtProgress');
    if (progress) progress.style.display = active ? '' : 'none';

    document.querySelectorAll('.raster-setting').forEach(row => {
      row.style.display = active ? 'none' : '';
    });
    document.querySelectorAll('.rt-setting').forEach(row => {
      row.style.display = active ? '' : 'none';
    });
    // FDM rows have visibility logic of their own; in raytracing they are moot
    if (active) {
      document.querySelectorAll('.fdm-setting').forEach(row => { row.style.display = 'none'; });
    }
    document.querySelectorAll('.rt-only').forEach(el => {
      el.style.display = active ? '' : 'none';
    });
    RT_HIDDEN_BUTTONS.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = active ? 'none' : '';
    });
  }

  /**
   * The viewer owns the camera, so it is the one that knows when a drag starts
   * and ends. Pass that through: the tracer holds its raster stand-in for the
   * whole drag instead of restarting a trace on every frame of it.
   */
  let interactionWired = false;
  function watchViewerInteraction() {
    if (interactionWired) return;
    const canvas = rasterCanvas();
    if (!canvas) return;
    interactionWired = true;

    canvas.addEventListener('pointerdown', () => { if (active) engine.setInteracting(true); });
    canvas.addEventListener('wheel', () => { if (active) engine.holdPreview(); }, { passive: true });
    const release = () => { if (active && engine) engine.setInteracting(false); };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
  }

  async function enable() {
    const container = document.getElementById('viewer3DContainer');
    if (!container || !viewer3D.mesh) return;

    engine = await waitForEngine();

    if (!built) {
      // Seconds of BVH build on a heavy model, so it waits until actually asked
      // for rather than happening behind every file that gets opened.
      showLoader('Preparing raytracer...');
      await new Promise(resolve => setTimeout(resolve, 50));
      try {
        if (!engine._state.renderer) {
          engine.init(container, { controls: false });
          const canvas = engine.getCanvas();
          canvas.classList.add('raytrace-canvas');
          // Also inline, not only in the stylesheet: styles.css is linked without
          // a version and a stale cached copy would leave this canvas swallowing
          // every drag meant for the OrbitControls underneath it.
          canvas.style.pointerEvents = 'none';
        }
        engine.setModel({
          vertices: viewer3D.vertices,
          faces: viewer3D.faces,
          faceColors: viewer3D.faceColors
        });
        engine.setModelRotation(viewer3D.mesh.rotation);
        built = true;
      } finally {
        hideLoader();
      }
    }

    watchViewerInteraction();
    active = true;
    engine.setInteracting(false);
    engine.setPaused(false);
    engine.getCanvas().style.display = '';
    // Hidden with opacity, not visibility: a visibility:hidden element receives
    // no pointer events, and this one still has to — OrbitControls is bound to
    // it and the tracer's canvas above deliberately passes clicks through.
    const raster = rasterCanvas();
    if (raster) raster.style.opacity = '0';
    showPanelRows();
    if (syncId === null) syncLoop();
  }

  function disable() {
    active = false;
    if (engine) engine.setInteracting(false);
    if (engine && engine.getCanvas()) {
      engine.setPaused(true);
      engine.getCanvas().style.display = 'none';
    }
    const raster = rasterCanvas();
    if (raster) raster.style.opacity = '';
    showPanelRows();
  }

  async function toggle() {
    if (active) disable();
    else await enable();
    const btn = document.getElementById('toggleRaytraceBtn');
    if (btn) btn.classList.toggle('active', active);
  }

  /** A new file invalidates everything the tracer built for the old one. */
  function onModelLoaded() {
    built = false;
    if (active) disable();
    const btn = document.getElementById('toggleRaytraceBtn');
    if (btn) btn.classList.remove('active');
  }

  /** The rotate buttons turn the viewer's mesh; mirror it and rebuild. */
  function onModelRotated() {
    if (!active || !engine || !built) return;
    showLoader('Rebuilding acceleration structure...');
    setTimeout(() => {
      try {
        engine.setModelRotation(viewer3D.mesh.rotation);
      } finally {
        hideLoader();
      }
    }, 50);
  }

  async function exportPNG(baseName) {
    if (!engine) return;
    showLoader('Converging the image...');
    await new Promise(resolve => setTimeout(resolve, 50));
    engine.renderTo(engine.CONVERGED_REFERENCE);
    hideLoader();

    let source = engine.getCanvas();
    if (alphaExport()) {
      const mask = engine.renderMask();
      if (mask) source = composeAlpha(source, mask);
    }

    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    await saveViewerBlob(blob, `${baseName}.png`, 'PNG Image', 'image/png', '.png');
  }

  /**
   * Time a handful of samples so the modal can quote the real cost on this
   * machine rather than a number made up on a different one.
   */
  function measureSampleMs() {
    if (!engine) return 40;
    const gl = engine._state.renderer.getContext();
    const probe = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);

    engine.restart();
    engine.renderTo(2);
    sync();
    const start = engine.getSamples();
    const t0 = performance.now();
    engine.renderTo(start + 6);
    sync();
    const done = engine.getSamples() - start;
    return done > 0 ? (performance.now() - t0) / done : 40;
  }

  async function exportTurntable(baseName, samplesPerFrame) {
    if (!engine) return;
    if (typeof canEncodeWebP === 'function' && !(await canEncodeWebP())) {
      alert('This browser cannot encode WebP images. Try Chrome, Edge or Firefox.');
      return;
    }

    const { frames, fps, width, quality } = getTurntableSettings();
    const delay = Math.round(1000 / fps);

    const source = engine.getCanvas();
    const outWidth = Math.round(width);
    const outHeight = Math.max(1, Math.round(outWidth * source.height / source.width));
    const grabCanvas = document.createElement('canvas');
    grabCanvas.width = outWidth;
    grabCanvas.height = outHeight;
    const grabCtx = grabCanvas.getContext('2d');

    engine.setPaused(true);
    engine.beginTurntable();

    try {
      const webpFrames = [];
      const started = performance.now();

      // The mask has to be redrawn per frame — the camera moves with the turn —
      // but that is a render and a readback of about 25ms, nothing next to the
      // seconds each frame spends being traced.
      const cutout = alphaExport();

      for (let i = 0; i < frames; i++) {
        engine.setTurntableAngle((i / frames) * Math.PI * 2);
        engine.renderTo(samplesPerFrame);

        let frameSource = source;
        if (cutout) {
          const mask = engine.renderMask();
          if (mask) frameSource = composeAlpha(source, mask);
        }

        grabCtx.clearRect(0, 0, outWidth, outHeight);
        grabCtx.drawImage(frameSource, 0, 0, outWidth, outHeight);
        const frameBlob = await new Promise(resolve => grabCanvas.toBlob(resolve, 'image/webp', quality));
        if (!frameBlob) throw new Error('WebP frame encoding failed');
        webpFrames.push(frameBlob);

        const left = Math.round((performance.now() - started) / (i + 1) * (frames - i - 1) / 1000);
        showLoader(`Raytracing turntable ${i + 1}/${frames} — ${formatDuration(left)} left...`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      showLoader('Assembling animation...');
      const animated = await encodeAnimatedWebP(webpFrames, {
        width: outWidth, height: outHeight, delay, loop: 0
      });
      hideLoader();
      await saveViewerBlob(animated, `${baseName}_turntable.webp`, 'Animated WebP', 'image/webp', '.webp');
    } catch (err) {
      console.error('Raytraced turntable export failed:', err);
      hideLoader();
      alert('Turntable export failed: ' + err.message);
    } finally {
      engine.endTurntable();
      engine.setPaused(false);
      hideLoader();
    }
  }

  return {
    isActive, toggle, enable, disable,
    onModelLoaded, onModelRotated,
    exportPNG, exportTurntable, measureSampleMs
  };
})();

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(0, seconds)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Turntable modal: how many samples to sit on each frame
// ---------------------------------------------------------------------------

/**
 * The raytracing rows drive the tracer's own settings, which it persists itself.
 * Same contract as the render page: a slider that invalidates the trace moves
 * the raster stand-in while dragged and only commits on release, so one
 * adjustment costs one restart instead of one per pixel of travel.
 */
function initRaytraceSliders() {
  const rows = [
    ['denoiseSlider', 'denoiseValue', 'denoise', v => v.toFixed(2), true],
    ['exposureSlider', 'exposureValue', 'exposure', v => v.toFixed(2), false],
    ['lightAzimuthSlider', 'lightAzimuthValue', 'lightAzimuth', v => `${v}°`, false],
    ['lightElevationSlider', 'lightElevationValue', 'lightElevation', v => `${v}°`, false],
    ['shadowBlurSlider', 'shadowBlurValue', 'shadowBlur', v => v.toFixed(2), false],
    ['envIntensitySlider', 'envIntensityValue', 'envIntensity', v => v.toFixed(2), false],
    ['bouncesSlider', 'bouncesValue', 'bounces', v => String(v), false]
  ];

  const wired = [];
  for (const [sliderId, valueId, key, format, live] of rows) {
    const slider = document.getElementById(sliderId);
    const value = document.getElementById(valueId);
    if (!slider || !value) continue;
    wired.push({ slider, value, key, format });

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      value.textContent = format(v);
      if (!window.PathRender) return;
      if (live) window.PathRender.setSetting(key, v);
      else window.PathRender.previewSetting(key, v);
    });
    slider.addEventListener('change', () => {
      if (!live && window.PathRender) window.PathRender.setSetting(key, parseFloat(slider.value));
    });
  }

  // The tracer is a module and shows up after this script, so the panel is put
  // back to its stored state once it is there.
  (async () => {
    for (let i = 0; i < 200 && !window.PathRender; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!window.PathRender) return;
    for (const { slider, value, key, format } of wired) {
      const stored = window.PathRender.settings[key];
      if (typeof stored === 'number') slider.value = String(stored);
      value.textContent = format(parseFloat(slider.value));
    }
  })();
}

function initRaytraceUI() {
  initRaytraceSliders();
  const toggleBtn = document.getElementById('toggleRaytraceBtn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      RaytraceMode.toggle().catch(err => {
        console.error('Raytracing:', err);
        alert('Could not start the raytracer: ' + err.message);
      });
    });
  }

  const alphaBtn = document.getElementById('toggleAlphaBtn');
  if (alphaBtn) {
    const sync = () => alphaBtn.classList.toggle('active', alphaExport());
    alphaBtn.addEventListener('click', () => {
      if (!window.PathRender) return;
      window.PathRender.setSetting('alphaExport', !alphaExport());
      sync();
    });
    // the tracer restores the stored value once its module has loaded
    (async () => {
      for (let i = 0; i < 200 && !window.PathRender; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      sync();
    })();
  }

  const overlay = document.getElementById('rtTurntableOverlay');
  if (!overlay) return;

  const samplesInput = document.getElementById('rtSamplesInput');
  const estimate = document.getElementById('rtTurntableEstimate');
  let sampleMs = 40;
  let pendingBaseName = 'model';

  function refreshEstimate() {
    const samples = Math.max(1, parseInt(samplesInput.value, 10) || 1);
    const { frames } = getTurntableSettings();
    const seconds = Math.round(frames * samples * sampleMs / 1000);
    estimate.textContent = `${frames} frames × ${samples} samples — about ${formatDuration(seconds)}`;
  }

  samplesInput.addEventListener('input', refreshEstimate);

  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('show');
  });
  document.getElementById('rtTurntableCancel').addEventListener('click', () => {
    overlay.classList.remove('show');
  });
  document.getElementById('rtTurntableConfirm').addEventListener('click', () => {
    overlay.classList.remove('show');
    const samples = Math.max(1, parseInt(samplesInput.value, 10) || RT_TURNTABLE_SAMPLES);
    RaytraceMode.exportTurntable(pendingBaseName, samples);
  });

  // opened from the 360 button when raytracing is on
  window.openRaytraceTurntableModal = baseName => {
    pendingBaseName = baseName;
    samplesInput.value = String(RT_TURNTABLE_SAMPLES);
    estimate.textContent = 'Measuring...';
    overlay.classList.add('show');
    // let the dialog paint before the probe blocks on the GPU
    setTimeout(() => {
      sampleMs = RaytraceMode.measureSampleMs();
      refreshEstimate();
    }, 60);
  };
}

document.addEventListener('DOMContentLoaded', initRaytraceUI);
