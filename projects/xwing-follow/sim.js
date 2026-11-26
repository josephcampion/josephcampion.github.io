// Port of star-wars-nav guidance/kinematic_sim.py (roll channel only — the view is top-down)
// and guidance/path_follower.py, plus the ch. 11 path manager.
// Beard & McLain, Small Unmanned Aircraft, ch. 10–11.
// Frame: NED, so pn = north, pe = east, course chi measured clockwise from north.

const G = 9.8067;
const DEG = Math.PI / 180;

// Floor-mod so this matches Python's (x + pi) % 2pi - pi for negative angles.
export const wrap = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export class KinematicModel {
  constructor({ Va, pn = 0, pe = 0, chi = 0, kpChi = 1.5, phiMax = 35 * DEG, omegaNPhi = 3, zetaPhi = 0.7, pMax = 60 * DEG }) {
    Object.assign(this, { Va, pn, pe, chi, phi: 0, phiDot: 0, kpChi, phiMax, omegaNPhi, zetaPhi, pMax });
  }

  step(chiCmd, dt) {
    const phiCmd = clamp(this.kpChi * wrap(chiCmd - this.chi), -this.phiMax, this.phiMax);
    const phiDdot = this.omegaNPhi ** 2 * (phiCmd - this.phi) - 2 * this.zetaPhi * this.omegaNPhi * this.phiDot;
    const phiDotNew = clamp(this.phiDot + phiDdot * dt, -this.pMax, this.pMax);
    const chiDot = this.Va > 1 ? (G / this.Va) * Math.tan(this.phi) : 0;

    this.pn += this.Va * Math.cos(this.chi) * dt;
    this.pe += this.Va * Math.sin(this.chi) * dt;
    this.chi = wrap(this.chi + chiDot * dt);
    this.phi += phiDotNew * dt;
    this.phiDot = phiDotNew;
  }
}

// B&M §10.1. r = path origin, q = unit direction; returns { chiCmd, ePy } with ePy > 0 right of path.
export function straightLine(pn, pe, r, q, chiInf = 70 * DEG, kPath = 0.02) {
  const ePy = q.n * (pe - r.e) - q.e * (pn - r.n);
  const chiQ = Math.atan2(q.e, q.n);
  return { chiCmd: wrap(chiQ - chiInf * (2 / Math.PI) * Math.atan(kPath * ePy)), ePy };
}

// B&M §10.2. dir = +1 clockwise, -1 counter-clockwise; returns { chiCmd, eRho } with eRho = rho - R.
export function orbit(pn, pe, c, R, dir = 1, kOrbit = 10) {
  const dn = pn - c.n, de = pe - c.e;
  const rho = Math.hypot(dn, de);
  const phi = Math.atan2(de, dn);
  return { chiCmd: wrap(phi + dir * (Math.PI / 2 + Math.atan((kOrbit * (rho - R)) / R))), eRho: rho - R };
}

// Fly a line toward the target, then orbit it. Hysteresis between the two switch
// radii keeps a target that jitters near the boundary from flipping modes every frame.
export class CursorGuidance {
  constructor({ R, kOrbit = 10, enterOrbit = 2 * R, leaveOrbit = 4 * R }) {
    Object.assign(this, { R, kOrbit, enterOrbit, leaveOrbit, mode: 'line', anchor: null, dir: 1 });
  }

  update(ac, target) {
    const dist = Math.hypot(target.n - ac.pn, target.e - ac.pe);

    if (this.mode === 'line' && dist < this.enterOrbit) {
      this.mode = 'orbit';
      const bearing = Math.atan2(target.e - ac.pe, target.n - ac.pn);
      this.dir = wrap(bearing - ac.chi) >= 0 ? 1 : -1;
    } else if (this.mode === 'orbit' && dist > this.leaveOrbit) {
      this.mode = 'line';
      this.anchor = null;
    }

    if (this.mode === 'orbit') return { mode: 'orbit', ...orbit(ac.pn, ac.pe, target, this.R, this.dir, this.kOrbit) };

    this.anchor ??= { n: ac.pn, e: ac.pe };
    const dn = target.n - this.anchor.n, de = target.e - this.anchor.e;
    const len = Math.hypot(dn, de) || 1;
    return { mode: 'line', ...straightLine(ac.pn, ac.pe, this.anchor, { n: dn / len, e: de / len }) };
  }
}

// ---- B&M ch. 11: path management ----
// Waypoints are { n, e } and are flown as a closed loop so the demo never runs out of path.
// Leg i runs from w[i-1] to w[i], indices mod N.

const HALF_PI = Math.PI / 2;
const mod2pi = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const sub = (a, b) => ({ n: a.n - b.n, e: a.e - b.e });
const add = (a, b, k = 1) => ({ n: a.n + k * b.n, e: a.e + k * b.e });
const dot = (a, b) => a.n * b.n + a.e * b.e;
const norm = (v) => Math.hypot(v.n, v.e);
const unit = (v) => { const l = norm(v) || 1; return { n: v.n / l, e: v.e / l }; };
const heading = (v) => Math.atan2(v.e, v.n);
const dirOf = (a) => ({ n: Math.cos(a), e: Math.sin(a) });
const neg = (v) => ({ n: -v.n, e: -v.e });

export const inHalfPlane = (p, r, n) => dot(sub(p, r), n) >= 0;

// B&M Algorithm 7. lam = +1 clockwise (right), -1 counter-clockwise (left).
// Arc angles a0/a1 are polar angles about the circle centre, for drawing.
export function dubinsParameters(ps, chiS, pe, chiE, R) {
  const center = (p, chi, lam) => ({ n: p.n - lam * R * Math.sin(chi), e: p.e + lam * R * Math.cos(chi) });
  const arc = (from, to, lam) => R * mod2pi(lam * (to - from));
  const crs = center(ps, chiS, 1), cls = center(ps, chiS, -1);
  const cre = center(pe, chiE, 1), cle = center(pe, chiE, -1);

  let ell = norm(sub(cre, crs));
  let th = heading(sub(cre, crs));
  const L1 = ell < 1e-6 ? Infinity
    : ell + arc(chiS - HALF_PI, th - HALF_PI, 1) + arc(th - HALF_PI, chiE - HALF_PI, 1);

  ell = norm(sub(cle, crs));
  th = heading(sub(cle, crs));
  let th2 = th - HALF_PI + Math.asin(Math.min(1, 2 * R / ell));
  const L2 = ell < 2 * R ? Infinity
    : Math.sqrt(ell ** 2 - 4 * R ** 2) + arc(chiS - HALF_PI, th2, 1) + arc(th2 + Math.PI, chiE + HALF_PI, -1);

  ell = norm(sub(cre, cls));
  th = heading(sub(cre, cls));
  th2 = Math.acos(Math.min(1, 2 * R / ell));
  const L3 = ell < 2 * R ? Infinity
    : Math.sqrt(ell ** 2 - 4 * R ** 2) + arc(chiS + HALF_PI, th + th2, -1) + arc(th + th2 - Math.PI, chiE - HALF_PI, 1);

  ell = norm(sub(cle, cls));
  th = heading(sub(cle, cls));
  const L4 = ell < 1e-6 ? Infinity
    : ell + arc(chiS + HALF_PI, th + HALF_PI, -1) + arc(th + HALF_PI, chiE + HALF_PI, -1);

  const L = Math.min(L1, L2, L3, L4);
  let cs, ce, lamS, lamE, q1, z1, z2, word;
  if (L === L1) {
    [cs, lamS, ce, lamE, word] = [crs, 1, cre, 1, 'RSR'];
    q1 = unit(sub(ce, cs));
    z1 = add(cs, { n: q1.e, e: -q1.n }, R);
    z2 = add(ce, { n: q1.e, e: -q1.n }, R);
  } else if (L === L2) {
    [cs, lamS, ce, lamE, word] = [crs, 1, cle, -1, 'RSL'];
    th2 = heading(sub(ce, cs)) - HALF_PI + Math.asin(2 * R / norm(sub(ce, cs)));
    q1 = dirOf(th2 + HALF_PI);
    z1 = add(cs, dirOf(th2), R);
    z2 = add(ce, dirOf(th2 + Math.PI), R);
  } else if (L === L3) {
    [cs, lamS, ce, lamE, word] = [cls, -1, cre, 1, 'LSR'];
    th = heading(sub(ce, cs));
    th2 = Math.acos(2 * R / norm(sub(ce, cs)));
    q1 = dirOf(th + th2 - HALF_PI);
    z1 = add(cs, dirOf(th + th2), R);
    z2 = add(ce, dirOf(th + th2 - Math.PI), R);
  } else {
    [cs, lamS, ce, lamE, word] = [cls, -1, cle, -1, 'LSL'];
    q1 = unit(sub(ce, cs));
    z1 = add(cs, { n: -q1.e, e: q1.n }, R);
    z2 = add(ce, { n: -q1.e, e: q1.n }, R);
  }
  return {
    L, word, cs, lamS, ce, lamE, z1, q1, z2, z3: pe, q3: dirOf(chiE),
    arcS: { c: cs, R, lam: lamS, a0: chiS - lamS * HALF_PI, a1: heading(sub(z1, cs)) },
    arcE: { c: ce, R, lam: lamE, a0: heading(sub(z2, ce)), a1: chiE - lamE * HALF_PI },
  };
}

// B&M §11.2 corner geometry. arc is null for a corner too sharp or too straight to round.
export function fillet(wPrev, w, wNext, R) {
  const qIn = unit(sub(w, wPrev)), qOut = unit(sub(wNext, w));
  const varrho = Math.acos(clamp(-dot(qIn, qOut), -1, 1));
  const t = Math.tan(varrho / 2);
  // B&M assume the tangent points fit on the legs; shrinking the fillet keeps
  // closely spaced waypoints from producing overlapping corners.
  const d = Math.min(R / t, 0.5 * norm(sub(w, wPrev)), 0.5 * norm(sub(wNext, w)));
  const Rf = d * t;
  const dq = sub(qIn, qOut);
  if (!(Rf >= 1) || norm(dq) < 1e-6) return { qIn, qOut, z1: w, z2: w, arc: null };
  const c = add(w, unit(dq), -Rf / Math.sin(varrho / 2));
  const z1 = add(w, qIn, -d), z2 = add(w, qOut, d);
  const lam = Math.sign(qIn.n * qOut.e - qIn.e * qOut.n);
  return { qIn, qOut, z1, z2, arc: { c, R: Rf, lam, a0: heading(sub(z1, c)), a1: heading(sub(z2, c)) } };
}

// Dubins needs a course at each waypoint; use the chord through its neighbours.
function waypointCourse(wPrev, w, wNext) {
  const v = sub(wNext, wPrev);
  return norm(v) > 1e-6 ? heading(v) : heading(sub(wNext, w));
}

// B&M Algorithms 5 (line), 6 (fillet) and 8 (Dubins), driving the ch. 10 followers.
// legs[i].prims is the planned geometry of leg i; `part` indexes the piece being flown.
export class PathManager {
  constructor({ R, type = 'fillet', kOrbit = 10 }) {
    Object.assign(this, { R, type, kOrbit, wps: [], legs: [], i: 1, state: 1, halfPlane: null });
  }

  setWaypoints(wps) {
    this.wps = wps.slice();
    this.i = this.wps.length ? this.i % this.wps.length : 1;
    this.state = 1;
    this.plan();
  }

  setType(type) {
    this.type = type;
    this.state = 1;
    this.plan();
  }

  get part() {
    if (this.type === 'fillet') return this.state - 1;
    if (this.type === 'dubins') return [0, 0, 1, 2, 2][this.state - 1];
    return 0;
  }

  plan() {
    const N = this.wps.length, R = this.R;
    const w = (k) => this.wps[((k % N) + N) % N];
    this.legs = [];
    if (N < 2) return;
    for (let i = 0; i < N; i++) {
      if (this.type === 'line') {
        const qIn = unit(sub(w(i), w(i - 1))), qOut = unit(sub(w(i + 1), w(i)));
        const bis = add(qIn, qOut);
        this.legs.push({ r: w(i - 1), q: qIn, n: norm(bis) > 1e-6 ? unit(bis) : qIn, prims: [{ a: w(i - 1), b: w(i) }] });
      } else if (this.type === 'fillet') {
        const prev = fillet(w(i - 2), w(i - 1), w(i), R);
        const f = fillet(w(i - 1), w(i), w(i + 1), R);
        this.legs.push({ r: w(i - 1), ...f, prims: [{ a: prev.z2, b: f.z1 }, ...(f.arc ? [f.arc] : [])] });
      } else {
        const chiS = waypointCourse(w(i - 2), w(i - 1), w(i));
        const chiE = waypointCourse(w(i - 1), w(i), w(i + 1));
        const dp = dubinsParameters(w(i - 1), chiS, w(i), chiE, R);
        this.legs.push({ ...dp, prims: [dp.arcS, { a: dp.z1, b: dp.z2 }, dp.arcE] });
      }
    }
  }

  next() {
    this.i = (this.i + 1) % this.wps.length;
    this.state = 1;
  }

  update(ac) {
    const p = { n: ac.pn, e: ac.pe };
    const L = this.legs[this.i];
    const follow = (r, q) => ({ mode: 'line', ...straightLine(ac.pn, ac.pe, r, q) });
    const circle = (c, R, lam) => ({ mode: 'orbit', ...orbit(ac.pn, ac.pe, c, R, lam, this.kOrbit) });

    if (this.type === 'line') {
      this.halfPlane = { r: this.wps[this.i], n: L.n };
      if (inHalfPlane(p, this.halfPlane.r, L.n)) this.next();
      const M = this.legs[this.i];
      return follow(M.r, M.q);
    }

    if (this.type === 'fillet') {
      this.halfPlane = this.state === 1 ? { r: L.z1, n: L.qIn } : { r: L.z2, n: L.qOut };
      if (inHalfPlane(p, this.halfPlane.r, this.halfPlane.n)) {
        if (this.state === 1 && L.arc) this.state = 2;
        else this.next();
      }
      const M = this.legs[this.i];
      return this.state === 1 ? follow(M.r, M.qIn) : circle(M.arc.c, M.arc.R, M.arc.lam);
    }

    // States 1/2 and 4/5 both orbit. The first of each pair waits until the aircraft
    // is behind the exit point, so a nearly full-circle arc isn't cut short.
    const planes = [[L.z1, neg(L.q1)], [L.z1, L.q1], [L.z2, L.q1], [L.z3, neg(L.q3)], [L.z3, L.q3]];
    const [r, n] = planes[this.state - 1];
    this.halfPlane = { r, n };
    if (inHalfPlane(p, r, n)) {
      if (this.state === 5) this.next();
      else this.state++;
    }
    const M = this.legs[this.i];
    if (this.state <= 2) return circle(M.cs, this.R, M.lamS);
    if (this.state === 3) return follow(M.z1, M.q1);
    return circle(M.ce, this.R, M.lamE);
  }
}
