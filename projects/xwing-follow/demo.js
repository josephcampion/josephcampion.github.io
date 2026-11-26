import { KinematicModel, CursorGuidance, PathManager } from './sim.js';

const VA = 25;             // m/s
const R = 120;             // orbit, fillet and Dubins radius, m
const K_ORBIT = 5;         // B&M default of 10 limit-cycles at this R/Va with the roll-loop lag
const VIEW_M = 700;        // metres spanned by the canvas's shorter side
const TIME_WARP = 4;       // 25 m/s in real time crawls across a screen this size
const DT = 0.01;
const TRAIL_S = 6;
const SPRITE_PX = 44;
const MAX_WPS = 8;
const HIT_M = 60;          // a tap this close to a waypoint removes it

const canvas = document.getElementById('sim');
const ctx = canvas.getContext('2d');
const sprite = new Image();
sprite.src = '/images/xwing.svg';

let W = 0, H = 0, s = 1, colors = {};

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['fg', 'muted', 'line', 'accent']) colors[k] = cs.getPropertyValue(`--${k}`).trim();
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
  s = Math.min(W, H) / VIEW_M;
}
resize();

const toScreen = (n, e) => [W / 2 + e * s, H / 2 - n * s];
const toWorld = (x, y) => ({ n: (H / 2 - y) / s, e: (x - W / 2) / s });

// Keep targets and waypoints at least an orbit radius inside the edge so the X-wing stays in view.
function viewBox() {
  const margin = R + 24 / s;
  return { maxN: Math.max(0, H / 2 / s - margin), maxE: Math.max(0, W / 2 / s - margin) };
}
function clampToView(t) {
  const { maxN, maxE } = viewBox();
  return { n: Math.min(maxN, Math.max(-maxN, t.n)), e: Math.min(maxE, Math.max(-maxE, t.e)) };
}

// A convex clockwise loop. The aspect cap stops a wide screen from stretching it into
// shallow S-bends, which Dubins turns into loops that leave the view.
function defaultLoop() {
  const { maxN, maxE } = viewBox();
  const bn = Math.min(maxN, 1.6 * maxE), be = Math.min(maxE, 1.6 * maxN);
  return [[0.9, 0.1], [0.25, 0.9], [-0.85, 0.6], [-0.7, -0.6], [0.3, -0.9]].map(([n, e]) => ({ n: n * bn, e: e * be }));
}

let pointer = null;
const track = (ev) => { pointer = { x: ev.offsetX, y: ev.offsetY }; };
canvas.addEventListener('pointermove', track);
canvas.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') pointer = null; });

const ac = new KinematicModel({ Va: VA, pn: -0.25 * H / s, pe: -0.45 * W / s, chi: Math.PI / 3 });
const manager = new PathManager({ R, type: 'fillet', kOrbit: K_ORBIT });
let cursor = new CursorGuidance({ R, kOrbit: K_ORBIT });
let waypoints = [], isDefault = true;

function setWaypoints(wps, asDefault = false) {
  waypoints = wps;
  isDefault = asDefault;
  manager.setWaypoints(wps);
  cursor = new CursorGuidance({ R, kOrbit: K_ORBIT });
  updateHint();
}

canvas.addEventListener('pointerdown', (ev) => {
  track(ev);
  const p = clampToView(toWorld(ev.offsetX, ev.offsetY));
  const hit = waypoints.findIndex((w) => Math.hypot(w.n - p.n, w.e - p.e) < HIT_M);
  if (hit >= 0) setWaypoints(waypoints.filter((_, k) => k !== hit));
  else setWaypoints([...waypoints, p].slice(-MAX_WPS));
});

const modeButtons = document.querySelectorAll('[data-path-type]');
for (const b of modeButtons) {
  b.addEventListener('click', () => {
    manager.setType(b.dataset.pathType);
    for (const o of modeButtons) o.setAttribute('aria-pressed', o === b);
  });
}
document.querySelector('[data-path-clear]').addEventListener('click', () => setWaypoints([]));

const hint = document.getElementById('sim-hint');
function updateHint() {
  hint.textContent = waypoints.length === 0
    ? 'Move or tap to steer · tap to drop waypoints'
    : `Tap to add waypoints (max ${MAX_WPS}) · tap one to remove it`;
}

setWaypoints(defaultLoop(), true);
new ResizeObserver(() => {
  resize();
  if (isDefault) setWaypoints(defaultLoop(), true);
}).observe(canvas);

const trail = [];
let cmd = { mode: 'line', chiCmd: 0, ePy: 0 };
let last = performance.now(), acc = 0;

function command() {
  if (waypoints.length >= 2) return manager.update(ac);
  return cursor.update(ac, waypoints[0] ?? clampToView(pointer ? toWorld(pointer.x, pointer.y) : { n: 0, e: 0 }));
}

function frame(now) {
  // Clamp so a backgrounded tab doesn't resume with a huge catch-up step.
  acc += Math.min((now - last) / 1000, 0.1) * TIME_WARP;
  last = now;
  while (acc >= DT) {
    cmd = command();
    ac.step(cmd.chiCmd, DT);
    acc -= DT;
  }
  trail.push({ n: ac.pn, e: ac.pe, t: now });
  while (trail.length && now - trail[0].t > TRAIL_S * 1000) trail.shift();
  draw(now);
  requestAnimationFrame(frame);
}

function tracePrim(p) {
  if (p.a) {
    ctx.moveTo(...toScreen(p.a.n, p.a.e));
    ctx.lineTo(...toScreen(p.b.n, p.b.e));
    return;
  }
  // NED polar angle a sits at canvas angle a − π/2, and clockwise is the same sense in both.
  const [x, y] = toScreen(p.c.n, p.c.e);
  const [x0, y0] = toScreen(p.c.n + p.R * Math.cos(p.a0), p.c.e + p.R * Math.sin(p.a0));
  ctx.moveTo(x0, y0);
  ctx.arc(x, y, p.R * s, p.a0 - Math.PI / 2, p.a1 - Math.PI / 2, p.lam < 0);
}

function drawPath() {
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.muted;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  manager.legs.forEach((leg) => leg.prims.forEach(tracePrim));
  ctx.stroke();
  ctx.setLineDash([]);

  const active = manager.legs[manager.i]?.prims[manager.part];
  if (active) {
    ctx.strokeStyle = colors.fg;
    ctx.beginPath();
    tracePrim(active);
    ctx.stroke();
  }

  // The switching half-plane's boundary: crossing this line moves the manager on.
  const hp = manager.halfPlane;
  if (hp) {
    const [x, y] = toScreen(hp.r.n, hp.r.e);
    const dx = hp.n.n * 18, dy = hp.n.e * 18;
    ctx.strokeStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
  }

  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  waypoints.forEach((w, k) => {
    const [x, y] = toScreen(w.n, w.e);
    ctx.fillStyle = k === manager.i ? colors.accent : colors.fg;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = colors.muted;
    ctx.fillText(String(k + 1), x + 7, y - 7);
  });
}

function drawTarget(target) {
  const [tx, ty] = toScreen(target.n, target.e);
  ctx.strokeStyle = colors.muted;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  if (cmd.mode === 'orbit') {
    ctx.arc(tx, ty, R * s, 0, 2 * Math.PI);
  } else if (cursor.anchor) {
    ctx.moveTo(...toScreen(cursor.anchor.n, cursor.anchor.e));
    ctx.lineTo(tx, ty);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(tx - 8, ty); ctx.lineTo(tx + 8, ty);
  ctx.moveTo(tx, ty - 8); ctx.lineTo(tx, ty + 8);
  ctx.stroke();
}

function draw(now) {
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 100 * s;
  for (let x = (W / 2) % step; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = (H / 2) % step; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  const onPath = waypoints.length >= 2;
  if (onPath) drawPath();
  else drawTarget(waypoints[0] ?? clampToView(pointer ? toWorld(pointer.x, pointer.y) : { n: 0, e: 0 }));

  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    ctx.globalAlpha = 1 - (now - trail[i].t) / (TRAIL_S * 1000);
    ctx.beginPath();
    ctx.moveTo(...toScreen(trail[i - 1].n, trail[i - 1].e));
    ctx.lineTo(...toScreen(trail[i].n, trail[i].e));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (sprite.complete) {
    const [x, y] = toScreen(ac.pn, ac.pe);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ac.chi);
    // Seen from above, a banked aircraft's wingspan foreshortens by cos(phi).
    ctx.scale(Math.cos(ac.phi), 1);
    ctx.drawImage(sprite, -SPRITE_PX / 2, -SPRITE_PX / 2, SPRITE_PX, SPRITE_PX);
    ctx.restore();
  }

  const deg = (r) => `${Math.round(r * 180 / Math.PI)}°`.padStart(5);
  const chiDeg = Math.round(((ac.chi * 180 / Math.PI) + 360) % 360);
  const leg = manager.legs[manager.i];
  const lines = [
    onPath
      ? `path  ${manager.type.toUpperCase()}${manager.type === 'dubins' ? ` ${leg.word}` : ''} → wp ${manager.i + 1}/${waypoints.length}`
      : `path  ${waypoints.length ? 'ORBIT WP' : 'CURSOR'}`,
    `mode  ${cmd.mode.toUpperCase()}`,
    `χ     ${String(chiDeg).padStart(4)}°`,
    `φ    ${deg(ac.phi)}`,
    cmd.mode === 'orbit' ? `ρ−R  ${String(Math.round(cmd.eRho)).padStart(4)} m` : `e_py ${String(Math.round(cmd.ePy)).padStart(4)} m`,
  ];
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = colors.muted;
  lines.forEach((l, i) => ctx.fillText(l, 14, 24 + i * 18));
  ctx.fillText(`grid 100 m · sim ×${TIME_WARP}`, 14, H - 14);
}

requestAnimationFrame(frame);
