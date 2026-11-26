import { Arm, ReachTask, solveIK, clampGoal, moveDuration, DEG } from './sim.js';

const DT = 0.002;
const HISTORY_S = 10;         // seconds on the strip chart
const IDLE_MS = 15000;        // resume the tour if nobody has touched it for this long
const DWELL_MS = 1200;        // pause at each tour stop
const TRAIL_MS = 2000;
const ERR_SPAN = 0.010;       // m, half-height of the error chart
const R_MAX = 0.62;
const FLOOR_Y = -0.70;
// Near full extension, low, high, then back to mid.
const TOUR = [[0.60, 0.10], [0.30, -0.50], [0.12, 0.45], [0.45, -0.12]];
const NAMES = ['sh', 'el', 'wr'];

const canvas = document.getElementById('sim');
const ctx = canvas.getContext('2d');

let W = 0, H = 0, s = 1, colors = {};

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['fg', 'muted', 'line', 'accent', 'card']) colors[k] = cs.getPropertyValue(`--${k}`).trim();
}
readColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
document.addEventListener('themechange', readColors);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  ({ width: W, height: H } = canvas.getBoundingClientRect());
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // World box x ∈ [−0.45, 0.80], y ∈ [−0.75, 0.75] m, centred.
  s = Math.min(W / 1.25, H / 1.5);
}
resize();
new ResizeObserver(resize).observe(canvas);

const toScreen = ([x, y]) => [W / 2 + (x - 0.175) * s, H / 2 - y * s];
const toWorld = (px, py) => [(px - W / 2) / s + 0.175, (H / 2 - py) / s];

const arm = new Arm();
const task = new ReachTask(arm);

let hover = null, dragging = false, auto = false, tourIdx = 0, holdSince = null;
// Starts the tour about 1.5 s after load: 0.3 s to go idle plus one dwell.
let lastInput = performance.now() - IDLE_MS + 300;

function input(ev) {
  lastInput = performance.now();
  auto = false;
  holdSince = null;
  if (ev) task.request(toWorld(ev.offsetX, ev.offsetY));
}

canvas.addEventListener('pointermove', (ev) => {
  hover = ev.pointerType === 'mouse' ? { x: ev.offsetX, y: ev.offsetY } : null;
  input(dragging ? ev : null);
});
canvas.addEventListener('pointerleave', () => { hover = null; });
canvas.addEventListener('pointerdown', (ev) => {
  dragging = true;
  canvas.setPointerCapture(ev.pointerId);
  input(ev);
});
for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, () => { dragging = false; });

let out = task.update(DT);
let simTime = 0, grip = 0;
const satAt = [-1e9, -1e9, -1e9];
const history = [], trail = [];
let last = performance.now(), acc = 0;

function frame(now) {
  // Clamp so a backgrounded tab doesn't resume with a huge catch-up step.
  const frameDt = Math.min((now - last) / 1000, 0.1);
  acc += frameDt;
  last = now;

  if (now - lastInput > IDLE_MS) {
    auto = true;
    if (task.mode === 'HOLD') {
      holdSince ??= now;
      if (now - holdSince > DWELL_MS) {
        task.request(TOUR[tourIdx++ % TOUR.length]);
        holdSince = null;
      }
    }
  }

  while (acc >= DT) {
    out = task.update(DT);
    out.sat.forEach((v, j) => { if (v) satAt[j] = now; });
    simTime += DT;
    acc -= DT;
  }
  grip += ((task.mode === 'MOVE' ? 1 : 0) - grip) * Math.min(1, frameDt * 6);
  history.push({ t: simTime, ex: out.e[0], ey: out.e[1] });
  while (history.length && simTime - history[0].t > HISTORY_S) history.shift();
  trail.push({ t: now, p: [...out.p] });
  while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();
  draw(now);
  requestAnimationFrame(frame);
}

function capsule(a, b, w) {
  const [ax, ay] = toScreen(a), [bx, by] = toScreen(b);
  ctx.lineCap = 'round';
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = w + 3;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  ctx.strokeStyle = colors.card;
  ctx.lineWidth = w;
  ctx.stroke();
  // Panel seams across the link.
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const nx = -(by - ay) / len, ny = (bx - ax) / len;
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const f of [0.3, 0.7]) {
    const cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f;
    ctx.moveTo(cx - nx * w * 0.3, cy - ny * w * 0.3);
    ctx.lineTo(cx + nx * w * 0.3, cy + ny * w * 0.3);
  }
  ctx.stroke();
}

function hub(p, r) {
  const [x, y] = toScreen(p);
  ctx.fillStyle = colors.line;
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.fillStyle = colors.accent;
  ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, r * 0.3), 0, 2 * Math.PI); ctx.fill();
}

const along = (p, a, d, n = 0) => [p[0] + d * Math.cos(a) - n * Math.sin(a), p[1] + d * Math.sin(a) + n * Math.cos(a)];

// The hand point sits between the fingertips, so the wrist link is drawn short and the fingers finish it.
function handParts(pts, phi, open) {
  const wrist = pts[2], a = phi[2], l3 = arm.l[2];
  const palm = along(wrist, a, 0.55 * l3);
  const base = 0.022, tip = 0.006 + 0.024 * open;
  return { palm, fingers: [1, -1].map((sg) => [along(wrist, a, 0.55 * l3, sg * base), along(wrist, a, 1.05 * l3, sg * tip)]) };
}

function drawArm(q, k, open) {
  const { pts, phi } = arm.fk(q);
  const widths = [18 * k, 14 * k, 9 * k];
  const { palm, fingers } = handParts(pts, phi, open);
  capsule(pts[0], pts[1], widths[0]);
  capsule(pts[1], pts[2], widths[1]);
  capsule(pts[2], palm, widths[2]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = Math.max(2.5, 3.5 * k);
  ctx.beginPath();
  const [tipA, baseA, baseB, tipB] = [fingers[0][1], fingers[0][0], fingers[1][0], fingers[1][1]].map(toScreen);
  ctx.moveTo(...tipA); ctx.lineTo(...baseA); ctx.lineTo(...baseB); ctx.lineTo(...tipB);
  ctx.stroke();
  hub(pts[0], widths[0] * 0.55 + 2);
  hub(pts[1], widths[1] * 0.55 + 2);
  hub(pts[2], widths[2] * 0.55 + 2);
}

function drawGhost(q, k) {
  const { pts, phi } = arm.fk(q);
  const { palm, fingers } = handParts(pts, phi, 0.3);
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = colors.muted;
  ctx.lineCap = 'round';
  [[pts[0], pts[1], 18], [pts[1], pts[2], 14], [pts[2], palm, 9], ...fingers.map(([a, b]) => [a, b, 3.5])].forEach(([a, b, w]) => {
    const [ax, ay] = toScreen(a), [bx, by] = toScreen(b);
    ctx.lineWidth = w * k;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  });
  ctx.restore();
}

function roundRect(x0, y0, x1, y1, r) {
  const [ax, ay] = toScreen([x0, y1]), [bx, by] = toScreen([x1, y0]);
  ctx.beginPath();
  ctx.roundRect(ax, ay, bx - ax, by - ay, r * s);
}

// A simple droid torso, facing +x, with the shoulder at the world origin.
function drawDroid() {
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.fg;

  ctx.fillStyle = colors.card;
  roundRect(-0.29, FLOOR_Y, 0.0, -0.63, 0.02); ctx.fill(); ctx.stroke();
  ctx.fillStyle = colors.line;
  roundRect(-0.22, -0.63, -0.07, -0.55, 0.01); ctx.fill(); ctx.stroke();

  const [hx, hy] = toScreen([-0.145, 0.075]);
  ctx.fillStyle = colors.card;
  ctx.beginPath(); ctx.arc(hx, hy, 0.085 * s, Math.PI, 2 * Math.PI); ctx.closePath(); ctx.fill(); ctx.stroke();
  const [ex, ey] = toScreen([-0.095, 0.115]);
  ctx.fillStyle = colors.fg;
  ctx.beginPath(); ctx.arc(ex, ey, 0.012 * s, 0, 2 * Math.PI); ctx.fill();

  ctx.fillStyle = colors.card;
  roundRect(-0.27, -0.55, -0.02, 0.08, 0.035); ctx.fill(); ctx.stroke();

  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = toScreen([-0.22, -0.30 - i * 0.04]), [bx] = toScreen([-0.08, 0]);
    ctx.moveTo(ax, ay); ctx.lineTo(bx, ay);
  }
  ctx.stroke();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.2;
  roundRect(-0.23, -0.20, -0.09, -0.10, 0.01); ctx.stroke();
  const [lx, ly] = toScreen([-0.205, -0.15]);
  ctx.fillStyle = colors.accent;
  ctx.beginPath(); ctx.arc(lx, ly, Math.max(1.5, 0.008 * s), 0, 2 * Math.PI); ctx.fill();

  ctx.fillStyle = colors.line;
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.5;
  roundRect(-0.075, -0.06, 0.035, 0.06, 0.03); ctx.fill(); ctx.stroke();
}

function drawFloor() {
  const [, fy] = toScreen([0, FLOOR_Y]);
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(W, fy); ctx.stroke();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -8; x < W; x += 12) { ctx.moveTo(x + 8, fy); ctx.lineTo(x, fy + 8); }
  ctx.stroke();
}

function segment(a, b) {
  const [ax, ay] = toScreen(a), [bx, by] = toScreen(b);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
}

function crosshair(p, r) {
  const [x, y] = toScreen(p);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.moveTo(x - 1.6 * r, y); ctx.lineTo(x - 0.5 * r, y);
  ctx.moveTo(x + 0.5 * r, y); ctx.lineTo(x + 1.6 * r, y);
  ctx.moveTo(x, y - 1.6 * r); ctx.lineTo(x, y - 0.5 * r);
  ctx.moveTo(x, y + 0.5 * r); ctx.lineTo(x, y + 1.6 * r);
  ctx.stroke();
}

function drawTorqueBars(x, y, w, now) {
  ctx.fillStyle = colors.muted;
  ctx.fillText('joint torque |τ|/τmax', x, y - 8);
  const bx = x + 28, bw = w - 28;
  out.tau.forEach((t, j) => {
    const yj = y + j * 16;
    const frac = Math.min(1, Math.abs(t) / arm.tauMax[j]);
    ctx.fillStyle = colors.muted;
    ctx.fillText(NAMES[j], x, yj + 9);
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, yj, bw, 10);
    ctx.fillStyle = now - satAt[j] < 300 ? colors.accent : colors.muted;
    ctx.fillRect(bx + 1, yj + 1, frac * (bw - 2), 8);
  });
}

function drawChart(x, y, w, h) {
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); ctx.stroke();
  for (const [key, color] of [['ey', colors.muted], ['ex', colors.accent]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    history.forEach((p, i) => {
      const px = x + w - ((simTime - p.t) / HISTORY_S) * w;
      const py = y + h / 2 - Math.max(-1, Math.min(1, p[key] / ERR_SPAN)) * h / 2;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  ctx.fillStyle = colors.muted;
  ctx.fillText('hand error ±10 mm', x, y - 8);
  const tw = ctx.measureText('x y').width;
  ctx.fillStyle = colors.accent;
  ctx.fillText('x', x + w - tw, y - 8);
  ctx.fillStyle = colors.muted;
  ctx.fillText('y', x + w - ctx.measureText('y').width, y - 8);
}

const num = (v, d, w = 0) => v.toFixed(d).replace('-', '−').padStart(w);

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  const k = Math.max(0.6, Math.min(1.2, Math.min(W, H) / 520));
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';

  drawFloor();
  drawDroid();

  let preview = null;
  if (hover) {
    const raw = toWorld(hover.x, hover.y);
    const { p, clamped } = clampGoal(raw);
    preview = { p, clamped, q: solveIK(arm, arm.q, p, { iters: 30, qRest: task.qRest }).q };
    if (clamped) {
      const [ox, oy] = toScreen([0, 0]);
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 6]);
      ctx.beginPath(); ctx.arc(ox, oy, R_MAX * s, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (task.mode === 'MOVE') {
    const pl = task.planner, n = 32;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [x, y] = toScreen(pl.sample(task.t + ((pl.T - task.t) * i) / n).p);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    ctx.globalAlpha = 0.6 * (1 - (now - trail[i].t) / TRAIL_MS);
    segment(trail[i - 1].p, trail[i].p);
  }
  ctx.globalAlpha = 1;

  if (preview) drawGhost(preview.q, k);
  drawArm(arm.q, k, grip);
  crosshair(task.goal, 7);

  const [dx, dy] = toScreen(out.pd);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(dx, dy, 4, 0, 2 * Math.PI); ctx.stroke();

  if (preview) {
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    segment(task.desired.p, preview.p);
    ctx.setLineDash([]);
    const d = Math.hypot(preview.p[0] - task.desired.p[0], preview.p[1] - task.desired.p[1]);
    const label = `${d.toFixed(2)} m · ${moveDuration(d).toFixed(1)} s${preview.clamped ? ' · out of reach' : ''}`;
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = colors.muted;
    ctx.fillText(label, Math.min(hover.x + 12, W - lw - 8), Math.max(hover.y - 10, 16));
  }

  const anySat = satAt.some((t) => now - t < 300);
  const errMm = out.err * 1000;
  const lines = [
    `mode   ${auto ? 'AUTO' : task.mode}${anySat ? ' · TORQUE SAT' : ''}`,
    `hand   x ${num(out.p[0], 2, 5)}  y ${num(out.p[1], 2, 5)} m   err ${num(errMm, 1)} mm`,
    `q      ${arm.q.map((v, j) => `${NAMES[j]} ${num(v / DEG, 0, 4)}°`).join('  ')}`,
    `dls    w ${num(out.w, 3)}  λ ${num(out.lambda, 3)}`,
  ];
  ctx.fillStyle = colors.muted;
  lines.forEach((l, i) => ctx.fillText(l, 14, 24 + i * 18));
  const gw = ctx.measureText('g ↓').width;
  ctx.fillText('g ↓', W - gw - 14, 24);

  const panelW = Math.min(220, W - 28);
  if (H > 360) {
    drawTorqueBars(14, H - 92, panelW, now);
    if (W >= 2 * panelW + 60) drawChart(W - panelW - 14, H - 82, panelW, 56);
  }
  // The floor hatching runs under this line, so give the text a clean background.
  const footer = 'real time · 500 Hz · click to reach';
  ctx.fillStyle = colors.card;
  ctx.fillRect(10, H - 27, ctx.measureText(footer).width + 8, 18);
  ctx.fillStyle = colors.muted;
  ctx.fillText(footer, 14, H - 14);
}

requestAnimationFrame(frame);
