// ============================================================================
// File Handling
// ============================================================================

const SUPPORTED_EXTENSIONS = ['.obj', '.stl', '.glb', '.3mf'];

function isSupportedFile(filename) {
  const lower = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function getFileType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.3mf')) return '3mf';
  return null;
}

function showViewerPngExport(baseName) {
  const pngBtn = document.getElementById('exportPreviewPngBtn');
  if (!pngBtn) return;
  pngBtn.style.display = 'flex';
  pngBtn.onclick = () => exportViewerPNG(baseName);
}

function stripExt(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function initFileHandling() {
  elements.dropZone.addEventListener('click', () => elements.fileInput.click());

  elements.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
  });

  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('dragover');
  });

  elements.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && isSupportedFile(file.name)) {
      handleFile(file);
    }
  });

  elements.fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
}

function handleFile(file) {
  const page = getPageType();
  loadedFile = file;
  loadedFileType = getFileType(file.name);
  elements.fileName.textContent = file.name;

  // Reset results section (converter only)
  if (elements.resultsCard) elements.resultsCard.classList.remove('show');
  if (elements.logCard) elements.logCard.classList.remove('show');
  if (elements.progressContainer) elements.progressContainer.classList.remove('show');
  if (elements.statsGrid) elements.statsGrid.innerHTML = '';
  if (typeof clearLog === 'function' && elements.logContainer) clearLog();
  const resultViewerCard = document.getElementById('resultViewerCard');
  if (resultViewerCard) {
    resultViewerCard.classList.remove('show');
  }
  if (typeof clearResultViewer === 'function') clearResultViewer();
  if (typeof hideTexturePreview === 'function') hideTexturePreview();

  // Hide preview export buttons
  const exportPreviewBtn = document.getElementById('exportPreviewObjBtn');
  if (exportPreviewBtn) exportPreviewBtn.style.display = 'none';
  const exportPreviewPngBtn = document.getElementById('exportPreviewPngBtn');
  if (exportPreviewPngBtn) exportPreviewPngBtn.style.display = 'none';

  // Reset processed state
  processedOBJ = null;
  processedData = null;
  finalPalette = null;
  originalTexture = null;
  clampedTexture = null;
  glbExtractedPalette = null;

  // Clear previous viewers
  if (typeof clearViewer === 'function') clearViewer();
  if (typeof clearProcessViewer === 'function') clearProcessViewer();
  parsedModelData = null;

  // Hide viewer cards and tabs until model loads
  const viewerCard = document.getElementById('viewerCard');
  if (viewerCard) viewerCard.style.display = 'none';
  const processViewerCard = document.getElementById('processViewerCard');
  if (processViewerCard) processViewerCard.style.display = 'none';
  const pickedPaletteCard = document.getElementById('pickedPaletteCard');
  if (pickedPaletteCard) pickedPaletteCard.style.display = 'none';

  // Show loader
  showLoader('Loading file...');

  if (loadedFileType === 'obj') {
    const reader = new FileReader();
    reader.onload = e => {
      const content = e.target.result;
      const lines = content.split('\n');
      const vertexCount = lines.filter(l => l.trim().startsWith('v ')).length;
      const faceCount = lines.filter(l => l.trim().startsWith('f ')).length;
      elements.fileStats.textContent = `${vertexCount.toLocaleString()} vertices, ${faceCount.toLocaleString()} faces`;
      elements.fileInfo.classList.add('show');
      if (elements.processBtn) elements.processBtn.disabled = false;

      // Parse and load into 3D viewer
      try {
        const parsed = parseOBJ(content);
        parsedModelData = {
          vertices: parsed.vertices,
          faces: parsed.faces,
          vertexLineIndices: parsed.vertexLineIndices,
          originalLines: parsed.originalLines
        };
        if (page === 'viewer' || page === 'decimator') {
          loadModelToViewer(parsed.vertices, parsed.faces);
          showViewerPngExport(stripExt(file.name));
        } else {
          loadModelToProcessViewer(parsed.vertices, parsed.faces);
          initColorPicker();
        }
      } catch (err) {
        console.error('Error parsing OBJ for viewer:', err);
      }
      hideLoader();
    };
    reader.readAsText(file);
  } else if (loadedFileType === 'stl') {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const buffer = e.target.result;
        const dataView = new DataView(buffer);
        const triangleCount = dataView.getUint32(80, true);
        elements.fileStats.textContent = `${triangleCount.toLocaleString()} triangles (STL)`;
        elements.fileInfo.classList.add('show');
        if (elements.processBtn) elements.processBtn.disabled = false;

        // Parse and load into 3D viewer
        try {
          const parsed = parseSTL(buffer);
          parsedModelData = {
            vertices: parsed.vertices,
            faces: parsed.faces
          };
          if (page === 'viewer' || page === 'decimator') {
            loadModelToViewer(parsed.vertices, parsed.faces);
            showViewerPngExport(stripExt(file.name));
          } else {
            loadModelToProcessViewer(parsed.vertices, parsed.faces);
            initColorPicker();
          }
        } catch (err) {
          console.error('Error parsing STL for viewer:', err);
        }
      } catch (err) {
        elements.fileStats.textContent = 'Error reading STL file';
        elements.fileInfo.classList.add('show');
      }
      hideLoader();
    };
    reader.readAsArrayBuffer(file);
  } else if (loadedFileType === 'glb') {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const buffer = e.target.result;
        const dataView = new DataView(buffer);
        const magic = dataView.getUint32(0, true);
        if (magic === 0x46546C67) {
          elements.fileStats.textContent = `GLB file (textures will be baked to vertex colors)`;
          elements.fileInfo.classList.add('show');
          if (elements.processBtn) elements.processBtn.disabled = false;

          // Parse and load into 3D viewer
          try {
            const parsed = await parseGLB(buffer);
            parsedModelData = {
              vertices: parsed.vertices,
              faces: parsed.faces,
              texture: parsed.texture
            };
            if (page === 'viewer' || page === 'decimator') {
              loadModelToViewer(parsed.vertices, parsed.faces);
              showViewerPngExport(stripExt(file.name));
            } else {
              loadModelToProcessViewer(parsed.vertices, parsed.faces);
              initColorPicker();
            }
          } catch (err) {
            console.error('Error parsing GLB for viewer:', err);
          }
        } else {
          elements.fileStats.textContent = 'Invalid GLB file';
          elements.fileInfo.classList.add('show');
        }
      } catch (err) {
        elements.fileStats.textContent = 'Error reading GLB file';
        elements.fileInfo.classList.add('show');
      }
      hideLoader();
    };
    reader.readAsArrayBuffer(file);
  } else if (loadedFileType === '3mf') {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const buffer = e.target.result;
        const parsed = await parse3MF(buffer);

        elements.fileStats.textContent = `${parsed.vertices.length.toLocaleString()} vertices, ${parsed.faces.length.toLocaleString()} faces (3MF)`;
        elements.fileInfo.classList.add('show');
        if (elements.processBtn) elements.processBtn.disabled = false;

        parsedModelData = {
          vertices: parsed.vertices,
          faces: parsed.faces,
          faceColors: parsed.faceColors
        };
        if (page === 'viewer' || page === 'decimator') {
          loadModelToViewer(parsed.vertices, parsed.faces, parsed.faceColors);
        } else {
          loadModelToProcessViewer(parsed.vertices, parsed.faces, parsed.faceColors);
          initColorPicker();
        }

        // Show export buttons if the model has vertex colors
        const hasColors = parsed.vertices.some(v => v.color && v.color.name !== 'default');
        const baseName = file.name.replace(/\.3mf$/i, '');
        if (hasColors) {
          const objBtn = document.getElementById('exportPreviewObjBtn');
          if (objBtn) {
            objBtn.style.display = 'flex';
            objBtn.onclick = () => {
              const objContent = generateOBJFromData(parsed.vertices, parsed.faces);
              const blob = new Blob([objContent], { type: 'text/plain' });
              downloadBlob(blob, `${baseName}.obj`);
            };
          }
        }

        // Always show PNG export for 3MF
        const pngBtn = document.getElementById('exportPreviewPngBtn');
        if (pngBtn) {
          pngBtn.style.display = 'flex';
          pngBtn.onclick = () => {
            exportViewerPNG(baseName);
          };
        }
      } catch (err) {
        console.error('Error parsing 3MF:', err);
        elements.fileStats.textContent = 'Error reading 3MF file: ' + err.message;
        elements.fileInfo.classList.add('show');
      }
      hideLoader();
    };
    reader.readAsArrayBuffer(file);
  }
}
