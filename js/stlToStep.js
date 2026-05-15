// ============================================================================
// STL to STEP Converter (uses opencascade.js WASM)
// ============================================================================

// jsDelivr rejects files > 50 MB; unpkg serves the 65 MB WASM without issue.
const OCJS_VERSION = '1.1.1';
const OCJS_BASE = `https://unpkg.com/opencascade.js@${OCJS_VERSION}/dist`;
const OCJS_LOADER_URL = `${OCJS_BASE}/opencascade.wasm.js`;
const OCJS_WASM_URL = `${OCJS_BASE}/opencascade.wasm.wasm`;

let ocInstance = null;
let ocLoadingPromise = null;

function initStlToStep() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileNameEl = document.getElementById('fileName');
  const fileStatsEl = document.getElementById('fileStats');
  const optionsCard = document.getElementById('optionsCard');
  const processCard = document.getElementById('processCard');
  const processBtn = document.getElementById('processBtn');
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const logCard = document.getElementById('logCard');
  const logContainer = document.getElementById('conversionLog');
  const resultCard = document.getElementById('resultCard');
  const resultSummary = document.getElementById('resultSummary');
  const downloadBtn = document.getElementById('downloadBtn');
  const unifyFacesInput = document.getElementById('unifyFaces');
  const makeSolidInput = document.getElementById('makeSolid');

  let stlBuffer = null;
  let stlFileName = '';
  let stlTriCount = 0;
  let stepBytes = null;

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) loadStl(file);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) loadStl(e.target.files[0]);
  });

  processBtn.addEventListener('click', () => convert());
  downloadBtn.addEventListener('click', () => downloadStep());

  function log(msg, type) {
    const div = document.createElement('div');
    div.className = 'repair-log-line' + (type ? ' repair-log-' + type : '');
    div.textContent = msg;
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function setProgress(pct, text) {
    progressContainer.classList.add('show');
    progressFill.style.width = `${pct}%`;
    progressText.textContent = text;
  }

  function hideProgress() {
    progressContainer.classList.remove('show');
  }

  async function loadStl(file) {
    stlFileName = file.name;
    fileNameEl.textContent = file.name;
    fileStatsEl.textContent = `${(file.size / 1024 / 1024).toFixed(2).replace('.', ',')} MB`;
    fileInfo.classList.add('show');
    logContainer.innerHTML = '';
    logCard.style.display = '';
    resultCard.style.display = 'none';
    stepBytes = null;

    try {
      const buffer = await file.arrayBuffer();
      stlBuffer = new Uint8Array(buffer);
      stlTriCount = countTriangles(buffer);
      log(`Loaded STL: ${stlTriCount.toLocaleString('fr-FR')} triangles`, 'ok');

      if (stlTriCount > 200000) {
        log(`Warning: ${stlTriCount.toLocaleString('fr-FR')} triangles is a lot — conversion may take several minutes and memory usage will be high. Consider decimating first.`, 'warn');
      } else if (stlTriCount > 50000) {
        log(`Note: large mesh (${stlTriCount.toLocaleString('fr-FR')} triangles), conversion may take a while.`, 'warn');
      }

      optionsCard.style.display = '';
      processCard.style.display = '';
    } catch (err) {
      log('Failed to read STL: ' + err.message, 'error');
    }
  }

  async function convert() {
    if (!stlBuffer) return;
    processBtn.disabled = true;
    resultCard.style.display = 'none';
    stepBytes = null;

    try {
      // Step 1: load OpenCascade if not already
      if (!ocInstance) {
        log('Loading OpenCascade WASM (~65 MB, cached on subsequent loads)...');
        await loadOpenCascade((received, total) => {
          const pct = total ? (received / total) * 100 : 0;
          const r = (received / 1024 / 1024).toFixed(1).replace('.', ',');
          const t = total ? (total / 1024 / 1024).toFixed(1).replace('.', ',') : '?';
          setProgress(pct, `Downloading OpenCascade: ${r} / ${t} MB`);
        });
        log('OpenCascade ready', 'ok');
      }

      const oc = ocInstance;
      const wantUnify = unifyFacesInput.checked;
      const wantSolid = makeSolidInput.checked;

      // Step 2: write STL to virtual FS, read with StlAPI_Reader
      setProgress(0, 'Reading STL into OpenCascade...');
      log('Reading STL into OpenCascade...');
      await yieldToUI();

      let shape = await readStlIntoShape(oc, stlBuffer, log, setProgress);
      if (!shape) {
        throw new Error('Could not parse the STL file');
      }

      // Step 3: optionally merge coplanar faces
      if (wantUnify) {
        setProgress(40, 'Merging coplanar faces...');
        log('Merging coplanar faces (ShapeUpgrade_UnifySameDomain)...');
        await yieldToUI();
        try {
          const unifier = new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false);
          unifier.Build();
          shape = unifier.Shape();
          log('Faces merged', 'ok');
        } catch (e) {
          log(`Face merging failed: ${e.message || e} — keeping original triangulated faces`, 'warn');
        }
      }

      // Step 4: optionally try to make solid
      if (wantSolid) {
        setProgress(60, 'Building solid...');
        log('Trying to make solid from shell...');
        await yieldToUI();
        try {
          const solid = tryMakeSolid(oc, shape);
          if (solid) {
            shape = solid;
            log('Solid built', 'ok');
          } else {
            log('No closed shell found — exporting as shell instead', 'warn');
          }
        } catch (e) {
          log(`Solid creation failed: ${e.message || e} — exporting as shell`, 'warn');
        }
      }

      // Step 5: write STEP
      setProgress(80, 'Writing STEP file...');
      log('Writing STEP (AP214)...');
      await yieldToUI();

      const writer = new oc.STEPControl_Writer_1();
      // Set AP214 schema before transferring (replicad pattern: commit by
      // touching the model and disposing the handle).
      oc.Interface_Static.SetIVal('write.step.schema', 5);
      try {
        const m = writer.Model(true);
        if (m && typeof m.delete === 'function') m.delete();
      } catch (_) {}

      const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
      const progress = makeProgress(oc);

      const status = callTransferRobust(writer, shape, mode, progress, log);
      const RetDone = oc.IFSelect_ReturnStatus.IFSelect_RetDone;
      if (status !== RetDone) {
        throw new Error(`STEP transfer failed (status code ${status})`);
      }
      log(`Transfer status: ${status} (RetDone)`, 'ok');

      // Use a short ASCII-only filename to avoid any string marshaling oddities
      const tmpStep = 'out.step';
      const writeStatus = writer.Write(tmpStep);
      log(`Write status: ${describeStatus(oc, writeStatus)}`);

      // Inspect the FS to find where the file landed (some builds drop the
      // file with a different name due to string-marshaling quirks).
      let foundPath = null;
      let foundSize = 0;
      const candidatePaths = ['/' + tmpStep, '/tmp/' + tmpStep, tmpStep];
      for (const p of candidatePaths) {
        try {
          const st = oc.FS.stat(p);
          if (st && st.size > 0) {
            foundPath = p;
            foundSize = st.size;
            break;
          }
        } catch (_) {}
      }
      const standardEntries = new Set(['.', '..', 'tmp', 'home', 'dev', 'proc']);
      if (!foundPath) {
        try {
          const entries = oc.FS.readdir('/');
          log(`Root FS entries: ${entries.map(e => JSON.stringify(e)).join(', ')}`, 'warn');
          // First pass: filename ending in .step / .stp
          // Second pass: any non-standard entry that has a positive size
          for (const e of entries) {
            if (typeof e !== 'string') continue;
            if (standardEntries.has(e)) continue;
            const p = '/' + e;
            try {
              const st = oc.FS.stat(p);
              if (!st || st.size === 0) continue;
              const isStep = /\.ste?p$/i.test(e);
              if (isStep || !foundPath) {
                foundPath = p;
                foundSize = st.size;
                log(`Found candidate file ${JSON.stringify(p)} (${foundSize} bytes)`, 'warn');
                if (isStep) break;
              }
            } catch (_) {}
          }
        } catch (e) {
          log(`Could not list root FS: ${e.message || e}`, 'error');
        }
      }

      if (!foundPath) {
        throw new Error('STEP file was not produced on the virtual FS');
      }

      log(`STEP file on virtual FS: ${foundSize.toLocaleString('fr-FR')} bytes at ${foundPath}`);
      const data = oc.FS.readFile(foundPath);
      try { oc.FS.unlink(foundPath); } catch (_) {}

      stepBytes = data;
      const sizeMb = (data.byteLength / 1024 / 1024).toFixed(2).replace('.', ',');
      log(`STEP generated: ${sizeMb} MB`, 'ok');

      hideProgress();
      resultSummary.textContent = `STEP file ready (${sizeMb} MB).`;
      resultCard.style.display = '';
    } catch (err) {
      log('Conversion failed: ' + (err.message || err), 'error');
      hideProgress();
    } finally {
      processBtn.disabled = false;
    }
  }

  function downloadStep() {
    if (!stepBytes) return;
    const baseName = stlFileName.replace(/\.stl$/i, '');
    const outName = `${baseName}.step`;
    const blob = new Blob([stepBytes], { type: 'application/step' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// ============================================================================
// OpenCascade loading (with progress)
// ============================================================================

async function loadOpenCascade(onProgress) {
  if (ocInstance) return ocInstance;
  if (ocLoadingPromise) return ocLoadingPromise;

  ocLoadingPromise = (async () => {
    const wasmBinary = await fetchWithProgress(OCJS_WASM_URL, onProgress);

    // The unpkg build is published as an ES module (ends with `export default`),
    // so we use a dynamic import rather than injecting a <script> tag.
    const mod = await import(/* @vite-ignore */ OCJS_LOADER_URL);
    const opencascadeFactory = mod.default;

    ocInstance = await opencascadeFactory({
      wasmBinary,
      locateFile: (p) => p.endsWith('.wasm') ? OCJS_WASM_URL : p,
      print: (text) => console.log('[OC]', text),
      printErr: (text) => console.warn('[OC stderr]', text),
    });

    // Expose for in-console diagnostic (e.g. Object.keys(ocInstance).filter(k=>...))
    if (typeof window !== 'undefined') window.ocInstance = ocInstance;
    const progressKeys = Object.keys(ocInstance).filter(k => /Progress/i.test(k));
    console.log('[stlToStep] OC keys matching Progress:', progressKeys);
    return ocInstance;
  })();

  return ocLoadingPromise;
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch WASM: ${res.status}`);
  const total = parseInt(res.headers.get('Content-Length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ============================================================================
// STL reading: try OpenCascade's StlAPI_Reader, fall back to JS-side build
// ============================================================================

async function readStlIntoShape(oc, stlBuffer, log, setProgress) {
  setProgress(5, 'Reading STL into OpenCascade...');
  log('Reading STL into OpenCascade...');
  await yieldToUI();

  const tmpStl = `input_${Date.now()}.stl`;
  const tmpStlPath = '/' + tmpStl;
  oc.FS.writeFile(tmpStlPath, stlBuffer);

  try {
    const stat = oc.FS.stat(tmpStlPath);
    log(`Virtual FS: ${stat.size.toLocaleString('fr-FR')} bytes at ${tmpStlPath}`);
  } catch (_) {}

  const reader = new oc.StlAPI_Reader();
  // Some opencascade.js builds want TopoDS_Shape rather than TopoDS_Shell here
  const target = new oc.TopoDS_Shape();

  let readOk = false;
  try {
    readOk = reader.Read(target, tmpStlPath);
  } catch (e) {
    log(`StlAPI_Reader.Read threw: ${e.message || e}`, 'error');
    // Try again with TopoDS_Shell as some builds require it
    try {
      const shell = new oc.TopoDS_Shell();
      readOk = reader.Read(shell, tmpStlPath);
      if (readOk) {
        oc.FS.unlink(tmpStlPath);
        log('STL parsed by OpenCascade (shell)', 'ok');
        return shell;
      }
    } catch (e2) {
      log(`Second StlAPI_Reader attempt threw: ${e2.message || e2}`, 'error');
    }
  }
  oc.FS.unlink(tmpStlPath);

  if (readOk) {
    log('STL parsed by OpenCascade', 'ok');
    return target;
  }

  log('StlAPI_Reader failed — falling back to JS-side parsing + manual shell build', 'warn');
  return await buildShellFromStlJS(oc, stlBuffer, log, setProgress);
}

// JS-side STL parser (binary + ASCII) building a TopoDS_Compound of triangle faces
async function buildShellFromStlJS(oc, stlBuffer, log, setProgress) {
  const mesh = parseStlAny(stlBuffer.buffer);
  log(`JS parsed: ${mesh.vertices.length.toLocaleString('fr-FR')} vertices, ${mesh.faces.length.toLocaleString('fr-FR')} triangles`);

  const builder = new oc.BRep_Builder();
  const compound = new oc.TopoDS_Compound();
  builder.MakeCompound(compound);

  const verts = mesh.vertices;
  const faces = mesh.faces;
  const total = faces.length;
  const stepReport = Math.max(500, Math.floor(total / 50));
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    const tri = faces[i];
    const a = verts[tri[0]];
    const b = verts[tri[1]];
    const c = verts[tri[2]];

    if (isDegenerateTri(a, b, c)) {
      skipped++;
      continue;
    }

    const face = makeTriangleFace(oc, a, b, c);
    if (face) {
      builder.Add(compound, face);
      added++;
    } else {
      skipped++;
    }

    if (i % stepReport === 0) {
      const pct = 5 + (i / total) * 30;
      setProgress(pct, `Building faces: ${i.toLocaleString('fr-FR')} / ${total.toLocaleString('fr-FR')}`);
      await yieldToUI();
    }
  }

  if (added === 0) return null;
  log(`Built compound with ${added.toLocaleString('fr-FR')} faces${skipped ? ` (${skipped} degenerate skipped)` : ''}`, 'ok');

  // Try to sew into a shell — but skip cleanly if Message_ProgressRange isn't
  // exposed in this opencascade.js build (Perform requires it).
  const progress = makeProgress(oc);
  if (progress) {
    setProgress(40, 'Sewing faces...');
    log('Sewing faces into shell...');
    await yieldToUI();
    try {
      const sewing = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
      sewing.Load(compound);
      sewing.Perform(progress);
      return sewing.SewedShape();
    } catch (e) {
      log(`Sewing failed: ${e.message || e} — exporting unsewn compound`, 'warn');
    }
  } else {
    log('No Message_ProgressRange available — skipping sewing, exporting unsewn compound', 'warn');
  }
  return compound;
}

let _progressCtor = undefined; // cache: ctor function | null (= no constructor) | undefined (= unresolved)

// IFSelect_ReturnStatus values are exposed as embind enum objects, not numbers,
// so a friendly description is needed for logging.
function describeStatus(oc, status) {
  if (status === undefined || status === null) return String(status);
  const enumObj = oc.IFSelect_ReturnStatus;
  if (enumObj) {
    for (const name of ['IFSelect_RetVoid', 'IFSelect_RetDone', 'IFSelect_RetError', 'IFSelect_RetFail', 'IFSelect_RetStop']) {
      if (enumObj[name] !== undefined && status === enumObj[name]) return name;
    }
  }
  if (typeof status === 'object' && 'value' in status) return `value=${status.value}`;
  return String(status);
}

function callTransferRobust(writer, shape, mode, progress, log) {
  // Try several signatures: opencascade.js builds vary by OCCT version.
  const attempts = [];
  if (progress) attempts.push([shape, mode, true, progress]);
  attempts.push([shape, mode, true]);
  attempts.push([shape, mode]);

  let lastErr;
  for (const args of attempts) {
    try {
      return writer.Transfer(...args);
    } catch (e) {
      lastErr = e;
      log(`writer.Transfer(${args.length} args) failed: ${e.message || e}`, 'warn');
    }
  }
  throw lastErr || new Error('writer.Transfer failed for all known signatures');
}

function makeProgress(oc) {
  if (_progressCtor === null) return null;
  if (typeof _progressCtor === 'function') {
    try { return new _progressCtor(); } catch (_) { return null; }
  }
  // Resolve once — search for any exported Message_ProgressRange variant
  const candidates = Object.keys(oc).filter(
    k => k === 'Message_ProgressRange' || /^Message_ProgressRange_\d+$/.test(k)
  );
  console.log('[stlToStep] Message_ProgressRange candidates:', candidates);
  for (const name of candidates) {
    const ctor = oc[name];
    if (typeof ctor !== 'function') continue;
    try {
      const inst = new ctor();
      _progressCtor = ctor;
      console.log('[stlToStep] Using progress ctor:', name);
      return inst;
    } catch (e) {
      console.warn(`[stlToStep] new oc.${name}() failed:`, e.message || e);
    }
  }
  _progressCtor = null;
  return null;
}

function makeTriangleFace(oc, a, b, c) {
  try {
    const p1 = new oc.gp_Pnt_3(a.x, a.y, a.z);
    const p2 = new oc.gp_Pnt_3(b.x, b.y, b.z);
    const p3 = new oc.gp_Pnt_3(c.x, c.y, c.z);
    const e1 = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2).Edge();
    const e2 = new oc.BRepBuilderAPI_MakeEdge_3(p2, p3).Edge();
    const e3 = new oc.BRepBuilderAPI_MakeEdge_3(p3, p1).Edge();
    const wire = new oc.BRepBuilderAPI_MakeWire_4(e1, e2, e3).Wire();
    return new oc.BRepBuilderAPI_MakeFace_15(wire, true).Face();
  } catch (e) {
    return null;
  }
}

function isDegenerateTri(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return (cx * cx + cy * cy + cz * cz) < 1e-20;
}

function parseStlAny(arrayBuffer) {
  if (arrayBuffer.byteLength >= 84) {
    const view = new DataView(arrayBuffer);
    const triCount = view.getUint32(80, true);
    const expected = 84 + triCount * 50;
    if (expected === arrayBuffer.byteLength) {
      return parseBinaryStl(view, triCount);
    }
  }
  return parseAsciiStl(new TextDecoder('utf-8').decode(arrayBuffer));
}

function parseBinaryStl(view, triCount) {
  const vertices = [];
  const faces = [];
  const map = new Map();
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12;
    const tri = [];
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(off, true);
      const y = view.getFloat32(off + 4, true);
      const z = view.getFloat32(off + 8, true);
      off += 12;
      const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = vertices.length;
        vertices.push({ x, y, z });
        map.set(key, idx);
      }
      tri.push(idx);
    }
    off += 2;
    faces.push(tri);
  }
  return { vertices, faces };
}

function parseAsciiStl(text) {
  const vertices = [];
  const faces = [];
  const map = new Map();
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('vertex')) {
      const p = line.split(/\s+/);
      const x = parseFloat(p[1]);
      const y = parseFloat(p[2]);
      const z = parseFloat(p[3]);
      const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = vertices.length;
        vertices.push({ x, y, z });
        map.set(key, idx);
      }
      current.push(idx);
      if (current.length === 3) {
        faces.push(current);
        current = [];
      }
    } else if (line.startsWith('endfacet')) {
      current = [];
    }
  }
  return { vertices, faces };
}

// ============================================================================
// Helpers
// ============================================================================

function tryMakeSolid(oc, sewedShape) {
  const solidMaker = new oc.BRepBuilderAPI_MakeSolid_1();
  const explorer = new oc.TopExp_Explorer_2(
    sewedShape,
    oc.TopAbs_ShapeEnum.TopAbs_SHELL,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  let count = 0;
  while (explorer.More()) {
    solidMaker.Add(oc.TopoDS.Shell_1(explorer.Current()));
    count++;
    explorer.Next();
  }
  if (count === 0) return null;
  return solidMaker.Solid();
}

function yieldToUI() {
  return new Promise(r => setTimeout(r, 0));
}

// Detect binary STL and count triangles. Returns 0 for ASCII (we don't count).
function countTriangles(arrayBuffer) {
  if (arrayBuffer.byteLength < 84) return 0;
  const view = new DataView(arrayBuffer);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (expected === arrayBuffer.byteLength) {
    return triCount;
  }
  // ASCII fallback: count "facet normal" occurrences
  const text = new TextDecoder('utf-8', { fatal: false }).decode(
    new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, 1024 * 1024))
  );
  const m = text.match(/facet\s+normal/gi);
  return m ? m.length : 0;
}
