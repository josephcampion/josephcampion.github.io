// Single-axis spacecraft attitude control: rigid body, one reaction wheel, thrusters for
// momentum dumping. Textbook model (e.g. Wie, Space Vehicle Dynamics and Control); every
// number is illustrative, and the disturbance is exaggerated so the wheel fills up quickly.
// Angles are counter-clockwise from +x.

const DEG = Math.PI / 180;

export const wrap = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export class Spacecraft {
  constructor({ J = 10, Jw = 0.002, uMax = 0.1, wheelMax = 6000 * Math.PI / 30, theta = 0 } = {}) {
    // wheel = wheel speed relative to the body, rad/s
    Object.assign(this, { J, Jw, uMax, wheelMax, theta, omega: 0, wheel: 0, u: 0 });
  }

  get hMax() { return this.Jw * this.wheelMax; }
  get hWheel() { return this.Jw * (this.wheel + this.omega); }

  // uCmd is the torque asked of the wheel, as felt by the body; tauExt is everything else.
  step(uCmd, tauExt, dt) {
    let u = clamp(uCmd, -this.uMax, this.uMax);
    // The wheel spins opposite to the torque it puts on the body, so at its speed limit it can only push one way.
    if ((this.wheel >= this.wheelMax && u < 0) || (this.wheel <= -this.wheelMax && u > 0)) u = 0;
    const omegaDot = (u + tauExt) / this.J;
    const wheelDot = -u / this.Jw - omegaDot;
    this.omega += omegaDot * dt;
    this.theta = wrap(this.theta + this.omega * dt);
    this.wheel = clamp(this.wheel + wheelDot * dt, -this.wheelMax, this.wheelMax);
    this.u = u;
  }
}

// Cascaded loops: angle error → rate command (capped at the slew rate) → torque, plus an
// integral term that trims out a steady disturbance torque.
// kTheta · omegaMax ≤ uMax / J keeps the deceleration ramp within what the wheel can deliver,
// so large slews stop without overshoot even while torque-limited.
// Stability of s³ + kΩ s² + kΩ kθ s + kI needs kI < kΩ² kθ.
export class SlewController {
  constructor({ J, kTheta = 0.15, kOmega = 0.6, kI = 0.01, omegaMax = 3 * DEG, iBand = 2 * DEG, iMax = 0.05 } = {}) {
    Object.assign(this, { J, kTheta, kOmega, kI, omegaMax, iBand, iMax, integral: 0 });
  }

  // uKnown is external torque the controller commanded itself (thrusters), cancelled by feedforward.
  // omegaFf is how fast the target direction itself is turning, so a rotating target is tracked without lag.
  update(sc, thetaCmd, dt, uKnown = 0, omegaFf = 0) {
    const err = wrap(thetaCmd - sc.theta);
    // Integrate only near the target so the end of a big slew doesn't wind it up into an overshoot.
    if (Math.abs(err) < this.iBand) this.integral = clamp(this.integral + this.kI * err * dt, -this.iMax, this.iMax);
    const omegaCmd = clamp(this.kTheta * err, -this.omegaMax, this.omegaMax) + omegaFf;
    const u = this.J * (this.kOmega * (omegaCmd - sc.omega) + this.integral) - uKnown;
    return { u, err, slewing: Math.abs(this.kTheta * err) > this.omegaMax };
  }
}

// Fire the thrusters against the wheel's stored momentum once it passes `start`, and stop at `stop`.
// The attitude loop holds the body still, so the external torque drains the wheel.
export class MomentumDump {
  constructor({ thrust = 0.03, start = 0.75, stop = 0.1 } = {}) {
    Object.assign(this, { thrust, start, stop, active: false });
  }

  update(sc) {
    const frac = Math.abs(sc.hWheel) / sc.hMax;
    if (!this.active && frac > this.start) this.active = true;
    else if (this.active && frac < this.stop) this.active = false;
    return this.active ? -Math.sign(sc.hWheel) * this.thrust : 0;
  }
}

// ---- Orbit (2D two-body) ----
// Units are km and s. MU is chosen so a 3000 km circular orbit takes 8 minutes: watchable, not a real planet.
export const MU = (4 * Math.PI ** 2 * 3000 ** 3) / 480 ** 2;

export class Orbit {
  constructor({ mu = MU, x, y, vx, vy }) {
    Object.assign(this, { mu, x, y, vx, vy });
  }

  static circular(mu, r, angle) {
    const v = Math.sqrt(mu / r);
    return new Orbit({ mu, x: r * Math.cos(angle), y: r * Math.sin(angle), vx: -v * Math.sin(angle), vy: v * Math.cos(angle) });
  }

  get r() { return Math.hypot(this.x, this.y); }
  get vr() { return (this.x * this.vx + this.y * this.vy) / this.r; }

  // Semi-implicit Euler: symplectic, so orbits don't spiral in or out at this step size.
  step(ax, ay, dt) {
    const k = -this.mu / this.r ** 3;
    this.vx += (k * this.x + ax) * dt;
    this.vy += (k * this.y + ay) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  elements() {
    const { mu, x, y, vx, vy } = this;
    const r = this.r, v2 = vx * vx + vy * vy, rv = x * vx + y * vy;
    const h = x * vy - y * vx;
    const ex = ((v2 - mu / r) * x - rv * vx) / mu;
    const ey = ((v2 - mu / r) * y - rv * vy) / mu;
    const e = Math.hypot(ex, ey);
    const p = (h * h) / mu;
    return { e, p, h, argp: Math.atan2(ey, ex), rp: p / (1 + e), ra: e < 1 ? p / (1 - e) : Infinity };
  }
}

// Ideal impulsive Hohmann Δv between circular orbits, for the preview readout.
export function hohmannDv(mu, r1, r2) {
  const a = (r1 + r2) / 2;
  const dv1 = Math.abs(Math.sqrt(mu * (2 / r1 - 1 / a)) - Math.sqrt(mu / r1));
  const dv2 = Math.abs(Math.sqrt(mu / r2) - Math.sqrt(mu * (2 / r2 - 1 / a)));
  return dv1 + dv2;
}

// Two-burn transfer to a new circular orbit with finite burns. The engine pushes along body +x
// (the dish axis), so the station must slew to prograde or retrograde before it can burn.
// Each burn ends on the live orbit, not a precomputed time: burn 1 when the far apsis reaches
// the target radius, burn 2 when the velocity matches a circular orbit at the current radius.
export class TransferGuidance {
  constructor({ accel = 0.8, alignTol = 2 * DEG, dvDone = 0.03 } = {}) {
    Object.assign(this, { accel, alignTol, dvDone, mode: 'POINT', r2: null, pending: null, up: true, prevVr: 0, coastT: 0, prevCmd: null });
  }

  // Velocity change that would make the current orbit circular at the current radius.
  static circularizeDv(orbit) {
    const r = orbit.r, v = Math.sqrt(orbit.mu / r);
    const sense = Math.sign(orbit.x * orbit.vy - orbit.y * orbit.vx) || 1;
    return { x: -sense * v * orbit.y / r - orbit.vx, y: sense * v * orbit.x / r - orbit.vy };
  }

  request(r2) { this.pending = r2; }

  update(orbit, sc, dt) {
    const out = this.command(orbit, sc, dt);
    // Feed forward how fast the command itself is turning. A jump (a mode switch) isn't a rate, so skip it.
    const d = this.prevCmd === null ? 0 : wrap(out.thetaCmd - this.prevCmd);
    this.prevCmd = out.thetaCmd;
    return { ...out, rate: Math.abs(d) < 0.5 * DEG ? d / dt : 0 };
  }

  command(orbit, sc, dt) {
    const nadir = Math.atan2(-orbit.y, -orbit.x);
    if (this.mode === 'POINT' && this.pending !== null) {
      this.r2 = this.pending;
      this.pending = null;
      this.up = this.r2 > orbit.r;
      this.mode = 'SLEW';
    }
    if (this.mode === 'POINT') return { thetaCmd: nadir, accel: 0 };

    let burnDir = wrap(Math.atan2(orbit.vy, orbit.vx) + (this.up ? 0 : Math.PI));
    const aligned = Math.abs(wrap(burnDir - sc.theta)) < this.alignTol;
    const el = orbit.elements();
    let accel = 0;

    if (this.mode === 'SLEW' && aligned) this.mode = 'BURN 1';
    if (this.mode === 'BURN 1') {
      if (this.up ? el.ra >= this.r2 : el.rp <= this.r2) {
        this.mode = 'COAST';
        this.prevVr = orbit.vr;
        this.coastT = 0;
      } else if (aligned) accel = this.accel;
    }
    if (this.mode === 'COAST') {
      this.coastT += dt;
      const vr = orbit.vr;
      // Raising: apoapsis is where radial velocity turns negative. Lowering: periapsis, where it turns positive.
      const atApsis = this.up ? this.prevVr > 0 && vr <= 0 : this.prevVr < 0 && vr >= 0;
      this.prevVr = vr;
      if (atApsis && this.coastT > 10) this.mode = 'BURN 2';
    }
    if (this.mode === 'BURN 2') {
      const dv = TransferGuidance.circularizeDv(orbit);
      const left = Math.hypot(dv.x, dv.y);
      if (left < this.dvDone) this.mode = 'POINT';
      else {
        burnDir = Math.atan2(dv.y, dv.x);
        if (Math.abs(wrap(burnDir - sc.theta)) < this.alignTol) accel = Math.min(this.accel, left / dt);
      }
    }
    return { thetaCmd: this.mode === 'POINT' ? nadir : burnDir, accel };
  }
}
