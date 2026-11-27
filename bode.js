(() => {
  const hero = document.querySelector('main.home .hero');
  const wrap = hero && hero.querySelector('.wrap');
  if (!wrap) return;

  const text = document.createElement('div');
  text.className = 'hero-text';
  text.append(...wrap.childNodes);
  const fig = document.createElement('figure');
  fig.className = 'hero-bode';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Bode plot of a second-order system. Move the pointer across the header to change its natural frequency and damping.');
  const readout = document.createElement('figcaption');
  readout.className = 'bode-readout';
  fig.append(canvas, readout);
  wrap.append(text, fig);
  wrap.classList.add('has-bode');

  const ctx = canvas.getContext('2d');
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const LOG_W0 = -1, DECADES = 3;
  const LW_MIN = Math.log10(0.3), LW_MAX = Math.log10(30);
  const Z_MIN = 0.05, Z_MAX = 1.2;
  const DB_TOP = 25, DB_BOT = -50;
  const OMEGA = 7;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const colors = {};
  let font = 'monospace';
  const readTheme = () => {
    const cs = getComputedStyle(root);
    for (const k of ['accent', 'muted', 'line', 'fg']) colors[k] = cs.getPropertyValue('--' + k).trim();
    font = cs.getPropertyValue('--mono').trim() || 'monospace';
  };

  // Easing runs on log10(ωn) so a move of one decade feels the same anywhere on the axis.
  const STATIC = { lw: Math.log10(3), z: 0.3 };
  const s = { lw: STATIC.lw, z: STATIC.z, vlw: 0, vz: 0 };
  const target = { lw: s.lw, z: s.z };
  let lastInput = -Infinity;

  const setFrom = (e, el) => {
    const r = el.getBoundingClientRect();
    const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
    const fy = clamp((e.clientY - r.top) / r.height, 0, 1);
    target.lw = LW_MIN + (LW_MAX - LW_MIN) * fx;
    // Log mapping gives the lightly damped end, where the plot changes most, more room.
    target.z = Z_MIN * (Z_MAX / Z_MIN) ** fy;
    lastInput = performance.now();
    if (reduce.matches) { s.lw = target.lw; s.z = target.z; draw(); } else schedule();
  };
  hero.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') setFrom(e, hero); });
  // Touch only drives the plot itself; CSS touch-action: pan-y keeps vertical page scroll working.
  for (const type of ['pointerdown', 'pointermove']) {
    canvas.addEventListener(type, (e) => {
      if (e.pointerType !== 'mouse' && (type === 'pointerdown' || e.pressure > 0)) setFrom(e, canvas);
    });
  }

  const idle = (now) => {
    if (now - lastInput < 4000) return;
    const t = now / 1000;
    target.z = 0.08 * (0.9 / 0.08) ** (0.5 + 0.5 * Math.sin(t * 0.5));
    target.lw = STATIC.lw + 0.3 * Math.sin(t * 0.23);
  };

  const step = (dt) => {
    for (const k of ['lw', 'z']) {
      const v = 'v' + k;
      s[v] += (OMEGA * OMEGA * (target[k] - s[k]) - 2 * OMEGA * s[v]) * dt;
      s[k] += s[v] * dt;
    }
  };

  let W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    draw();
  };

  let lastText = '';
  function draw() {
    if (!W || !H) return;
    const z = clamp(s.z, 0.02, 2), wn = 10 ** s.lw;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const padL = 34, padR = 10, padT = 10, padB = 18, gap = 14;
    const plotW = W - padL - padR;
    const magH = (H - padT - padB - gap) * 0.58, phH = H - padT - padB - gap - magH;
    const phTop = padT + magH + gap;
    const x = (w) => padL + (Math.log10(w) - LOG_W0) / DECADES * plotW;
    const yMag = (db) => padT + (DB_TOP - db) / (DB_TOP - DB_BOT) * magH;
    const yPh = (deg) => phTop + (-deg / 180) * phH;
    const hline = (y, color, alpha) => {
      ctx.globalAlpha = alpha; ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(padL + plotW, Math.round(y) + 0.5); ctx.stroke();
    };

    ctx.lineWidth = 1;
    for (let d = LOG_W0; d < LOG_W0 + DECADES + 1; d++) {
      for (let k = 1; k <= 9; k++) {
        if (d === LOG_W0 + DECADES && k > 1) break;
        const px = Math.round(x(k * 10 ** d)) + 0.5;
        ctx.globalAlpha = k === 1 ? 1 : 0.5;
        ctx.strokeStyle = colors.line;
        ctx.beginPath();
        ctx.moveTo(px, padT); ctx.lineTo(px, padT + magH);
        ctx.moveTo(px, phTop); ctx.lineTo(px, phTop + phH);
        ctx.stroke();
      }
    }
    for (const db of [20, -20, -40]) hline(yMag(db), colors.line, 1);
    hline(yMag(0), colors.muted, 0.6);
    for (const deg of [0, -180]) hline(yPh(deg), colors.line, 1);
    hline(yPh(-90), colors.muted, 0.6);

    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.muted;
    ctx.font = `10px ${font}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const db of [20, 0, -20, -40]) ctx.fillText(String(db), padL - 5, yMag(db));
    for (const deg of [0, -90, -180]) ctx.fillText(String(deg), padL - 5, yPh(deg));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let d = LOG_W0; d <= LOG_W0 + DECADES; d++) {
      ctx.textAlign = d === LOG_W0 ? 'left' : d === LOG_W0 + DECADES ? 'right' : 'center';
      ctx.fillText(String(+(10 ** d).toFixed(1)), x(10 ** d), phTop + phH + 4);
    }
    // Top-right is where both curves have dropped away, so the unit labels never sit on a trace.
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('dB', padL + plotW - 4, padT + 2);
    ctx.fillText('deg', padL + plotW - 4, phTop + 2);

    const N = Math.max(2, Math.round(plotW / 2));
    const mag = new Float64Array(N), ph = new Float64Array(N), xs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 10 ** (LOG_W0 + DECADES * i / (N - 1)), u = w / wn;
      const re = 1 - u * u, im = 2 * z * u;
      xs[i] = x(w);
      mag[i] = -10 * Math.log10(re * re + im * im);
      ph[i] = -Math.atan2(im, re) * 180 / Math.PI;
    }
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, plotW, magH); ctx.clip();
    ctx.beginPath();
    for (let i = 0; i < N; i++) ctx[i ? 'lineTo' : 'moveTo'](xs[i], yMag(clamp(mag[i], DB_BOT - 5, DB_TOP + 5)));
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    for (let i = 0; i < N; i++) ctx[i ? 'lineTo' : 'moveTo'](xs[i], yPh(ph[i]));
    ctx.stroke();

    const inAxis = (w) => w >= 10 ** LOG_W0 && w <= 10 ** (LOG_W0 + DECADES);
    let Mr = 0;
    ctx.fillStyle = colors.accent;
    if (z < Math.SQRT1_2) {
      const wr = wn * Math.sqrt(1 - 2 * z * z);
      Mr = -20 * Math.log10(2 * z * Math.sqrt(1 - z * z));
      if (inAxis(wr) && Mr <= DB_TOP) { ctx.beginPath(); ctx.arc(x(wr), yMag(Mr), 3, 0, 2 * Math.PI); ctx.fill(); }
    }
    const z2 = z * z;
    const wb = wn * Math.sqrt(1 - 2 * z2 + Math.sqrt(4 * z2 * z2 - 4 * z2 + 2));
    ctx.strokeStyle = colors.fg; ctx.fillStyle = colors.fg; ctx.lineWidth = 1.5;
    if (inAxis(wb)) {
      const bx = x(wb), by = yMag(-3);
      ctx.beginPath(); ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by + 5); ctx.stroke();
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('ωb', bx + 3, by - 2);
    }
    if (inAxis(wn)) {
      const nx = x(wn), ny = yPh(-90);
      ctx.beginPath(); ctx.moveTo(nx, ny - 5); ctx.lineTo(nx, ny + 5); ctx.stroke();
    }

    const t = `ζ ${z.toFixed(2)} · ωn ${wn.toFixed(wn < 10 ? 1 : 0)} rad/s · Mr ${Mr.toFixed(1)} dB`;
    if (t !== lastText) { readout.textContent = t; lastText = t; }
  }

  let raf = 0, last = 0, visible = true;
  const frame = (now) => {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    idle(now);
    step(dt);
    draw();
    schedule();
  };
  function schedule() {
    if (raf || reduce.matches || !visible || document.hidden) { if (!raf) last = 0; return; }
    raf = requestAnimationFrame(frame);
  }

  const retheme = () => { readTheme(); draw(); };
  document.addEventListener('themechange', retheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  // Themes can also be switched without the event (e.g. from a command palette), so watch the attribute too.
  new MutationObserver(retheme).observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  reduce.addEventListener('change', () => {
    if (reduce.matches) { Object.assign(s, STATIC, { vlw: 0, vz: 0 }); Object.assign(target, STATIC); draw(); }
    else schedule();
  });
  document.addEventListener('visibilitychange', schedule);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; schedule(); }).observe(hero);
  new ResizeObserver(resize).observe(canvas);
  if (document.fonts) document.fonts.ready.then(draw);

  readTheme();
  resize();
  schedule();
})();
