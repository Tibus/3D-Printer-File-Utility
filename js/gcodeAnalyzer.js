// ============================================================================
// G-code Analyzer Page Logic
// ============================================================================

function initGcodeAnalyzer() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const fileStats = document.getElementById('fileStats');
  const resultsSection = document.getElementById('resultsSection');
  const thumbnailContainer = document.getElementById('thumbnailContainer');
  const thumbnailCard = document.getElementById('thumbnailCard');

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) loadGcodeFile(file);
  });

  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) loadGcodeFile(e.target.files[0]);
  });

  function loadGcodeFile(file) {
    fileName.textContent = file.name;
    fileStats.textContent = `${(file.size / 1024 / 1024).toFixed(2).replace('.', ',')} MB`;
    fileInfo.classList.add('show');
    resultsSection.style.display = 'none';

    const is3mf = file.name.toLowerCase().endsWith('.3mf');

    showLoader('Analyzing G-code...');

    if (is3mf) {
      const reader = new FileReader();
      reader.onload = async e => {
        try {
          const result = await loadGcode3mf(e.target.result);
          displayGcodeStats(result.stats, result.images);
        } catch (err) {
          console.error('Error reading .gcode.3mf:', err);
          fileStats.textContent = 'Error: ' + err.message;
        }
        hideLoader();
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = e => {
        // setTimeout to let the loader render before sync parsing
        setTimeout(() => {
          const stats = parseGcode(e.target.result);
          displayGcodeStats(stats, []);
          hideLoader();
        }, 50);
      };
      reader.readAsText(file);
    }
  }

  async function loadGcode3mf(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const filenames = Object.keys(zip.files);

    // Find gcode file(s) inside the archive
    const gcodeFiles = filenames.filter(f =>
      f.toLowerCase().endsWith('.gcode') && !f.toLowerCase().endsWith('.md5')
    );
    if (gcodeFiles.length === 0) {
      throw new Error('No .gcode file found in 3MF archive');
    }

    // Use first gcode file (typically Metadata/plate_1.gcode)
    const gcodeFile = zip.files[gcodeFiles[0]];
    // Skip movement parsing for large files (>50MB) since metadata has the key stats
    const skipMovements = gcodeFile._data && gcodeFile._data.uncompressedSize
      ? gcodeFile._data.uncompressedSize > 50 * 1024 * 1024
      : false;
    const gcodeContent = await gcodeFile.async('text');
    const stats = parseGcode(gcodeContent, { skipMovementParsing: skipMovements });

    // Extract thumbnail images from the archive (PNG files)
    const images = [];
    // Prefer larger thumbnails: plate > top > pick; skip small variants
    const imageFiles = filenames.filter(f => {
      const lower = f.toLowerCase();
      return lower.endsWith('.png') && !lower.includes('_small') && !lower.includes('pick_');
    }).sort((a, b) => {
      // Prefer top_ images (larger plate renders), then plate_
      const aIsTop = a.toLowerCase().includes('top_');
      const bIsTop = b.toLowerCase().includes('top_');
      if (aIsTop && !bIsTop) return -1;
      if (!aIsTop && bIsTop) return 1;
      return 0;
    });

    for (const imgFile of imageFiles) {
      const data = await zip.files[imgFile].async('base64');
      images.push({ name: imgFile, data });
    }

    // Parse slice_info.config for printer model
    const sliceInfoFile = filenames.find(f => f.toLowerCase().includes('slice_info.config'));
    if (sliceInfoFile) {
      try {
        const sliceInfoXml = await zip.files[sliceInfoFile].async('text');
        const parser = new DOMParser();
        const doc = parser.parseFromString(sliceInfoXml, 'application/xml');
        const metadatas = doc.getElementsByTagName('metadata');
        for (let i = 0; i < metadatas.length; i++) {
          const key = metadatas[i].getAttribute('key');
          const val = metadatas[i].getAttribute('value');
          if (key === 'printer_model_id' && !stats.printerModel) stats.printerModel = val;
          if (key === 'nozzle_diameters' && !stats.nozzleDiameter) stats.nozzleDiameter = val;
          if (key === 'prediction' && !stats.estimatedTimeSeconds) {
            stats.estimatedTimeSeconds = parseInt(val);
            stats.estimatedTime = formatSeconds(parseInt(val));
          }
          if (key === 'weight' && !stats.totalFilamentUsedG) {
            stats.totalFilamentUsedG = parseFloat(val).toFixed(2);
          }
        }
      } catch (e) {
        console.warn('Failed to parse slice_info.config:', e);
      }
    }

    // Parse plate JSON for objects list
    const plateJsonFile = filenames.find(f => /plate_\d+\.json$/i.test(f));
    if (plateJsonFile) {
      try {
        const plateJson = JSON.parse(await zip.files[plateJsonFile].async('text'));
        if (plateJson.bbox_objects) {
          stats.objects = plateJson.bbox_objects.map(obj => ({
            name: obj.name,
            layerHeight: obj.layer_height,
          }));
        }
      } catch (e) {
        console.warn('Failed to parse plate JSON:', e);
      }
    }

    return { stats, images };
  }

  function displayGcodeStats(stats, archiveImages) {
    resultsSection.style.display = '';
    archiveImages = archiveImages || [];

    // Thumbnail: prefer archive images (from 3MF), fallback to embedded thumbnails in gcode
    const hasArchiveImages = archiveImages.length > 0;
    const hasEmbeddedThumbnails = stats.thumbnails.length > 0;

    if (hasArchiveImages || hasEmbeddedThumbnails) {
      thumbnailCard.style.display = '';
      thumbnailContainer.innerHTML = '';

      if (hasArchiveImages) {
        // Show the best archive image (first one, sorted by preference)
        const imgData = archiveImages[0];
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${imgData.data}`;
        img.alt = 'G-code thumbnail';
        img.className = 'gcode-thumbnail';
        thumbnailContainer.appendChild(img);
      } else {
        // Fallback to embedded thumbnail (pick the largest)
        const thumb = stats.thumbnails[stats.thumbnails.length - 1];
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${thumb.data}`;
        img.alt = 'G-code thumbnail';
        img.className = 'gcode-thumbnail';
        thumbnailContainer.appendChild(img);
      }
    } else {
      thumbnailCard.style.display = 'none';
    }

    // Printer section
    setStatValue('statPrinter', stats.printerModel);
    setStatValue('statNozzle', stats.nozzleDiameter, 'mm');
    setStatValue('statProfile', stats.printProfile);

    // Time & filament
    setStatValue('statTime', stats.estimatedTime);
    setStatValue('statFilamentG', stats.totalFilamentUsedG, 'g');
    setStatValue('statFilamentMm', formatFilamentMm(stats.totalFilamentUsedMm));

    // Dimensions
    if (stats.sizeX !== undefined) {
      setStatValue('statDimensions', `${fmtNum(stats.sizeX)} × ${fmtNum(stats.sizeY)} × ${fmtNum(stats.sizeZ)}`, 'mm');
    } else {
      setStatValue('statDimensions', null);
    }

    // Layers
    setStatValue('statLayers', stats.totalLayers);
    setStatValue('statLayerHeight', stats.layerHeight, 'mm');
    setStatValue('statFirstLayerHeight', stats.firstLayerHeight, 'mm');

    // Temperatures
    setStatValue('statNozzleTemp', formatTemp(stats.nozzleTemp));
    setStatValue('statBedTemp', formatTemp(stats.bedTemp));
    setStatValue('statChamberTemp', formatTemp(stats.chamberTemp));

    // Print settings
    setStatValue('statWallLoops', stats.wallLoops);
    setStatValue('statTopLayers', stats.topShellLayers);
    setStatValue('statBottomLayers', stats.bottomShellLayers);
    setStatValue('statInfillDensity', formatPercent(stats.infillDensity));
    setStatValue('statInfillPattern', stats.infillPattern);
    setStatValue('statSupport', formatBool(stats.supportEnabled));

    // Speeds
    setStatValue('statOuterWallSpeed', stats.outerWallSpeed, 'mm/s');
    setStatValue('statInnerWallSpeed', stats.innerWallSpeed, 'mm/s');
    setStatValue('statInfillSpeed', stats.infillSpeed, 'mm/s');
    setStatValue('statTopSpeed', stats.topSurfaceSpeed, 'mm/s');
    setStatValue('statTravelSpeed', stats.travelSpeed, 'mm/s');
    setStatValue('statFirstLayerSpeed', stats.firstLayerSpeed, 'mm/s');

    // Multi-tool stats
    setStatValue('statToolChanges', stats.toolChanges > 0 ? stats.toolChanges : null);
    setStatValue('statRetractions', stats.retractCount > 0 ? stats.retractCount.toLocaleString() : null);

    // Waste stats
    setStatValue('statTotalWaste', stats.totalWasteWeightG
      ? `${fmtNum(stats.totalWasteWeightG)} g (${fmtNum(stats.totalWasteVolumeCm3)} cm³)` : null);
    setStatValue('statFlushWaste', stats.flushWeightG
      ? `${fmtNum(stats.flushWeightG)} g (${fmtNum(stats.flushVolumeCm3)} cm³)` : null);
    setStatValue('statTowerWaste', stats.wipeTowerWeightG
      ? `${fmtNum(stats.wipeTowerWeightG)} g (${fmtNum(stats.wipeTowerVolumeCm3)} cm³)` : null);
    setStatValue('statFlushCount', stats.flushCount > 0 ? stats.flushCount : null);
    setStatValue('statFlushMultiplier', stats.flushMultiplier);
    setStatValue('statFlushIntoInfill', formatBool(stats.flushIntoInfill));
    setStatValue('statFlushIntoSupport', formatBool(stats.flushIntoSupport));

    // Filaments table
    const filamentsCard = document.getElementById('filamentsCard');
    const filamentsBody = document.getElementById('filamentsBody');
    if (stats.filaments.length > 0) {
      filamentsCard.style.display = '';
      filamentsBody.innerHTML = '';
      stats.filaments.forEach(f => {
        const tr = document.createElement('tr');
        const colorSwatch = f.color
          ? `<span class="filament-swatch" style="background:${f.color}">${f.color}</span>`
          : '';
        tr.innerHTML = `
          <td>${f.index + 1}</td>
          <td>${colorSwatch}${f.type || '—'}</td>
          <td>${f.usedG != null ? f.usedG.toFixed(2).replace('.', ',') + ' g' : '—'}</td>
          <td>${f.usedMm != null ? (f.usedMm / 1000).toFixed(2).replace('.', ',') + ' m' : '—'}</td>
        `;
        filamentsBody.appendChild(tr);
      });
    } else {
      filamentsCard.style.display = 'none';
    }

    // Objects table
    const objectsCard = document.getElementById('objectsCard');
    const objectsBody = document.getElementById('objectsBody');
    if (stats.objects && stats.objects.length > 0) {
      objectsCard.style.display = '';
      objectsBody.innerHTML = '';
      // Count unique objects
      const objectCounts = {};
      stats.objects.forEach(o => {
        objectCounts[o.name] = (objectCounts[o.name] || 0) + 1;
      });
      Object.entries(objectCounts).forEach(([name, count], idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td>${name}${count > 1 ? ` <span style="color:var(--text-muted)">&times;${count}</span>` : ''}</td>
        `;
        objectsBody.appendChild(tr);
      });
    } else {
      objectsCard.style.display = 'none';
    }

    // Hide empty sections
    document.querySelectorAll('.gcode-stat-group').forEach(group => {
      const items = group.querySelectorAll('.gcode-stat-item');
      const allHidden = [...items].every(item => item.style.display === 'none');
      group.style.display = allHidden ? 'none' : '';
    });
  }

  // Replace decimal dots with commas for French number formatting
  function fmtNum(val) {
    if (val == null) return val;
    return String(val).replace(/(\d)\.(\d)/g, '$1,$2');
  }

  function setStatValue(id, value, unit) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value === null || value === undefined) {
      el.closest('.gcode-stat-item').style.display = 'none';
      return;
    }
    el.closest('.gcode-stat-item').style.display = '';
    const display = fmtNum(value);
    el.textContent = unit ? `${display} ${unit}` : `${display}`;
  }

  function formatFilamentMm(val) {
    if (!val) return null;
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    if (num > 1000) return (num / 1000).toFixed(2).replace('.', ',') + ' m';
    return num.toFixed(1).replace('.', ',') + ' mm';
  }

  function formatTemp(val) {
    if (!val) return null;
    // Could be comma-separated for multi-tool
    const temps = val.split(/[,;]\s*/);
    return temps.map(t => t.trim() + '°C').join(', ');
  }

  function formatPercent(val) {
    if (!val) return null;
    if (val.includes('%')) return val;
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    return num + '%';
  }

  function formatBool(val) {
    if (!val) return null;
    const v = val.toLowerCase().trim();
    if (v === '1' || v === 'true' || v === 'yes') return 'Yes';
    if (v === '0' || v === 'false' || v === 'no') return 'No';
    return val;
  }
}
