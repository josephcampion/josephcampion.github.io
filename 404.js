// A satellite tumbling torque-free. Spun about its intermediate principal axis it periodically
// flips over (the Dzhanibekov or tennis-racket effect), straight out of Euler's equations:
//   I₁ω̇₁ = (I₂ − I₃)ω₂ω₃,  I₂ω̇₂ = (I₃ − I₁)ω₃ω₁,  I₃ω̇₃ = (I₁ − I₂)ω₁ω₂
// Attitude is a quaternion, integrated together with ω by RK4.

const I = [1, 3.4, 4];       // principal inertias: x along the panels, y the intermediate axis
const SPIN = 2.2;            // rad/s about y
const DT = 0.004;
const TIME_WARP = 1;

const canvas = document.getElementById('sim');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, colors = {};

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
}
resize();
new ResizeObserver(resize).observe(canvas);

// ---- Dynamics ----

const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

// State: [w1, w2, w3, q0, q1, q2, q3], with q rotating body into world.
function deriv(s) {
  const [w1, w2, w3] = s;
  const q = s.slice(3);
  const qd = qmul(q, [0, w1, w2, w3]).map((v) => 0.5 * v);
  return [
    ((I[1] - I[2]) * w2 * w3) / I[0],
    ((I[2] - I[0]) * w3 * w1) / I[1],
    ((I[0] - I[1]) * w1 * w2) / I[2],
    ...qd,
  ];
}

function rk4(s, dt) {
  const add = (a, b, k) => a.map((v, i) => v + k * b[i]);
  const k1 = deriv(s), k2 = deriv(add(s, k1, dt / 2)), k3 = deriv(add(s, k2, dt / 2)), k4 = deriv(add(s, k3, dt));
  const n = s.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  const m = Math.hypot(n[3], n[4], n[5], n[6]);
  for (let i = 3; i < 7; i++) n[i] /= m;
  return n;
}

let state, e0 = 1, flips = 0, lastSign = 1;
function spin() {
  // Mostly about y, with a small nudge on the other axes; the nudge sets how long between flips.
  const e = 0.02 + 0.04 * Math.random();
  state = [e * (Math.random() < 0.5 ? -1 : 1), SPIN, e * 0.6, 1, 0, 0, 0];
  flips = 0;
  lastSign = 1;
  e0 = energy(state);
}
canvas.addEventListener('pointerdown', spin);

const energy = (s) => 0.5 * (I[0] * s[0] ** 2 + I[1] * s[1] ** 2 + I[2] * s[2] ** 2);
spin();

// ---- Geometry: a bus and two solar panels along body x ----

function box(cx, cy, cz, hx, hy, hz, kind) {
  const v = [];
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) v.push([cx + x, cy + y, cz + z]);
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return faces.map((f) => ({ pts: f.map((i) => v[i]), kind }));
}
const PARTS = [
  ...box(0, 0, 0, 0.42, 0.34, 0.3, 'bus'),
  ...box(-1.05, 0, 0, 0.6, 0.02, 0.26, 'panel'),
  ...box(1.05, 0, 0, 0.6, 0.02, 0.26, 'panel'),
  ...box(0, 0, 0.36, 0.08, 0.08, 0.06, 'bus'),
];

const rotate = (q, p) => qmul(qmul(q, [0, ...p]), [q[0], -q[1], -q[2], -q[3]]).slice(1);
// A fixed camera, tilted to look slightly down on the scene.
const CAM = [Math.cos(-0.35), Math.sin(-0.35), 0, 0];
const LIGHT = (() => { const l = [-0.5, 0.7, 0.6]; const m = Math.hypot(...l); return l.map((x) => x / m); })();

const stars = Array.from({ length: 90 }, (_, i) => {
  const r = (n) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  return [r(1), r(2), r(3) < 0.85 ? 1 : 1.8, 0.25 + 0.6 * r(4)];
});

let last = performance.now(), acc = 0;

function frame(now) {
  acc += Math.min((now - last) / 1000, 0.1) * TIME_WARP;
  last = now;
  while (acc >= DT) {
    state = rk4(state, DT);
    const sgn = Math.sign(state[1]);
    if (sgn && sgn !== lastSign) { flips += 1; lastSign = sgn; }
    acc -= DT;
  }
  draw();
  requestAnimationFrame(frame);
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = colors.muted;
  for (const [x, y, sz, a] of stars) { ctx.globalAlpha = a; ctx.fillRect(x * W, y * H, sz, sz); }
  ctx.globalAlpha = 1;

  const q = qmul(CAM, state.slice(3));
  const scale = Math.min(W, H) * 0.24;
  const cx = W / 2, cy = H / 2;
  const faces = PARTS.map((f) => {
    const P = f.pts.map((p) => rotate(q, p));
    const e1 = P[1].map((v, i) => v - P[0][i]), e2 = P[2].map((v, i) => v - P[0][i]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const m = Math.hypot(...n) || 1;
    return { P, n: n.map((v) => v / m), z: P.reduce((s, p) => s + p[2], 0) / P.length, kind: f.kind };
  });
  // Painter's algorithm: far faces first, and only faces turned toward the camera (+z).
  faces.sort((a, b) => a.z - b.z);
  ctx.lineJoin = 'round';
  for (const f of faces) {
    if (f.n[2] <= 0) continue;
    ctx.beginPath();
    f.P.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x * scale, cy - y * scale) : ctx.moveTo(cx + x * scale, cy - y * scale)));
    ctx.closePath();
    const lit = 0.35 + 0.65 * Math.max(0, f.n[0] * LIGHT[0] + f.n[1] * LIGHT[1] + f.n[2] * LIGHT[2]);
    ctx.fillStyle = colors.card; ctx.fill();
    ctx.fillStyle = f.kind === 'panel' ? colors.accent : colors.fg;
    ctx.globalAlpha = f.kind === 'panel' ? 0.15 + 0.35 * lit : 0.4 * (1 - lit);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.fg; ctx.lineWidth = 1.2; ctx.stroke();
  }

  const [w1, w2, w3] = state;
  const lines = [
    `ω  ${[w1, w2, w3].map((w) => w.toFixed(2).padStart(6)).join(' ')} rad/s`,
    `flips  ${flips}`,
    `energy drift  ${((energy(state) / e0 - 1) * 100).toFixed(4)}%`,
  ];
  ctx.font = `12px ${getComputedStyle(document.documentElement).getPropertyValue('--mono')}`;
  ctx.fillStyle = colors.muted;
  lines.forEach((l, i) => ctx.fillText(l, 14, 22 + i * 17));
  ctx.fillText('click to spin it again', 14, H - 14);
}

requestAnimationFrame(frame);
