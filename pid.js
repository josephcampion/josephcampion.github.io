// Easter egg: press "p" and a quadrotor holds position on your cursor with a PID loop per axis.
// Pressing "p" again steps the damping ratio (underdamped, critical, overdamped), then turns it off.
(() => {
  const { funToy, toast } = window.fun;
  const WN = 6;                   // rad/s, natural frequency of the closed position loop
  const MODES = [[0.3, 'UNDERDAMPED'], [1, 'CRITICALLY DAMPED'], [2, 'OVERDAMPED']];
  const KI = 4;                   // 1/s³, a slow integral that trims out drag lag on a moving cursor
  const I_MAX = 40;               // px·s, anti-windup clamp
  const DRAG = 0.6;               // 1/s, linear drag the controller doesn't model
  const A_MAX = 5000;             // px/s², thrust-limited acceleration per axis
  const TILT_MAX = 35 * Math.PI / 180;
  const TRAIL = 0.6;              // s
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  let mode = 0, drone = null, setpoint = null, trail = [];
  try { mode = Math.min(MODES.length - 1, +sessionStorage.getItem('pidMode') || 0); } catch {}
  const saveMode = () => { try { sessionStorage.setItem('pidMode', String(mode)); } catch {} };

  // Kp = ωn² and Kd = 2ζωn place the closed-loop poles of the double integrator at the chosen ζ, ωn.
  const stepAxis = (s, ref, kp, kd, dt) => {
    const e = ref - s.p;
    s.i = clamp(s.i + e * dt, -I_MAX, I_MAX);
    // Derivative on the measurement, not the error, so a jump in the setpoint doesn't kick the drone.
    const u = clamp(kp * e + KI * s.i - kd * s.v, -A_MAX, A_MAX);
    s.v += (u - DRAG * s.v) * dt;
    s.p += s.v * dt;
    return u;
  };

  const frame = (ctx, t, dt, ptr, colors) => {
    if (ptr.pointer) setpoint = ptr.pointer;
    if (!setpoint) return;
    if (!drone) drone = { x: { p: setpoint.x, v: 0, i: 0 }, y: { p: setpoint.y, v: 0, i: 0 }, ux: 0, uy: 0, spin: 0 };
    const [zeta] = MODES[mode];
    const kp = WN * WN, kd = 2 * zeta * WN;
    for (let k = 0; k < 4; k++) {
      drone.ux = stepAxis(drone.x, setpoint.x, kp, kd, dt / 4);
      drone.uy = stepAxis(drone.y, setpoint.y, kp, kd, dt / 4);
    }
    drone.spin += dt * 40;
    const x = drone.x.p, y = drone.y.p;

    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(setpoint.x - 7, setpoint.y); ctx.lineTo(setpoint.x + 7, setpoint.y);
    ctx.moveTo(setpoint.x, setpoint.y - 7); ctx.lineTo(setpoint.x, setpoint.y + 7);
    ctx.stroke();

    trail.push({ x, y, t });
    trail = trail.filter((p) => t - p.t < TRAIL);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    for (let i = 1; i < trail.length; i++) {
      ctx.globalAlpha = 0.6 * (1 - (t - trail[i].t) / TRAIL);
      ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Seen from above, a quad tilted toward its acceleration foreshortens along that direction.
    const a = Math.hypot(drone.ux, drone.uy), tilt = TILT_MAX * Math.min(1, a / A_MAX), dir = Math.atan2(drone.uy, drone.ux);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir); ctx.scale(Math.cos(tilt), 1); ctx.rotate(-dir);
    ctx.strokeStyle = colors.fg;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-12, -12); ctx.lineTo(12, 12); ctx.moveTo(12, -12); ctx.lineTo(-12, 12); ctx.stroke();
    [[-12, -12, 1], [12, -12, -1], [12, 12, 1], [-12, 12, -1]].forEach(([rx, ry, sense]) => {
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(rx, ry, 7, 0, 2 * Math.PI); ctx.stroke();
      const b = sense * drone.spin;
      ctx.strokeStyle = colors.fg;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(rx - 6 * Math.cos(b), ry - 6 * Math.sin(b)); ctx.lineTo(rx + 6 * Math.cos(b), ry + 6 * Math.sin(b)); ctx.stroke();
    });
    ctx.fillStyle = colors.card;
    ctx.strokeStyle = colors.fg;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-5, -5, 10, 10, 2); ctx.fill(); ctx.stroke();
    ctx.restore();

    ctx.fillStyle = colors.muted;
    ctx.font = '10px "B612 Mono", ui-monospace, monospace';
    ctx.fillText(`ζ ${zeta}  e ${Math.round(Math.hypot(setpoint.x - x, setpoint.y - y))}px`, x + 22, y - 18);
  };

  const say = () => toast(`PID DRONE — ζ = ${MODES[mode][0]}, ${MODES[mode][1]} — p to step`);
  funToy({
    key: 'p',
    name: 'PID DRONE',
    global: 'pidDrone',
    frame,
    reset: () => { drone = null; setpoint = null; trail = []; },
    onKey: ({ on, off, enabled }) => {
      if (!enabled) { mode = 0; on(true); say(); }
      else if (mode < MODES.length - 1) { mode++; say(); }
      else off();
      saveMode();
    },
  });
})();
