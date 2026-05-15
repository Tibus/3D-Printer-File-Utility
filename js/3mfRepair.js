// ============================================================================
// 3MF Repair Tool
// ============================================================================

function init3mfRepair() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const fileStats = document.getElementById('fileStats');
  const analysisSection = document.getElementById('analysisSection');
  const analysisLog = document.getElementById('analysisLog');
  const objectsCard = document.getElementById('objectsCard');
  const objectsBody = document.getElementById('objectsBody');
  const repairActions = document.getElementById('repairActions');
  const repairSummary = document.getElementById('repairSummary');
  const repairBtn = document.getElementById('repairBtn');

  let repairData = null;

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
    if (file) loadFile(file);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  repairBtn.addEventListener('click', () => {
    if (repairData) doRepair(repairData);
  });

  function log(msg, type) {
    const div = document.createElement('div');
    div.className = 'repair-log-line' + (type ? ' repair-log-' + type : '');
    div.textContent = msg;
    analysisLog.appendChild(div);
  }

  async function loadFile(file) {
    fileName.textContent = file.name;
    fileStats.textContent = `${(file.size / 1024 / 1024).toFixed(2).replace('.', ',')} MB`;
    fileInfo.classList.add('show');
    analysisSection.style.display = '';
    analysisLog.innerHTML = '';
    objectsCard.style.display = 'none';
    objectsBody.innerHTML = '';
    repairActions.style.display = 'none';
    repairData = null;

    showLoader('Analyzing 3MF...');

    try {
      const buffer = await file.arrayBuffer();
      const result = await analyze3mf(buffer, file.name);
      repairData = result;
      repairData.originalName = file.name;
    } catch (err) {
      log('Fatal error: ' + err.message, 'error');
    }

    hideLoader();
  }

  async function analyze3mf(buffer, filename) {
    log('Opening archive...');

    let zip;
    try {
      zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
    } catch (e) {
      log('Standard ZIP open failed: ' + e.message, 'warn');
      log('Trying recovery mode (truncated archive)...', 'warn');
      try {
        zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
      } catch (e2) {
        throw new Error('Cannot open archive: ' + e2.message);
      }
    }

    const allFiles = Object.keys(zip.files);
    log(`Found ${allFiles.length} entries in archive`);

    // Check for _rels/.rels
    const hasRootRels = allFiles.some(f => f === '_rels/.rels');
    if (!hasRootRels) {
      log('Missing _rels/.rels (root relationship file)', 'warn');
    } else {
      log('_rels/.rels present', 'ok');
    }

    // Check for [Content_Types].xml
    const hasContentTypes = allFiles.some(f => f === '[Content_Types].xml');
    if (!hasContentTypes) {
      log('Missing [Content_Types].xml', 'warn');
    } else {
      log('[Content_Types].xml present', 'ok');
    }

    // Find root model
    const rootModelPath = allFiles.find(f =>
      f.toLowerCase().endsWith('.model') && !f.toLowerCase().includes('objects/')
    );
    if (!rootModelPath) {
      throw new Error('No root model file found');
    }
    log(`Root model: ${rootModelPath}`, 'ok');

    const rootModelXml = await zip.files[rootModelPath].async('text');

    // Parse root model to find objects, components, and build items
    const parser = new DOMParser();
    const rootDoc = parser.parseFromString(rootModelXml, 'application/xml');

    // Extract namespaces
    const modelEl = rootDoc.querySelector('model');
    const ns = modelEl ? modelEl.getAttribute('xmlns') : '';
    const pNs = modelEl ? (modelEl.getAttribute('xmlns:p') || '') : '';

    // Find all objects in root model
    const rootObjects = rootDoc.querySelectorAll('object');
    log(`Root model contains ${rootObjects.length} object definitions`);

    // Find build items
    const buildItems = rootDoc.querySelectorAll('build item, item');
    log(`Build plate has ${buildItems.length} items`);

    // Find referenced sub-object files from relationships
    const relsPath = allFiles.find(f => f.toLowerCase().includes('3dmodel.model.rels'));
    let relsEntries = [];
    if (relsPath) {
      const relsXml = await zip.files[relsPath].async('text');
      const relsDoc = parser.parseFromString(relsXml, 'application/xml');
      const rels = relsDoc.querySelectorAll('Relationship');
      rels.forEach(r => {
        relsEntries.push({
          target: r.getAttribute('Target'),
          id: r.getAttribute('Id'),
        });
      });
      log(`Relationships file references ${relsEntries.length} sub-objects`);
    }

    // Find all object model files actually present
    const objectFiles = allFiles.filter(f =>
      f.toLowerCase().includes('objects/') && f.toLowerCase().endsWith('.model')
    );
    log(`Object files present in archive: ${objectFiles.length}`);

    // Parse each object file to get mesh stats
    const objects = [];
    const presentObjectPaths = new Set(objectFiles.map(f => f.toLowerCase()));

    // Determine which objects are referenced
    const referencedPaths = new Set();
    for (const rel of relsEntries) {
      // Target is relative like "Objects/object_69.model"
      const fullPath = '3D/' + rel.target;
      referencedPaths.add(fullPath.toLowerCase());
    }

    // Also scan component references in root model
    const components = rootDoc.querySelectorAll('component');
    const componentPaths = new Set();
    components.forEach(comp => {
      const path = comp.getAttribute('path');
      if (path) {
        const normalized = path.startsWith('/') ? path.substring(1) : path;
        componentPaths.add(normalized.toLowerCase());
        referencedPaths.add(normalized.toLowerCase());
      }
    });

    // Find missing files
    const missingPaths = [];
    for (const refPath of referencedPaths) {
      if (!presentObjectPaths.has(refPath)) {
        missingPaths.push(refPath);
      }
    }

    if (missingPaths.length > 0) {
      log(`${missingPaths.length} referenced object files are MISSING`, 'error');
      missingPaths.forEach(p => log(`  Missing: ${p}`, 'error'));
    } else {
      log('All referenced object files are present', 'ok');
    }

    // Parse present object files for stats
    showLoader('Parsing object meshes...');
    for (const objFile of objectFiles) {
      try {
        const xml = await zip.files[objFile].async('text');
        const doc = parser.parseFromString(xml, 'application/xml');
        const vertices = doc.querySelectorAll('vertex');
        const triangles = doc.querySelectorAll('triangle');
        const objId = objFile.match(/object_(\d+)/)?.[1] || objFile;
        objects.push({
          path: objFile,
          id: objId,
          vertices: vertices.length,
          triangles: triangles.length,
          present: true,
        });
      } catch (e) {
        objects.push({
          path: objFile,
          id: objFile,
          vertices: 0,
          triangles: 0,
          present: true,
          error: e.message,
        });
      }
    }

    // Add missing objects
    for (const mp of missingPaths) {
      const objId = mp.match(/object_(\d+)/)?.[1] || mp;
      objects.push({
        path: mp,
        id: objId,
        vertices: 0,
        triangles: 0,
        present: false,
      });
    }

    // Sort by ID
    objects.sort((a, b) => parseInt(a.id) - parseInt(b.id));

    // Display objects table
    objectsCard.style.display = '';
    const totalVerts = objects.reduce((s, o) => s + o.vertices, 0);
    const totalTris = objects.reduce((s, o) => s + o.triangles, 0);
    for (const obj of objects) {
      const tr = document.createElement('tr');
      if (!obj.present) tr.style.color = 'var(--color-danger, #f38ba8)';
      tr.innerHTML = `
        <td>${obj.id}</td>
        <td>${obj.path.split('/').pop()}</td>
        <td>${obj.vertices.toLocaleString('fr-FR')}</td>
        <td>${obj.triangles.toLocaleString('fr-FR')}</td>
        <td>${obj.present ? (obj.error ? 'Error' : 'OK') : 'Missing'}</td>
      `;
      objectsBody.appendChild(tr);
    }

    const presentCount = objects.filter(o => o.present && !o.error).length;
    log(`Total: ${presentCount} valid objects, ${totalVerts.toLocaleString('fr-FR')} vertices, ${totalTris.toLocaleString('fr-FR')} triangles`, 'ok');

    // Show repair button
    repairActions.style.display = '';
    if (missingPaths.length > 0) {
      repairSummary.textContent = `${missingPaths.length} missing object(s) will be removed from the build plate. A valid 3MF will be generated with the ${presentCount} remaining objects.`;
    } else if (!hasRootRels) {
      repairSummary.textContent = `Missing relationship file will be recreated. All ${presentCount} objects will be preserved.`;
    } else {
      repairSummary.textContent = `${presentCount} objects will be repackaged into a clean 3MF.`;
    }

    return {
      zip,
      rootModelPath,
      rootModelXml,
      rootDoc,
      ns,
      pNs,
      modelEl,
      relsPath,
      relsEntries,
      objectFiles,
      missingPaths: new Set(missingPaths),
      objects,
      allFiles,
      hasContentTypes,
    };
  }

  async function doRepair(data) {
    showLoader('Rebuilding 3MF...');

    try {
      const newZip = new JSZip();

      // 1. [Content_Types].xml
      newZip.file('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />\n' +
        '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />\n' +
        '  <Default Extension="png" ContentType="image/png" />\n' +
        '</Types>'
      );

      // 2. _rels/.rels
      newZip.file('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
        `  <Relationship Target="/${data.rootModelPath}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />\n` +
        '</Relationships>'
      );

      // 3. Rebuild root model XML — remove references to missing objects
      let repairedRootXml = data.rootModelXml;

      if (data.missingPaths.size > 0) {
        // Remove <object> elements whose components reference missing files
        // and corresponding <item> build entries
        const missingObjectIds = new Set();

        // Find which root object IDs reference missing sub-objects
        const rootObjects = data.rootDoc.querySelectorAll('object');
        rootObjects.forEach(obj => {
          const comps = obj.querySelectorAll('component');
          for (const comp of comps) {
            const path = comp.getAttribute('path');
            if (path) {
              const normalized = (path.startsWith('/') ? path.substring(1) : path).toLowerCase();
              if (data.missingPaths.has(normalized)) {
                missingObjectIds.add(obj.getAttribute('id'));
                break;
              }
            }
          }
        });

        log(`Removing ${missingObjectIds.size} root objects referencing missing files`);

        // Remove object blocks and build items for missing IDs
        for (const objId of missingObjectIds) {
          // Remove <object id="N" ...>...</object>
          const objRegex = new RegExp(`<object\\s+[^>]*id="${objId}"[^>]*>[\\s\\S]*?</object>\\s*`, 'g');
          repairedRootXml = repairedRootXml.replace(objRegex, '');
          // Remove <item objectid="N" .../>
          const itemRegex = new RegExp(`<item\\s+[^>]*objectid="${objId}"[^>]*/>\\s*`, 'g');
          repairedRootXml = repairedRootXml.replace(itemRegex, '');
        }

        // Also clean up relationships entries for missing files
        const validRels = data.relsEntries.filter(rel => {
          const fullPath = ('3D/' + rel.target).toLowerCase();
          return !data.missingPaths.has(fullPath);
        });

        // Rebuild rels file
        let relsXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
        validRels.forEach(rel => {
          relsXml += `  <Relationship Target="${rel.target}" Id="${rel.id}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />\n`;
        });
        relsXml += '</Relationships>';
        newZip.file('3D/_rels/3dmodel.model.rels', relsXml);
      } else if (data.relsPath) {
        // Copy existing rels
        const relsContent = await data.zip.files[data.relsPath].async('uint8array');
        newZip.file(data.relsPath, relsContent);
      }

      // 4. Write repaired root model
      newZip.file(data.rootModelPath, repairedRootXml);

      // 5. Copy all present object files
      for (const objFile of data.objectFiles) {
        const content = await data.zip.files[objFile].async('uint8array');
        newZip.file(objFile, content);
      }

      // 6. Copy metadata files (thumbnails, configs, etc.)
      for (const filePath of data.allFiles) {
        if (filePath.toLowerCase().startsWith('metadata/') ||
            filePath.toLowerCase().endsWith('.png')) {
          if (newZip.files[filePath]) continue; // already added
          try {
            const content = await data.zip.files[filePath].async('uint8array');
            newZip.file(filePath, content);
          } catch (e) {
            log(`Skipped corrupted file: ${filePath}`, 'warn');
          }
        }
      }

      // Generate output
      const blob = await newZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      // Download
      const baseName = data.originalName.replace(/\.3mf$/i, '');
      const outName = `${baseName}_repaired.3mf`;

      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: outName,
            types: [{ description: '3MF File', accept: { 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml': ['.3mf'] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          log(`Saved: ${outName}`, 'ok');
          hideLoader();
          return;
        } catch (e) {
          if (e.name === 'AbortError') { hideLoader(); return; }
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outName;
      a.click();
      URL.revokeObjectURL(url);

      log(`Downloaded: ${outName}`, 'ok');
    } catch (err) {
      log('Repair failed: ' + err.message, 'error');
    }

    hideLoader();
  }
}
