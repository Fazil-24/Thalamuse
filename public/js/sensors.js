// Raw sensing: device motion, scroll and touch, kept as timestamped samples so
// features can be computed over a rolling window. Nothing here leaves the phone.

export class Sensors {
  constructor() {
    this.scroll = []; // {t, y}
    this.motion = []; // {t, mag}
    this.touches = []; // {t, force, radius, durationMs}
    this.lastActivity = performance.now();
    this.raw = { accel: null, gravityFallback: false, rotation: null, touchForce: null, touchRadius: null };
    this.motionEvents = 0;
    this.permission = 'unknown'; // unknown | granted | denied | not-needed | unsupported
    this.forceSupported = false;
    this._gravity = null;
    this._touchStart = new Map();
  }

  get secure() {
    return window.isSecureContext;
  }

  // Must be called from a user gesture (tap) — iOS Safari rejects otherwise.
  async requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') {
      this.permission = 'unsupported';
      return this.permission;
    }
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        this.permission = await DeviceMotionEvent.requestPermission();
        if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
          await DeviceOrientationEvent.requestPermission().catch(() => {});
        }
      } else {
        this.permission = 'not-needed';
      }
    } catch (err) {
      console.warn('Motion permission request failed', err);
      this.permission = 'denied';
    }
    return this.permission;
  }

  start() {
    if (this._started) return;
    this._started = true;
    window.addEventListener('devicemotion', (e) => this._onMotion(e));
    window.addEventListener('deviceorientation', (e) => {
      this.raw.rotation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    });
    window.addEventListener('scroll', () => this._onScroll(), { passive: true });
    window.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
    window.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: true });
    window.addEventListener('touchcancel', (e) => this._onTouchEnd(e), { passive: true });
    this._onScroll();
  }

  _onMotion(e) {
    this.motionEvents++;
    const t = performance.now();
    let a = e.acceleration;
    if (!a || a.x == null) {
      // No gravity-free reading: high-pass the gravity-included one ourselves.
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      this.raw.gravityFallback = true;
      const k = 0.9;
      this._gravity = this._gravity
        ? { x: k * this._gravity.x + (1 - k) * g.x, y: k * this._gravity.y + (1 - k) * g.y, z: k * this._gravity.z + (1 - k) * g.z }
        : { x: g.x, y: g.y, z: g.z };
      a = { x: g.x - this._gravity.x, y: g.y - this._gravity.y, z: g.z - this._gravity.z };
    }
    this.raw.accel = { x: a.x, y: a.y, z: a.z };
    this.motion.push({ t, mag: Math.hypot(a.x, a.y, a.z) });
  }

  _onScroll() {
    const t = performance.now();
    this.scroll.push({ t, y: window.scrollY });
    this.lastActivity = t;
  }

  _onTouchStart(e) {
    const t = performance.now();
    this.lastActivity = t;
    for (const touch of e.changedTouches) {
      if (touch.force > 0 && touch.force < 1) this.forceSupported = true;
      this._touchStart.set(touch.identifier, { t, force: touch.force, radius: touch.radiusX || 0 });
      this.raw.touchForce = touch.force;
      this.raw.touchRadius = touch.radiusX;
    }
  }

  _onTouchEnd(e) {
    const t = performance.now();
    this.lastActivity = t;
    for (const touch of e.changedTouches) {
      const s = this._touchStart.get(touch.identifier);
      if (!s) continue;
      this._touchStart.delete(touch.identifier);
      this.touches.push({ t, force: s.force, radius: s.radius, durationMs: t - s.t });
    }
  }

  // Drop samples older than the window to keep memory flat.
  prune(windowMs) {
    const cutoff = performance.now() - windowMs;
    for (const arr of [this.scroll, this.motion, this.touches]) {
      let i = 0;
      while (i < arr.length - 1 && arr[i].t < cutoff) i++;
      if (i) arr.splice(0, i);
    }
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const variance = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

// Rolling-window features from the raw samples.
export function extractFeatures(sensors, cfg) {
  const now = performance.now();
  const from = now - cfg.windowMs;
  const rereadFrom = now - cfg.overloaded.rereadWindowMs;
  sensors.prune(Math.max(cfg.windowMs, cfg.overloaded.rereadWindowMs) + 1000);

  const sc = sensors.scroll.filter((s) => s.t >= Math.min(from, rereadFrom));
  let path = 0;
  let reversals = 0;
  let rereadPx = 0;
  let lastDir = 0;
  for (let i = 1; i < sc.length; i++) {
    const dy = sc[i].y - sc[i - 1].y;
    const dt = Math.max(1, sc[i].t - sc[i - 1].t);
    if (Math.abs(dy) < 2) continue;
    if (dy < 0 && sc[i].t >= rereadFrom && (Math.abs(dy) / dt) * 1000 < cfg.overloaded.rereadMaxVel) rereadPx += -dy;
    if (sc[i - 1].t < from) continue;
    path += Math.abs(dy);
    const dir = Math.sign(dy);
    if (lastDir && dir !== lastDir) reversals++;
    lastDir = dir;
  }
  const scrollVel = (path / cfg.windowMs) * 1000;

  const mags = sensors.motion.filter((m) => m.t >= from).map((m) => m.mag);
  const jitter = Math.sqrt(variance(mags));

  const tc = sensors.touches.filter((x) => x.t >= from);
  // Many Android browsers report force as 0 or 1 only; fall back to contact
  // radius (normalised to ~0..1) as a pressure proxy.
  const pressures = sensors.forceSupported ? tc.map((x) => x.force) : tc.map((x) => Math.min(1, x.radius / 40));
  const pressureVar = variance(pressures);

  return {
    scrollVel,
    reversals,
    rereadPx,
    jitter,
    motionSamples: mags.length,
    pressureVar,
    pressureSource: sensors.forceSupported ? 'force' : 'contact radius',
    touchCount: tc.length,
    meanTouchMs: mean(tc.map((x) => x.durationMs)),
    idleMs: now - sensors.lastActivity
  };
}
