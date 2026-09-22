// ============================================================================
// Render page wiring (render.html)
// ============================================================================
// Classic script: file handling and UI. The path tracer itself lives in
// js/pathRender.js, an ES module loaded through the page's import map.

const RENDER_EXTENSIONS = ['.obj', '.stl', '.glb', '.3mf'];

const el = {};

function showLoader(text) {
  el.loaderText.textContent = text;
  el.loaderOverlay.classList.add('show');
}

function hideLoader() {
  el.loaderOverlay.classList.remove('show');
}

/** Wait for the module to register itself (it loads asynchronously). */
async function waitForEngine() {
  for (let i = 0; i < 200 && !window.PathRender; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!window.PathRender) throw new Error('path tracer failed to load');
  return window.PathRender;
}

function parseFile(file) {
  const name = file.name.toLowerCase();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read the file'));
    reader.onload = async e => {
      try {
        if (name.endsWith('.obj')) resolve(parseOBJ(e.target.result));
        else if (name.endsWith('.stl')) resolve(parseSTL(e.target.result));
        else if (name.endsWith('.glb')) resolve(await parseGLB(e.target.result));
        else if (name.endsWith('.3mf')) resolve(await parse3MF(e.target.result));
        else reject(new Error('unsupported format'));
      } catch (err) {
        reject(err);
      }
    };
    if (name.endsWith('.obj')) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

async function handleFile(file) {
  if (!RENDER_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext))) return;

  el.fileName.textContent = file.name;
  el.fileInfo.classList.add('show');
  el.fileStats.textContent = 'Reading...';
  showLoader('Reading ' + file.name + '...');

  try {
    const engine = await waitForEngine();
    const parsed = await parseFile(file);

    if (!engine._state.renderer) {
      el.renderCard.style.display = 'block';
      engine.init(el.renderContainer);
    }
    el.renderCard.style.display = 'block';

    // The BVH build blocks for seconds on a big model: let the loader paint first
    showLoader('Building acceleration structure...');
    await new Promise(resolve => setTimeout(resolve, 50));

    const info = engine.setModel(parsed);
    const skipped = parsed.skippedParts
      ? `, ${parsed.skippedParts} helper part${parsed.skippedParts > 1 ? 's' : ''} hidden`
      : '';
    el.fileStats.textContent =
      `${info.triangles.toLocaleString()} triangles${skipped} — acceleration structure built in ${(info.buildMs / 1000).toFixed(1)}s`;

    engine._state.onSample = updateProgress;
    updateProgress(0, engine.CONVERGED_REFERENCE);
  } catch (err) {
    console.error('Render page:', err);
    el.fileStats.textContent = 'Error: ' + err.message;
  } finally {
    hideLoader();
  }
}

// Sampling never stops while the page is open, so the bar tracks progress up to
// the point the image is visually clean and the count keeps climbing after that.
function updateProgress(samples, reference) {
  const pct = Math.min(100, Math.round((samples / reference) * 100));
  el.progressFill.style.width = pct + '%';
  el.progressText.textContent = samples >= reference
    ? `${samples.toLocaleString()} samples — converged`
    : `${samples} / ${reference} samples`;
}

const controls = [];

/**
 * `live` is for settings that only change how the accumulated image is displayed
 * — they cost nothing to apply, so they follow the handle. Everything else
 * invalidates the trace, so it waits for the release: `input` moves the preview,
 * `change` commits and restarts.
 */
function initSlider(id, valueId, key, format, live = false) {
  const slider = document.getElementById(id);
  const value = document.getElementById(valueId);
  controls.push({ slider, value, key, format });

  value.textContent = format(parseFloat(slider.value));

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

/**
 * Put the panel back the way it was left. The engine is an ES module and loads
 * after this script, so the stored values are not there to read at wiring time —
 * the markup holds the defaults until it shows up.
 */
async function restoreSettings() {
  const engine = await waitForEngine();
  for (const { slider, value, key, format } of controls) {
    const stored = engine.settings[key];
    if (typeof stored === 'number') slider.value = String(stored);
    value.textContent = format(parseFloat(slider.value));
  }
  document.getElementById('alphaBtn').classList.toggle('active', alphaExport());
}

async function exportPNG() {
  const engine = window.PathRender;
  if (!engine || !engine.getCanvas()) return;

  // Push the image to convergence before grabbing it
  const target = engine.CONVERGED_REFERENCE;
  if (engine.getSamples() < target) {
    showLoader('Converging the image...');
    await new Promise(resolve => setTimeout(resolve, 50));
    engine.renderTo(target);
    hideLoader();
  }

  let source = engine.getCanvas();
  if (alphaExport()) {
    const mask = engine.renderMask();
    if (mask) source = composeAlpha(source, mask);
  }

  const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
  const base = (el.fileName.textContent || 'render').replace(/\.[^.]+$/, '');

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${base}_render.png`,
        types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}_render.png`;
  a.click();
  URL.revokeObjectURL(url);
}

function init() {
  el.dropZone = document.getElementById('dropZone');
  el.fileInput = document.getElementById('fileInput');
  el.fileInfo = document.getElementById('fileInfo');
  el.fileName = document.getElementById('fileName');
  el.fileStats = document.getElementById('fileStats');
  el.renderCard = document.getElementById('renderCard');
  el.renderContainer = document.getElementById('renderContainer');
  el.loaderOverlay = document.getElementById('loaderOverlay');
  el.loaderText = document.getElementById('loaderText');
  el.progressFill = document.getElementById('renderProgressFill');
  el.progressText = document.getElementById('renderProgressText');

  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('dragover', e => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
  el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
  el.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    el.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  el.fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  const settingsPanel = document.getElementById('viewerSettings');
  const settingsBtn = document.getElementById('toggleSettingsBtn');
  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('show');
    settingsBtn.classList.toggle('active', settingsPanel.classList.contains('show'));
  });

  document.getElementById('fitBtn').addEventListener('click', () => {
    if (window.PathRender) { window.PathRender.frameCamera(); window.PathRender.restart(); }
  });
  document.getElementById('exportPngBtn').addEventListener('click', exportPNG);

  const alphaBtn = document.getElementById('alphaBtn');
  alphaBtn.classList.toggle('active', alphaExport());
  alphaBtn.addEventListener('click', () => {
    const next = !alphaExport();
    window.PathRender.setSetting('alphaExport', next);
    alphaBtn.classList.toggle('active', next);
  });

  initSlider('denoiseSlider', 'denoiseValue', 'denoise', v => v.toFixed(2), true);
  initSlider('exposureSlider', 'exposureValue', 'exposure', v => v.toFixed(2));
  initSlider('lightAzimuthSlider', 'lightAzimuthValue', 'lightAzimuth', v => `${v}°`);
  initSlider('lightElevationSlider', 'lightElevationValue', 'lightElevation', v => `${v}°`);
  initSlider('shadowBlurSlider', 'shadowBlurValue', 'shadowBlur', v => v.toFixed(2));
  initSlider('envIntensitySlider', 'envIntensityValue', 'envIntensity', v => v.toFixed(2));
  initSlider('bouncesSlider', 'bouncesValue', 'bounces', v => String(v));

  restoreSettings().catch(err => console.error('Render page:', err));
}

document.addEventListener('DOMContentLoaded', init);
