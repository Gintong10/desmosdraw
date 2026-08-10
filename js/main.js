import { ImagePipeline } from './imagePipeline.js';
import { DesmosBuilder } from './desmosBuilder.js';
import { Player } from './player.js';

(function () {
  // ---------- Desmos calculator setup ----------
  const calculatorElt = document.getElementById('calculator');
  const calculator = Desmos.GraphingCalculator(calculatorElt, {
    expressionsCollapsed: false,
    border: false,
    lockViewport: false,
    settingsMenu: true,
    zoomButtons: true,
    expressionsTopbar: true,
  });

  // ---------- DOM refs ----------
  const fileInput = document.getElementById('fileInput');
  const uploadBtn = document.getElementById('uploadBtn');
  const removeBgCheck = document.getElementById('removeBgCheck');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const detailSlider = document.getElementById('detailSlider');
  const ghostImageCheck = document.getElementById('ghostImageCheck');
  const statusText = document.getElementById('statusText');
  const dropHint = document.getElementById('dropHint');
  const modelLoadingOverlay = document.getElementById('modelLoadingOverlay');
  const modelLoadingBar = document.getElementById('modelLoadingBar');
  const modelLoadingPct = document.getElementById('modelLoadingPct');
  const modelLoadingLabel = document.getElementById('modelLoadingLabel');

  const videoControls = document.getElementById('videoControls');
  const scrubBar = document.getElementById('scrubBar');
  const timeCurrent = document.getElementById('timeCurrent');
  const timeTotal = document.getElementById('timeTotal');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const back5Btn = document.getElementById('back5Btn');
  const fwd5Btn = document.getElementById('fwd5Btn');
  const speedBtn = document.getElementById('speedBtn');
  const speedMenu = document.getElementById('speedMenu');

  const GHOST_ID = 'ghost_image';
  const GHOST_OPACITY = 0.28;

  let currentExpressionIds = [];
  let lastGhost = null;
  let scrubbing = false;

  function fmtNum(n) {
    return String(Math.round(n * 1000) / 1000);
  }

  // Desmos API v1.10 doesn't accept type:'image' via setExpression — use setState.
  function applyGhostImage(ghost, enabled) {
    const state = calculator.getState();
    const list = (state.expressions && state.expressions.list) || [];
    state.expressions.list = list.filter((item) => item.id !== GHOST_ID);

    if (enabled && ghost && ghost.imageUrl) {
      state.expressions.list.unshift({
        type: 'image',
        id: GHOST_ID,
        image_url: ghost.imageUrl,
        name: 'G',
        width: fmtNum(ghost.width),
        height: fmtNum(ghost.height),
        center: ghost.center || '(0,0)',
        angle: '0',
        opacity: String(GHOST_OPACITY),
        foreground: false,
        draggable: false,
        secret: true,
      });
    }

    const gp = calculator.graphpaperBounds && calculator.graphpaperBounds.mathCoordinates;
    calculator.setState(state);
    if (gp) {
      calculator.setMathBounds({
        left: gp.left,
        right: gp.right,
        bottom: gp.bottom,
        top: gp.top,
      });
    }
  }

  function clearGhostImage() {
    applyGhostImage(null, false);
  }

  // Expand content bounds to the graph paper's pixel aspect so that after
  // Desmos stretches math→pixels, 1 x-unit and 1 y-unit are the same size.
  // Use graphpaperBounds (not #calculator) — the expressions list would make
  // the aspect too wide and squash the drawing.
  function fitBoundsToViewport(contentBounds) {
    let viewAspect = 0;
    const gp = calculator.graphpaperBounds && calculator.graphpaperBounds.pixelCoordinates;
    if (gp && gp.width > 0 && gp.height > 0) {
      viewAspect = gp.width / gp.height;
    } else if (gp) {
      const w = Math.abs(gp.right - gp.left);
      const h = Math.abs(gp.bottom - gp.top);
      if (w > 0 && h > 0) viewAspect = w / h;
    }
    if (!(viewAspect > 0)) {
      const rect = calculatorElt.getBoundingClientRect();
      viewAspect = rect.width / Math.max(1, rect.height);
    }

    const cx = (contentBounds.left + contentBounds.right) / 2;
    const cy = (contentBounds.bottom + contentBounds.top) / 2;
    let width = contentBounds.right - contentBounds.left;
    let height = contentBounds.top - contentBounds.bottom;
    if (!(width > 0) || !(height > 0)) return contentBounds;

    const contentAspect = width / height;
    if (contentAspect > viewAspect) {
      height = width / viewAspect;
    } else {
      width = height * viewAspect;
    }

    return {
      left: cx - width / 2,
      right: cx + width / 2,
      bottom: cy - height / 2,
      top: cy + height / 2,
    };
  }

  // ---------- Status helper ----------
  function setStatus(msg, spinning) {
    if (!msg) {
      statusText.classList.add('hidden');
      statusText.innerHTML = '';
      return;
    }
    statusText.classList.remove('hidden');
    statusText.innerHTML = (spinning ? '<span class="status-dot"></span>' : '') +
      '<span>' + msg + '</span>';
  }

  function showModelLoading(pct, message) {
    const p = Math.max(0, Math.min(100, pct == null ? 0 : pct));
    modelLoadingOverlay.classList.remove('hidden');
    modelLoadingOverlay.setAttribute('aria-hidden', 'false');
    modelLoadingBar.style.width = p + '%';
    modelLoadingPct.textContent = p + '%';
    if (message) modelLoadingLabel.textContent = message;
  }

  function hideModelLoading() {
    modelLoadingOverlay.classList.add('hidden');
    modelLoadingOverlay.setAttribute('aria-hidden', 'true');
    modelLoadingBar.style.width = '0%';
    modelLoadingPct.textContent = '0%';
  }

  let processingFile = false;
  let modelDownloadPct = 0;
  let modelDownloadDone = false;

  function onDownloadProgress(msg) {
    if (!msg || msg.phase !== 'download') return;
    modelDownloadPct = msg.pct || 0;
    if (modelDownloadPct >= 100) modelDownloadDone = true;

    // Background preload stays silent — only show the bar after an upload.
    if (!processingFile) return;

    if (modelDownloadDone) {
      hideModelLoading();
      setStatus('Processing image…', true);
    } else {
      showModelLoading(modelDownloadPct, msg.message || 'Downloading cutout model…');
      setStatus(
        (msg.message || 'Downloading cutout model…') + ' ' + modelDownloadPct + '%',
        true
      );
    }
  }

  function onPipelineProgress(msg) {
    if (msg && typeof msg === 'object' && msg.phase === 'download') {
      onDownloadProgress(msg);
      return;
    }
    hideModelLoading();
    setStatus(typeof msg === 'string' ? msg : (msg && msg.message) || '', true);
  }

  // Warm the cutout model in the background as soon as the tab loads.
  ImagePipeline.preloadCutoutModel(onDownloadProgress).catch(() => {
    // Leave modelDownloadDone false so upload can retry / show progress.
  });

  function fmtTime(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  // ---------- Settings panel ----------
  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
    settingsBtn.classList.toggle('active');
  });

  if (ghostImageCheck) {
    ghostImageCheck.addEventListener('change', () => {
      applyGhostImage(lastGhost, ghostImageCheck.checked);
    });
  }

  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn && !settingsBtn.contains(e.target)) {
      settingsPanel.classList.add('hidden');
      settingsBtn.classList.remove('active');
    }
    if (!speedMenu.contains(e.target) && e.target !== speedBtn) {
      speedMenu.classList.add('hidden');
    }
  });

  // ---------- Upload flow ----------
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      handleFile(fileInput.files[0]);
    }
  });

  // Drag & drop support
  ['dragover', 'drop'].forEach((evt) => {
    document.addEventListener(evt, (e) => e.preventDefault());
  });
  document.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) handleFile(file);
  });

  async function handleFile(file) {
    processingFile = true;
    videoControls.classList.add('hidden');
    dropHint.classList.add('hidden');
    uploadBtn.disabled = true;

    const detailLevel = parseInt(detailSlider.value, 10);
    const removeBackground = !!(removeBgCheck && removeBgCheck.checked);

    // Show the download overlay only once the user has uploaded, and only if
    // the background preload hasn't finished yet.
    if (removeBackground && !modelDownloadDone) {
      showModelLoading(modelDownloadPct, 'Downloading cutout model…');
      setStatus('Downloading cutout model… ' + modelDownloadPct + '%', true);
    } else {
      hideModelLoading();
      setStatus('Processing image…', true);
    }

    try {
      // Yield a frame so the "processing" status paints before heavy sync work.
      await new Promise((r) => setTimeout(r, 30));

      const result = await ImagePipeline.processImage(
        file,
        detailLevel,
        onPipelineProgress,
        { removeBackground }
      );

      hideModelLoading();

      if (result.stats.contours === 0) {
        setStatus('No clear edges found — try a higher-contrast image.', false);
        uploadBtn.disabled = false;
        return;
      }

      // Clear previous drawing.
      if (currentExpressionIds.length) {
        calculator.removeExpressions(currentExpressionIds.map((id) => ({ id })));
      }
      clearGhostImage();

      const built = DesmosBuilder.buildExpressions(result.polylines);
      const tExpr = DesmosBuilder.buildTExpression(0);

      calculator.setExpressions([tExpr, ...built.expressions]);
      // Pad math bounds to the calculator's pixel aspect so 1 x-unit == 1 y-unit
      // on screen (otherwise portrait/landscape images look stretched).
      calculator.setMathBounds(fitBoundsToViewport(result.bounds));

      lastGhost = result.ghost || null;
      applyGhostImage(lastGhost, !!(ghostImageCheck && ghostImageCheck.checked));

      currentExpressionIds = ['T', ...built.expressions.map((e) => e.id)];

      Player.init(calculator, built.total, onPlayerUpdate);
      videoControls.classList.remove('hidden');
      const cutoutNote = result.stats.cutout ? ' · AI cutout' : '';
      setStatus(
        `Drawing with ${result.stats.contours} equations · ${result.stats.points} points${cutoutNote}`,
        false
      );
      setTimeout(() => setStatus(null), 3200);

      Player.play();
    } catch (err) {
      console.error(err);
      hideModelLoading();
      setStatus('Something went wrong processing that image.', false);
    } finally {
      processingFile = false;
      hideModelLoading();
      uploadBtn.disabled = false;
    }
  }

  // ---------- Player <-> UI wiring ----------
  let lastKnownTotalSeconds = 1;

  function onPlayerUpdate(state) {
    lastKnownTotalSeconds = state.totalSeconds;
    const pct = state.totalSeconds > 0 ? (state.elapsed / state.totalSeconds) * 1000 : 0;
    if (!scrubbing) scrubBar.value = pct;
    timeCurrent.textContent = fmtTime(state.elapsed);
    timeTotal.textContent = fmtTime(state.totalSeconds);

    if (state.playing) {
      playIcon.style.display = 'none';
      pauseIcon.style.display = '';
    } else {
      playIcon.style.display = '';
      pauseIcon.style.display = 'none';
    }
  }

  playBtn.addEventListener('click', () => Player.toggle());
  back5Btn.addEventListener('click', () => Player.skip(-5));
  fwd5Btn.addEventListener('click', () => Player.skip(5));

  scrubBar.addEventListener('mousedown', () => { scrubbing = true; });
  scrubBar.addEventListener('touchstart', () => { scrubbing = true; });
  scrubBar.addEventListener('input', () => {
    const frac = parseFloat(scrubBar.value) / 1000;
    Player.seekSeconds(frac * lastKnownTotalSeconds);
  });
  function endScrub() {
    scrubbing = false;
  }
  scrubBar.addEventListener('mouseup', endScrub);
  scrubBar.addEventListener('touchend', endScrub);
  scrubBar.addEventListener('change', endScrub);

  // ---------- Speed menu ----------
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedMenu.classList.toggle('hidden');
  });
  speedMenu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = parseFloat(btn.dataset.speed);
      Player.setSpeed(val);
      speedBtn.textContent = (val === 1 ? '1' : val) + '×';
      speedMenu.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      speedMenu.classList.add('hidden');
    });
  });
})();
