/**
 * ImagePipeline
 * Turns an uploaded raster image into simplified polylines (Desmos graph
 * coordinates) that sketch the subject.
 *
 * Pipeline (cutout / BG-removal path):
 *   1) Optional in-browser AI cutout (@imgly/background-removal)
 *   2) XDoG + color-dodge stroke score inside the subject
 *   3) Threshold → close gaps → drop tiny blobs → Zhang–Suen thin
 *   4) Skeleton neighbor segments → chain → RDP → budget
 *
 * Isolines are avoided here: they turn soft anime shading into concentric
 * "topo" blobs. Thinning collapses real ink strokes to 1px centerlines.
 */
export const ImagePipeline = (function () {

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  function drawToCanvas(img, maxDim) {
    const longest = Math.max(img.width, img.height) || 1;
    const scale = Math.min(1, maxDim / longest);
    const w = Math.max(2, Math.round(img.width * scale));
    const h = Math.max(2, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Transparent clear so cutout alpha is preserved in getImageData.
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { w, h, imageData: ctx.getImageData(0, 0, w, h), canvas };
  }

  // Grayscale with alpha composited over white (so cutouts don't go black).
  function toGrayscale(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const a = data[i + 3] / 255;
      const r = data[i] * a + 255 * (1 - a);
      const g = data[i + 1] * a + 255 * (1 - a);
      const b = data[i + 2] * a + 255 * (1 - a);
      gray[p] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return gray;
  }

  function alphaMask(imageData, threshold) {
    threshold = threshold == null ? 12 : threshold;
    const { data, width, height } = imageData;
    const fg = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      fg[p] = data[i + 3] > threshold ? 1 : 0;
    }
    return fg;
  }

  /**
   * Keep the largest central foreground blob(s). Drops detached cutout
   * speckles that otherwise become stray outline "blobs" on the graph.
   */
  function keepMainForeground(rawFg, w, h, options) {
    const opts = options || {};
    const n = w * h;
    const labels = new Int32Array(n);
    labels.fill(-1);
    const comps = [];
    let label = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!rawFg[p] || labels[p] >= 0) continue;
        let area = 0, sx = 0, sy = 0;
        const q = [p];
        labels[p] = label;
        while (q.length) {
          const cur = q.pop();
          area++;
          const cx = cur % w;
          const cy = (cur - cx) / w;
          sx += cx; sy += cy;
          const nbs = [cur + 1, cur - 1, cur + w, cur - w];
          for (let t = 0; t < 4; t++) {
            const nb = nbs[t];
            if (nb < 0 || nb >= n) continue;
            const nx = nb % w;
            if (Math.abs(nx - cx) > 1) continue;
            if (!rawFg[nb] || labels[nb] >= 0) continue;
            labels[nb] = label;
            q.push(nb);
          }
        }
        comps.push({
          label,
          area,
          cx: sx / area,
          cy: sy / area,
        });
        label++;
      }
    }

    comps.sort((a, b) => b.area - a.area);
    const fg = new Uint8Array(n);
    if (!comps.length) return fg;

    const cx0 = w / 2, cy0 = h / 2;
    const minArea = opts.minArea != null ? opts.minArea : n * 0.008;
    const allowSecond = !!opts.allowSecond;
    let kept = 0;

    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      if (c.area < minArea) continue;
      const distC = Math.hypot(c.cx - cx0, c.cy - cy0);
      if (i > 0) {
        if (!allowSecond) break;
        if (c.area < n * 0.04 || distC > Math.min(w, h) * 0.4) continue;
      }
      for (let p = 0; p < n; p++) {
        if (labels[p] === c.label) fg[p] = 1;
      }
      kept++;
      if (i > 0) break;
    }

    if (opts.fallbackFill) {
      let fgCount = 0;
      for (let i = 0; i < n; i++) fgCount += fg[i];
      const ratio = fgCount / n;
      if (!kept || ratio < 0.06 || ratio > 0.92) fg.fill(1);
    }
    return fg;
  }

  // Zero alpha outside the subject so ghost / stroke don't keep cutout junk.
  function applyFgToImageData(imageData, fg) {
    const { data } = imageData;
    for (let p = 0, i = 0; p < fg.length; p++, i += 4) {
      if (!fg[p]) data[i + 3] = 0;
    }
  }

  // In-browser AI cutout (ONNX / WASM). First run downloads ~40MB model.
  // Dynamic import so Desmos can boot even if this package fails to load.
  let cutoutModulePromise = null;
  let cutoutPreloadPromise = null;
  let cutoutPreloadProgressCb = null;

  function getCutoutModule() {
    if (!cutoutModulePromise) {
      cutoutModulePromise = import('@imgly/background-removal');
    }
    return cutoutModulePromise;
  }

  function makeDownloadProgress(progressCb) {
    const report = (msg) => progressCb && progressCb(msg);
    const fetchTotals = Object.create(null);
    const fetchCurrents = Object.create(null);
    return {
      report,
      progress: (key, current, total) => {
        // Only surface model/WASM fetches — ignore compute:* steps.
        if (!total || current == null) return;
        if (typeof key !== 'string' || key.indexOf('fetch:') !== 0) return;
        fetchTotals[key] = total;
        fetchCurrents[key] = current;
        let sumCur = 0;
        let sumTot = 0;
        for (const k in fetchTotals) {
          sumTot += fetchTotals[k];
          sumCur += fetchCurrents[k] || 0;
        }
        if (!sumTot) return;
        const pct = Math.min(100, Math.round((sumCur / sumTot) * 100));
        report({ phase: 'download', pct, message: 'Downloading cutout model…' });
      },
    };
  }

  function cutoutConfig(progress) {
    return {
      // Quantized model: smaller download, fine for a fun static site.
      model: 'isnet_quint8',
      output: { format: 'image/png', type: 'foreground' },
      progress,
    };
  }

  // Kick off model/WASM fetch early (e.g. on tab load) so upload feels instant.
  function preloadCutoutModel(progressCb) {
    if (progressCb) cutoutPreloadProgressCb = progressCb;
    if (cutoutPreloadPromise) return cutoutPreloadPromise;

    const { report, progress } = makeDownloadProgress((msg) => {
      if (cutoutPreloadProgressCb) cutoutPreloadProgressCb(msg);
    });

    cutoutPreloadPromise = (async () => {
      try {
        const { preload } = await getCutoutModule();
        await preload(cutoutConfig(progress));
        report({ phase: 'download', pct: 100, message: 'Downloading cutout model…' });
      } catch (err) {
        console.warn('Cutout model preload failed:', err);
        cutoutPreloadPromise = null;
        throw err;
      }
    })();

    return cutoutPreloadPromise;
  }

  async function browserCutout(file, progressCb) {
    const { report, progress } = makeDownloadProgress(progressCb);

    // Finish any boot-time preload first (shares cache / in-flight fetches).
    if (cutoutPreloadPromise) {
      const prevCb = cutoutPreloadProgressCb;
      cutoutPreloadProgressCb = progressCb;
      try {
        await cutoutPreloadPromise;
      } catch (_) {
        // removeBackground below will retry download if needed
      } finally {
        cutoutPreloadProgressCb = prevCb;
      }
    } else {
      report({ phase: 'download', pct: 0, message: 'Downloading cutout model…' });
    }

    const { removeBackground } = await getCutoutModule();
    const config = cutoutConfig(progress);
    try {
      return await removeBackground(file, { ...config, device: 'gpu' });
    } catch (err) {
      console.warn('GPU cutout failed, retrying on CPU:', err);
      report('Retrying cutout on CPU…');
      return removeBackground(file, { ...config, device: 'cpu' });
    }
  }

  function percentileValue(field, p, mask) {
    const vals = [];
    if (mask) {
      for (let i = 0; i < field.length; i++) if (mask[i]) vals.push(field[i]);
    } else {
      for (let i = 0; i < field.length; i++) vals.push(field[i]);
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    const idx = Math.min(vals.length - 1, Math.max(0, Math.floor(p * (vals.length - 1))));
    return vals[idx];
  }

  function contrastStretch(gray, loP, hiP, mask) {
    const lo = percentileValue(gray, loP, mask);
    const hi = percentileValue(gray, hiP, mask);
    const span = Math.max(1e-3, hi - lo);
    const out = new Float32Array(gray.length);
    for (let i = 0; i < gray.length; i++) {
      out[i] = Math.max(0, Math.min(255, ((gray[i] - lo) / span) * 255));
    }
    return out;
  }

  function boxBlur(src, w, h, radius) {
    if (radius <= 0) return src;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w) { sum += src[rowOff + xx]; count++; }
        }
        tmp[rowOff + x] = sum / count;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let sum = 0, count = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h) { sum += tmp[yy * w + x]; count++; }
        }
        out[y * w + x] = sum / count;
      }
    }
    return out;
  }

  // Morphological dilate/erode with a square kernel (odd size).
  function morph(src, w, h, radius, mode) {
    if (radius <= 0) return src;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = mode === 'min' ? 1 : 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const s = src[yy * w + xx];
            if (mode === 'max') { if (s) v = 1; }
            else { if (!s) v = 0; }
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    const copy = arr.slice().sort((a, b) => a - b);
    return copy[Math.floor(copy.length / 2)];
  }

  /**
   * Subject matte: classify border-like / high-chroma BG pixels, flood from
   * the frame edge through them, dilate to eat fringes, then keep the largest
   * central foreground blob. Returns Uint8Array: 1 = subject.
   */
  function foregroundMask(imageData, w, h) {
    const { data } = imageData;
    const n = w * h;
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    const dist = new Float32Array(n);
    const sat = new Float32Array(n);
    const chromaDom = new Float32Array(n);

    for (let p = 0, i = 0; p < n; p++, i += 4) {
      r[p] = data[i];
      g[p] = data[i + 1];
      b[p] = data[i + 2];
      const mx = Math.max(r[p], g[p], b[p]);
      const mn = Math.min(r[p], g[p], b[p]);
      sat[p] = mx > 1e-3 ? (mx - mn) / mx : 0;
      // Strongest channel dominance (petals, skies, etc.).
      chromaDom[p] = mx - Math.max(mn, (r[p] + g[p] + b[p] - mx) / 2);
    }

    const band = Math.max(3, Math.floor(Math.min(w, h) * 0.05));
    const borderIdx = [];
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < band; y++) borderIdx.push(y * w + x);
      for (let y = h - band; y < h; y++) borderIdx.push(y * w + x);
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < band; x++) borderIdx.push(y * w + x);
      for (let x = w - band; x < w; x++) borderIdx.push(y * w + x);
    }

    const brs = [], bgs = [], bbs = [], bsats = [], bdoms = [];
    for (let k = 0; k < borderIdx.length; k++) {
      const p = borderIdx[k];
      brs.push(r[p]); bgs.push(g[p]); bbs.push(b[p]);
      bsats.push(sat[p]); bdoms.push(chromaDom[p]);
    }
    const br = medianOf(brs), bgc = medianOf(bgs), bb = medianOf(bbs);
    const borderSat = medianOf(bsats);
    const borderDom = medianOf(bdoms);

    for (let p = 0; p < n; p++) {
      dist[p] = Math.hypot(r[p] - br, g[p] - bgc, b[p] - bb);
    }
    const nearThr = percentileValue(dist, 0.50);
    const petalDistThr = percentileValue(dist, 0.85);
    const satThr = Math.max(0.10, borderSat * 0.45);
    const domThr = Math.max(14, borderDom * 0.55);

    const bgLike = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const near = dist[p] <= nearThr;
      const texturedBg =
        chromaDom[p] >= domThr &&
        sat[p] >= satThr &&
        dist[p] <= petalDistThr;
      bgLike[p] = near || texturedBg ? 1 : 0;
    }
    // Force frame edge as background seeds.
    for (let x = 0; x < w; x++) {
      bgLike[x] = 1;
      bgLike[(h - 1) * w + x] = 1;
    }
    for (let y = 0; y < h; y++) {
      bgLike[y * w] = 1;
      bgLike[y * w + (w - 1)] = 1;
    }

    const bg = new Uint8Array(n);
    const seen = new Uint8Array(n);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push(x, 0, x, h - 1);
    for (let y = 0; y < h; y++) stack.push(0, y, w - 1, y);

    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const p = y * w + x;
      if (seen[p]) continue;
      seen[p] = 1;
      if (!bgLike[p]) continue;
      bg[p] = 1;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }

    // Eat petal fringes that still touch the subject.
    let matte = bg;
    for (let i = 0; i < 4; i++) matte = morph(matte, w, h, 1, 'max');

    // Connected components on remaining foreground; keep largest central blob.
    const rawFg = new Uint8Array(n);
    for (let i = 0; i < n; i++) rawFg[i] = matte[i] ? 0 : 1;
    return keepMainForeground(rawFg, w, h, { allowSecond: true, fallbackFill: true });
  }

  // Color-dodge pencil sketch; higher ink = stronger dark stroke.
  function dodgeInk(gray, w, h, blurRadius) {
    const blurred = boxBlur(gray, w, h, blurRadius);
    const ink = new Float32Array(gray.length);
    for (let i = 0; i < gray.length; i++) {
      const dodge = Math.min(255, (gray[i] * 255) / Math.max(1, blurred[i]));
      ink[i] = 255 - dodge;
    }
    return ink;
  }

  // XDoG-style edge emphasis (artistic line extraction). Higher = stronger stroke.
  function xdogEdges(gray, w, h, sigma, k, phi) {
    sigma = sigma == null ? 1.0 : sigma;
    k = k == null ? 1.6 : k;
    phi = phi == null ? 0.98 : phi;
    const g1 = boxBlur(gray, w, h, Math.max(1, Math.round(sigma)));
    const g2 = boxBlur(gray, w, h, Math.max(1, Math.round(sigma * k)));
    const out = new Float32Array(gray.length);
    for (let i = 0; i < gray.length; i++) {
      const dog = g1[i] - phi * g2[i];
      out[i] = dog < 0 ? -dog : 0;
    }
    return out;
  }

  // Stroke score: edge-like DoG + dodge ink (not filled dark regions).
  function strokeScore(gray, w, h, fg, inkBlur) {
    const edges = xdogEdges(gray, w, h, 1.0, 1.6, 0.98);
    const ink = dodgeInk(gray, w, h, inkBlur == null ? 2 : inkBlur);
    const score = new Float32Array(gray.length);
    let p99 = 0;
    const vals = [];
    for (let i = 0; i < gray.length; i++) {
      if (!fg[i]) continue;
      vals.push(edges[i]);
    }
    if (vals.length) {
      vals.sort((a, b) => a - b);
      p99 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))] || 1;
    }
    const inv = 255 / Math.max(1e-3, p99);
    for (let i = 0; i < gray.length; i++) {
      if (!fg[i]) { score[i] = 0; continue; }
      score[i] = 0.7 * Math.min(255, edges[i] * inv) + 0.3 * ink[i];
    }
    return score;
  }

  function thresholdMask(score, fg, percentile) {
    const thr = Math.max(8, percentileValue(score, percentile, fg));
    const out = new Uint8Array(score.length);
    for (let i = 0; i < score.length; i++) {
      out[i] = fg[i] && score[i] >= thr ? 1 : 0;
    }
    return out;
  }

  // Keep strong strokes + weak ink that touches them (closes hairline gaps).
  function hysteresisMask(score, fg, w, h, highP, lowP) {
    const hi = Math.max(10, percentileValue(score, highP, fg));
    const lo = Math.max(4, Math.min(hi * 0.6, percentileValue(score, lowP, fg)));
    const n = w * h;
    const out = new Uint8Array(n);
    const weak = new Uint8Array(n);
    const stack = new Int32Array(n);
    let top = 0;
    for (let i = 0; i < n; i++) {
      if (!fg[i]) continue;
      if (score[i] >= hi) {
        out[i] = 1;
        stack[top++] = i;
      } else if (score[i] >= lo) {
        weak[i] = 1;
      }
    }
    const dxy = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    while (top) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      for (let d = 0; d < 8; d++) {
        const nx = x + dxy[d][0];
        const ny = y + dxy[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!weak[q] || out[q]) continue;
        out[q] = 1;
        weak[q] = 0;
        stack[top++] = q;
      }
    }
    return out;
  }

  // Connect nearby skeleton endpoints so strokes don't stop mid-hair.
  function bridgeSkeletonGaps(skel, w, h, maxDist) {
    maxDist = maxDist == null ? 4 : maxDist;
    const out = new Uint8Array(skel);
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

    function deg(x, y) {
      let c = 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + dirs[d][0], ny = y + dirs[d][1];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && out[ny * w + nx]) c++;
      }
      return c;
    }

    function tangent(x, y) {
      // Direction from the single neighbor toward the endpoint (outward).
      for (let d = 0; d < 8; d++) {
        const nx = x + dirs[d][0], ny = y + dirs[d][1];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && out[ny * w + nx]) {
          return { x: x - nx, y: y - ny };
        }
      }
      return { x: 0, y: 0 };
    }

    function drawLine(x0, y0, x1, y1) {
      let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
      let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        out[y0 * w + x0] = 1;
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }

    const ends = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (out[y * w + x] && deg(x, y) === 1) ends.push({ x, y });
      }
    }

    const used = new Uint8Array(ends.length);
    const maxDistSq = maxDist * maxDist;
    for (let i = 0; i < ends.length; i++) {
      if (used[i]) continue;
      const a = ends[i];
      const ta = tangent(a.x, a.y);
      let best = -1, bestD = maxDistSq + 1;
      for (let j = i + 1; j < ends.length; j++) {
        if (used[j]) continue;
        const b = ends[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 2 || d2 > maxDistSq) continue;
        // Prefer pairs that face each other roughly along the stroke.
        const tb = tangent(b.x, b.y);
        const toward = dx * ta.x + dy * ta.y;
        const towardB = -dx * tb.x + -dy * tb.y;
        if (toward < 0 && towardB < 0) continue;
        if (d2 < bestD) { bestD = d2; best = j; }
      }
      if (best < 0) continue;
      used[i] = 1;
      used[best] = 1;
      drawLine(a.x, a.y, ends[best].x, ends[best].y);
    }
    return out;
  }

  // Join open polylines whose endpoints nearly touch.
  function mergeNearbyPolylines(polylines, maxDist) {
    maxDist = maxDist == null ? 3.5 : maxDist;
    const polys = polylines.map((p) => p.slice());
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < polys.length; i++) {
        const a = polys[i];
        if (!a || a.length < 2) continue;
        const aEnds = [a[0], a[a.length - 1]];
        for (let j = i + 1; j < polys.length; j++) {
          const b = polys[j];
          if (!b || b.length < 2) continue;
          const bEnds = [b[0], b[b.length - 1]];
          let best = null;
          for (let ae = 0; ae < 2; ae++) {
            for (let be = 0; be < 2; be++) {
              const d = Math.hypot(aEnds[ae].x - bEnds[be].x, aEnds[ae].y - bEnds[be].y);
              if (d <= maxDist && (!best || d < best.d)) best = { ae, be, d };
            }
          }
          if (!best) continue;
          let left = a, right = b;
          // Orient so we append right onto left.
          if (best.ae === 0) left = a.slice().reverse();
          if (best.be === 1) right = b.slice().reverse();
          const joined = left.concat(right.slice(1));
          polys[i] = joined;
          polys[j] = null;
          merged = true;
          break;
        }
        if (merged) break;
      }
      // compact
      if (merged) {
        for (let k = polys.length - 1; k >= 0; k--) if (!polys[k]) polys.splice(k, 1);
      }
    }
    return polys.filter(Boolean);
  }

  // Keep connected components above a minimum pixel area.
  function filterSmallComponents(bin, w, h, minArea) {
    const n = w * h;
    const seen = new Uint8Array(n);
    const out = new Uint8Array(n);
    const stack = new Int32Array(n);
    const dirs = [1, -1, w, -w, w + 1, w - 1, -w + 1, -w - 1];
    for (let i = 0; i < n; i++) {
      if (!bin[i] || seen[i]) continue;
      let top = 0;
      stack[top++] = i;
      seen[i] = 1;
      const comp = [];
      while (top) {
        const p = stack[--top];
        comp.push(p);
        const x = p % w;
        const y = (p - x) / w;
        for (let d = 0; d < 8; d++) {
          const q = p + dirs[d];
          if (q < 0 || q >= n) continue;
          const qx = q % w;
          const qy = (q - qx) / w;
          if (Math.abs(qx - x) > 1 || Math.abs(qy - y) > 1) continue;
          if (!bin[q] || seen[q]) continue;
          seen[q] = 1;
          stack[top++] = q;
        }
      }
      if (comp.length < minArea) continue;
      for (let k = 0; k < comp.length; k++) out[comp[k]] = 1;
    }
    return out;
  }

  // Zhang–Suen thinning → 1px skeleton.
  function zhangSuenThin(bin, w, h) {
    const img = new Uint8Array(bin);
    const marker = new Uint8Array(w * h);
    let changed = true;
    let iters = 0;
    while (changed && iters < 80) {
      changed = false;
      iters++;
      for (let step = 0; step < 2; step++) {
        marker.fill(0);
        let marked = 0;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!img[i]) continue;
            const p2 = img[(y - 1) * w + x];
            const p3 = img[(y - 1) * w + x + 1];
            const p4 = img[y * w + x + 1];
            const p5 = img[(y + 1) * w + x + 1];
            const p6 = img[(y + 1) * w + x];
            const p7 = img[(y + 1) * w + x - 1];
            const p8 = img[y * w + x - 1];
            const p9 = img[(y - 1) * w + x - 1];
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            let A = 0;
            const n = [p2, p3, p4, p5, p6, p7, p8, p9];
            for (let k = 0; k < 8; k++) if (!n[k] && n[(k + 1) & 7]) A++;
            if (A !== 1) continue;
            if (step === 0) {
              if (p2 * p4 * p6) continue;
              if (p4 * p6 * p8) continue;
            } else {
              if (p2 * p4 * p8) continue;
              if (p2 * p6 * p8) continue;
            }
            marker[i] = 1;
            marked++;
          }
        }
        if (marked) {
          changed = true;
          for (let i = 0; i < marker.length; i++) if (marker[i]) img[i] = 0;
        }
      }
    }
    return img;
  }

  // Turn a 1px skeleton into segments (half-neighborhood) then chain.
  function traceSkeleton(skel, w, h) {
    const segs = [];
    // Right / down / diagonals only — each bond once.
    const half = [[1, 0], [1, 1], [0, 1], [-1, 1]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!skel[y * w + x]) continue;
        for (let d = 0; d < half.length; d++) {
          const nx = x + half[d][0];
          const ny = y + half[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!skel[ny * w + nx]) continue;
          segs.push([{ x, y }, { x: nx, y: ny }]);
        }
      }
    }
    return chainSegments(segs);
  }

  // Inner silhouette rim (stays inside FG so coverage filters keep it).
  function silhouetteRim(fg, w, h) {
    const ero = morph(fg, w, h, 1, 'min');
    const rim = new Uint8Array(w * h);
    for (let i = 0; i < rim.length; i++) rim[i] = fg[i] && !ero[i] ? 1 : 0;
    return rim;
  }

  function marchingSquares(field, w, h, threshold) {
    const segs = [];

    function edgePoint(v0, v1, x0, y0, x1, y1) {
      let t = (threshold - v0) / (v1 - v0);
      if (!isFinite(t)) t = 0.5;
      t = Math.max(0, Math.min(1, t));
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
    }

    for (let j = 0; j < h - 1; j++) {
      for (let i = 0; i < w - 1; i++) {
        const va = field[j * w + i];
        const vb = field[j * w + i + 1];
        const vc = field[(j + 1) * w + i + 1];
        const vd = field[(j + 1) * w + i];
        const a = va >= threshold ? 1 : 0;
        const b = vb >= threshold ? 1 : 0;
        const c = vc >= threshold ? 1 : 0;
        const d = vd >= threshold ? 1 : 0;
        const caseIdx = a | (b << 1) | (c << 2) | (d << 3);
        if (caseIdx === 0 || caseIdx === 15) continue;

        const T = () => edgePoint(va, vb, i, j, i + 1, j);
        const R = () => edgePoint(vb, vc, i + 1, j, i + 1, j + 1);
        const B = () => edgePoint(vd, vc, i, j + 1, i + 1, j + 1);
        const L = () => edgePoint(va, vd, i, j, i, j + 1);

        switch (caseIdx) {
          case 1: segs.push([L(), T()]); break;
          case 2: segs.push([T(), R()]); break;
          case 3: segs.push([L(), R()]); break;
          case 4: segs.push([R(), B()]); break;
          case 5: segs.push([L(), T()]); segs.push([R(), B()]); break;
          case 6: segs.push([T(), B()]); break;
          case 7: segs.push([L(), B()]); break;
          case 8: segs.push([B(), L()]); break;
          case 9: segs.push([T(), B()]); break;
          case 10: segs.push([T(), R()]); segs.push([B(), L()]); break;
          case 11: segs.push([R(), B()]); break;
          case 12: segs.push([L(), R()]); break;
          case 13: segs.push([T(), R()]); break;
          case 14: segs.push([T(), L()]); break;
        }
      }
    }
    return segs;
  }

  function chainSegments(segs) {
    const key = (p) => Math.round(p.x * 32) + ',' + Math.round(p.y * 32);
    const pointMap = new Map();
    segs.forEach((seg, idx) => {
      [0, 1].forEach((end) => {
        const k = key(seg[end]);
        if (!pointMap.has(k)) pointMap.set(k, []);
        pointMap.get(k).push({ segIdx: idx, end });
      });
    });

    const used = new Array(segs.length).fill(false);
    const polylines = [];

    for (let idx = 0; idx < segs.length; idx++) {
      if (used[idx]) continue;
      used[idx] = true;
      const poly = [segs[idx][0], segs[idx][1]];

      let extending = true;
      while (extending) {
        extending = false;
        const candidates = pointMap.get(key(poly[poly.length - 1])) || [];
        for (const cand of candidates) {
          if (!used[cand.segIdx]) {
            used[cand.segIdx] = true;
            poly.push(segs[cand.segIdx][cand.end === 0 ? 1 : 0]);
            extending = true;
            break;
          }
        }
      }

      extending = true;
      while (extending) {
        extending = false;
        const candidates = pointMap.get(key(poly[0])) || [];
        for (const cand of candidates) {
          if (!used[cand.segIdx]) {
            used[cand.segIdx] = true;
            poly.unshift(segs[cand.segIdx][cand.end === 0 ? 1 : 0]);
            extending = true;
            break;
          }
        }
      }

      polylines.push(poly);
    }
    return polylines;
  }

  function perpendicularDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function simplifyRDP(points, epsilon) {
    if (points.length < 3) return points.slice();
    function rdp(pts) {
      if (pts.length < 3) return pts;
      let maxDist = 0, index = 0;
      const a = pts[0], b = pts[pts.length - 1];
      for (let i = 1; i < pts.length - 1; i++) {
        const d = perpendicularDistance(pts[i], a, b);
        if (d > maxDist) { maxDist = d; index = i; }
      }
      if (maxDist > epsilon) {
        const left = rdp(pts.slice(0, index + 1));
        const right = rdp(pts.slice(index));
        return left.slice(0, -1).concat(right);
      }
      return [a, b];
    }
    return rdp(points);
  }

  function polylineLength(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return len;
  }

  function isClosed(points, tol) {
    const a = points[0], b = points[points.length - 1];
    return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  }

  // Simple / Balanced / Detail — stroke threshold & budget (not isolines).
  // strokePercentile: higher → fewer, stronger lines only.
  // smallLoop must stay modest — eyes/headphones are closed loops.
  const DETAIL_PRESETS = [
    {
      maxDim: 320,
      strokeHighP: 0.88,
      strokeLowP: 0.72,
      inkBlur: 2,
      bridgeDist: 5,
      mergeDist: 4,
      minComponentFactor: 0.00018,
      includeSilhouette: true,
      epsilon: 1.45,
      minLenFactor: 0.022,
      smallLoopFactor: 0.07,
      maxContours: 80,
      maxTotalPoints: 3200,
      minFgCoverage: 0.3,
      internalLevels: [0.38, 0.58],
      structBlur: 2,
    },
    {
      maxDim: 400,
      strokeHighP: 0.84,
      strokeLowP: 0.66,
      inkBlur: 2,
      bridgeDist: 6,
      mergeDist: 4.5,
      minComponentFactor: 0.00012,
      includeSilhouette: true,
      epsilon: 1.15,
      minLenFactor: 0.016,
      smallLoopFactor: 0.055,
      maxContours: 160,
      maxTotalPoints: 6000,
      minFgCoverage: 0.25,
      internalLevels: [0.32, 0.48, 0.64],
      structBlur: 2,
    },
    {
      maxDim: 480,
      strokeHighP: 0.80,
      strokeLowP: 0.60,
      inkBlur: 2,
      bridgeDist: 7,
      mergeDist: 5,
      minComponentFactor: 0.00008,
      includeSilhouette: true,
      epsilon: 0.95,
      minLenFactor: 0.012,
      smallLoopFactor: 0.045,
      maxContours: 220,
      maxTotalPoints: 9000,
      minFgCoverage: 0.2,
      internalLevels: [0.28, 0.42, 0.56, 0.7],
      structBlur: 1,
    },
  ];

  function contourFgCoverage(points, fg, w, h) {
    if (!points.length) return 0;
    const step = Math.max(1, Math.floor(points.length / 16));
    let ok = 0, n = 0;
    for (let i = 0; i < points.length; i += step) {
      n++;
      const x = Math.round(points[i].x);
      const y = Math.round(points[i].y);
      if (x >= 0 && y >= 0 && x < w && y < h && fg[y * w + x]) ok++;
    }
    return n ? ok / n : 0;
  }

  // Smooth binary mask: close holes, then open speckles, then slight blur field.
  function smoothMask(fg, w, h) {
    let m = morph(fg, w, h, 1, 'max');
    m = morph(m, w, h, 1, 'min');
    m = morph(m, w, h, 1, 'min');
    m = morph(m, w, h, 1, 'max');
    return m;
  }

  function maskToField(fg) {
    const field = new Float32Array(fg.length);
    for (let i = 0; i < fg.length; i++) field[i] = fg[i] ? 255 : 0;
    return field;
  }

  function selectPolylines(polylines, preset, fg, w, h, requireFg) {
    const diag = Math.hypot(w, h);
    const minLen = diag * preset.minLenFactor;
    const smallLoop = diag * preset.smallLoopFactor;
    const scored = [];
    for (let i = 0; i < polylines.length; i++) {
      const simplified = simplifyRDP(polylines[i], preset.epsilon);
      const len = polylineLength(simplified);
      if (simplified.length < 4 || len < minLen) continue;
      if (isClosed(simplified, 3) && len < smallLoop) continue;
      if (requireFg && contourFgCoverage(simplified, fg, w, h) < preset.minFgCoverage) continue;
      scored.push({ score: len, points: simplified });
    }
    scored.sort((a, b) => b.score - a.score);
    const selected = [];
    let totalPts = 0;
    for (let i = 0; i < scored.length; i++) {
      const p = scored[i].points;
      if (selected.length >= preset.maxContours) break;
      if (totalPts + p.length > preset.maxTotalPoints) continue;
      selected.push(p);
      totalPts += p.length;
    }
    selected.sort((a, b) => (a[0].y - b[0].y) || (a[0].x - b[0].x));
    return { selected, totalPts };
  }

  async function processImage(file, detailLevel, progressCb, options) {
    const opts = options || {};
    const removeBackground = opts.removeBackground !== false;
    const preset = DETAIL_PRESETS[Math.max(0, Math.min(2, detailLevel))];
    const report = (msg) => progressCb && progressCb(msg);

    let source = file;
    let usedCutout = false;
    if (removeBackground) {
      try {
        source = await browserCutout(file, report);
        usedCutout = true;
        report('Background removed…');
      } catch (err) {
        console.warn('Browser cutout failed, using local matte:', err);
        report('Cutout failed — using local matte…');
      }
    }

    report('Loading image…');
    const img = await loadImage(source);

    report('Analyzing pixels…');
    const { w, h, imageData, canvas } = drawToCanvas(img, preset.maxDim);
    let fg;
    if (!removeBackground) {
      fg = new Uint8Array(w * h).fill(1);
    } else if (usedCutout) {
      // AI cutout often leaves small alpha islands (hands, fringe, noise).
      // Keep only the main subject before stroking / silhouetting.
      const rawAlpha = smoothMask(alphaMask(imageData, 24), w, h);
      fg = keepMainForeground(rawAlpha, w, h, {
        allowSecond: false,
        fallbackFill: false,
        minArea: w * h * 0.01,
      });
      let kept = 0;
      for (let i = 0; i < fg.length; i++) kept += fg[i];
      if (!kept) fg = rawAlpha;
      applyFgToImageData(imageData, fg);
      canvas.getContext('2d').putImageData(imageData, 0, 0);
    } else {
      fg = smoothMask(foregroundMask(imageData, w, h), w, h);
    }
    const gray = toGrayscale(imageData);

    report('Extracting line art…');
    let polylines = [];
    const stretched = contrastStretch(gray, 0.02, 0.98, removeBackground ? fg : null);

    if (usedCutout || removeBackground) {
      // Thin stroke centerlines (not luminance isolines).
      const score = strokeScore(stretched, w, h, fg, preset.inkBlur);
      const highP = preset.strokeHighP != null ? preset.strokeHighP : 0.84;
      const lowP = preset.strokeLowP != null ? preset.strokeLowP : 0.66;
      let binary = hysteresisMask(score, fg, w, h, highP, lowP);
      // Close small breaks in the ink, then open speckles.
      binary = morph(binary, w, h, 1, 'max');
      binary = morph(binary, w, h, 1, 'max');
      binary = morph(binary, w, h, 1, 'min');
      binary = morph(binary, w, h, 1, 'min');
      const minArea = Math.max(8, Math.floor(w * h * (preset.minComponentFactor || 0.00012)));
      binary = filterSmallComponents(binary, w, h, minArea);

      report('Thinning strokes…');
      let thin = zhangSuenThin(binary, w, h);
      thin = bridgeSkeletonGaps(thin, w, h, preset.bridgeDist || 6);
      polylines = polylines.concat(traceSkeleton(thin, w, h));

      if (preset.includeSilhouette !== false) {
        const rim = silhouetteRim(fg, w, h);
        polylines = polylines.concat(traceSkeleton(rim, w, h));
      }

      polylines = mergeNearbyPolylines(polylines, preset.mergeDist || 4.5);
    } else {
      // No BG removal: soft luminance isolines over the whole image.
      report('Tracing contours…');
      const soft = boxBlur(stretched, w, h, preset.structBlur + 1);
      const levels = (preset.internalLevels && preset.internalLevels.length)
        ? preset.internalLevels
        : [0.4, 0.6];
      for (let t = 0; t < levels.length; t++) {
        const thr = percentileValue(soft, levels[t]);
        polylines = polylines.concat(chainSegments(marchingSquares(soft, w, h, thr)));
      }
    }

    report('Simplifying paths…');
    const { selected, totalPts } = selectPolylines(
      polylines,
      preset,
      fg,
      w,
      h,
      removeBackground
    );

    const targetSpan = 16;
    const scale = targetSpan / Math.max(w, h);
    const offsetX = w / 2, offsetY = h / 2;
    const graphPolylines = selected.map((poly) => poly.map((pt) => ({
      x: (pt.x - offsetX) * scale,
      y: -(pt.y - offsetY) * scale,
    })));

    const halfW = (w * scale) / 2 + 1.5;
    const halfH = (h * scale) / 2 + 1.5;
    const bounds = { left: -halfW, right: halfW, bottom: -halfH, top: halfH };

    // Faint reference image aligned with the polylines (Desmos image expression).
    const ghost = {
      imageUrl: canvas.toDataURL('image/png'),
      width: w * scale,
      height: h * scale,
      center: '(0,0)',
    };

    return {
      polylines: graphPolylines,
      bounds,
      ghost,
      stats: {
        contours: graphPolylines.length,
        points: totalPts,
        width: w,
        height: h,
        cutout: usedCutout,
      },
    };
  }

  return { processImage, preloadCutoutModel };
})();
