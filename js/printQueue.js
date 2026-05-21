// ============================================================================
// Print Queue — concatenate multiple .gcode.3mf jobs into a single farm loop
// ============================================================================

const END_GCODE_STORAGE_KEY = 'printQueue.endGcode';
const COOLDOWN_STORAGE_KEY = 'printQueue.cooldownBetweenLoops';
const LOOP_COUNT_STORAGE_KEY = 'printQueue.loopCount';
const FILAMENT_SLOTS_STORAGE_KEY = 'printQueue.filamentSlots';
const PREEND_MINUTES_STORAGE_KEY = 'printQueue.preEndMinutes';
const PREEND_SNIPPET_STORAGE_KEY = 'printQueue.preEndSnippet';

// G-code transformation constants (EXTRUDE_CALI_*, PRINT_END_TRIGGER) live in
// js/printQueueWorker.js — the heavy lifting runs there off the main thread.

// Empty by default — the user MUST supply their own ejection sequence
// before the export button does anything.
const DEFAULT_END_GCODE = '';

// Single in-flight cancel handler (used by the toast × button)
let currentExportCancel = null;

function showExportToast(message, percent) {
  const toast = document.getElementById('exportToast');
  const titleEl = document.getElementById('exportToastTitle');
  const msgEl = document.getElementById('exportToastMessage');
  const barEl = document.getElementById('exportToastBar');
  if (!toast) return;
  toast.classList.remove('success', 'error');
  toast.classList.add('show');
  titleEl.textContent = 'Exporting';
  msgEl.textContent = message;
  barEl.style.width = (percent || 0) + '%';
}

function updateExportToast(message, percent) {
  const msgEl = document.getElementById('exportToastMessage');
  const barEl = document.getElementById('exportToastBar');
  if (msgEl) msgEl.textContent = message;
  if (barEl && typeof percent === 'number') barEl.style.width = percent + '%';
}

function finishExportToast(state, title, message) {
  const toast = document.getElementById('exportToast');
  const titleEl = document.getElementById('exportToastTitle');
  const msgEl = document.getElementById('exportToastMessage');
  const barEl = document.getElementById('exportToastBar');
  if (!toast) return;
  toast.classList.remove('success', 'error');
  toast.classList.add('show', state); // ensure visible + 'success' or 'error'
  titleEl.textContent = title;
  msgEl.textContent = message;
  barEl.style.width = '100%';
  // Auto-dismiss success after a few seconds; keep errors until the user closes.
  currentExportCancel = null;
  if (state === 'success') {
    setTimeout(() => toast.classList.remove('show'), 4000);
  }
}

function initPrintQueue(monaco) {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const queueCard = document.getElementById('queueCard');
  const queueList = document.getElementById('queueList');
  const queueCount = document.getElementById('queueCount');
  const endGcodeCard = document.getElementById('endGcodeCard');
  const endGcodeEditorEl = document.getElementById('endGcodeEditor');
  const resetEndGcodeBtn = document.getElementById('resetEndGcodeBtn');
  const findEndGcodeBtn = document.getElementById('findEndGcodeBtn');
  const replaceEndGcodeBtn = document.getElementById('replaceEndGcodeBtn');
  const preEndCard = document.getElementById('preEndCard');
  const preEndMinutes = document.getElementById('preEndMinutes');
  const preEndSnippet = document.getElementById('preEndSnippet');
  const filamentCard = document.getElementById('filamentCard');
  const filamentSlots = document.getElementById('filamentSlots');
  const loopCard = document.getElementById('loopCard');
  const loopCount = document.getElementById('loopCount');
  const cooldownInput = document.getElementById('cooldownBetweenLoops');
  const totalPrints = document.getElementById('totalPrints');
  const totalTime = document.getElementById('totalTime');
  const totalFilament = document.getElementById('totalFilament');
  const totalSize = document.getElementById('totalSize');
  const exportCard = document.getElementById('exportCard');
  const exportBtn = document.getElementById('exportBtn');
  const outputName = document.getElementById('outputName');

  // queue is an array of job objects:
  // { id, name, sizeBytes, buffer, gcodeContent, gcodePath, thumbnailDataUrl,
  //   timeSeconds, weightG, stats }
  const queue = [];
  let dragSrcId = null;

  // ── Monaco editor (G-code) ────────────────────────────────────────────────
  const endGcodeEditor = monaco.editor.create(endGcodeEditorEl, {
    value: loadEndGcode(),
    language: 'gcode',
    theme: 'gcode-dark',
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, monospace',
    fontSize: 13,
    lineNumbers: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
    renderLineHighlight: 'line',
    quickSuggestions: { other: true, comments: false, strings: false },
  });

  endGcodeEditor.onDidChangeModelContent(() => {
    saveEndGcode(endGcodeEditor.getValue());
  });

  // ── Upload handlers ──────────────────────────────────────────────────────
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', e => {
    handleFiles(e.target.files);
    fileInput.value = '';
  });

  resetEndGcodeBtn.addEventListener('click', () => {
    endGcodeEditor.setValue(DEFAULT_END_GCODE);
    saveEndGcode(DEFAULT_END_GCODE);
  });

  findEndGcodeBtn.addEventListener('click', () => {
    endGcodeEditor.focus();
    endGcodeEditor.getAction('actions.find').run();
  });

  replaceEndGcodeBtn.addEventListener('click', () => {
    endGcodeEditor.focus();
    endGcodeEditor.getAction('editor.action.startFindReplaceAction').run();
  });

  // Restore + persist cooldown setting
  cooldownInput.value = loadCooldown();
  cooldownInput.addEventListener('input', () => {
    saveCooldown(cooldownInput.value);
    updateSummary();
  });

  // Restore + persist pre-end trigger settings
  preEndMinutes.value = loadPreEndMinutes();
  preEndSnippet.value = loadPreEndSnippet();
  preEndMinutes.addEventListener('input', () => savePreEndMinutes(preEndMinutes.value));
  preEndSnippet.addEventListener('input', () => savePreEndSnippet(preEndSnippet.value));

  // Restore + persist filament-per-loop list
  filamentSlots.value = loadFilamentSlots();
  filamentSlots.addEventListener('input', () => saveFilamentSlots(filamentSlots.value));

  loopCount.value = loadLoopCount();
  loopCount.addEventListener('input', () => {
    saveLoopCount(loopCount.value);
    updateSummary();
  });

  exportBtn.addEventListener('click', doExport);

  // Toast × button: cancels an in-flight export, or just dismisses a finished one
  const exportToastCancel = document.getElementById('exportToastCancel');
  const exportToast = document.getElementById('exportToast');
  exportToastCancel.addEventListener('click', () => {
    if (currentExportCancel) {
      currentExportCancel();
      currentExportCancel = null;
    } else {
      exportToast.classList.remove('show');
    }
  });

  async function handleFiles(fileList) {
    const files = [...fileList].filter(f => f.name.toLowerCase().endsWith('.3mf'));
    if (files.length === 0) return;

    showLoader(`Analyzing ${files.length} file(s)...`);
    for (const file of files) {
      try {
        const job = await readJobFromFile(file);
        queue.push(job);
      } catch (err) {
        console.error(`Failed to read ${file.name}:`, err);
        alert(`Failed to read ${file.name}: ${err.message}`);
      }
    }
    hideLoader();
    renderQueue();
    updateSummary();
  }

  async function readJobFromFile(file) {
    const buffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const filenames = Object.keys(zip.files);

    // Find the gcode file (typically Metadata/plate_1.gcode)
    const gcodePath = filenames.find(f =>
      f.toLowerCase().endsWith('.gcode') && !f.toLowerCase().endsWith('.md5')
    );
    if (!gcodePath) {
      throw new Error('No .gcode file inside archive');
    }

    const gcodeContent = await zip.files[gcodePath].async('text');
    const stats = parseGcode(gcodeContent, { skipMovementParsing: true });

    // Extract the plate index from the gcode path (e.g. "Metadata/plate_2.gcode" → 2).
    const plateMatch = gcodePath.match(/plate_(\d+)\.gcode$/i);
    const plateIdx = plateMatch ? plateMatch[1] : null;

    // Find best thumbnail for THIS plate — prefer top_<N>.png, then plate_<N>.png.
    // Fall back to any non-small/non-pick PNG if no plate-specific image is present.
    let thumbnailDataUrl = null;
    const allPngs = filenames.filter(f => {
      const l = f.toLowerCase();
      return l.endsWith('.png') && !l.includes('_small') && !l.includes('pick_');
    });

    const scoreImage = (filepath) => {
      const name = filepath.toLowerCase().split('/').pop() || '';
      if (plateIdx) {
        if (name === `plate_${plateIdx}.png`) return 0;
        if (name === `top_${plateIdx}.png`) return 1;     // best
        // Other plate-numbered files (different plate) → push to bottom
        if (/^(top|plate)_\d+\.png$/.test(name)) return 100;
      }
      if (name.startsWith('plate_')) return 10;
      if (name.startsWith('top_')) return 11;
      return 20;
    };
    const imageFiles = allPngs
      .map(f => ({ path: f, score: scoreImage(f) }))
      .sort((a, b) => a.score - b.score);

    console.log(`[Queue:${file.name}] gcode=${gcodePath}  plateIdx=${plateIdx}`);
    console.log(`  PNG candidates (${allPngs.length}):`, allPngs);
    console.log(`  Ranked (best first):`, imageFiles.map(x => `${x.path} [score=${x.score}]`));

    if (imageFiles.length > 0) {
      const picked = imageFiles[0].path;
      console.log(`  → picked thumbnail: ${picked}`);
      const b64 = await zip.files[picked].async('base64');
      thumbnailDataUrl = `data:image/png;base64,${b64}`;
    } else if (stats.thumbnails && stats.thumbnails.length > 0) {
      console.log(`  → no archive PNG, falling back to embedded gcode thumbnail`);
      const thumb = stats.thumbnails[stats.thumbnails.length - 1];
      thumbnailDataUrl = `data:image/png;base64,${thumb.data}`;
    } else {
      console.warn(`  → no thumbnail available at all`);
    }

    // Try slice_info.config for prediction & weight (more reliable than gcode header)
    let timeSeconds = stats.estimatedTimeSeconds || null;
    let weightG = parseFloat(stats.totalFilamentUsedG) || null;
    const sliceInfoPath = filenames.find(f => f.toLowerCase().includes('slice_info.config'));
    if (sliceInfoPath) {
      try {
        const xml = await zip.files[sliceInfoPath].async('text');
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const metas = doc.getElementsByTagName('metadata');
        for (let i = 0; i < metas.length; i++) {
          const key = metas[i].getAttribute('key');
          const val = metas[i].getAttribute('value');
          if (key === 'prediction' && !timeSeconds) timeSeconds = parseInt(val);
          if (key === 'weight' && !weightG) weightG = parseFloat(val);
        }
      } catch (_) {}
    }

    // Capture compressed + uncompressed gcode size so the summary can estimate
    // the final .gcode.3mf size with the actual observed compression ratio.
    const gcodeEntry = zip.files[gcodePath];
    const gcodeUncompressedBytes = gcodeEntry && gcodeEntry._data && gcodeEntry._data.uncompressedSize
      ? gcodeEntry._data.uncompressedSize
      : new Blob([gcodeContent]).size;
    const gcodeCompressedBytes = gcodeEntry && gcodeEntry._data && gcodeEntry._data.compressedSize
      ? gcodeEntry._data.compressedSize
      : null;

    return {
      id: cryptoRandomId(),
      name: file.name,
      sizeBytes: file.size,
      buffer,
      gcodeContent,
      gcodePath,
      gcodeUncompressedBytes,
      gcodeCompressedBytes,
      thumbnailDataUrl,
      timeSeconds,
      weightG,
      stats,
    };
  }

  // ── Queue rendering ──────────────────────────────────────────────────────
  function renderQueue() {
    queueCount.textContent = queue.length;
    const hasJobs = queue.length > 0;
    queueCard.style.display = hasJobs ? '' : 'none';
    endGcodeCard.style.display = hasJobs ? '' : 'none';
    preEndCard.style.display = hasJobs ? '' : 'none';
    filamentCard.style.display = hasJobs ? '' : 'none';
    loopCard.style.display = hasJobs ? '' : 'none';
    exportCard.style.display = hasJobs ? '' : 'none';

    queueList.innerHTML = '';
    queue.forEach((job, idx) => {
      const item = document.createElement('div');
      item.className = 'queue-item';
      item.draggable = true;
      item.dataset.id = job.id;

      const thumb = job.thumbnailDataUrl
        ? `<img src="${job.thumbnailDataUrl}" alt="">`
        : `<div class="queue-thumb-placeholder">—</div>`;

      const timeStr = job.timeSeconds ? formatSeconds(job.timeSeconds) : '—';
      const weightStr = job.weightG != null ? `${job.weightG.toFixed(1).replace('.', ',')} g` : '—';

      item.innerHTML = `
        <div class="queue-handle" title="Drag to reorder">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/>
            <circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>
          </svg>
        </div>
        <div class="queue-index">${idx + 1}</div>
        <div class="queue-thumb">${thumb}</div>
        <div class="queue-meta">
          <div class="queue-name" title="${escapeHtml(job.name)}">${escapeHtml(job.name)}</div>
          <div class="queue-stats">
            <span title="Estimated print time">⏱ ${timeStr}</span>
            <span title="Filament weight">⏚ ${weightStr}</span>
          </div>
        </div>
        <button type="button" class="queue-remove" data-id="${job.id}" title="Remove">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;

      // Drag events
      item.addEventListener('dragstart', e => {
        dragSrcId = job.id;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Required for FF
        e.dataTransfer.setData('text/plain', job.id);
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        queueList.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
        dragSrcId = null;
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragSrcId && dragSrcId !== job.id) {
          item.classList.add('drag-over');
        }
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', e => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (!dragSrcId || dragSrcId === job.id) return;
        moveJob(dragSrcId, job.id);
      });

      queueList.appendChild(item);
    });

    queueList.querySelectorAll('.queue-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const i = queue.findIndex(j => j.id === id);
        if (i >= 0) queue.splice(i, 1);
        renderQueue();
        updateSummary();
      });
    });
  }

  function moveJob(srcId, targetId) {
    const srcIdx = queue.findIndex(j => j.id === srcId);
    const tgtIdx = queue.findIndex(j => j.id === targetId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const [src] = queue.splice(srcIdx, 1);
    // Insert at target's new position (target may have shifted after splice)
    const newTgt = queue.findIndex(j => j.id === targetId);
    queue.splice(newTgt + (srcIdx < tgtIdx ? 1 : 0), 0, src);
    renderQueue();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  function updateSummary() {
    const loops = Math.max(1, parseInt(loopCount.value) || 1);
    const perLoopCount = queue.length;
    const totalPrintsN = perLoopCount * loops;

    let perLoopTime = 0;
    let perLoopWeight = 0;
    let hasMissingTime = false;
    let hasMissingWeight = false;
    queue.forEach(j => {
      if (j.timeSeconds != null) perLoopTime += j.timeSeconds;
      else hasMissingTime = true;
      if (j.weightG != null) perLoopWeight += j.weightG;
      else hasMissingWeight = true;
    });

    const cooldown = Math.max(0, parseInt(cooldownInput.value) || 0);
    const cooldownTotal = cooldown * loops;

    totalPrints.textContent = totalPrintsN > 0 ? totalPrintsN : '—';
    if (perLoopTime > 0) {
      const total = perLoopTime * loops + cooldownTotal;
      const suffix = (hasMissingTime ? ' (partial)' : '')
        + (cooldownTotal > 0 ? ` · incl. ${formatSeconds(cooldownTotal)} cooldown` : '');
      totalTime.textContent = formatSeconds(total) + suffix;
    } else {
      totalTime.textContent = '—';
    }
    if (perLoopWeight > 0) {
      const total = perLoopWeight * loops;
      totalFilament.textContent = `${total.toFixed(1).replace('.', ',')} g` + (hasMissingWeight ? ' (partial)' : '');
    } else {
      totalFilament.textContent = '—';
    }

    const estimated = estimateOutputSize(loops);
    totalSize.textContent = estimated > 0 ? formatBytes(estimated) : '—';
  }

  // Estimate the final .gcode.3mf compressed size in bytes (for the summary
  // AND for ETA computation during export). Returns 0 when nothing in queue.
  function estimateOutputSize(loops) {
    if (queue.length === 0) return 0;
    let uncTotal = 0;
    let cmpTotal = 0;
    let uncSum = 0;
    queue.forEach(j => {
      uncSum += j.gcodeUncompressedBytes || 0;
      if (j.gcodeUncompressedBytes && j.gcodeCompressedBytes) {
        uncTotal += j.gcodeUncompressedBytes;
        cmpTotal += j.gcodeCompressedBytes;
      }
    });
    if (uncSum === 0) return 0;
    const ratio = uncTotal > 0 ? cmpTotal / uncTotal : 0.3;
    const endGcodeBytes = endGcodeEditor
      ? new Blob([endGcodeEditor.getValue() || '']).size
      : 0;
    const perLoopUnc = uncSum + endGcodeBytes * queue.length;
    const totalUnc = perLoopUnc * loops;
    const baseJob = queue[0];
    const overhead = baseJob && baseJob.gcodeCompressedBytes
      ? Math.max(0, baseJob.sizeBytes - baseJob.gcodeCompressedBytes)
      : 50 * 1024;
    return Math.round(totalUnc * ratio + overhead);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} GB`;
  }

  // ── Export ───────────────────────────────────────────────────────────────
  async function doExport() {
    if (queue.length === 0) return;
    const loops = Math.max(1, parseInt(loopCount.value) || 1);
    const cooldown = Math.max(0, parseInt(cooldownInput.value) || 0);
    const endGcode = endGcodeEditor.getValue() || '';
    const preEndMin = Math.max(0, parseFloat(preEndMinutes.value) || 0);
    const preEndCode = (preEndSnippet.value || '').trim();
    // Parse "0, 1, 2, 3" → [0,1,2,3]. Invalid entries are dropped silently;
    // an empty list disables the feature.
    const filamentSlotsList = (filamentSlots.value || '')
      .split(/[,\s]+/)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n) && n >= 0);

    // The end-of-print ejection gcode is mandatory: without it the farm loop
    // would chain prints with no part removal between them.
    if (endGcode.trim() === '') {
      endGcodeEditor.focus();
      finishExportToast('error', 'Export blocked', 'End-of-Print G-code is required.');
      return;
    }

    const baseName = (outputName.value || 'print-queue').replace(/\.gcode\.3mf$|\.3mf$/i, '');
    const filename = `${baseName}.gcode.3mf`;

    // Ask for save location BEFORE building, so the user gesture is preserved
    // (showSaveFilePicker requires a user-activation context).
    let fileHandle = null;
    if (window.showSaveFilePicker) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'Bambu G-code archive',
            accept: { 'application/zip': ['.gcode.3mf', '.3mf'] },
          }],
        });
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user cancelled
        console.warn('Save picker failed, falling back to download:', err);
      }
    }

    showExportToast('Spawning export worker...', 0);
    try {
      await runExportInWorker({ filename, fileHandle, loops, cooldown, endGcode, preEndMin, preEndCode, filamentSlotsList });
      finishExportToast('success', 'Export complete', filename);
    } catch (err) {
      console.error(err);
      finishExportToast('error', 'Export failed', err.message);
    }
  }

  // Spin up the export worker, stream chunks back, write them to disk (or
  // accumulate in a Blob for fallback download), and display a live ETA.
  function runExportInWorker({ filename, fileHandle, loops, cooldown, endGcode, preEndMin, preEndCode, filamentSlotsList }) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('js/printQueueWorker.js');
      let writable = null;
      const blobChunks = [];
      let writePromise = Promise.resolve();
      let cancelled = false;

      // ETA tracking — based on bytes/sec rate, not JSZip's non-linear percent.
      // The percent from JSZip jumps through tiny metadata files then crawls
      // through the giant gcode → ETA via percent underestimates massively.
      let writeStart = 0;
      let bytesWritten = 0;
      const estimatedTotalSize = estimateOutputSize(loops);

      const cleanup = () => worker.terminate();

      // Cancel handler registered globally so the toast × button can trigger it.
      currentExportCancel = () => {
        cancelled = true;
        cleanup();
        if (writable) writable.abort().catch(() => {});
        reject(new Error('Cancelled by user'));
      };

      worker.onmessage = (ev) => {
        if (cancelled) return;
        const msg = ev.data;
        if (msg.type === 'progress') {
          updateExportToast(msg.message, 0);
          return;
        }
        if (msg.type === 'chunk') {
          if (writeStart === 0) writeStart = performance.now();
          bytesWritten += msg.chunk.byteLength;

          // Write/buffer the chunk, then ack the worker so it pumps the next.
          writePromise = writePromise.then(async () => {
            if (cancelled) return;
            if (writable) await writable.write(msg.chunk);
            else blobChunks.push(msg.chunk);

            const percent = msg.percent || 0;
            const elapsedMs = performance.now() - writeStart;

            // Bytes-based ETA: more accurate than JSZip's non-linear percent.
            // After ~500 ms we have a meaningful write rate; before that show no ETA.
            let etaText = '';
            let displayPercent = percent;
            if (elapsedMs > 500 && bytesWritten > 0 && estimatedTotalSize > 0) {
              const bytesPerSec = bytesWritten / (elapsedMs / 1000);
              const remainingBytes = Math.max(0, estimatedTotalSize - bytesWritten);
              const etaSec = Math.round(remainingBytes / bytesPerSec);
              etaText = ` · ${formatSeconds(etaSec)} left`;
              // Override JSZip's percent with a byte-based one — far more linear.
              displayPercent = Math.min(99, Math.round(bytesWritten / estimatedTotalSize * 100));
            }
            const phase = writable ? 'Writing' : 'Packing';
            const sizeText = ` · ${formatBytes(bytesWritten)}`;
            updateExportToast(`${phase}... ${displayPercent}%${sizeText}${etaText}`, displayPercent);

            worker.postMessage({ type: 'ack' });
          }).catch(err => {
            cleanup();
            if (writable) writable.abort().catch(() => {});
            reject(err);
          });
          return;
        }
        if (msg.type === 'done') {
          writePromise.then(async () => {
            if (cancelled) return;
            if (writable) {
              updateExportToast('Closing file...', 100);
              await writable.close();
            } else {
              const blob = new Blob(blobChunks, { type: 'application/zip' });
              downloadBlob(blob, filename);
            }
            cleanup();
            resolve();
          }, err => {
            cleanup();
            reject(err);
          });
          return;
        }
        if (msg.type === 'error') {
          cleanup();
          if (writable) writable.abort().catch(() => {});
          reject(new Error(msg.message));
          return;
        }
      };

      worker.onerror = (err) => {
        cleanup();
        reject(new Error(err.message || 'Worker crashed'));
      };

      // Open the writable BEFORE posting the build message so the user
      // gesture from showSaveFilePicker is still active.
      const setupWritable = fileHandle
        ? fileHandle.createWritable().then(w => { writable = w; })
        : Promise.resolve();

      setupWritable.then(() => {
        // Send everything the worker needs. We don't transfer baseBuffer so the
        // original ArrayBuffer remains usable on main (user might re-export).
        worker.postMessage({
          type: 'build',
          baseBuffer: queue[0].buffer,
          jobs: queue.map(j => ({
            name: j.name,
            gcodeContent: j.gcodeContent,
            timeSeconds: j.timeSeconds,
            weightG: j.weightG,
          })),
          loops,
          cooldown,
          endGcode,
          preEndMin,
          preEndCode,
          filamentSlotsList,
        });
      }, reject);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// ── Utility functions ──────────────────────────────────────────────────────
function cryptoRandomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function loadEndGcode() {
  try {
    const stored = localStorage.getItem(END_GCODE_STORAGE_KEY);
    if (stored !== null) return stored;
  } catch (_) {}
  return DEFAULT_END_GCODE;
}

function saveEndGcode(value) {
  try {
    localStorage.setItem(END_GCODE_STORAGE_KEY, value);
  } catch (_) {}
}

function loadCooldown() {
  try {
    const stored = localStorage.getItem(COOLDOWN_STORAGE_KEY);
    if (stored !== null) {
      const n = parseInt(stored);
      if (!isNaN(n) && n >= 0) return n;
    }
  } catch (_) {}
  return 60; // default 60s
}

function saveCooldown(value) {
  try {
    localStorage.setItem(COOLDOWN_STORAGE_KEY, String(parseInt(value) || 0));
  } catch (_) {}
}

function loadLoopCount() {
  try {
    const stored = localStorage.getItem(LOOP_COUNT_STORAGE_KEY);
    if (stored !== null) {
      const n = parseInt(stored);
      if (!isNaN(n) && n >= 1) return n;
    }
  } catch (_) {}
  return 1;
}

function saveLoopCount(value) {
  try {
    localStorage.setItem(LOOP_COUNT_STORAGE_KEY, String(Math.max(1, parseInt(value) || 1)));
  } catch (_) {}
}

function loadFilamentSlots() {
  try {
    const stored = localStorage.getItem(FILAMENT_SLOTS_STORAGE_KEY);
    if (stored !== null) return stored;
  } catch (_) {}
  return '';
}

function saveFilamentSlots(value) {
  try {
    localStorage.setItem(FILAMENT_SLOTS_STORAGE_KEY, value || '');
  } catch (_) {}
}

function loadPreEndMinutes() {
  try {
    const stored = localStorage.getItem(PREEND_MINUTES_STORAGE_KEY);
    if (stored !== null) {
      const n = parseFloat(stored);
      if (!isNaN(n) && n >= 0) return n;
    }
  } catch (_) {}
  return 1;
}

function savePreEndMinutes(value) {
  try {
    localStorage.setItem(PREEND_MINUTES_STORAGE_KEY, String(parseFloat(value) || 0));
  } catch (_) {}
}

function loadPreEndSnippet() {
  try {
    const stored = localStorage.getItem(PREEND_SNIPPET_STORAGE_KEY);
    if (stored !== null) return stored;
  } catch (_) {}
  return '';
}

function savePreEndSnippet(value) {
  try {
    localStorage.setItem(PREEND_SNIPPET_STORAGE_KEY, value || '');
  } catch (_) {}
}
