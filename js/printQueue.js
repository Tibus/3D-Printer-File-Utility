// ============================================================================
// Print Queue — concatenate multiple .gcode.3mf jobs into a single farm loop
// ============================================================================

const END_GCODE_STORAGE_KEY = 'printQueue.endGcode';
const COOLDOWN_STORAGE_KEY = 'printQueue.cooldownBetweenLoops';

// Bambu cali block: replace per-job so the farm loop doesn't recalibrate
// every print. The original section sits between `;===== extrude cali test ==`
// and the next major section header.
// Anchored at line start so we don't match the same text inside the
// `; machine_start_gcode = ...\n;===== extrude cali test ==\n...` template
// comment (which contains escaped \n, not real line breaks).
const EXTRUDE_CALI_MARKER = /^;===== extrude cali test =+/gm;
const EXTRUDE_CALI_REPLACEMENT = `

M400
G1 X-48.2 F3000
M400
G0 E50 F100

G1 Z0.2

;M400
;M73 P1.717

G90
M83
G0 E50 F100
M400
`;

// Bambu machine_end_gcode starts right after the line below (which restores
// the Z motor current). Stripping from this point removes the per-print
// cooldown/park/finish-sound so the farm loop chains directly into ejection.
const PRINT_END_TRIGGER = /^M17 R[^\n]*\n/m;

const DEFAULT_END_GCODE = `; ==== END-OF-PRINT — part ejection ====
M400                          ; wait for moves to finish
M104 S0                       ; nozzle off
M140 S0                       ; bed off
M106 P1 S0                    ; part fan off
M106 P2 S0                    ; aux fan off
G90                           ; absolute positioning
G1 Z250 F1200                 ; raise Z to clear part
G1 X0 Y0 F6000                ; park
; --- pneumatic ejection ---
M42 P0 S255                   ; trigger cylinder OUT
G4 S2                         ; hold 2s
M42 P0 S0                     ; cylinder IN
G4 S1
; --- ready for next print ---
`;

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

  loopCount.addEventListener('input', updateSummary);

  exportBtn.addEventListener('click', doExport);

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

    // ── Output file size estimate ────────────────────────────────────────
    // Sum uncompressed gcode bytes; pick a compression ratio observed in
    // the source archives (gcode usually compresses to ~25-35% with DEFLATE).
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
    if (uncSum > 0) {
      const ratio = uncTotal > 0 ? cmpTotal / uncTotal : 0.3;
      const endGcodeBytes = endGcodeEditor
        ? new Blob([endGcodeEditor.getValue() || '']).size
        : 0;
      // Per-loop uncompressed text = sum of jobs + ejection per print.
      // Total = per-loop × loops + overhead from base archive (thumbnails, xml, etc.)
      const perLoopUnc = uncSum + endGcodeBytes * perLoopCount;
      const totalUnc = perLoopUnc * loops;
      const baseJob = queue[0];
      const overhead = baseJob && baseJob.gcodeCompressedBytes
        ? Math.max(0, baseJob.sizeBytes - baseJob.gcodeCompressedBytes)
        : 50 * 1024;
      const estimated = Math.round(totalUnc * ratio + overhead);
      totalSize.textContent = formatBytes(estimated);
    } else {
      totalSize.textContent = '—';
    }
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

    showLoader('Building concatenated G-code...');
    try {
      const zip = await buildOutput3mf(queue, loops, endGcode, cooldown);
      if (fileHandle) {
        await streamZipToWritable(zip, fileHandle, msg => showLoader(msg));
      } else {
        showLoader('Compressing archive...');
        const blob = await zip.generateAsync(
          { type: 'blob', compression: 'DEFLATE', streamFiles: true },
          metadata => showLoader(`Compressing... ${Math.round(metadata.percent)}%`)
        );
        downloadBlob(blob, filename);
      }
    } catch (err) {
      console.error(err);
      alert('Export failed: ' + err.message);
    }
    hideLoader();
  }

  // Stream a JSZip instance directly to a File System Access writable handle
  // so we never hold the entire .gcode.3mf in memory. Uses backpressure: pause
  // the zip stream while the disk write is in flight.
  function streamZipToWritable(zip, fileHandle, onProgress) {
    return new Promise((resolve, reject) => {
      fileHandle.createWritable().then(writable => {
        const stream = zip.generateInternalStream({
          type: 'uint8array',
          compression: 'DEFLATE',
          streamFiles: true,
        });
        stream
          .on('data', (chunk, metadata) => {
            stream.pause();
            writable.write(chunk).then(() => {
              if (onProgress && metadata && typeof metadata.percent === 'number') {
                onProgress(`Writing... ${Math.round(metadata.percent)}%`);
              }
              stream.resume();
            }).catch(err => {
              stream.pause();
              writable.abort().finally(() => reject(err));
            });
          })
          .on('error', err => {
            writable.abort().finally(() => reject(err));
          })
          .on('end', () => {
            writable.close().then(resolve, reject);
          })
          .resume();
      }, reject);
    });
  }

  // Build a concatenated .gcode.3mf using the first job as the template.
  // Output ordering: for each loop, run all jobs in queue order, inserting the
  // end-of-print gcode after every print (including after the last one of the
  // session, to leave the part ejected and the machine in a safe state).
  async function buildOutput3mf(jobs, loops, endGcode, cooldownSeconds) {
    const baseJob = jobs[0];
    const baseZip = await JSZip.loadAsync(baseJob.buffer);
    const filenames = Object.keys(baseZip.files);

    // Find the gcode entry to overwrite in the template
    const targetGcodePath = filenames.find(f =>
      f.toLowerCase().endsWith('.gcode') && !f.toLowerCase().endsWith('.md5')
    ) || 'Metadata/plate_1.gcode';

    // ── Concatenate gcodes ──────────────────────────────────────────────
    const ejection = endGcode.endsWith('\n') ? endGcode : endGcode + '\n';
    const ejectionMarker = '\n; ==== farm-loop ejection ====\n';

    const chunks = [];

    // Header summary comment (visible in Bambu / file inspector)
    let totalTime = 0;
    let totalWeight = 0;
    let timeKnown = true;
    let weightKnown = true;
    for (const j of jobs) {
      if (j.timeSeconds != null) totalTime += j.timeSeconds; else timeKnown = false;
      if (j.weightG != null) totalWeight += j.weightG; else weightKnown = false;
    }
    totalTime *= loops;
    totalWeight *= loops;
    const cooldownTotal = (cooldownSeconds || 0) * loops;
    if (timeKnown) totalTime += cooldownTotal;

    chunks.push(`; Generated by Print Queue — farm-loop concatenation\n`);
    chunks.push(`; jobs: ${jobs.length}, loops: ${loops}, total prints: ${jobs.length * loops}\n`);
    if (cooldownSeconds > 0) {
      chunks.push(`; cooldown after each loop: ${cooldownSeconds}s (×${loops} = ${cooldownTotal}s)\n`);
    }
    if (timeKnown) chunks.push(`; total estimated time: ${formatSeconds(totalTime)} (${totalTime}s)\n`);
    if (weightKnown) chunks.push(`; total filament weight [g]: ${totalWeight.toFixed(2)}\n`);
    chunks.push(`;\n`);

    const lastLoopIdx = loops - 1;
    const lastJobIdx = jobs.length - 1;

    for (let loop = 0; loop < loops; loop++) {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const isVeryLast = loop === lastLoopIdx && i === lastJobIdx;

        let content = replaceExtrudeCaliSection(job.gcodeContent, EXTRUDE_CALI_REPLACEMENT);
        if (!isVeryLast) content = stripPrintEnd(content);

        chunks.push(`\n; ==== loop ${loop + 1}/${loops} — print ${i + 1}/${jobs.length}: ${job.name} ====\n`);
        chunks.push(content);
        if (!content.endsWith('\n')) chunks.push('\n');
        chunks.push(ejectionMarker);
        chunks.push(ejection);
      }
    }

    // Build the gcode as a Blob (virtual concat) rather than a single string,
    // because String.prototype joining hits V8's ~512 MB length limit on big
    // farm loops. Blobs have no such cap and JSZip can stream them.
    const concatenated = new Blob(chunks, { type: 'text/plain;charset=utf-8' });

    // Replace the gcode entry in the zip
    baseZip.file(targetGcodePath, concatenated);

    // Also overwrite its .md5 sibling if present (avoid checksum mismatch).
    // We delete it; the slicer/printer should accept the file without it.
    const md5Path = targetGcodePath + '.md5';
    if (baseZip.files[md5Path]) {
      baseZip.remove(md5Path);
    }

    // ── Update slice_info.config (prediction + weight) ──────────────────
    const sliceInfoPath = filenames.find(f => f.toLowerCase().includes('slice_info.config'));
    if (sliceInfoPath) {
      try {
        let xml = await baseZip.files[sliceInfoPath].async('text');
        if (timeKnown) {
          xml = replaceMetadataValue(xml, 'prediction', String(Math.round(totalTime)));
        }
        if (weightKnown) {
          xml = replaceMetadataValue(xml, 'weight', totalWeight.toFixed(2));
        }
        baseZip.file(sliceInfoPath, xml);
      } catch (e) {
        console.warn('Could not update slice_info.config:', e);
      }
    }

    // Caller decides how to serialize: streaming write to disk, or blob.
    return baseZip;
  }

  // Helpers
  function replaceMetadataValue(xml, key, newValue) {
    // Match <metadata key="KEY" value="..." /> with single OR double quotes
    const re = new RegExp(
      `(<metadata\\s+key=(["'])${escapeRegex(key)}\\2\\s+value=)(["'])[^"']*(\\3\\s*/?>)`,
      'i'
    );
    if (re.test(xml)) {
      return xml.replace(re, `$1$3${escapeXml(newValue)}$4`);
    }
    return xml;
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

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace the Bambu "extrude cali test" section content with the farm-loop
// replacement. Two strategies, in order:
//   • If the marker appears twice (some firmwares use start+end markers),
//     replace strictly between them.
//   • Otherwise, replace from the single marker up to the next major section
//     header (a line starting with ;====+).
function replaceExtrudeCaliSection(gcode, replacement) {
  const matches = [];
  let m;
  EXTRUDE_CALI_MARKER.lastIndex = 0;
  while ((m = EXTRUDE_CALI_MARKER.exec(gcode)) !== null) {
    matches.push({ index: m.index, end: m.index + m[0].length });
  }

  const body = replacement.trim();

  if (matches.length >= 2) {
    const a = matches[0];
    const b = matches[1];
    return gcode.slice(0, a.end) + '\n' + body + '\n' + gcode.slice(b.index);
  }
  if (matches.length === 1) {
    const a = matches[0];
    const after = gcode.slice(a.end);
    const nextSection = after.match(/\n;====+/);
    if (nextSection) {
      const endIdx = a.end + nextSection.index + 1;
      return gcode.slice(0, a.end) + '\n' + body + '\n' + gcode.slice(endIdx);
    }
  }
  return gcode;
}

// Strip the per-print end-of-print (cooldown, park, finish sound, motor off).
// The Bambu machine_end_gcode starts immediately after `M17 R ; restore z current`.
function stripPrintEnd(gcode) {
  const m = gcode.match(PRINT_END_TRIGGER);
  if (!m) return gcode;
  const cutoff = m.index + m[0].length;
  return gcode.slice(0, cutoff);
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
