// Flyby easter eggs, each flown by a real model: an X-wing on the X-wing demo's own Dubins path
// manager, a freighter dragging its Mach cone, and a droid balancing on one wheel.
import { KinematicModel, PathManager, wrap } from '/projects/xwing-follow/sim.js';

const DEG = Math.PI / 180;
// fun.js is a classic script injected before this module; read it lazily so load order can't bite.
const F = () => window.fun;
const mono = (px) => `${px}px "B612 Mono", ui-monospace, monospace`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const diamond = (ctx, x, y, r, filled) => {
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
  ctx.closePath();
  if (filled) ctx.fill(); else ctx.stroke();
};

// ── X-wing vs TIE ──────────────────────────────────────────────────────────────────────────────
// Same airframe numbers as the X-wing demo, sped up so the run fits in a few seconds.
const VA = 25;                  // m/s
const R = 120;                  // Dubins radius, m
const K_ORBIT = 5;
const VIEW_M = 700;             // metres spanned by the screen's shorter side
const WARP = 18;
const DT = 0.01;
const SPRITE_PX = 40;
const TIE_SPEED = 15;           // m/s
const BOLT_SPEED = 120;         // m/s
const RANGE = 350, CONE = 10 * DEG, HIT = 20, SHOT_GAP = 4;   // m, rad, m, sim s
const TIME_LIMIT = 700;         // sim s, about 40 s on screen
const DEBRIS_LIFE = 25, FLASH_LIFE = 8;   // sim s

let xwingSprite = null, dogfight = false;

function drawTie(ctx, c, x, y, h) {
  // Top-down, nose up: the two wing panels are seen edge-on, parallel to the flight path.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(h);
  ctx.strokeStyle = c.fg;
  ctx.fillStyle = c.fg;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(11, 0); ctx.stroke();
  for (const sg of [-1, 1]) ctx.fillRect(sg * 11 - 1.5, -13, 3, 26);
  ctx.fillStyle = c.card;
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(0, 0, 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.fillStyle = c.fg;
  ctx.beginPath(); ctx.arc(0, -3, 2, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
}

function xwingVsTie(clicks) {
  const { reduced, toast, overlay } = F();
  if (dogfight) return;
  if (reduced.matches) { toast('X-WING SKIPPED — reduced motion is on'); return; }
  dogfight = true;
  xwingSprite ??= Object.assign(new Image(), { src: '/images/xwing.svg' });

  const W = innerWidth, H = innerHeight;
  const s = Math.min(W, H) / VIEW_M;
  const toW = (x, y) => ({ n: -y / s, e: x / s });
  const toS = (n, e) => [e * s, -n * s];
  const offScreen = (n, e, m) => { const [x, y] = toS(n, e); return x < -m || x > W + m || y < -m || y > H + m; };
  const wps = clicks.map((p) => toW(p.x, p.y));

  // Enter from beyond the screen edge nearest the first click.
  const c0 = clicks[0], out = 80;
  const [ex, ey] = [[c0.x, -out, c0.y], [c0.x, H + out, H - c0.y], [-out, c0.y, c0.x], [W + out, c0.y, W - c0.x]]
    .sort((a, b) => a[2] - b[2])[0];
  const entry = toW(ex, ey);
  const ac = new KinematicModel({ Va: VA, pn: entry.n, pe: entry.e, chi: Math.atan2(wps[0].e - entry.e, wps[0].n - entry.n) });
  // The manager loops, so the leg after the last click heads back to the entry: that's where it breaks off.
  const pm = new PathManager({ R, type: 'dubins', kOrbit: K_ORBIT });
  pm.setWaypoints([entry, ...wps]);

  let phase = 'path', tie = null, bolts = [], debris = [], flash = null, trail = [], lastShot = -Infinity, simT = 0;
  toast(`DUBINS PATH THROUGH YOUR ${clicks.length} CLICKS`);

  const spawnTie = () => {
    const [x] = toS(ac.pn, ac.pe);
    const start = toW(x > W / 2 ? -40 : W + 40, H * (0.25 + 0.5 * Math.random()));
    const aim = toW(W * (0.3 + 0.4 * Math.random()), H * (0.3 + 0.4 * Math.random()));
    tie = { n: start.n, e: start.e, h0: Math.atan2(aim.e - start.e, aim.n - start.n), h: 0, vn: 0, ve: 0, t0: simT };
  };

  const step = (dt) => {
    simT += dt;
    let chiCmd = ac.chi;
    if (phase === 'path') {
      chiCmd = pm.update(ac).chiCmd;
      if (pm.i === 0) { phase = 'attack'; spawnTie(); toast('TIE INBOUND — LEAD PURSUIT'); }
    }
    if (tie) {
      tie.h = tie.h0 + 0.35 * Math.sin(0.12 * (simT - tie.t0));
      tie.vn = TIE_SPEED * Math.cos(tie.h);
      tie.ve = TIE_SPEED * Math.sin(tie.h);
      tie.n += tie.vn * dt;
      tie.e += tie.ve * dt;
    }
    if (phase === 'attack') {
      // Lead pursuit: aim where the TIE will be after the time it would take to fly there now.
      const dn = tie.n - ac.pn, de = tie.e - ac.pe, dist = Math.hypot(dn, de), tgo = dist / VA;
      chiCmd = Math.atan2(de + tie.ve * tgo, dn + tie.vn * tgo);
      if (dist < RANGE && Math.abs(wrap(Math.atan2(de, dn) - ac.chi)) < CONE && simT - lastShot > SHOT_GAP) {
        lastShot = simT;
        const half = SPRITE_PX / 2.2 / s;
        for (const sg of [-1, 1]) bolts.push({ n: ac.pn - sg * half * Math.sin(ac.chi), e: ac.pe + sg * half * Math.cos(ac.chi), chi: ac.chi, t: simT });
      }
      if (tie.t0 + 40 < simT && offScreen(tie.n, tie.e, 120)) { phase = 'egress'; tie = null; toast('TIE ESCAPED'); }
    }
    ac.step(chiCmd, dt);

    for (const b of bolts) { b.n += BOLT_SPEED * Math.cos(b.chi) * dt; b.e += BOLT_SPEED * Math.sin(b.chi) * dt; }
    bolts = bolts.filter((b) => simT - b.t < 5);
    if (tie && bolts.some((b) => Math.hypot(b.n - tie.n, b.e - tie.e) < HIT)) {
      for (let k = 0; k < 16; k++) {
        const a = 2 * Math.PI * Math.random(), sp = 5 + 20 * Math.random();
        debris.push({ n: tie.n, e: tie.e, vn: tie.vn + sp * Math.cos(a), ve: tie.ve + sp * Math.sin(a), th: 2 * Math.PI * Math.random(), w: (Math.random() - 0.5) * 4, len: 3 + 6 * Math.random(), t: simT });
      }
      flash = { n: tie.n, e: tie.e, t: simT };
      tie = null;
      bolts = [];
      phase = 'egress';
      toast('SPLASH ONE');
    }
    for (const d of debris) {
      const k = Math.exp(-0.3 * dt);
      d.vn *= k; d.ve *= k;
      d.n += d.vn * dt; d.e += d.ve * dt; d.th += d.w * dt;
    }
    debris = debris.filter((d) => simT - d.t < DEBRIS_LIFE);
  };

  const ov = overlay();
  const { ctx } = ov;
  const tracePrim = (p) => {
    if (p.a) { ctx.moveTo(...toS(p.a.n, p.a.e)); ctx.lineTo(...toS(p.b.n, p.b.e)); return; }
    // NED polar angle a sits at canvas angle a − π/2, as in the X-wing demo.
    const [x, y] = toS(p.c.n, p.c.e);
    ctx.moveTo(...toS(p.c.n + p.R * Math.cos(p.a0), p.c.e + p.R * Math.sin(p.a0)));
    ctx.arc(x, y, p.R * s, p.a0 - Math.PI / 2, p.a1 - Math.PI / 2, p.lam < 0);
  };

  ov.run((t, dt) => {
    for (let k = Math.round((dt * WARP) / DT); k > 0; k--) step(DT);
    const c = ov.colors;

    if (phase === 'path') {
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      for (let i = Math.max(pm.i, 1); i < pm.legs.length; i++) pm.legs[i].prims.forEach(tracePrim);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.font = mono(10);
    wps.forEach((w, k) => {
      const [x, y] = toS(w.n, w.e);
      const done = phase !== 'path' || k + 1 < pm.i;
      ctx.strokeStyle = ctx.fillStyle = done ? c.muted : c.accent;
      ctx.lineWidth = 1.5;
      diamond(ctx, x, y, 5, done);
      ctx.fillText(String(k + 1), x + 8, y - 6);
    });

    trail.push({ xy: toS(ac.pn, ac.pe), t });
    trail = trail.filter((p) => t - p.t < 1.2);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      ctx.globalAlpha = 0.5 * (1 - (t - trail[i].t) / 1.2);
      ctx.beginPath(); ctx.moveTo(...trail[i - 1].xy); ctx.lineTo(...trail[i].xy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const b of bolts) {
      const [x, y] = toS(b.n, b.e), dx = Math.sin(b.chi) * 9, dy = -Math.cos(b.chi) * 9;
      ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
    }
    ctx.lineCap = 'butt';

    if (tie) drawTie(ctx, c, ...toS(tie.n, tie.e), tie.h);
    if (flash && simT - flash.t < FLASH_LIFE) {
      const k = (simT - flash.t) / FLASH_LIFE, [x, y] = toS(flash.n, flash.e);
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6 + 40 * k, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.strokeStyle = c.fg;
    ctx.lineWidth = 2;
    for (const d of debris) {
      const [x, y] = toS(d.n, d.e);
      ctx.globalAlpha = 1 - (simT - d.t) / DEBRIS_LIFE;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(d.th) * d.len, y - Math.sin(d.th) * d.len);
      ctx.lineTo(x + Math.cos(d.th) * d.len, y + Math.sin(d.th) * d.len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const [x, y] = toS(ac.pn, ac.pe);
    if (xwingSprite.complete) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ac.chi);
      // Seen from above, a banked aircraft's wingspan foreshortens by cos(phi).
      ctx.scale(Math.cos(ac.phi), 1);
      ctx.drawImage(xwingSprite, -SPRITE_PX / 2, -SPRITE_PX / 2, SPRITE_PX, SPRITE_PX);
      ctx.restore();
    }
    ctx.fillStyle = c.muted;
    ctx.fillText(phase === 'path' ? `DUBINS ${pm.legs[pm.i]?.word ?? ''}` : phase === 'attack' ? 'LEAD PURSUIT' : 'RTB', x + 26, y - 18);

    const done = (phase === 'egress' && !debris.length && offScreen(ac.pn, ac.pe, 60)) || simT > TIME_LIMIT;
    if (done) dogfight = false;
    return !done;
  });
}

// Five clicks on empty page, spread out, within three seconds. Diamonds appear from the second
// click on, so a single stray click shows nothing.
const clicks = [];
const IGNORE = 'a, button, input, textarea, select, label, summary, iframe, video, img, canvas, dialog, .sim-stage, .egg, [contenteditable]';
let pips = null;
const showPips = () => {
  if (pips) return;
  const ov = F().overlay();
  pips = ov.run((t) => {
    const now = performance.now();
    while (clicks.length && now - clicks[0].t > 3000) clicks.shift();
    if (!clicks.length) { pips = null; return false; }
    ov.ctx.strokeStyle = ov.colors.accent;
    ov.ctx.lineWidth = 1.5;
    for (const p of clicks) {
      ov.ctx.globalAlpha = 1 - (now - p.t) / 3000;
      diamond(ov.ctx, p.x, p.y, 5, false);
    }
  });
};
document.addEventListener('click', (e) => {
  if (dogfight || e.button !== 0 || e.target.closest(IGNORE) || !getSelection().isCollapsed) return;
  const now = performance.now();
  while (clicks.length && now - clicks[0].t > 3000) clicks.shift();
  if (clicks.some((p) => Math.hypot(p.x - e.clientX, p.y - e.clientY) < 40)) return;
  clicks.push({ x: e.clientX, y: e.clientY, t: now });
  if (clicks.length >= 2) showPips();
  if (clicks.length === 5) xwingVsTie(clicks.splice(0));
});

// ── Freighter flyby ────────────────────────────────────────────────────────────────────────────
const MACH = 3;
let flying = false;

function drawFreighter(ctx, c, x, y, w, t) {
  // Top-down, nose to the right (+x), so starboard is down the screen.
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  const edge = (lw = 1.3) => { ctx.strokeStyle = c.fg; ctx.lineWidth = lw; ctx.stroke(); };
  ctx.fillStyle = c.card;
  for (const sg of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0.2 * w, sg * 0.04 * w); ctx.lineTo(0.6 * w, sg * 0.04 * w);
    ctx.lineTo(0.6 * w, sg * 0.13 * w); ctx.lineTo(0.2 * w, sg * 0.21 * w);
    ctx.closePath(); ctx.fill(); edge();
  }
  ctx.save();
  ctx.rotate(0.6);
  ctx.beginPath(); ctx.rect(0.2 * w, -0.04 * w, 0.24 * w, 0.08 * w); ctx.fill(); edge();
  ctx.beginPath(); ctx.arc(0.46 * w, 0, 0.06 * w, 0, 2 * Math.PI); ctx.fill(); edge();
  ctx.restore();

  ctx.beginPath(); ctx.arc(0, 0, 0.36 * w, 0, 2 * Math.PI); ctx.fill(); edge(1.5);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * 2 * Math.PI;
    ctx.moveTo(Math.cos(a) * 0.14 * w, Math.sin(a) * 0.14 * w);
    ctx.lineTo(Math.cos(a) * 0.35 * w, Math.sin(a) * 0.35 * w);
  }
  ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = c.line;
  ctx.beginPath(); ctx.arc(0, 0, 0.14 * w, 0, 2 * Math.PI); ctx.fill(); edge(1.2);
  ctx.fillStyle = c.card;
  ctx.beginPath(); ctx.arc(-0.06 * w, -0.21 * w, 0.045 * w, 0, 2 * Math.PI); ctx.fill(); edge(1.1);

  const flick = 0.9 + 0.1 * Math.sin(t * 27);
  ctx.strokeStyle = c.accent;
  ctx.lineCap = 'round';
  for (const [g, a] of [[3, 0.15], [1.8, 0.3], [0.8, 1]]) {
    ctx.globalAlpha = a;
    ctx.lineWidth = 0.035 * w * g * flick;
    ctx.beginPath(); ctx.arc(0, 0, 0.36 * w, Math.PI - 0.85, Math.PI + 0.85); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function flyby(y = innerHeight * 0.4) {
  const { reduced, toast, overlay, shake } = F();
  const mu = Math.asin(1 / MACH);
  const label = `MACH ${MACH} · μ = asin(1/M) = ${(mu / DEG).toFixed(1)}°`;
  if (flying) return;
  if (reduced.matches) { toast(label); return; }
  flying = true;
  const W = innerWidth, H = innerHeight;
  const w = clamp(W * 0.12, 80, 150);
  const speed = Math.max(1100, W * 1.2);    // px/s; the scene isn't to scale, only the cone angle is
  const L = W * 0.8;                        // drawn length of each shock line
  y = clamp(y, w, H - w);
  let x = -w, boomed = false;
  const ov = overlay();
  ov.run((t, dt) => {
    x += speed * dt;
    const { ctx, colors: c } = ov;
    const nose = x + 0.6 * w, tail = x - 0.4 * w;
    const fade = clamp(1 - (x - W - w) / (0.5 * W), 0, 1);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    for (const [ax, a] of [[nose, 0.9], [tail, 0.35]]) {
      ctx.globalAlpha = a * fade;
      ctx.beginPath();
      for (const sg of [-1, 1]) { ctx.moveTo(ax, y); ctx.lineTo(ax - L * Math.cos(mu), y + sg * L * Math.sin(mu)); }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.8 * fade;
    ctx.fillStyle = c.muted;
    ctx.font = mono(10);
    ctx.fillText(`M ${MACH}  μ ${(mu / DEG).toFixed(1)}°`, nose - 190, y - 190 * Math.tan(mu) - 8);
    ctx.globalAlpha = 1;
    drawFreighter(ctx, c, x, y, w, t);
    // The boom reaches an observer at the centre of the screen when the cone sweeps over them.
    if (!boomed && nose - Math.abs(H / 2 - y) / Math.tan(mu) >= W / 2) { boomed = true; shake(); toast(label); }
    if (fade > 0) return true;
    flying = false;
    return false;
  });
}

// ── Droid whirl ────────────────────────────────────────────────────────────────────────────────
// A wheel under an inverted pendulum: θ̈ = (g sin θ − u cos θ)/l, v̇ = u, with the wheel's
// acceleration u = aθ + bθ̇ + c(v − v_ref). Matching the linearised characteristic polynomial
// s³ + (b/l − c)s² + ((a − g)/l)s + gc/l to (s + p)³ gives the gains below. c > 0 is the
// non-minimum-phase signature: to speed up, the wheel first rolls *backward* to tip the body forward.
const G = 9.81, ARM = 0.45, POLE = 4, U_MAX = 20, WHEEL_R = 0.11, CRUISE = 3;
// Metres of roll-out per m/s at the moment the stop is commanded; measured from this loop (2.15 m from 3 m/s).
const BRAKE = 0.72;
const KC = (POLE ** 3 * ARM) / G, KA = G + 3 * POLE * POLE * ARM, KB = ARM * (3 * POLE + KC);
let rolling = false;

function drawDroid(ctx, c, X, ground, s, th, roll, look) {
  const r = WHEEL_R * s;
  ctx.save();
  ctx.translate(X, ground - r);
  ctx.lineJoin = 'round';
  const edge = (lw = 1.4) => { ctx.strokeStyle = c.fg; ctx.lineWidth = lw; ctx.stroke(); };

  ctx.save();
  ctx.rotate(th);
  const bw = 0.3 * s, top = -0.55 * s;
  ctx.fillStyle = c.card;
  ctx.beginPath(); ctx.roundRect(-bw / 2, top, bw, 0.5 * s, 0.05 * s); ctx.fill(); edge();
  ctx.fillStyle = c.accent;
  ctx.fillRect(-bw / 2 + 1, -0.34 * s, bw - 2, 0.045 * s);
  ctx.beginPath();
  ctx.moveTo(-bw / 2 + 0.05 * s, -0.24 * s); ctx.lineTo(bw / 2 - 0.05 * s, -0.24 * s);
  ctx.moveTo(-bw / 2 + 0.05 * s, -0.18 * s); ctx.lineTo(0, -0.18 * s);
  edge(1);
  ctx.fillStyle = c.line;
  ctx.beginPath(); ctx.arc(0, top, bw / 2, Math.PI, 0); ctx.closePath(); ctx.fill(); edge();
  ctx.beginPath(); ctx.moveTo(-0.06 * s, top - 0.13 * s); ctx.lineTo(-0.09 * s, top - 0.24 * s); edge(1.2);
  ctx.fillStyle = c.accent;
  ctx.beginPath(); ctx.arc(-0.09 * s, top - 0.24 * s, 0.018 * s, 0, 2 * Math.PI); ctx.fill();
  // One lens on the dome: at the front while it drives, swung round to face you when it stops to look.
  const ex = 0.09 * s * (1 - look), rx = 0.035 * s * (0.55 + 0.45 * look);
  ctx.fillStyle = c.fg;
  ctx.beginPath(); ctx.ellipse(ex, top - 0.07 * s, rx, 0.035 * s, 0, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = c.accent;
  ctx.beginPath(); ctx.arc(ex + rx * 0.3, top - 0.08 * s, 0.009 * s, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();

  ctx.fillStyle = c.line;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fill(); edge(1.5);
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = roll + (k * 2 * Math.PI) / 3;
    ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85);
  }
  edge(1.2);
  ctx.restore();
}

function droid() {
  const { reduced, toast, overlay } = F();
  if (rolling) return;
  if (reduced.matches) { toast('DROID SKIPPED — reduced motion is on'); return; }
  rolling = true;
  const W = innerWidth;
  const s = clamp(Math.min(innerHeight, W) / 7, 60, 130);     // px per metre
  const x0 = 80 / s;
  let x = x0, v = 0, th = 0, om = 0, roll = 0, ref = 0, look = 0, stage = 'wait', stageT = 0;
  toast('NON-MINIMUM PHASE: IT BACKS UP TO LEAN FORWARD');
  const step = (dt) => {
    const u = clamp(KA * th + KB * om + KC * (v - ref), -U_MAX, U_MAX);
    om += ((G * Math.sin(th) - u * Math.cos(th)) / ARM) * dt;
    th += om * dt;
    v += u * dt;
    x += v * dt;
    roll += (v / WHEEL_R) * dt;
  };
  const go = (next, vRef) => { stage = next; stageT = 0; ref = vRef; };
  const ov = overlay();
  ov.run((t, dt) => {
    for (let k = 0; k < 10; k++) step(dt / 10);
    stageT += dt;
    if (stage === 'wait' && stageT > 0.5) go('go', CRUISE);
    else if (stage === 'go' && (x + BRAKE * v) * s > W * 0.5) go('stop', 0);
    else if (stage === 'stop' && stageT > 1.2 && Math.abs(v) < 0.05) go('look', 0);
    else if (stage === 'look' && stageT > 1.4) go('leave', CRUISE * 1.5);
    look = clamp(look + (stage === 'look' && stageT < 1 ? 3 : -3) * dt, 0, 1);

    const { ctx, colors: c } = ov;
    const ground = innerHeight - 16;
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0 * s, ground - 6); ctx.lineTo(x0 * s, ground + 2); ctx.stroke();
    drawDroid(ctx, c, x * s, ground, s, th, roll, look);
    ctx.fillStyle = c.muted;
    ctx.font = mono(10);
    ctx.fillText(`θ ${(th / DEG).toFixed(1).padStart(5)}°  v ${v.toFixed(2).padStart(5)} m/s`, x * s + 0.25 * s, ground - 0.85 * s);
    if (x * s < W + 0.6 * s) return true;
    rolling = false;
    return false;
  });
}

document.addEventListener('click', (e) => {
  const egg = e.target.closest('.egg[data-egg]');
  if (!egg) return;
  const r = egg.getBoundingClientRect();
  if (egg.dataset.egg === 'flyby') flyby(r.top + r.height / 2);
  else if (egg.dataset.egg === 'droid') droid();
});
