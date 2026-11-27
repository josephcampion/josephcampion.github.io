import { Arm, ReachTask, solveIK, clampGoal, moveDuration, DEG } from './sim.js';

const DT = 0.002;
const HISTORY_S = 10;         // seconds on the strip chart
const IDLE_MS = 15000;        // resume the tour if nobody has touched it for this long
const DWELL_MS = 1200;        // pause at each tour stop
const TRAIL_MS = 2000;
const ERR_SPAN = 0.010;       // m, half-height of the hand error chart
const VIEW_LEFT = -0.25;      // m, world x at the canvas's left edge
const PANEL_W = 220;          // px, readout column
const STACK_MIN_W = 560;      // px, narrowest canvas that gets the readout column
const R_MAX = 0.62;
// Leg joint heights below the shoulder, for a droid about 1.5 m tall with human proportions.
const LEGS = { yH: -0.47, yK: -0.85, yA: -1.18, F: -1.23 };
const FLOOR_Y = LEGS.F;
// Near full extension, low, high, then back to mid.
const TOUR = [[0.60, 0.10], [0.32, -0.40], [0.14, 0.45], [0.45, -0.12]];
const NAMES = ['sh', 'el', 'wr'];

const canvas = document.getElementById('sim');
const ctx = canvas.getContext('2d');

let W = 0, H = 0, s = 1, CX = 0.2, colors = {};

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['fg', 'muted', 'line', 'accent', 'card']) colors[k] = cs.getPropertyValue(`--${k}`).trim();
  // Gold plating isn't a site colour, so pick a lighter or darker gold from the card's brightness.
  const hex = colors.card.replace('#', '');
  const dark = hex.length >= 6 && parseInt(hex.slice(0, 2), 16) + parseInt(hex.slice(2, 4), 16) + parseInt(hex.slice(4, 6), 16) < 3 * 96;
  colors.gold = dark ? '#8f7333' : '#e4c473';
  colors.goldShade = dark ? '#5f4c22' : '#c39a45';
  colors.goldHi = dark ? '#b39550' : '#f4e2a8';
  colors.dark = dark;
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
  // World box x ∈ [−0.30, 0.70], y ∈ [−0.46, 0.56] m: the band of the arm's reach in front of the chest,
  // so the legs run off the bottom and the arm gets as much of the canvas as it can. Goals come from
  // clicks, so this box is also, in effect, the reachable space.
  // When the canvas is wide enough, keep a column on the right for the readouts and fit the reach
  // (x from VIEW_LEFT to 0.72 m) into what's left, with the droid pinned near the left edge.
  s = Math.min((W - (W >= STACK_MIN_W ? PANEL_W + 40 : 0)) / (0.72 - VIEW_LEFT), H / 1.02);
  CX = VIEW_LEFT + W / (2 * s);
}
resize();
new ResizeObserver(resize).observe(canvas);

const CY = 0.05;
const toScreen = ([x, y]) => [W / 2 + (x - CX) * s, H / 2 - (y - CY) * s];
const toWorld = (px, py) => [(px - W / 2) / s + CX, (H / 2 - py) / s + CY];
const view = () => ({ ctx, s, P: toScreen, W, H });
const C = colors;

// The real arm is a little heavier than the controller's model (the hand most of all), has Coulomb
// friction the controller doesn't know about, and its motors take a few milliseconds to respond.
const arm = new Arm({ m: [1.6, 1.08, 0.45], fc: [0.1, 0.05, 0.012], Tm: 0.006 });
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
  history.push({ t: simTime, ex: out.e[0], ey: out.e[1], sh: out.eq[0], el: out.eq[1], wr: out.eq[2] });
  while (history.length && simTime - history[0].t > HISTORY_S) history.shift();
  trail.push({ t: now, p: [...out.p] });
  while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();
  draw(now);
  requestAnimationFrame(frame);
}

const along = (p, a, d, n = 0) => [p[0] + d * Math.cos(a) - n * Math.sin(a), p[1] + d * Math.sin(a) + n * Math.cos(a)];

// The hand point sits between the fingertips, so the wrist link is drawn short and the fingers finish it.
function handParts(pts, phi, open) {
  const wrist = pts[2], a = phi[2], l3 = arm.l[2];
  const palm = along(wrist, a, 0.55 * l3);
  const base = 0.022, tip = 0.006 + 0.024 * open;
  return { palm, fingers: [1, -1].map((sg) => [along(wrist, a, 0.55 * l3, sg * base), along(wrist, a, 1.05 * l3, sg * tip)]) };
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

const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

function blob(v, pts) {
  const { ctx, P } = v, q = pts.map(P), n = q.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.beginPath();
  ctx.moveTo(...mid(q[n - 1], q[0]));
  for (let i = 0; i < n; i++) ctx.quadraticCurveTo(...q[i], ...mid(q[i], q[(i + 1) % n]));
  ctx.closePath();
}
function fillStroke(v, fill, lw = 1.5) { const { ctx } = v; if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = C.fg; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke(); }
// A limb segment that tapers from radius r0 at a to r1 at b, with rounded ends.
function taper(v, a, b, r0, r1, fill, lw = 1.5) {
  const { ctx, P, s } = v, A = P(a), B = P(b);
  const t = Math.atan2(B[1] - A[1], B[0] - A[0]);
  ctx.beginPath();
  ctx.arc(B[0], B[1], r1 * s, t - Math.PI / 2, t + Math.PI / 2);
  ctx.arc(A[0], A[1], r0 * s, t + Math.PI / 2, t + 1.5 * Math.PI);
  ctx.closePath();
  fillStroke(v, fill, lw);
}
function disc(v, p, r, fill, lw = 1.5) {
  const { ctx, P, s } = v, [x, y] = P(p);
  ctx.beginPath(); ctx.arc(x, y, r * s, 0, 2 * Math.PI);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (lw) { ctx.strokeStyle = C.fg; ctx.lineWidth = lw; ctx.stroke(); }
}
function line(v, a, b, color, lw) {
  const { ctx, P } = v; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke();
}
function bands(v, a, b, r0, r1, fracs) {
  const t = ang(a, b), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (const f of fracs) { const r = (r0 + (r1 - r0) * f) * 0.92; line(v, along(a, t, f * len, -r), along(a, t, f * len, r), C.goldShade, 1.6); }
}
// A highlight streak along a limb, to read as a polished tube.
function shine(v, a, b, r, f0 = 0.2, f1 = 0.75) {
  const t = ang(a, b), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  line(v, along(a, t, f0 * len, r * 0.45), along(a, t, f1 * len, r * 0.45), C.goldHi, Math.max(1.5, r * v.s * 0.35));
}
// Exposed wiring in the gap at a joint: dark core and a few cables bowing across it.
function wiring(v, a, b, r) {
  const t = ang(a, b), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  taper(v, a, b, r, r, C.line, 1.2);
  const { ctx, P } = v;
  ctx.strokeStyle = C.muted; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [o0, o1, bow] of [[-0.6, -0.2, 0.5], [0.0, 0.5, -0.4], [0.55, 0.1, 0.4]]) {
    const p0 = P(along(a, t, 0, o0 * r)), p1 = P(along(a, t, len, o1 * r)), m = P(along(a, t, len / 2, ((o0 + o1) / 2 + bow) * r));
    ctx.moveTo(...p0); ctx.quadraticCurveTo(...m, ...p1);
  }
  ctx.stroke();
}

// Elbow: a dark ball of wiring that shows in the gap between the two tubes.
function elbow(v, p, a0, a1, r) {
  disc(v, p, r, C.line, 1.2);
  const { ctx, P, s } = v, [x, y] = P(p);
  ctx.strokeStyle = C.muted; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
  const t0 = -a0, t1 = -a1;
  ctx.beginPath();
  for (const f of [0.45, 0.75]) {
    ctx.moveTo(x - Math.cos(t0) * r * s * 0.2, y - Math.sin(t0) * r * s * 0.2);
    ctx.arc(x, y, r * s * f, t0 + Math.PI, t1, false);
  }
  ctx.stroke();
}


const SILVER = () => (C.dark ? '#7d838c' : '#c9cdd3');
const SILVER_SHADE = () => (C.dark ? '#5a6068' : '#a3a8b0');
const WIRES = ['#b5483a', '#3d5f9a', '#d9b44a', '#e8e4da', '#7a3b6e'];

function ringDisc(v, p, r, fill, rings = [0.72, 0.45, 0.2]) {
  disc(v, p, r, fill, 1.4);
  const { ctx, P, s } = v, [x, y] = P(p);
  ctx.strokeStyle = C.goldShade === fill ? C.gold : C.goldShade; ctx.lineWidth = 1.3;
  for (const f of rings) { ctx.beginPath(); ctx.arc(x, y, r * s * f, 0, 2 * Math.PI); ctx.stroke(); }
}
function curve(v, pts, color, lw) {
  const { ctx, P } = v, q = pts.map(P);
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(...q[0]);
  for (let i = 1; i < q.length - 1; i++) ctx.quadraticCurveTo(...q[i], (q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2);
  ctx.lineTo(...q[q.length - 1]); ctx.stroke();
}

function legRef(v, dx, far) {
  const { yH, yK, yA, F } = LEGS;
  const fill = far ? C.goldShade : C.gold;
  const lower = far ? SILVER_SHADE() : C.gold;
  const hip = [-0.035 + dx * 0.3, yH], knee = [0.012 + dx, yK], ankle = [-0.015 + dx, yA];
  const tK = ang(hip, knee), tA = ang(knee, ankle);
  const kneeTop = along(knee, tK, -0.05), kneeBot = along(knee, tA, 0.05);
  wiring(v, along(knee, tK, -0.07), along(knee, tA, 0.07), 0.024);
  // Calf piston running down the back of the shin.
  const p0 = along(knee, tA, 0.06, -0.034), p1 = along(ankle, tA, -0.05, -0.03);
  line(v, p0, p1, C.fg, 3); line(v, p0, p1, far ? SILVER() : C.muted, 1.4);
  taper(v, hip, kneeTop, 0.054, 0.042, fill);
  taper(v, kneeBot, ankle, 0.04, 0.03, lower);
  if (!far) {
    bands(v, hip, kneeTop, 0.054, 0.042, [0.55, 0.62]);
    line(v, along(hip, tK, 0.06, 0.018), along(hip, tK, 0.3, 0.014), C.goldShade, 1.3);
    shine(v, hip, kneeTop, 0.05, 0.12, 0.45);
    line(v, along(kneeBot, tA, 0.04, 0.012), along(kneeBot, tA, 0.27, 0.01), C.goldShade, 1.3);
    bands(v, kneeBot, ankle, 0.04, 0.03, [0.72, 0.78]);
  }
  // The big round knee cap.
  ringDisc(v, knee, 0.047, far ? C.goldShade : C.gold, [0.7, 0.42]);
  disc(v, ankle, 0.022, C.line, 1.2);
  // Sandal-like foot: flat sole, strap ridges, slightly pointed toe.
  const fx = dx - 0.015, ff = far ? SILVER_SHADE() : C.gold;
  blob(v, [[fx - 0.06, F], [fx + 0.165, F], [fx + 0.18, F + 0.016], [fx + 0.1, F + 0.036], [fx + 0.02, F + 0.062], [fx - 0.062, F + 0.05]]);
  fillStroke(v, ff);
  for (const x of [0.035, 0.065, 0.095]) line(v, [fx + x, F + 0.01], [fx + x - 0.008, F + 0.045 - (x - 0.035) * 0.3], C.goldShade, 1.3);
  line(v, [fx - 0.055, F + 0.008], [fx + 0.165, F + 0.008], C.fg, 1.2);
}

// A protocol droid in profile, facing +x, with the arm's shoulder at the world origin.
function drawDroid(v) {
  const { ctx } = v;

  legRef(v, 0.075, true);

  // Midriff: a tangle of coloured wires behind the ribcage.
  blob(v, [[-0.09, -0.22], [0.03, -0.22], [0.04, -0.37], [-0.1, -0.37]]);
  fillStroke(v, C.dark ? '#14110f' : '#2b2420', 1.2);
  ctx.save(); ctx.clip();
  WIRES.forEach((c, i) => {
    const x = -0.075 + i * 0.024;
    curve(v, [[x, -0.215], [x + 0.016 * ((i % 2) * 2 - 1), -0.27], [x - 0.01, -0.32], [x + 0.006, -0.375]], c, 2.4);
  });
  ctx.restore();

  // Pelvis: layered V plates at the front.
  blob(v, [[-0.125, -0.33], [0.06, -0.33], [0.07, -0.4], [0.035, -0.5], [-0.09, -0.49], [-0.135, -0.41]]);
  fillStroke(v, C.gold);
  for (const [y, x0] of [[-0.36, 0.062], [-0.395, 0.06], [-0.43, 0.052]]) curve(v, [[-0.06, y + 0.012], [0.0, y - 0.004], [x0, y + 0.006]], C.goldShade, 1.5);
  shine(v, [-0.11, -0.44], [-0.11, -0.36], 0.01, 0.1, 0.9);

  legRef(v, 0, false);
  ringDisc(v, [-0.035, LEGS.yH], 0.032, C.gold, [0.5]);

  // Torso: broad rounded shoulders, deep chest, a ribcage edge over the midriff.
  blob(v, [[-0.05, 0.1], [-0.13, 0.085], [-0.16, 0.0], [-0.145, -0.12], [-0.1, -0.235], [0.035, -0.235], [0.075, -0.15], [0.095, -0.04], [0.088, 0.05], [0.04, 0.1]]);
  fillStroke(v, C.gold);
  curve(v, [[-0.12, -0.2], [-0.03, -0.185], [0.06, -0.205]], C.goldShade, 1.6);
  curve(v, [[-0.105, 0.07], [-0.02, 0.085], [0.07, 0.065]], C.goldShade, 1.4);
  shine(v, [-0.135, -0.12], [-0.135, 0.04], 0.012, 0.05, 0.95);
  // Chest: the small black button high up, and the concentric power disc lower down.
  ringDisc(v, [0.05, -0.13], 0.046, C.gold, [0.75, 0.52, 0.3, 0.12]);
  curve(v, [[0.08, 0.035], [0.075, -0.03], [0.083, -0.07]], C.fg, 1.4);

  neckRef(v);
  drawHead(v);
}

function handRef(v, wrist, a, open) {
  const H = (u, w) => along(wrist, a, u, w);
  const fr = 0.0072;
  // Long, skeletal, jointed fingers; the hand point sits between thumb and fingertips when closed.
  const finger = (i, fill) => {
    const vb = 0.008 - 0.006 * i, L = 1 - 0.05 * i;
    const tip = [0.045 + 0.066 * L, (-0.006 - 0.002 * i) * (1 - open) + (vb - 0.034) * open];
    const pts = [H(0.045, vb), H(0.045 + 0.024 * L, vb - 0.003 * open), H(0.045 + 0.046 * L, (vb + 2 * tip[1]) / 3 + 0.005 * (1 - open)), H(...tip)];
    for (let n = 0; n < 3; n++) taper(v, pts[n], pts[n + 1], fr * (1 - 0.12 * n), fr * (0.88 - 0.12 * n), fill, 1.1);
    pts.slice(1, -1).forEach((p) => disc(v, p, fr * 0.55, C.line, 0));
  };
  for (const i of [3, 2, 1]) finger(i, C.goldShade);
  // Palm: gold back plate over a dark inner hand.
  blob(v, [H(-0.006, 0.016), H(0.03, 0.022), H(0.052, 0.016), H(0.056, -0.012), H(0.036, -0.022), H(-0.006, -0.016)]);
  fillStroke(v, C.line, 1.3);
  blob(v, [H(-0.004, 0.015), H(0.03, 0.021), H(0.05, 0.012), H(0.046, -0.004), H(0.0, -0.004)]);
  fillStroke(v, C.gold, 1.2);
  finger(0, C.gold);
  const th = [H(0.016, 0.018), H(0.04, 0.03 + 0.008 * open), H(0.066, 0.026 + 0.012 * open), H(0.09, 0.008 + 0.026 * open)];
  for (let n = 0; n < 3; n++) taper(v, th[n], th[n + 1], fr * 1.15 * (1 - 0.1 * n), fr * 1.15 * (0.9 - 0.1 * n), C.gold, 1.1);
  th.slice(1, -1).forEach((p) => disc(v, p, fr * 0.6, C.line, 0));
}

function drawArm(v, q, open) {
  const { pts, phi } = arm.fk(q);
  const [sh, el, wr] = pts;
  const upEnd = along(sh, phi[0], arm.l[0] - 0.03);
  const foStart = along(el, phi[1], 0.03), foEnd = along(el, phi[1], arm.l[1] - 0.022);
  elbow(v, el, phi[0], phi[1], 0.03);
  // Upper arm, then the shoulder shell capping it.
  taper(v, along(sh, phi[0], 0.03), upEnd, 0.034, 0.03, C.gold);
  shine(v, sh, upEnd, 0.03, 0.3, 0.85);
  // Forearm gauntlet: wider than the upper arm, with raised rings at both ends and a thin cable.
  taper(v, foStart, foEnd, 0.034, 0.03, C.gold);
  bands(v, foStart, foEnd, 0.034, 0.03, [0.12, 0.18, 0.84, 0.9]);
  shine(v, foStart, foEnd, 0.03, 0.25, 0.75);
  const c0 = along(el, phi[1], 0.06, -0.03), c1 = along(el, phi[1], 0.2, -0.026);
  curve(v, [c0, along(el, phi[1], 0.13, -0.036), c1], C.fg, 2.2);
  curve(v, [c0, along(el, phi[1], 0.13, -0.036), c1], C.muted, 1);
  // Wrist cuff.
  taper(v, along(wr, phi[1], -0.026), along(wr, phi[1], -0.016), 0.031, 0.031, C.goldShade, 1.3);
  disc(v, wr, 0.015, C.line, 1.2);
  handRef(v, wr, phi[2], open);
  // Shoulder shell: a rounded dome with a seam ring.
  blob(v, [along(sh, phi[0], -0.05, 0.0), along(sh, phi[0], -0.03, 0.045), along(sh, phi[0], 0.05, 0.045), along(sh, phi[0], 0.07, 0.0), along(sh, phi[0], 0.05, -0.045), along(sh, phi[0], -0.03, -0.045)]);
  fillStroke(v, C.gold);
  line(v, along(sh, phi[0], 0.045, 0.038), along(sh, phi[0], 0.045, -0.038), C.goldShade, 1.4);
  for (const p of [sh, el, wr]) disc(v, p, 0.0065, C.accent, 0);
}


const AMBER = '#ffbf4d', AMBER_HI = '#fff0c2';

// Points along the same midpoint-quadratic chain that curve() draws.
function sampleChain(pts, n = 48) {
  const out = [], segs = [];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let start = pts[0];
  for (let i = 1; i < pts.length - 1; i++) { const end = i === pts.length - 2 ? pts[i + 1] : mid(pts[i], pts[i + 1]); segs.push([start, pts[i], end]); start = end; }
  if (!segs.length) segs.push([pts[0], mid(pts[0], pts[1]), pts[1]]);
  for (let k = 0; k <= n; k++) {
    const u = (k / n) * segs.length, j = Math.min(segs.length - 1, Math.floor(u)), t = u - j, [a, c, b] = segs[j];
    out.push([(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]);
  }
  return out;
}
// The ribbed band that frames the face: a gold strip with dark ribs across it.
function ribBand(v, pts, w, ribs) {
  const { ctx, P, s } = v, q = sampleChain(pts);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); q.map(P).forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
  ctx.strokeStyle = C.fg; ctx.lineWidth = w * s + 3; ctx.stroke();
  ctx.strokeStyle = C.gold; ctx.lineWidth = w * s; ctx.stroke();
  for (let r = 1; r < ribs; r++) {
    const i = Math.round((r / ribs) * (q.length - 1)), a = q[Math.max(0, i - 1)], b = q[Math.min(q.length - 1, i + 1)];
    const t = ang(a, b);
    line(v, along(q[i], t, 0, -w * 0.42), along(q[i], t, 0, w * 0.42), C.goldShade, Math.max(1.2, w * s * 0.18));
  }
}
// A round lens seen at some angle: dark rim, amber glow, horizontal grille, dark pupil.
function lens(v, c, rx, ry, { color = AMBER, grille = true, rot = 0 } = {}) {
  const { ctx, P, s } = v, [x, y] = P(c);
  ctx.beginPath(); ctx.ellipse(x, y, rx * s * 1.3, ry * s * 1.22, rot, 0, 2 * Math.PI);
  ctx.fillStyle = C.goldShade; ctx.fill(); ctx.strokeStyle = C.fg; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.save();
  ctx.beginPath(); ctx.ellipse(x, y, rx * s, ry * s, rot, 0, 2 * Math.PI);
  const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry) * s);
  g.addColorStop(0, AMBER_HI); g.addColorStop(0.55, color); g.addColorStop(1, '#a8641c');
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = C.fg; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.clip();
  if (grille) {
    ctx.strokeStyle = 'rgba(90, 45, 10, 0.55)'; ctx.lineWidth = Math.max(1, ry * s * 0.12);
    ctx.translate(x, y); ctx.rotate(rot);
    for (let k = -3; k <= 3; k++) { const yy = (k / 3.6) * ry * s; ctx.beginPath(); ctx.moveTo(-rx * s, yy); ctx.lineTo(rx * s, yy); ctx.stroke(); }
    ctx.setTransform(ctx.getTransform());
  }
  ctx.restore();
  disc(v, c, Math.min(rx, ry) * 0.22, '#3a2208', 0);
}
function slot(v, cx, cy, w, h) {
  const { ctx, P } = v, q = [[cx - w / 2, cy + h / 2], [cx + w / 2, cy + h / 2], [cx + w / 2, cy - h / 2], [cx - w / 2, cy - h / 2]].map(P);
  ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
  ctx.fillStyle = C.fg; ctx.fill();
  ctx.strokeStyle = C.goldShade; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(...q[3]); ctx.lineTo(...q[2]); ctx.stroke();
}
function earDisc(v, p, r) {
  ringDisc(v, p, r, C.gold, [0.55]);
  disc(v, p, r * 0.25, C.goldShade, 1);
}
function nub(v, p) {
  blob(v, [[p[0] - 0.008, p[1] - 0.004], [p[0] + 0.008, p[1] - 0.004], [p[0] + 0.005, p[1] + 0.012], [p[0] - 0.005, p[1] + 0.012]]);
  fillStroke(v, C.gold, 1.2);
}
function shade(v, pts, alpha = 0.4) {
  const { ctx } = v; blob(v, pts);
  ctx.fillStyle = C.goldShade; ctx.globalAlpha = alpha; ctx.fill(); ctx.globalAlpha = 1;
}

function neckRef(v) {
  // Thin ribbed neck column.
  blob(v, [[-0.045, 0.09], [0.008, 0.09], [0.01, 0.15], [-0.042, 0.15]]);
  fillStroke(v, C.line, 1.2);
  for (const y of [0.112, 0.122, 0.132, 0.142]) line(v, [-0.04, y], [0.006, y], C.muted, 1.1);
  // Ribbed collar ring at the base.
  blob(v, [[-0.085, 0.08], [0.045, 0.08], [0.048, 0.112], [-0.082, 0.112]]);
  fillStroke(v, C.gold, 1.3);
  for (const y of [0.089, 0.097, 0.105]) line(v, [-0.08, y], [0.044, y], C.goldShade, 1.3);
  // Ribbed connector rod from the collar down onto the chest, and the round chest button.
  const r0 = [0.035, 0.083], r1 = [0.05, 0.02];
  taper(v, r0, r1, 0.007, 0.006, C.gold, 1.2);
  bands(v, r0, r1, 0.007, 0.006, [0.25, 0.4, 0.55, 0.7]);
  disc(v, r1, 0.008, C.goldShade, 1.2);
  ringDisc(v, [0.078, 0.035], 0.012, C.gold, [0.45]);
}

function profileHead(v, g) {
  blob(v, g.outline);
  fillStroke(v, C.gold);
  // Face: everything in front of the band, a shade darker.
  shade(v, g.face, 0.32);
  if (g.brow) { blob(v, g.brow); fillStroke(v, C.gold, 1.3); }
  line(v, [g.faceX, g.eye[1] + 0.024], [g.band[0][0] + 0.004, g.eye[1] + 0.024], C.goldShade, 1.4);
  line(v, [g.faceX - 0.002, g.eye[1] - 0.024], [g.band[0][0] - 0.001, g.eye[1] - 0.024], C.goldShade, 1.4);
  shine(v, g.shine[0], g.shine[1], 0.012, 0.1, 0.9);
  ribBand(v, g.band, g.bandW ?? 0.017, g.ribs ?? 13);
  lens(v, g.eye, g.eyeR?.[0] ?? 0.011, g.eyeR?.[1] ?? 0.02);
  slot(v, g.mouth[0], g.mouth[1], g.mouthW ?? 0.022, 0.0065);
  curve(v, g.chin, C.goldShade, 1.3);
  earDisc(v, g.ear, 0.017);
  nub(v, g.nub);
}
function drawHead(v) {
  profileHead(v, {
    outline: [[0.005, 0.348], [0.055, 0.33], [0.082, 0.29], [0.086, 0.24], [0.08, 0.19], [0.074, 0.146], [0.05, 0.122], [-0.005, 0.122], [-0.045, 0.138], [-0.076, 0.178], [-0.082, 0.245], [-0.06, 0.315]],
    face: [[0.012, 0.343], [0.054, 0.326], [0.08, 0.29], [0.084, 0.24], [0.078, 0.19], [0.072, 0.148], [0.05, 0.126], [-0.006, 0.13]],
    faceX: 0.084, band: [[0.008, 0.344], [0.004, 0.24], [-0.006, 0.152]], eye: [0.072, 0.24], eyeR: [0.012, 0.022], mouth: [0.068, 0.168],
    chin: [[0.015, 0.15], [0.045, 0.144], [0.074, 0.15]], ear: [-0.008, 0.146], nub: [0.008, 0.348], shine: [[-0.07, 0.25], [-0.035, 0.325]],
  });
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

function drawChart(x, y, w, h, label, span, series) {
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); ctx.stroke();
  for (const [key, color] of series) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    history.forEach((p, i) => {
      const px = x + w - ((simTime - p.t) / HISTORY_S) * w;
      const py = y + h / 2 - Math.max(-1, Math.min(1, p[key] / span)) * h / 2;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  ctx.fillStyle = colors.muted;
  ctx.fillText(label, x, y - 8);
  let lx = x + w;
  for (const [, color, name] of [...series].reverse()) {
    lx -= ctx.measureText(name).width;
    ctx.fillStyle = color;
    ctx.fillText(name, lx, y - 8);
    lx -= ctx.measureText(' ').width;
  }
}

const num = (v, d, w = 0) => v.toFixed(d).replace('-', '−').padStart(w);

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  const k = Math.max(0.6, Math.min(1.2, Math.min(W, H) / 520));
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';

  drawFloor();
  drawDroid(view());

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
  drawArm(view(), arm.q, grip);
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
    `e_q    ${out.eq.map((v, j) => `${NAMES[j]} ${num(v / DEG, 2, 5)}°`).join('  ')}`,
    `dls    w ${num(out.w, 3)}  λ ${num(out.lambda, 3)}`,
  ];
  ctx.fillStyle = colors.muted;
  lines.forEach((l, i) => ctx.fillText(l, 14, 24 + i * 18));
  const gw = ctx.measureText('g ↓').width;
  ctx.fillText('g ↓', W - gw - 14, 24);

  const panelW = Math.min(PANEL_W, W - 28);
  const hand = ['hand error ±10 mm', ERR_SPAN, [['ex', colors.accent, 'x'], ['ey', colors.muted, 'y']]];
  // One chart per joint; the wrist is light and twitchy, so its scale is wider.
  const joints = [['shoulder', 'sh', 1.5], ['elbow', 'el', 2], ['wrist', 'wr', 5]]
    .map(([name, key, span]) => [`${name} error ±${span}°`, span * DEG, [[key, colors.accent, '']]]);
  const footer = 'real time · 500 Hz · click to reach';
  const fw = ctx.measureText(footer).width;
  // Stack the readouts down the right side when there's room beside the arm's reach; otherwise split
  // them across the bottom corners as before.
  // Torque bars, then the three joint charts and the hand chart, sized to fit the canvas height.
  const top = 48, barsH = 70, gap = 24;
  const chartH = Math.min(56, (H - 30 - top - barsH) / 4 - gap);
  if (chartH >= 22 && W >= STACK_MIN_W) {
    const px = W - panelW - 14;
    drawTorqueBars(px, top + 8, panelW, now);
    [...joints, hand].forEach((c, i) => drawChart(px, top + barsH + gap + i * (chartH + gap), panelW, chartH, ...c));
    ctx.fillStyle = colors.muted;
    ctx.fillText(footer, W - fw - 14, H - 14);
  } else {
    if (H > 360) {
      drawTorqueBars(14, H - 92, panelW, now);
      if (W >= 2 * panelW + 60) drawChart(W - panelW - 14, H - 82, panelW, 56, ...hand);
    }
    // The floor hatching runs under this line, so give the text a clean background.
    ctx.fillStyle = colors.card;
    ctx.fillRect(10, H - 27, fw + 8, 18);
    ctx.fillStyle = colors.muted;
    ctx.fillText(footer, 14, H - 14);
  }
}

requestAnimationFrame(frame);
