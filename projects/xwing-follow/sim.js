// Port of star-wars-nav guidance/kinematic_sim.py (roll channel only — the view is top-down)
// and guidance/path_follower.py. Beard & McLain, Small Unmanned Aircraft, ch. 10.
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
