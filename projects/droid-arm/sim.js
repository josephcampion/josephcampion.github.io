// Planar 3-link arm in a vertical plane, gravity along −y: kinematics, rigid-body dynamics,
// damped-least-squares IK, min-jerk Cartesian trajectories and computed-torque control.
// Textbook models (e.g. Siciliano et al., Robotics: Modelling, Planning and Control); every
// number is illustrative. Angles are counter-clockwise from +x, the shoulder is the origin.

export const DEG = Math.PI / 180;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const wrap = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// Gaussian elimination with partial pivoting; A is n×n (rows), b has length n.
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const L = [0.30, 0.25, 0.10], MASS = [1.5, 1.0, 0.4];

export class Arm {
  constructor({
    l = L, m = MASS, lc = l.map((v) => v / 2), I = m.map((mi, i) => (mi * l[i] ** 2) / 12),
    qMin = [-135 * DEG, 0, -90 * DEG], qMax = [135 * DEG, 150 * DEG, 90 * DEG],
    tauMax = [20, 8, 1.5], b = 0.05, g = 9.81, q = [-40 * DEG, 80 * DEG, -20 * DEG], qd,
  } = {}) {
    const n = l.length;
    Object.assign(this, { n, l, m, lc, I, qMin, qMax, tauMax, b, g });
    this.q = [...q];
    this.qd = qd ? [...qd] : new Array(n).fill(0);
    this.tau = new Array(n).fill(0);
    this.sat = new Array(n).fill(false);
  }

  fk(q = this.q) {
    let x = 0, y = 0, a = 0;
    const pts = [[0, 0]], phi = [];
    for (let i = 0; i < this.n; i++) {
      a += q[i];
      phi.push(a);
      x += this.l[i] * Math.cos(a);
      y += this.l[i] * Math.sin(a);
      pts.push([x, y]);
    }
    return { pts, p: [x, y], phi };
  }

  // 2×n, rows are x and y.
  jacobian(q = this.q) {
    const { phi } = this.fk(q);
    const J = [new Array(this.n).fill(0), new Array(this.n).fill(0)];
    let sx = 0, sy = 0;
    for (let j = this.n - 1; j >= 0; j--) {
      sx -= this.l[j] * Math.sin(phi[j]);
      sy += this.l[j] * Math.cos(phi[j]);
      J[0][j] = sx;
      J[1][j] = sy;
    }
    return J;
  }

  clampQ(q) {
    return q.map((v, i) => clamp(v, this.qMin[i], this.qMax[i]));
  }

  // Per link: centre-of-mass position, its Jacobian, and the velocity-product part of its acceleration.
  links(q, qd = new Array(this.n).fill(0)) {
    const { phi } = this.fk(q);
    const { n, l, lc } = this;
    const e = phi.map((a) => [Math.cos(a), Math.sin(a)]);
    const nn = phi.map((a) => [-Math.sin(a), Math.cos(a)]);
    const w = [];
    qd.reduce((s, v) => (w.push(s + v), s + v), 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      const pc = [lc[i] * e[i][0], lc[i] * e[i][1]];
      const kap = [-lc[i] * w[i] ** 2 * e[i][0], -lc[i] * w[i] ** 2 * e[i][1]];
      for (let k = 0; k < i; k++) {
        pc[0] += l[k] * e[k][0]; pc[1] += l[k] * e[k][1];
        kap[0] -= l[k] * w[k] ** 2 * e[k][0]; kap[1] -= l[k] * w[k] ** 2 * e[k][1];
      }
      const Jc = [new Array(n).fill(0), new Array(n).fill(0)];
      let cx = lc[i] * nn[i][0], cy = lc[i] * nn[i][1];
      for (let j = i; j >= 0; j--) {
        if (j < i) { cx += l[j] * nn[j][0]; cy += l[j] * nn[j][1]; }
        Jc[0][j] = cx;
        Jc[1][j] = cy;
      }
      out.push({ pc, Jc, kap });
    }
    return out;
  }

  massMatrix(q = this.q) {
    const { n, m, I } = this;
    const M = Array.from({ length: n }, () => new Array(n).fill(0));
    this.links(q).forEach(({ Jc }, i) => {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          M[r][c] += m[i] * (Jc[0][r] * Jc[0][c] + Jc[1][r] * Jc[1][c]) + (r <= i && c <= i ? I[i] : 0);
        }
      }
    });
    return M;
  }

  // Coriolis, centrifugal and gravity torques.
  bias(q = this.q, qd = this.qd) {
    const h = new Array(this.n).fill(0);
    this.links(q, qd).forEach(({ Jc, kap }, i) => {
      for (let j = 0; j < this.n; j++) h[j] += this.m[i] * (Jc[0][j] * kap[0] + Jc[1][j] * (kap[1] + this.g));
    });
    return h;
  }

  // Semi-implicit Euler. Friction b is in the plant only, so the controller never sees it.
  step(tauCmd, dt) {
    const { n, q, qd } = this;
    this.sat = tauCmd.map((t, i) => Math.abs(t) > this.tauMax[i]);
    this.tau = tauCmd.map((t, i) => clamp(t, -this.tauMax[i], this.tauMax[i]));
    const h = this.bias(q, qd);
    const qdd = solve(this.massMatrix(q), this.tau.map((t, i) => t - this.b * qd[i] - h[i]));
    for (let i = 0; i < n; i++) {
      qd[i] += qdd[i] * dt;
      q[i] += qd[i] * dt;
      if (q[i] < this.qMin[i]) { q[i] = this.qMin[i]; if (qd[i] < 0) qd[i] = 0; }
      if (q[i] > this.qMax[i]) { q[i] = this.qMax[i]; if (qd[i] > 0) qd[i] = 0; }
    }
  }
}

// Damped least squares, J# = Jᵀ(JJᵀ + λ²I)⁻¹, with λ ramping in only near a singularity
// (Nakamura & Hanafusa 1986), plus a posture term pulled toward qRest through I − J#J.
// A joint sitting on its limit and asked to push past it is locked (its column dropped) and the
// rest re-solved, so the other joints pick up the motion instead of the solver stalling there.
export function dlsRate(arm, q, v, { lambda0 = 0.05, w0 = 0.06, k0 = 0, qRest = null } = {}) {
  const n = q.length, Jfull = arm.jacobian(q), locked = new Array(n).fill(false);
  for (;;) {
    const J = Jfull.map((row) => row.map((x, j) => (locked[j] ? 0 : x)));
    const a = dot(J[0], J[0]), b = dot(J[0], J[1]), d = dot(J[1], J[1]);
    const w = Math.sqrt(Math.max(0, a * d - b * b));
    const l2 = w < w0 ? lambda0 ** 2 * (1 - (w / w0) ** 2) : 0;
    const A = a + l2, D = d + l2, det = A * D - b * b;
    const Jp = J[0].map((_, j) => [(J[0][j] * D - J[1][j] * b) / det, (J[1][j] * A - J[0][j] * b) / det]);
    const qd = Jp.map((r) => r[0] * v[0] + r[1] * v[1]);
    if (k0 && qRest) {
      // With λ > 0, I − J#J is no longer a true null-space projector and the posture pull leaks
      // into the hand position, so it fades out as damping fades in: (w/w0)² = 1 − λ²/λ0².
      const k = w < w0 ? k0 * (w / w0) ** 2 : k0;
      const z = qRest.map((r, j) => (locked[j] ? 0 : k * (r - q[j])));
      const Jz = [dot(J[0], z), dot(J[1], z)];
      for (let j = 0; j < n; j++) qd[j] += z[j] - (Jp[j][0] * Jz[0] + Jp[j][1] * Jz[1]);
    }
    const out = qd.findIndex((x, j) => !locked[j] && ((q[j] <= arm.qMin[j] + 1e-9 && x < 0) || (q[j] >= arm.qMax[j] - 1e-9 && x > 0)));
    if (out < 0 || locked.filter(Boolean).length === n - 1) return { qd: qd.map((x, j) => (locked[j] ? 0 : x)), w, lambda: Math.sqrt(l2) };
    locked[out] = true;
  }
}

// Iterated DLS steps; for an unreachable target it settles at the closest pose it can find.
export function solveIK(arm, q0, target, { iters = 100, tol = 1e-4, maxStep = 0.1, k0 = 0.05, qRest = null, lambda0, w0 } = {}) {
  let q = [...q0];
  const errAt = (q) => {
    const p = arm.fk(q).p;
    return [target[0] - p[0], target[1] - p[1]];
  };
  let e = errAt(q), err = Math.hypot(...e);
  for (let it = 0; it < iters && err >= tol; it++) {
    // Linearisation is only good locally, so long steps are shortened.
    const f = Math.min(1, maxStep / err);
    // Posture picks the elbow/wrist split on the way in; near a singularity it also nudges the
    // hand off target, so the last few millimetres are solved without it.
    const { qd } = dlsRate(arm, q, [e[0] * f, e[1] * f], { lambda0, w0, k0: err > 5e-3 ? k0 : 0, qRest });
    q = arm.clampQ(q.map((v, j) => v + qd[j]));
    e = errAt(q);
    err = Math.hypot(...e);
  }
  return { q, err, converged: err < tol };
}

// Quintic from (p0, v0, a0) to p1 at rest, at time t of T.
export function quintic(p0, v0, a0, p1, T, t) {
  t = clamp(t, 0, T);
  const D = p1 - p0;
  const c3 = (20 * D - 12 * v0 * T - 3 * a0 * T * T) / (2 * T ** 3);
  const c4 = (-30 * D + 16 * v0 * T + 3 * a0 * T * T) / (2 * T ** 4);
  const c5 = (12 * D - 6 * v0 * T - a0 * T * T) / (2 * T ** 5);
  return {
    p: p0 + v0 * t + (a0 / 2) * t * t + c3 * t ** 3 + c4 * t ** 4 + c5 * t ** 5,
    v: v0 + a0 * t + 3 * c3 * t * t + 4 * c4 * t ** 3 + 5 * c5 * t ** 4,
    a: a0 + 6 * c3 * t + 12 * c4 * t * t + 20 * c5 * t ** 3,
  };
}

// A rest-to-rest min-jerk move peaks at 1.875 d/T in speed and 5.774 d/T² in acceleration.
export function moveDuration(d, { vMax = 0.8, aMax = 3, Tmin = 0.4 } = {}) {
  return Math.max(Tmin, (1.875 * d) / vMax, Math.sqrt((5.774 * d) / aMax));
}

export class CartesianPlanner {
  constructor(opts = {}) {
    this.opts = opts;
    this.T = 0;
  }

  plan(state, goal) {
    this.from = { p: [...state.p], v: [...state.v], a: [...state.a] };
    this.goal = [...goal];
    this.T = moveDuration(Math.hypot(goal[0] - state.p[0], goal[1] - state.p[1]), this.opts);
    // The duration rule assumes a start from rest. Re-planning mid-move (a drag) starts with
    // speed, which can need far more acceleration, so stretch T until the peak fits.
    const { aMax = 3 } = this.opts;
    for (let i = 0; i < 30 && this.peakAccel() > 1.05 * aMax; i++) this.T *= 1.1;
    return this.T;
  }

  peakAccel() {
    let peak = 0;
    for (let i = 0; i <= 40; i++) {
      const { a } = this.sample((i / 40) * this.T);
      peak = Math.max(peak, Math.hypot(a[0], a[1]));
    }
    return peak;
  }

  sample(t) {
    const { from, goal, T } = this;
    const s = [0, 1].map((i) => quintic(from.p[i], from.v[i], from.a[i], goal[i], T, t));
    return { p: s.map((x) => x.p), v: s.map((x) => x.v), a: s.map((x) => x.a), done: t >= T };
  }
}

// The droid's chest and head, which the hand shouldn't be sent into. The chest box runs on
// behind the back, and the belly box covers the pocket under the shoulder: with the elbow
// only bending one way, both need the arm to swing round past a joint limit, which local IK can't plan.
// `exits` lists the sides a goal may be pushed out through (left, right, top), so a goal is
// never pushed from one box into its neighbour.
export const KEEP_OUT = [
  { x0: -1, x1: -0.04, y0: -0.08, y1: 0.10, exits: 'rt' },
  { x0: -1, x1: 0.14, y0: -1, y1: -0.08, exits: 'r' },
  { x0: -0.25, x1: -0.05, y0: 0.10, y1: 0.19, exits: 'lrt' },
];

export function clampGoal(p, { rMin = 0.20, rMax = 0.62, yMin = -0.60, keepOut = KEEP_OUT, margin = 0.01 } = {}) {
  let [x, y] = p;
  // The reach circle cuts through the boxes, so one fix can undo another; repeat until it settles.
  for (let it = 0; it < 8; it++) {
    const r = Math.hypot(x, y) || 1e-9;
    const rc = clamp(r, rMin, rMax);
    x *= rc / r; y *= rc / r;
    y = Math.max(y, yMin);
    for (const b of keepOut) {
      if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) {
        const opts = { l: [b.x0 - margin, y, x - b.x0], r: [b.x1 + margin, y, b.x1 - x], t: [x, b.y1 + margin, b.y1 - y] };
        [x, y] = [...b.exits].map((k) => opts[k]).reduce((best, o) => (o[2] < best[2] ? o : best));
      }
    }
  }
  return { p: [x, y], clamped: Math.hypot(x - p[0], y - p[1]) > 1e-9 };
}

export class ComputedTorque {
  constructor({ Kp = 400, Kd = 40 } = {}) {
    Object.assign(this, { Kp, Kd });
  }

  update(arm, qRef, qdRef, qddRef) {
    const u = qRef.map((r, i) => qddRef[i] + this.Kd * (qdRef[i] - arm.qd[i]) + this.Kp * (r - arm.q[i]));
    const M = arm.massMatrix(arm.q), h = arm.bias(arm.q, arm.qd);
    return M.map((row, i) => dot(row, u) + h[i]);
  }
}

// Goal → min-jerk Cartesian path → CLIK on a joint reference → computed torque on the plant.
export class ReachTask {
  constructor(arm, { Kik = 20, lambda0 = 0.05, w0 = 0.06, k0 = 2, qRest = [-40 * DEG, 80 * DEG, -20 * DEG], traj, ctl, goal } = {}) {
    Object.assign(this, { arm, Kik, qRest, goalOpts: goal });
    this.dls = { lambda0, w0, k0, qRest };
    this.planner = new CartesianPlanner(traj);
    this.ctl = new ComputedTorque(ctl);
    this.qr = [...arm.q];
    this.qrd = new Array(arm.n).fill(0);
    this.qrdd = new Array(arm.n).fill(0);
    const p = arm.fk(this.qr).p;
    this.desired = { p, v: [0, 0], a: [0, 0] };
    this.goal = [...p];
    this.mode = 'HOLD';
    this.t = 0;
  }

  request(goal) {
    this.goal = clampGoal(goal, this.goalOpts).p;
    // Starting from the current desired state keeps p_d and v_d continuous through a re-plan.
    this.planner.plan(this.desired, this.goal);
    this.t = 0;
    this.mode = 'MOVE';
    return this.planner.T;
  }

  update(dt) {
    const { arm } = this;
    if (this.mode === 'MOVE') {
      this.t += dt;
      const s = this.planner.sample(this.t);
      if (s.done) {
        this.mode = 'HOLD';
        this.desired = { p: [...this.goal], v: [0, 0], a: [0, 0] };
      } else this.desired = s;
    }
    const d = this.desired;
    const pr = arm.fk(this.qr).p;
    const v = [0, 1].map((i) => d.v[i] + this.Kik * (d.p[i] - pr[i]));
    const r = dlsRate(arm, this.qr, v, this.dls);
    const qr = arm.clampQ(this.qr.map((x, j) => x + r.qd[j] * dt));
    const qrd = qr.map((x, j) => (x - this.qr[j]) / dt);
    this.qrdd = qrd.map((x, j) => (x - this.qrd[j]) / dt);
    this.qrd = qrd;
    this.qr = qr;

    arm.step(this.ctl.update(arm, this.qr, this.qrd, this.qrdd), dt);
    const p = arm.fk().p;
    const e = [d.p[0] - p[0], d.p[1] - p[1]];
    return { mode: this.mode, pd: d.p, p, err: Math.hypot(...e), e, w: r.w, lambda: r.lambda, tau: arm.tau, sat: arm.sat };
  }
}
