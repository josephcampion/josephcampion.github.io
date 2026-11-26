import { atmosphere, Propulsion, Vehicle, ClimbGuidance, MachHold } from './sim.js';

const TIME_WARP = 25;         // the M 0.8 → 3.8 run takes ~19 minutes of sim time
const DT = 0.02;
const H_TOP_KM = 26;
const STAR_COUNT = 260;
const M_AXIS = 4.2;
const M_MIN = 0.6, M_MAX = 4.0;
const IDLE_MS = 20000;
const F_AXIS = 300e3;         // N, top of the thrust chart

const canvas = document.getElementById('sim');
const ctx = canvas.getContext('2d');

let W = 0, H = 0, colors = {}, L = {};

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['fg', 'muted', 'line', 'accent', 'card']) colors[k] = cs.getPropertyValue(`--${k}`).trim();
}
readColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
document.addEventListener('themechange', readColors);

// Panels in CSS px. Wide: flight and engine side by side over a full-width chart. Narrow: stacked.
function layout() {
  if (W >= 640) {
    const top = Math.round(H * 0.58);
    const split = Math.round(W * 0.6);
    return { flight: { x: 0, y: 0, w: split, h: top }, engine: { x: split, y: 0, w: W - split, h: top }, chart: { x: 0, y: top, w: W, h: H - top } };
  }
  const a = Math.round(H * 0.4), b = Math.round(H * 0.66);
  return { flight: { x: 0, y: 0, w: W, h: a }, engine: { x: 0, y: a, w: W, h: b - a }, chart: { x: 0, y: b, w: W, h: H - b } };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  ({ width: W, height: H } = canvas.getBoundingClientRect());
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  L = layout();
}
resize();
new ResizeObserver(resize).observe(canvas);

// Chart plot area; clicks anywhere map through its Mach axis.
const plotX0 = () => L.chart.x + 52;
const plotX1 = () => L.chart.x + L.chart.w - 16;
const machToX = (M) => plotX0() + (M / M_AXIS) * (plotX1() - plotX0());
const xToMach = (x) => ((x - plotX0()) / (plotX1() - plotX0())) * M_AXIS;

const prop = new Propulsion();
const guidance = new ClimbGuidance();
const hold = new MachHold();
const veh = new Vehicle({ M: 0.8, h: guidance.altitudeFor(0.8) });

// Full-power thrust and 1 g drag along the climb schedule, fixed, so they're computed once.
const curves = [];
for (let M = 0.05; M <= M_AXIS + 1e-9; M += 0.05) {
  const atm = atmosphere(guidance.altitudeFor(Math.max(M, 0.3)));
  curves.push({
    M,
    dry: prop.turbojet(atm, M, prop.dry).F,
    ab: prop.turbojet(atm, M, 1).F,
    rj: prop.ramjet(atm, M, 1).F,
    total: prop.evaluate(atm, M, 1).F,
    drag: M >= 0.3 ? veh.drag(atm, M * atm.a) : null,
  });
}

let Mcmd = 0.8;
let hoverX = null;
let lastAction = performance.now() - IDLE_MS + 3000;
let state = { M: 0.8, e: prop.evaluate(atmosphere(veh.h), 0.8, 0.3), hCmd: veh.h };
let fuelUsed = 0, flow = 0;

// Chase-view starfield in camera space: x, y across the view, z the distance ahead.
const spawnStar = (z = 0.15 + 0.85 * Math.random()) => ({ x: (Math.random() * 2 - 1) * 1.6, y: (Math.random() * 2 - 1) * 1.0, z });
const stars = Array.from({ length: STAR_COUNT }, () => spawnStar());

// Stars approach at a rate proportional to Mach, so both their speed and their streak length read as speed.
function moveStars(dt) {
  const rate = 0.05 + 0.16 * state.M;
  for (let i = 0; i < stars.length; i++) {
    stars[i].z -= rate * dt;
    if (stars[i].z < 0.04) stars[i] = spawnStar(1);
  }
}

canvas.addEventListener('pointermove', (ev) => { hoverX = ev.pointerType === 'mouse' ? ev.offsetX : null; });
canvas.addEventListener('pointerleave', () => { hoverX = null; });
canvas.addEventListener('pointerdown', (ev) => {
  lastAction = performance.now();
  Mcmd = Math.min(M_MAX, Math.max(M_MIN, xToMach(ev.offsetX)));
});

let last = performance.now(), acc = 0;

function frame(now) {
  // Clamp so a backgrounded tab doesn't resume with a huge catch-up step.
  const frameDt = Math.min((now - last) / 1000, 0.1);
  acc += frameDt * TIME_WARP;
  last = now;

  if (now - lastAction > IDLE_MS && Math.abs(state.M - Mcmd) < 0.05) {
    lastAction = now;
    Mcmd = state.M < 2 ? 3.8 : 0.9;
  }

  while (acc >= DT) {
    const atm = atmosphere(veh.h);
    const M = veh.V / atm.a;
    const p = hold.update(M, Mcmd, DT);
    const e = prop.evaluate(atm, M, p);
    const gc = guidance.update(veh);
    veh.step(e.F, gc.gammaCmd, DT);
    fuelUsed += e.fuel * DT;
    acc -= DT;
    state = { M, e, hCmd: gc.hCmd, q: 0.5 * atm.rho * veh.V ** 2 };
  }
  moveStars(frameDt);
  flow += frameDt;
  draw(now);
  requestAnimationFrame(frame);
}

// ---- Drawing ----

const mono = (px) => `${px}px ui-monospace, SFMono-Regular, Menlo, monospace`;

function panelFrame(P) {
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (P.x > 0) { ctx.moveTo(P.x + 0.5, P.y); ctx.lineTo(P.x + 0.5, P.y + P.h); }
  if (P.y > 0) { ctx.moveTo(P.x, P.y + 0.5); ctx.lineTo(P.x + P.w, P.y + 0.5); }
  ctx.stroke();
}

// An original light freighter seen from behind: a flat lifting disc with a center spine,
// canopy and twin canted fins. Its stacked exhausts match the engine diagram: the round
// turbojet nozzle above, the wide ramjet slot below.
function drawShip(x, y, w, now) {
  const { e } = state;
  ctx.save();
  ctx.translate(x, y);

  const hull = () => { ctx.beginPath(); ctx.ellipse(0, 0, 0.5 * w, 0.1 * w, 0, 0, 2 * Math.PI); };
  ctx.fillStyle = colors.card;
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.4;
  hull(); ctx.fill();

  // Underside in shadow, panel seams, and a raised rim.
  ctx.save();
  hull(); ctx.clip();
  ctx.fillStyle = colors.line;
  ctx.fillRect(-0.5 * w, 0.015 * w, w, 0.1 * w);
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of [-0.36, -0.22, 0.22, 0.36]) { ctx.moveTo(f * w, -0.1 * w); ctx.lineTo(f * 1.08 * w, 0.1 * w); }
  ctx.moveTo(-0.5 * w, 0.015 * w); ctx.lineTo(0.5 * w, 0.015 * w);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.4;
  hull(); ctx.stroke();

  // Twin fins, canted outward.
  ctx.fillStyle = colors.card;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * 0.24 * w, -0.06 * w);
    ctx.lineTo(s * 0.33 * w, -0.2 * w);
    ctx.lineTo(s * 0.36 * w, -0.2 * w);
    ctx.lineTo(s * 0.32 * w, -0.045 * w);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  // Spine and canopy.
  ctx.beginPath();
  ctx.moveTo(-0.15 * w, -0.06 * w);
  ctx.quadraticCurveTo(-0.13 * w, -0.17 * w, 0, -0.18 * w);
  ctx.quadraticCurveTo(0.13 * w, -0.17 * w, 0.15 * w, -0.06 * w);
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = colors.muted;
  ctx.beginPath(); ctx.ellipse(0, -0.145 * w, 0.06 * w, 0.022 * w, 0, Math.PI, 2 * Math.PI); ctx.stroke();

  // Engine block.
  ctx.fillStyle = colors.card;
  ctx.strokeStyle = colors.fg;
  ctx.beginPath();
  ctx.roundRect(-0.14 * w, -0.085 * w, 0.28 * w, 0.17 * w, 0.03 * w);
  ctx.fill(); ctx.stroke();

  // Exhaust glow: layered discs, sized and brightened by each engine's thrust.
  const flick = 0.9 + 0.1 * Math.sin(now / 37);
  const glow = (cx, cy, rx, ry, k) => {
    ctx.fillStyle = colors.accent;
    for (const [grow, a] of [[2.6, 0.12], [1.7, 0.25], [1, 0.9]]) {
      ctx.globalAlpha = a * Math.min(1, k);
      ctx.beginPath(); ctx.ellipse(cx, cy, rx * (1 + (grow - 1) * k * flick), ry * (1 + (grow - 1) * k * flick), 0, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  const tjK = e.tj.F / 180e3, rjK = e.rj.F / 180e3;
  ctx.fillStyle = colors.fg;
  ctx.globalAlpha = 0.8;
  ctx.beginPath(); ctx.arc(0, -0.025 * w, 0.045 * w, 0, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.roundRect(-0.1 * w, 0.035 * w, 0.2 * w, 0.032 * w, 0.01 * w); ctx.fill();
  ctx.globalAlpha = 1;
  if (tjK > 0.01) glow(0, -0.025 * w, 0.04 * w, 0.04 * w, tjK * (e.tj.ab ? 1.3 : 1));
  if (rjK > 0.01) glow(0, 0.051 * w, 0.095 * w, 0.014 * w, rjK);

  // Wingtip lights.
  if (Math.floor(now / 600) % 2) {
    ctx.fillStyle = colors.accent;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(s * 0.49 * w, 0, 2, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.restore();
}

function drawFlight(P, now) {
  ctx.save();
  ctx.beginPath(); ctx.rect(P.x, P.y, P.w, P.h); ctx.clip();
  const cx = P.x + P.w / 2, cy = P.y + P.h * 0.42;
  const f = 0.5 * Math.min(P.w, P.h * 1.6);
  const hFrac = Math.min(1, veh.h / (H_TOP_KM * 1000));

  // Horizon sinks as the ship climbs, and tips with the flight path.
  const horizon = cy + P.h * (0.04 + 0.42 * hFrac) + veh.gamma * f;
  ctx.fillStyle = colors.line;
  ctx.globalAlpha = 0.35 + 0.3 * (1 - hFrac);
  ctx.beginPath();
  ctx.moveTo(P.x, horizon + 8);
  ctx.quadraticCurveTo(cx, horizon - 8, P.x + P.w, horizon + 8);
  ctx.lineTo(P.x + P.w, P.y + P.h); ctx.lineTo(P.x, P.y + P.h);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Streaks: each star drawn from where it is to where it was a moment ago. Faster = longer.
  const streak = 0.004 + 0.022 * state.M;
  ctx.strokeStyle = colors.muted;
  ctx.lineCap = 'round';
  for (const st of stars) {
    const x1 = cx + (st.x / st.z) * f, y1 = cy + (st.y / st.z) * f;
    if (x1 < P.x || x1 > P.x + P.w || y1 < P.y || y1 > P.y + P.h) continue;
    const zt = st.z + streak;
    const x0 = cx + (st.x / zt) * f, y0 = cy + (st.y / zt) * f;
    ctx.globalAlpha = Math.min(1, (1 - st.z) * 1.3) * (0.45 + 0.55 * hFrac);
    ctx.lineWidth = Math.min(2.2, 0.4 + 0.5 / st.z);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';

  const shipW = Math.max(150, Math.min(P.w * 0.46, 340));
  drawShip(cx, P.y + P.h * 0.66 + Math.sin(now / 900) * 2, shipW, now);

  // Altitude tape on the right: current altitude and where the constant-q schedule wants it.
  const tx = P.x + P.w - 30, t0 = P.y + 20, t1 = P.y + P.h - 26;
  const hToY = (h) => t1 - (h / (H_TOP_KM * 1000)) * (t1 - t0);
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.font = mono(10);
  ctx.fillStyle = colors.muted;
  ctx.beginPath(); ctx.moveTo(tx, t0); ctx.lineTo(tx, t1);
  for (let h = 0; h <= 25; h += 5) { const y = hToY(h * 1000); ctx.moveTo(tx - 4, y); ctx.lineTo(tx, y); ctx.fillText(String(h), tx + 5, y + 3); }
  ctx.stroke();
  ctx.fillText('km', tx - 4, t0 - 6);
  ctx.strokeStyle = colors.accent;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(tx - 12, hToY(state.hCmd)); ctx.lineTo(tx, hToY(state.hCmd)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = colors.accent;
  const hy = hToY(veh.h);
  ctx.beginPath(); ctx.moveTo(tx - 1, hy); ctx.lineTo(tx - 10, hy - 5); ctx.lineTo(tx - 10, hy + 5); ctx.closePath(); ctx.fill();

  const { e } = state;
  const door = e.r > 0 && e.r < 1 ? ` · door ${Math.round(e.r * 100)}%` : '';
  const lines = [
    `mode   ${e.mode}${door}`,
    `Mach   ${state.M.toFixed(2)} → ${Mcmd.toFixed(2)}`,
    `alt    ${(veh.h / 1000).toFixed(1).padStart(4)} km   q ${Math.round(state.q / 1000)} kPa`,
    `thrust ${String(Math.round(e.F / 1000)).padStart(4)} kN  drag ${Math.round(veh.D / 1000)} kN`,
    `Isp    ${String(Math.round(e.isp)).padStart(4)} s   power ${Math.round(e.p * 100)}%`,
    `fuel   ${String(Math.round(fuelUsed)).padStart(4)} kg`,
  ];
  ctx.font = mono(W < 420 ? 11 : 13);
  ctx.fillStyle = colors.muted;
  const lh = W < 420 ? 14 : 18;
  lines.forEach((l, i) => ctx.fillText(l, P.x + 14, P.y + 22 + i * lh));
  ctx.font = mono(11);
  ctx.fillText(`sim ×${TIME_WARP} · streak length ∝ speed`, P.x + 14, P.y + P.h - 8);
  ctx.restore();
}

// Schematic over/under engine: one inlet, a door at the splitter, turbojet above, ramjet below.
function drawEngine(P, now) {
  const { e } = state;
  const r = e.r;
  const pad = 18;
  const bx = P.x + pad, bw = P.w - 2 * pad;
  const by = P.y + 28, bh = Math.max(60, P.h - 28 - (P.h > 220 ? 64 : 40));
  const X = (u) => bx + u * bw;
  const Y = (v) => by + v * bh;

  ctx.font = mono(11);
  ctx.fillStyle = colors.muted;
  ctx.fillText('inlet door · turbojet over ramjet', bx, P.y + 18);

  const share = [1 - r, r];
  const ducts = [{ y0: 0.12, y1: 0.48 }, { y0: 0.52, y1: 0.88 }];

  // Airflow, scrolling at a rate set by how much air each duct is passing.
  ducts.forEach((d, i) => {
    const s = share[i];
    if (s < 0.02) return;
    ctx.strokeStyle = colors.muted;
    ctx.globalAlpha = 0.25 + 0.6 * s;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 10]);
    ctx.lineDashOffset = -flow * 60 * (0.3 + state.M / 2);
    for (const f of [0.3, 0.7]) {
      const yy = Y(d.y0 + f * (d.y1 - d.y0));
      ctx.beginPath(); ctx.moveTo(X(0.02), yy); ctx.lineTo(X(1), yy); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  });

  const flame = (u0, u1, v0, v1, k) => {
    if (k <= 0.02) return;
    const flick = 0.85 + 0.15 * Math.sin(now / 35 + u0 * 10);
    ctx.fillStyle = colors.accent;
    ctx.globalAlpha = Math.min(1, 0.3 + 0.7 * k);
    const mid = (Y(v0) + Y(v1)) / 2, half = (Y(v1) - Y(v0)) * 0.32 * Math.min(1, 0.4 + k);
    ctx.beginPath();
    ctx.moveTo(X(u0), mid - half);
    ctx.lineTo(X(u0 + (u1 - u0) * Math.min(1, 0.3 + 0.7 * k) * flick), mid);
    ctx.lineTo(X(u0), mid + half);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  };
  const tj = e.tj, tjOn = tj.F > 0;
  flame(0.45, 0.57, 0.12, 0.48, tjOn ? (1 - r) * (tj.Tt4 / prop.Tt4Max) : 0);
  flame(0.69, 0.86, 0.12, 0.48, tj.ab ? (1 - r) * Math.max(0.2, (e.p - prop.dry) / (1 - prop.dry)) : 0);
  flame(0.56, 0.88, 0.52, 0.88, e.rj.F > 0 ? r * Math.max(0.25, e.p) : 0);

  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  // Outer walls, cowl lips, and the nozzles' throats.
  ctx.moveTo(X(0.06), Y(0.12)); ctx.lineTo(X(0.86), Y(0.12)); ctx.lineTo(X(0.92), Y(0.2)); ctx.lineTo(X(1), Y(0.14));
  ctx.moveTo(X(0.06), Y(0.88)); ctx.lineTo(X(0.86), Y(0.88)); ctx.lineTo(X(0.92), Y(0.8)); ctx.lineTo(X(1), Y(0.86));
  // Splitter, with its own throats.
  ctx.moveTo(X(0.2), Y(0.5)); ctx.lineTo(X(0.86), Y(0.5));
  ctx.moveTo(X(0.86), Y(0.48)); ctx.lineTo(X(0.92), Y(0.42)); ctx.lineTo(X(1), Y(0.47));
  ctx.moveTo(X(0.86), Y(0.52)); ctx.lineTo(X(0.92), Y(0.58)); ctx.lineTo(X(1), Y(0.53));
  ctx.moveTo(X(0.86), Y(0.48)); ctx.lineTo(X(0.86), Y(0.52));
  ctx.stroke();

  // Turbojet core: compressor tapering in, burner, turbine, then the afterburner duct.
  ctx.strokeStyle = colors.fg;
  ctx.globalAlpha = 0.4 + 0.6 * (1 - r);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 5; i++) {
    const u = 0.27 + i * 0.03, inset = 0.03 + i * 0.012;
    ctx.moveTo(X(u), Y(0.12 + inset)); ctx.lineTo(X(u), Y(0.48 - inset));
  }
  ctx.rect(X(0.44), Y(0.2), X(0.57) - X(0.44), Y(0.4) - Y(0.2));
  for (let i = 0; i <= 2; i++) {
    const u = 0.59 + i * 0.03;
    ctx.moveTo(X(u), Y(0.18)); ctx.lineTo(X(u), Y(0.42));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Ramjet flameholders.
  ctx.strokeStyle = colors.fg;
  ctx.globalAlpha = 0.4 + 0.6 * r;
  ctx.beginPath();
  for (const v of [0.62, 0.7, 0.78]) {
    ctx.moveTo(X(0.57), Y(v - 0.03)); ctx.lineTo(X(0.55), Y(v)); ctx.lineTo(X(0.57), Y(v + 0.03));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // The door hinges at the splitter's nose and swings from sealing the ramjet to sealing the turbojet.
  const hx = X(0.2), hy = Y(0.5);
  const a0 = Math.atan2(Y(0.88) - hy, X(0.06) - hx), a1 = Math.atan2(Y(0.12) - hy, X(0.06) - hx);
  let da = a1 - a0;
  if (da > Math.PI) da -= 2 * Math.PI;
  if (da < -Math.PI) da += 2 * Math.PI;
  const ang = a0 + da * r, dl = Math.hypot(X(0.06) - hx, Y(0.88) - hy);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + dl * Math.cos(ang), hy + dl * Math.sin(ang)); ctx.stroke();
  ctx.fillStyle = colors.accent;
  ctx.beginPath(); ctx.arc(hx, hy, 3, 0, 2 * Math.PI); ctx.fill();

  // Station numbers along the turbojet.
  ctx.fillStyle = colors.muted;
  ctx.font = mono(10);
  for (const [u, n] of [[0.25, '2'], [0.43, '3'], [0.575, '4'], [0.67, '5'], [0.86, '7'], [0.985, '9']]) ctx.fillText(n, X(u) - 3, Y(0.12) - 4);

  ctx.font = mono(P.w < 360 ? 10 : 11);
  const ty = Y(1) + 6;
  const tjText = tjOn
    ? `turbojet  πc ${tj.piC.toFixed(1).padStart(4)}  Tt3 ${Math.round(tj.Tt3)}/${prop.Tt3Max} K${tj.ab ? '  AB' : ''}`
    : `turbojet  ${r >= 1 ? 'shut, door closed' : `off: Tt3 limit ${prop.Tt3Max} K`}`;
  const rjText = r > 0 ? `ramjet    ${e.rj.F > 0 ? `lit, ${Math.round(e.rj.F / 1000)} kN` : 'idle'}` : `ramjet    door shut below M ${prop.M_ON}`;
  ctx.fillText(tjText, bx, ty + 10);
  ctx.fillText(rjText, bx, ty + 26);
}

function drawChart(P) {
  const y0 = P.y + 30, y1 = P.y + P.h - 28;
  const X = machToX, Y = (F) => y1 - (Math.min(F, F_AXIS) / F_AXIS) * (y1 - y0);
  const x0 = plotX0(), x1 = plotX1();

  ctx.font = mono(11);
  ctx.fillStyle = colors.muted;
  ctx.fillText('full-power thrust along the climb (kN) · click to set target Mach', P.x + 12, P.y + 18);

  ctx.fillStyle = colors.line;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(X(prop.M_ON), y0, X(prop.M_OFF) - X(prop.M_ON), y1 - y0);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let F = 0; F <= F_AXIS; F += 100e3) { ctx.moveTo(x0, Y(F)); ctx.lineTo(x1, Y(F)); }
  ctx.stroke();
  ctx.fillStyle = colors.muted;
  for (let F = 0; F <= F_AXIS; F += 100e3) ctx.fillText(String(F / 1000).padStart(3), P.x + 14, Y(F) + 4);
  for (let M = 0; M <= 4; M++) ctx.fillText(`M${M}`, X(M) - 8, y1 + 16);

  const line = (key, color, width, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let on = false;
    for (const c of curves) {
      const v = c[key];
      if (v === null || (v <= 0 && key !== 'total')) { on = false; continue; }
      on ? ctx.lineTo(X(c.M), Y(v)) : ctx.moveTo(X(c.M), Y(v));
      on = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line('dry', colors.muted, 1, [4, 4]);
  line('ab', colors.muted, 1.2, []);
  line('rj', colors.muted, 1, [1, 3]);
  line('drag', colors.fg, 1, []);
  line('total', colors.accent, 2, []);

  // Legend, top right.
  const items = [['blended', colors.accent, 2, []], ['turbojet + AB', colors.muted, 1.2, []], ['turbojet dry', colors.muted, 1, [4, 4]], ['ramjet alone', colors.muted, 1, [1, 3]], ['drag', colors.fg, 1, []]];
  ctx.font = mono(10);
  const lw = 120, lx = x1 - lw, compact = P.h < 170 || W < 420;
  // Short panels keep only the two lines that matter most.
  const shown = compact ? [items[0], items[4]] : items;
  shown.forEach(([name, color, width, dash], i) => {
    const yy = y0 + 4 + i * 13;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(lx, yy); ctx.lineTo(lx + 18, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.muted;
    ctx.fillText(name, lx + 24, yy + 3);
  });

  // Target and hover.
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(X(Mcmd), y0); ctx.lineTo(X(Mcmd), y1); ctx.stroke();
  ctx.setLineDash([]);
  if (hoverX !== null) {
    const Mh = Math.min(M_MAX, Math.max(M_MIN, xToMach(hoverX)));
    ctx.strokeStyle = colors.muted;
    ctx.beginPath(); ctx.moveTo(X(Mh), y0); ctx.lineTo(X(Mh), y1); ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.font = mono(11);
    ctx.fillText(`M ${Mh.toFixed(2)}`, Math.min(X(Mh) + 6, x1 - 50), y0 + 12);
  }

  // Live operating point: actual thrust at the current power setting.
  ctx.fillStyle = colors.accent;
  ctx.strokeStyle = colors.card;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(X(Math.min(state.M, M_AXIS)), Y(state.e.F), 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
}

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  drawFlight(L.flight, now);
  drawEngine(L.engine, now);
  drawChart(L.chart);
  panelFrame(L.engine);
  panelFrame(L.chart);
}

requestAnimationFrame(frame);
