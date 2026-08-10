/**
 * Player
 * Drives the drawing animation like a video player: play/pause, seek,
 * skip ±5s, and variable playback speed. Internally it just walks a
 * "T" value from 0..totalPoints and pushes it into the Desmos calculator,
 * which does the actual redrawing via the filtered list expressions.
 */
export const Player = (function () {
  let calculator = null;
  let totalPoints = 0;
  let totalSeconds = 1;
  let pointsPerSecond = 1;

  let elapsed = 0;     // seconds, independent of speed
  let playing = false;
  let speed = 1;
  let rafId = null;
  let lastTs = null;
  let onUpdate = null;

  const MIN_DURATION = 6;
  const MAX_DURATION = 26;
  const RATE_POINTS_PER_SEC = 260; // nominal pacing at 1x

  function init(calc, total, cb) {
    calculator = calc;
    totalPoints = Math.max(total, 1);
    onUpdate = cb;
    totalSeconds = Math.min(MAX_DURATION, Math.max(MIN_DURATION, totalPoints / RATE_POINTS_PER_SEC));
    pointsPerSecond = totalPoints / totalSeconds;
    elapsed = 0;
    playing = false;
    speed = 1;
    pushT();
    notify();
  }

  function pushT() {
    if (!calculator) return;
    const t = Math.min(totalPoints, Math.max(0, elapsed * pointsPerSecond));
    calculator.setExpression({ id: 'T', latex: `T=${t.toFixed(2)}` });
  }

  function notify() {
    if (onUpdate) {
      onUpdate({
        elapsed,
        totalSeconds,
        playing,
        speed,
      });
    }
  }

  function frame(ts) {
    if (!playing) { rafId = null; return; }
    if (lastTs == null) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    elapsed += dt * speed;
    if (elapsed >= totalSeconds) {
      elapsed = totalSeconds;
      playing = false;
    }
    pushT();
    notify();
    if (playing) {
      rafId = requestAnimationFrame(frame);
    } else {
      rafId = null;
    }
  }

  function play() {
    if (playing || !calculator) return;
    if (elapsed >= totalSeconds) elapsed = 0;
    playing = true;
    lastTs = null;
    notify();
    rafId = requestAnimationFrame(frame);
  }

  function pause() {
    playing = false;
    notify();
  }

  function toggle() {
    if (playing) pause(); else play();
  }

  function seekSeconds(s) {
    elapsed = Math.max(0, Math.min(totalSeconds, s));
    pushT();
    notify();
  }

  function skip(deltaSeconds) {
    seekSeconds(elapsed + deltaSeconds);
  }

  function setSpeed(s) {
    speed = s;
    notify();
  }

  function isReady() {
    return !!calculator;
  }

  return { init, play, pause, toggle, seekSeconds, skip, setSpeed, isReady };
})();
