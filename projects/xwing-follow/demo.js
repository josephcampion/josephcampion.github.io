import { KinematicModel, CursorGuidance } from './sim.js';

const VA = 25;             // m/s
const R = 120;             // orbit radius, m
const K_ORBIT = 5;         // B&M default of 10 limit-cycles at this R/Va with the roll-loop lag
const VIEW_M = 700;        // metres spanned by the canvas's shorter side
const TIME_WARP = 4;       // 25 m/s in real time crawls across a screen this size
const DT = 0.01;
const TRAIL_S = 6;
const SPRITE_PX = 44;

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
new ResizeObserver(resize).observe(canvas);

const toScreen = (n, e) => [W / 2 + e * s, H / 2 - n * s];
const toWorld = (x, y) => ({ n: (H / 2 - y) / s, e: (x - W / 2) / s });

let pointer = null;
const track = (ev) => { pointer = { x: ev.offsetX, y: ev.offsetY }; };
canvas.addEventListener('pointermove', track);
canvas.addEventListener('pointerdown', track);
canvas.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') pointer = null; });

// Keep the whole orbit on screen so the X-wing never flies out of view.
function currentTarget() {
  const t = pointer ? toWorld(pointer.x, pointer.y) : { n: 0, e: 0 };
  const margin = R + 24 / s;
  const maxE = Math.max(0, W / 2 / s - margin), maxN = Math.max(0, H / 2 / s - margin);
  return { n: Math.min(maxN, Math.max(-maxN, t.n)), e: Math.min(maxE, Math.max(-maxE, t.e)) };
}

const ac = new KinematicModel({ Va: VA, pn: -0.25 * H / s, pe: -0.45 * W / s, chi: Math.PI / 3 });
const guidance = new CursorGuidance({ R, kOrbit: K_ORBIT });
const trail = [];
let cmd = { mode: 'line', chiCmd: 0, ePy: 0 };
let last = performance.now(), acc = 0;

function frame(now) {
  // Clamp so a backgrounded tab doesn't resume with a huge catch-up step.
  acc += Math.min((now - last) / 1000, 0.1) * TIME_WARP;
  last = now;
  const target = currentTarget();
  while (acc >= DT) {
    cmd = guidance.update(ac, target);
    ac.step(cmd.chiCmd, DT);
    acc -= DT;
  }
  trail.push({ n: ac.pn, e: ac.pe, t: now });
  while (trail.length && now - trail[0].t > TRAIL_S * 1000) trail.shift();
  draw(target, now);
  requestAnimationFrame(frame);
}

function draw(target, now) {
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 100 * s;
  for (let x = (W / 2) % step; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = (H / 2) % step; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  const [tx, ty] = toScreen(target.n, target.e);
  ctx.strokeStyle = colors.muted;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  if (cmd.mode === 'orbit') {
    ctx.arc(tx, ty, R * s, 0, 2 * Math.PI);
  } else if (guidance.anchor) {
    ctx.moveTo(...toScreen(guidance.anchor.n, guidance.anchor.e));
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
  const lines = [
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
