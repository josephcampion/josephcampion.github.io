// Easter egg: press "k" and a constant-velocity Kalman filter tracks a noisy version of your cursor.
(() => {
  const SIGMA = 18;             // px, measurement noise
  const R = SIGMA * SIGMA;
  // White-acceleration spectral density (px²/s³). Hand movements accelerate hard, so this is large;
  // smaller values smooth more but lag visibly behind a fast flick.
  const Q = 3e5;
  const MEAS_DT = 1 / 15;
  const MARK_LIFE = 1;          // s
  const COAST = 0.6;            // s of prediction after the pointer leaves; 2σ has grown to ~300 px by then
  const FADE = 0.4;             // s
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let canvas, ctx, raf = 0, enabled = false, colors = {};
  let pointer = null, leftAt = 0, lastMeas = 0, lastFrame = 0;
  let marks = [], trail = [];
  // x and y are independent with identical noise, so the 4-state filter splits into two 2-state ones
  // and the cross-covariance stays zero: the 2×2 position block is diagonal and its eigenvalues are Pxx, Pyy.
  let fx = null, fy = null;

  const gauss = () => {
    let u = 0;
    while (!u) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  };

  const init = (z) => ({ p: z, v: 0, a: R, b: 0, c: 1e6 });
  const predict = (f, dt) => {
    f.p += f.v * dt;
    f.a += 2 * dt * f.b + dt * dt * f.c + (Q * dt * dt * dt) / 3;
    f.b += dt * f.c + (Q * dt * dt) / 2;
    f.c += Q * dt;
  };
  const update = (f, z) => {
    const s = f.a + R, k0 = f.a / s, k1 = f.b / s, y = z - f.p;
    f.p += k0 * y;
    f.v += k1 * y;
    f.c -= k1 * f.b;
    f.b -= k0 * f.b;
    f.a -= k0 * f.a;
  };

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    colors = { accent: get('--accent', 'currentColor'), muted: get('--muted', 'gray'), fg: get('--fg', 'black') };
  };

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const onMove = (e) => { pointer = { x: e.clientX, y: e.clientY }; leftAt = 0; };
  const onLeave = (e) => {
    if (e.type === 'pointerout' && e.relatedTarget) return;
    if (e.type === 'pointerup' && e.pointerType === 'mouse') return;
    if (pointer) { pointer = null; leftAt = performance.now() / 1000; }
  };

  const frame = (ms) => {
    raf = requestAnimationFrame(frame);
    const t = ms / 1000;
    const dt = Math.min(0.1, lastFrame ? t - lastFrame : 0);
    lastFrame = t;

    if (fx) { predict(fx, dt); predict(fy, dt); }
    if (pointer && t - lastMeas >= MEAS_DT) {
      lastMeas = t;
      const z = { x: pointer.x + SIGMA * gauss(), y: pointer.y + SIGMA * gauss(), t };
      marks.push(z);
      if (!fx) { fx = init(z.x); fy = init(z.y); } else { update(fx, z.x); update(fy, z.y); }
    }
    let alpha = 1;
    if (!pointer && leftAt) {
      const since = t - leftAt;
      alpha = Math.max(0, 1 - (since - COAST) / FADE);
      if (since > COAST + FADE) { fx = fy = null; trail = []; leftAt = 0; }
    }

    marks = marks.filter((m) => t - m.t < MARK_LIFE);
    const trailLife = reduced.matches ? 0.12 : 0.45;
    if (fx) trail.push({ x: fx.p, y: fy.p, t });
    trail = trail.filter((p) => t - p.t < trailLife);

    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = colors.muted;
    for (const m of marks) {
      ctx.globalAlpha = 0.8 * (1 - (t - m.t) / MARK_LIFE);
      ctx.beginPath();
      ctx.moveTo(m.x - 4, m.y - 4); ctx.lineTo(m.x + 4, m.y + 4);
      ctx.moveTo(m.x + 4, m.y - 4); ctx.lineTo(m.x - 4, m.y + 4);
      ctx.stroke();
    }
    if (!fx) return;

    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    for (let i = 1; i < trail.length; i++) {
      ctx.globalAlpha = alpha * 0.6 * (1 - (t - trail[i].t) / trailLife);
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }

    const sx = Math.sqrt(fx.a), sy = Math.sqrt(fy.a);
    ctx.globalAlpha = alpha * 0.9;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.ellipse(fx.p, fy.p, 2 * sx, 2 * sy, 0, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalAlpha = alpha;
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.arc(fx.p, fy.p, 4, 0, 2 * Math.PI);
    ctx.fill();

    ctx.globalAlpha = alpha * 0.75;
    ctx.fillStyle = colors.muted;
    ctx.font = '10px "B612 Mono", ui-monospace, monospace';
    ctx.fillText(`x\u0302  2\u03c3=${Math.round(2 * Math.max(sx, sy))}px`, fx.p + 2 * sx + 6, fy.p - 2 * sy - 4);
    ctx.globalAlpha = 1;
  };

  const toast = (text) => {
    const el = document.createElement('div');
    el.textContent = text;
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);z-index:2147483001;'
      + 'padding:0.45rem 0.8rem;font:0.75rem/1.4 var(--mono, monospace);letter-spacing:0.06em;'
      + 'color:var(--fg);background:var(--card);border:1px solid var(--accent);border-radius:4px;'
      + 'pointer-events:none;transition:opacity 0.4s;';
    document.body.append(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2000);
    setTimeout(() => el.remove(), 2500);
  };

  const save = () => { try { sessionStorage.setItem('kalmanCursor', enabled ? '1' : '0'); } catch {} };

  const on = (quiet) => {
    if (enabled) return;
    enabled = true;
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000;';
    document.body.append(canvas);
    ctx = canvas.getContext('2d');
    readColors();
    resize();
    addEventListener('resize', resize);
    addEventListener('pointermove', onMove, { passive: true });
    addEventListener('pointerdown', onMove, { passive: true });
    addEventListener('pointerout', onLeave, { passive: true });
    addEventListener('pointerup', onLeave, { passive: true });
    addEventListener('pointercancel', onLeave, { passive: true });
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
    save();
    if (quiet !== true) toast('KALMAN CURSOR ON \u2014 press k to turn off');
  };

  const off = () => {
    if (!enabled) return;
    enabled = false;
    cancelAnimationFrame(raf);
    removeEventListener('resize', resize);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerdown', onMove);
    removeEventListener('pointerout', onLeave);
    removeEventListener('pointerup', onLeave);
    removeEventListener('pointercancel', onLeave);
    canvas.remove();
    fx = fy = pointer = null;
    marks = []; trail = []; leftAt = 0;
    save();
    toast('KALMAN CURSOR OFF');
  };

  const toggle = () => (enabled ? off() : on());

  addEventListener('keydown', (e) => {
    if (e.key !== 'k' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target;
    if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    toggle();
  });
  document.addEventListener('themechange', () => enabled && readColors());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => enabled && readColors());

  window.kalmanCursor = { on: () => on(), off, toggle, get enabled() { return enabled; } };

  try { if (sessionStorage.getItem('kalmanCursor') === '1') on(true); } catch {}
})();
