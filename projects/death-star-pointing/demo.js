import { Spacecraft, SlewController, MomentumDump, Orbit, TransferGuidance, MU, hohmannDv, wrap } from './sim.js';

const DEG = Math.PI / 180;
const TIME_WARP = 12;         // an 8-minute orbit at ×12 takes 40 s to watch
const DT = 0.01;
const TAU_DIST = 0.008;       // N·m, constant disturbance torque, exaggerated
const HISTORY_S = 120;        // seconds of sim time on the strip chart
const VIEW_KM = 5300;         // half the canvas's shorter side, in km
const PLANET_KM = 1000;
const R_MIN = 1700, R_MAX = 4900;
const IDLE_MS = 15000;        // fly a transfer on its own if nobody has clicked for this long

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

// Fixed starfield in unit coordinates so it survives resizes.
const stars = Array.from({ length: 140 }, (_, i) => {
  const r = (n) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  return { x: r(1), y: r(2), size: r(3) < 0.85 ? 1 : 1.8, a: 0.25 + 0.6 * r(4) };
});

function resize() {
  const dpr = window.devicePixelRatio || 1;
  ({ width: W, height: H } = canvas.getBoundingClientRect());
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  s = Math.min(W, H) / (2 * VIEW_KM);
}
resize();
new ResizeObserver(resize).observe(canvas);

const toScreen = (x, y) => [W / 2 + x * s, H / 2 - y * s];
const radiusAt = (px, py) => Math.min(R_MAX, Math.max(R_MIN, Math.hypot(px - W / 2, py - H / 2) / s));

const orbit = Orbit.circular(MU, 3000, 200 * DEG);
const sc = new Spacecraft({ theta: wrap(Math.atan2(-orbit.y, -orbit.x) + 70 * DEG) });
const ctl = new SlewController({ J: sc.J });
const dump = new MomentumDump();
const guidance = new TransferGuidance();

let hover = null;
let plan = null;            // { r2, ideal } for the transfer in progress or last flown
let dvUsed = 0;
let lastAction = performance.now() - IDLE_MS + 5000;

function requestTransfer(r2) {
  if (Math.abs(r2 - orbit.r) < 150) return;
  guidance.request(r2);
  plan = { r2, ideal: hohmannDv(MU, orbit.r, r2) };
  dvUsed = 0;
}

canvas.addEventListener('pointermove', (ev) => { hover = ev.pointerType === 'mouse' ? { x: ev.offsetX, y: ev.offsetY } : null; });
canvas.addEventListener('pointerleave', () => { hover = null; });
canvas.addEventListener('pointerdown', (ev) => {
  lastAction = performance.now();
  requestTransfer(radiusAt(ev.offsetX, ev.offsetY));
});

let gc = { thetaCmd: 0, accel: 0, rate: 0 };
let cmd = { err: 0, slewing: false };
let thrust = 0, simTime = 0, wheelAngle = 0;
const history = [];
let last = performance.now(), acc = 0;

function frame(now) {
  // Clamp so a backgrounded tab doesn't resume with a huge catch-up step.
  const frameDt = Math.min((now - last) / 1000, 0.1);
  acc += frameDt * TIME_WARP;
  last = now;
  // Spun at a small fraction of its real speed so the eye can follow it.
  wheelAngle += sc.wheel * 0.004 * frameDt;

  if (guidance.mode === 'POINT' && guidance.pending === null && now - lastAction > IDLE_MS && Math.abs(cmd.err) < 1 * DEG) {
    lastAction = now;
    requestTransfer(orbit.r < 3300 ? 4400 : 2300);
  }

  while (acc >= DT) {
    gc = guidance.update(orbit, sc, DT);
    thrust = dump.update(sc);
    cmd = ctl.update(sc, gc.thetaCmd, DT, thrust, gc.rate);
    sc.step(cmd.u, TAU_DIST + thrust, DT);
    orbit.step(gc.accel * Math.cos(sc.theta), gc.accel * Math.sin(sc.theta), DT);
    dvUsed += gc.accel * DT;
    simTime += DT;
    acc -= DT;
  }
  history.push({ t: simTime, err: cmd.err });
  while (history.length && simTime - history[0].t > HISTORY_S) history.shift();
  draw(now);
  requestAnimationFrame(frame);
}

function drawPlanet(x, y, r) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = colors.card;
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.clip();
  // Cloud bands, then a night side.
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  for (const f of [-0.55, -0.15, 0.3, 0.65]) {
    ctx.beginPath(); ctx.ellipse(0, f * r, r * 1.1, 0.18 * r, 0, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
  }
  ctx.fillStyle = colors.fg;
  ctx.globalAlpha = 0.12;
  ctx.beginPath(); ctx.arc(0.45 * r, 0, r * 1.05, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
  ctx.restore();
}

// Body frame: the dish (and boresight, and engine thrust) on +x, the trench across the middle.
// Canvas y is flipped, hence rotate(-theta).
function drawStation(x, y, R, k, now) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-sc.theta);

  if (gc.accel > 0) {
    const len = (14 + 6 * Math.sin(now / 30)) * k;
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(-R + 1, -0.35 * R);
    ctx.lineTo(-R - len, 0);
    ctx.lineTo(-R + 1, 0.35 * R);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = colors.card;
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();

  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R, 0, 2 * Math.PI); ctx.clip();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of [-0.7, -0.4, 0.35, 0.7]) { ctx.moveTo(f * R, -R); ctx.lineTo(f * R, R); }
  ctx.stroke();
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(0, R); ctx.stroke();
  ctx.restore();

  // Superlaser dish.
  ctx.fillStyle = colors.line;
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(0.52 * R, 0, 0.28 * R, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.fillStyle = colors.accent;
  ctx.beginPath(); ctx.arc(0.52 * R, 0, 0.07 * R, 0, 2 * Math.PI); ctx.fill();

  // Reaction wheel.
  const wr = 0.18 * R, wx = -0.5 * R;
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(wx, 0, wr, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(wx, 0); ctx.lineTo(wx + wr * Math.cos(wheelAngle), wr * Math.sin(wheelAngle)); ctx.stroke();

  // Desaturation thrusters at the rim, pushing in the direction of the commanded torque.
  if (thrust !== 0 && Math.floor(now / 70) % 3) {
    const dir = Math.sign(thrust);
    ctx.fillStyle = colors.accent;
    for (const sgn of [-1, 1]) {
      const yTip = sgn * R;
      // A CCW torque pushes the canvas +y rim toward +x, so its plume points -x.
      const xDir = -sgn * dir;
      ctx.beginPath();
      ctx.moveTo(0, yTip);
      ctx.lineTo(xDir * 10 * k, yTip - 3 * k);
      ctx.lineTo(xDir * 10 * k, yTip + 3 * k);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawConic(el) {
  if (el.e >= 0.999) return;
  ctx.beginPath();
  for (let i = 0; i <= 180; i++) {
    const nu = (i / 180) * 2 * Math.PI;
    const r = el.p / (1 + el.e * Math.cos(nu));
    const [x, y] = toScreen(r * Math.cos(el.argp + nu), r * Math.sin(el.argp + nu));
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

function circle(r) {
  ctx.beginPath(); ctx.arc(W / 2, H / 2, r * s, 0, 2 * Math.PI); ctx.stroke();
}

function drawWheelBar(x, y, w) {
  const frac = sc.hWheel / sc.hMax;
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, 10);
  ctx.fillStyle = dump.active ? colors.accent : colors.muted;
  const mid = x + w / 2;
  ctx.fillRect(Math.min(mid, mid + frac * w / 2), y + 1, Math.abs(frac) * w / 2, 8);
  ctx.strokeStyle = colors.fg;
  ctx.beginPath();
  ctx.moveTo(mid, y - 3); ctx.lineTo(mid, y + 13);
  for (const f of [-dump.start, dump.start]) { ctx.moveTo(mid + f * w / 2, y - 3); ctx.lineTo(mid + f * w / 2, y + 13); }
  ctx.stroke();
  ctx.fillStyle = colors.muted;
  ctx.fillText(`wheel momentum ${String(Math.round(frac * 100)).padStart(4)}%`, x, y - 8);
}

function drawChart(x, y, w, h) {
  const span = 10 * DEG;
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); ctx.stroke();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  history.forEach((p, i) => {
    const px = x + w - ((simTime - p.t) / HISTORY_S) * w;
    const py = y + h / 2 - Math.max(-1, Math.min(1, p.err / span)) * h / 2;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = colors.muted;
  ctx.fillText(`pointing error ±10°`, x, y - 8);
}

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  const m = Math.min(W, H);
  const k = Math.max(0.6, Math.min(1.2, m / 520));
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';

  ctx.fillStyle = colors.muted;
  for (const st of stars) {
    ctx.globalAlpha = st.a;
    ctx.fillRect(st.x * W, st.y * H, st.size, st.size);
  }
  ctx.globalAlpha = 1;

  const el = orbit.elements();
  const [px, py] = toScreen(orbit.x, orbit.y);
  const R = 12 * k + 4;
  const busy = guidance.mode !== 'POINT' || guidance.pending !== null;
  const locked = !busy && Math.abs(cmd.err) < 0.5 * DEG;

  if (hover) {
    const r2 = radiusAt(hover.x, hover.y);
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    circle(r2);
    ctx.setLineDash([]);
    ctx.fillStyle = colors.muted;
    ctx.fillText(`${Math.round(r2)} km · Δv ${hohmannDv(MU, orbit.r, r2).toFixed(1)} km/s`, hover.x + 12, hover.y - 10);
  }
  if (busy && plan) {
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([6, 6]);
    circle(plan.r2);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1.2;
  drawConic(el);

  drawPlanet(W / 2, H / 2, PLANET_KM * s);

  // Boresight: a solid beam to the planet once locked on, otherwise a short sight line.
  const c = Math.cos(sc.theta), sn = Math.sin(sc.theta);
  const to = locked ? orbit.r * s - PLANET_KM * s : 4 * R;
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = locked ? 2.5 : 1;
  ctx.beginPath();
  ctx.moveTo(px + 0.8 * R * c, py - 0.8 * R * sn);
  ctx.lineTo(px + to * c, py - to * sn);
  ctx.stroke();

  drawStation(px, py, R, k, now);

  const mode = guidance.mode === 'POINT' ? (busy ? 'PLAN' : locked ? 'POINT · LOCKED' : 'POINT') : guidance.mode;
  const lines = [
    `mode   ${mode}${dump.active ? ' · DESAT' : ''}`,
    `orbit  r ${String(Math.round(orbit.r)).padStart(4)} km  e ${el.e.toFixed(3)}`,
    `Δv     ${dvUsed.toFixed(2)} km/s${plan ? `  (ideal ${plan.ideal.toFixed(2)})` : ''}`,
    `point  ${(cmd.err / DEG).toFixed(1).padStart(5)}° err`,
    `wheel  ${String(Math.round(sc.wheel * 30 / Math.PI)).padStart(5)} rpm`,
  ];
  ctx.fillStyle = colors.muted;
  lines.forEach((l, i) => ctx.fillText(l, 14, 24 + i * 18));

  const panelW = Math.min(220, W - 28);
  if (H > 360) {
    drawWheelBar(14, H - 92, panelW);
    if (W >= 2 * panelW + 60) drawChart(W - panelW - 14, H - 82, panelW, 56);
  }
  ctx.fillStyle = colors.muted;
  ctx.fillText(`sim ×${TIME_WARP} · click to pick a new orbit`, 14, H - 14);
}

requestAnimationFrame(frame);
