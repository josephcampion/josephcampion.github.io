// Easter egg: press "k" and a constant-velocity Kalman filter tracks a noisy version of your cursor.
// Pressing "k" again steps the process noise Q (trust the model, balanced, trust the sensor), then turns it off.
(() => {
  const SIGMA = 18;             // px, measurement noise
  const R = SIGMA * SIGMA;
  const MEAS_DT = 1 / 15;
  // White-acceleration spectral density Q (px²/s³). Only Q/R matters: in steady state the filter is a
  // second-order low-pass with ωn = (Q / (R·Δt))^¼ and ζ = √2/2 whatever Q is. Each step is 100× Q.
  const MODES = [[3e3, 'TRUSTS THE MODEL'], [3e5, 'BALANCED'], [3e7, 'TRUSTS THE SENSOR']];
  const wn = (q) => Math.round((q / (R * MEAS_DT)) ** 0.25);
  let mode = 0, Q = MODES[0][0];
  try { mode = Math.min(MODES.length - 1, +sessionStorage.getItem('kalmanMode') || 0); Q = MODES[mode][0]; } catch {}
  const saveMode = () => { try { sessionStorage.setItem('kalmanMode', String(mode)); } catch {} };
  const MARK_LIFE = 1;          // s
  const COAST = 0.6;            // s of prediction after the pointer leaves; at the balanced Q, 2σ has grown to ~300 px by then
  const FADE = 0.4;             // s
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let lastMeas = 0;
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

  const frame = (ctx, t, dt, ptr, colors) => {
    const { pointer } = ptr;
    if (fx) { predict(fx, dt); predict(fy, dt); }
    if (pointer && t - lastMeas >= MEAS_DT) {
      lastMeas = t;
      const z = { x: pointer.x + SIGMA * gauss(), y: pointer.y + SIGMA * gauss(), t };
      marks.push(z);
      if (!fx) { fx = init(z.x); fy = init(z.y); } else { update(fx, z.x); update(fy, z.y); }
    }
    let alpha = 1;
    if (!pointer && ptr.leftAt) {
      const since = t - ptr.leftAt;
      alpha = Math.max(0, 1 - (since - COAST) / FADE);
      if (since > COAST + FADE) { fx = fy = null; trail = []; ptr.leftAt = 0; }
    }

    marks = marks.filter((m) => t - m.t < MARK_LIFE);
    const trailLife = reduced.matches ? 0.12 : 0.45;
    if (fx) trail.push({ x: fx.p, y: fy.p, t });
    trail = trail.filter((p) => t - p.t < trailLife);

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
    ctx.fillText(`x\u0302  \u03c9n ${wn(Q)}  2\u03c3=${Math.round(2 * Math.max(sx, sy))}px`, fx.p + 2 * sx + 6, fy.p - 2 * sy - 4);
    ctx.globalAlpha = 1;
  };

  window.fun.funToy({
    key: 'k',
    name: 'KALMAN CURSOR',
    global: 'kalmanCursor',
    frame,
    reset: () => { fx = fy = null; marks = []; trail = []; },
    onKey: ({ on, off, enabled }) => {
      if (!enabled) { mode = 0; on(true); }
      else if (mode < MODES.length - 1) mode++;
      else { off(); saveMode(); return; }
      Q = MODES[mode][0];
      saveMode();
      window.fun.toast(`KALMAN CURSOR \u2014 \u03c9n \u2248 ${wn(Q)} rad/s, ${MODES[mode][1]} \u2014 k to step`);
    },
  });
})();
