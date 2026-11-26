// Turbojet → ramjet acceleration of a point-mass vehicle. Every engine model is the ideal
// (textbook) cycle from Mattingly, Elements of Propulsion, ch. 5 & 7: isentropic components,
// perfectly expanded nozzle, constant γ and cp. Every number is illustrative.

const G0 = 9.80665, GAMMA = 1.4, R_AIR = 287.05, CP = 1004.5, H_PR = 42.8e6;
const P_SL = 101325, T_SL = 288.15;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (lo, hi, x) => { const t = clamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) { const [x0, y0] = table[i - 1]; return lerp(y0, y1, (x - x0) / (x1 - x0)); }
  }
  return table[table.length - 1][1];
}

// 1976 standard atmosphere, 0–32 km.
export function atmosphere(h) {
  let T, p;
  if (h < 11000) {
    T = T_SL - 0.0065 * h;
    p = P_SL * (T / T_SL) ** (G0 / (0.0065 * R_AIR));
  } else if (h < 20000) {
    T = 216.65;
    p = 22632.1 * Math.exp(-G0 * (h - 11000) / (R_AIR * T));
  } else {
    T = 216.65 + 0.001 * (h - 20000);
    p = 5474.89 * (T / 216.65) ** (-G0 / (0.001 * R_AIR));
  }
  return { T, p, rho: p / (R_AIR * T), a: Math.sqrt(GAMMA * R_AIR * T) };
}

// Ideal single-spool turbojet with afterburner, run off-design (Mattingly ch. 8). The turbine
// and nozzle are choked, so the turbine temperature ratio τt stays at its design value, and
//   τc − 1 ∝ Tt4/Tt2,   ṁ ∝ (Pt2/√Tt2) · πc / √(Tt4/Tt2).
// As ram heating raises Tt2, the compressor unloads: πc and the thermal efficiency fall. The
// compressor exit temperature Tt3 also climbs, and holding it under its limit forces Tt4 down.
// Design point is sea-level static at Tt4R. mdotR is the design airflow.
export function turbojet(atm, M0, { mdotR, piCR, Tt4R, Tt3Max, Tt4, Tt7 = 0 }) {
  const { T, p, a } = atm;
  const tauR = 1 + 0.5 * (GAMMA - 1) * M0 * M0;
  const Tt2 = T * tauR, Pt2 = p * tauR ** (GAMMA / (GAMMA - 1));
  const tauCR = piCR ** ((GAMMA - 1) / GAMMA), thetaR = Tt4R / T_SL;
  const tauT = 1 - (tauCR - 1) / thetaR;
  Tt4 = Math.min(Tt4, (Tt3Max - Tt2) * thetaR / (tauCR - 1));
  const off = { F: 0, fuel: 0, mdot: 0, Tt3: Tt2, Tt4: 0, piC: 1, ab: false };
  if (Tt4 <= Tt2) return off;
  const th = Tt4 / Tt2;
  const tauC = 1 + (th / thetaR) * (tauCR - 1);
  const piC = tauC ** (GAMMA / (GAMMA - 1));
  const mdot = mdotR * (Pt2 / P_SL) / Math.sqrt(Tt2 / T_SL) * (piC / piCR) / Math.sqrt(th / thetaR);
  const tauL = Tt4 / T, X = tauR * tauC * tauT;
  const ab = Tt7 > Tt4 * tauT;
  const v9a0sq = (2 / (GAMMA - 1)) * (ab ? (Tt7 / T) / X : tauL / (tauR * tauC)) * (X - 1);
  const f = (CP * T / H_PR) * (ab ? Tt7 / T - tauR : tauL - tauR * tauC);
  // V9 < V0 would make the engine a net drag; the throttle never asks for that, so clamp.
  const F = Math.max(0, mdot * a * (Math.sqrt(Math.max(0, v9a0sq)) - M0));
  return { F, fuel: mdot * Math.max(0, f), mdot, Tt3: Tt2 * tauC, Tt4, piC, ab };
}

// Ideal ramjet. Full capture: the inlet swallows the whole free-stream tube of area Ac.
export function ramjet(atm, M0, { Ac, Tt4 }) {
  const { T, rho, a } = atm;
  const tauR = 1 + 0.5 * (GAMMA - 1) * M0 * M0;
  const tauL = Tt4 / T;
  const mdot = rho * a * M0 * Ac;
  if (tauL <= tauR || M0 <= 0) return { F: 0, fuel: 0, mdot };
  return { F: mdot * a * M0 * (Math.sqrt(tauL / tauR) - 1), fuel: mdot * (CP * T / H_PR) * (tauL - tauR), mdot };
}

// Over/under combined cycle. One power lever p ∈ [0, 1]: below `dry` it sets the turbojet's
// burner temperature, above it lights the afterburner. The ramjet burner follows the whole lever.
// A splitter door hands the shared inlet from the turbojet duct to the ramjet duct between
// M_ON and M_OFF; `blend` is how far across it is.
export class Propulsion {
  constructor({
    mdotR = 150, piCR = 12, Tt4Idle = 1100, Tt4Max = 1700, Tt3Max = 900, Tt7Max = 2200,
    Ac = 1.6, Tt4RjMax = 2400, dry = 0.6, M_ON = 2.0, M_OFF = 3.0,
  } = {}) {
    Object.assign(this, { mdotR, piCR, Tt4Idle, Tt4Max, Tt3Max, Tt7Max, Ac, Tt4RjMax, dry, M_ON, M_OFF });
  }

  blend(M) { return smoothstep(this.M_ON, this.M_OFF, M); }

  // The turbojet with its whole inlet, at power p. Used by the sim (scaled by the door) and the chart.
  turbojet(atm, M, p, share = 1) {
    const Tt4 = lerp(this.Tt4Idle, this.Tt4Max, Math.min(1, p / this.dry));
    const Tt7 = p > this.dry ? lerp(Tt4, this.Tt7Max, (p - this.dry) / (1 - this.dry)) : 0;
    return turbojet(atm, M, { mdotR: this.mdotR * share, piCR: this.piCR, Tt4R: this.Tt4Max, Tt3Max: this.Tt3Max, Tt4, Tt7 });
  }

  ramjet(atm, M, p, share = 1) {
    const Tt0 = atm.T * (1 + 0.5 * (GAMMA - 1) * M * M);
    return ramjet(atm, M, { Ac: this.Ac * share, Tt4: lerp(Tt0, this.Tt4RjMax, p) });
  }

  evaluate(atm, M, p) {
    const r = this.blend(M);
    const tj = r < 1 ? this.turbojet(atm, M, p, 1 - r) : { F: 0, fuel: 0, mdot: 0, ab: false };
    const rj = r > 0 ? this.ramjet(atm, M, p, r) : { F: 0, fuel: 0, mdot: 0 };
    const F = tj.F + rj.F, fuel = tj.fuel + rj.fuel;
    const mode = r === 0 ? (tj.ab ? 'AFTERBURNER' : 'TURBOJET') : r === 1 ? 'RAMJET' : 'TRANSITION';
    return { F, fuel, isp: fuel > 0 ? F / (fuel * G0) : 0, r, p, tj, rj, mode };
  }
}

// Point mass in the vertical plane. Lift always balances weight across the path, so there is
// no pitch or angle of attack yet; the flight-path angle just lags its command.
export class Vehicle {
  constructor({ m = 30000, S = 60, h = 2000, M = 0.8, tauGamma = 4 } = {}) {
    const V = M * atmosphere(h).a;
    Object.assign(this, { m, S, h, V, x: 0, gamma: 0, tauGamma, F: 0, D: 0 });
  }

  // Zero-lift drag rises through Mach 1 and eases off above; induced drag grows supersonic.
  static CD0 = [[0, 0.016], [0.85, 0.016], [1.05, 0.042], [1.3, 0.038], [2, 0.03], [3, 0.024], [4.5, 0.021]];
  static K = [[0, 0.15], [1, 0.2], [2, 0.32], [4.5, 0.55]];

  drag(atm, V, gamma = 0) {
    const M = V / atm.a, q = 0.5 * atm.rho * V * V;
    const CL = this.m * G0 * Math.cos(gamma) / (q * this.S);
    return q * this.S * (interp(Vehicle.CD0, M) + interp(Vehicle.K, M) * CL * CL);
  }

  step(F, gammaCmd, dt) {
    const atm = atmosphere(this.h);
    this.F = F;
    this.D = this.drag(atm, this.V, this.gamma);
    this.V = Math.max(50, this.V + ((F - this.D) / this.m - G0 * Math.sin(this.gamma)) * dt);
    this.gamma += (gammaCmd - this.gamma) / this.tauGamma * dt;
    this.h += this.V * Math.sin(this.gamma) * dt;
    this.x += this.V * Math.cos(this.gamma) * dt;
  }
}

// Constant dynamic pressure climb: q = ½ρV² = ½γpM², so holding q means holding p·M².
// Below the floor altitude the vehicle just holds the floor.
export class ClimbGuidance {
  constructor({ q = 45000, hMin = 2000, hMax = 28000, kH = 0.04, gammaMax = 12 * Math.PI / 180 } = {}) {
    Object.assign(this, { q, hMin, hMax, kH, gammaMax });
  }

  altitudeFor(M) {
    const pTarget = 2 * this.q / (GAMMA * M * M);
    let lo = this.hMin, hi = this.hMax;
    if (atmosphere(lo).p <= pTarget) return lo;
    if (atmosphere(hi).p >= pTarget) return hi;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      atmosphere(mid).p > pTarget ? (lo = mid) : (hi = mid);
    }
    return (lo + hi) / 2;
  }

  update(veh) {
    const M = veh.V / atmosphere(veh.h).a;
    const hCmd = this.altitudeFor(M);
    const hDot = clamp(this.kH * (hCmd - veh.h), -veh.V * Math.sin(this.gammaMax), veh.V * Math.sin(this.gammaMax));
    return { hCmd, gammaCmd: Math.asin(hDot / veh.V) };
  }
}

// Mach hold on the power lever: PI with conditional integration so it doesn't wind up at full power.
export class MachHold {
  constructor({ kP = 1.5, kI = 0.05 } = {}) {
    Object.assign(this, { kP, kI, integral: 0.3 });
  }

  update(M, Mcmd, dt) {
    const e = Mcmd - M;
    const raw = this.kP * e + this.integral;
    if ((raw < 1 || e < 0) && (raw > 0 || e > 0)) this.integral = clamp(this.integral + this.kI * e * dt, 0, 1);
    return clamp(raw, 0, 1);
  }
}

export { G0 };
