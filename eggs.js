// Page easter eggs: a barrel roll (that isn't), Konami-code zero-g with a detumble controller,
// and the badge launch.
(() => {
  const { reduced, toast, overlay, onSequence } = window.fun;

  // Google's "do a barrel roll" spins the page about one axis, which is an aileron roll; a barrel
  // roll also loops the flight path around a helix.
  const barrelRoll = () => {
    if (reduced.matches) { toast('BARREL ROLL SKIPPED — reduced motion is on'); return; }
    const origin = `50% ${scrollY + innerHeight / 2}px`;
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = 'hidden';
    document.body.animate(
      [{ transform: 'rotate(0)', transformOrigin: origin }, { transform: 'rotate(360deg)', transformOrigin: origin }],
      { duration: 1200, easing: 'ease-in-out' },
    ).finished.then(() => {
      html.style.overflow = overflow;
      toast('TECHNICALLY, THAT WAS AN AILERON ROLL');
    });
  };

  // Zero-g: everything on screen drifts free, then a critically damped PD drives each element's
  // offset and rotation back to zero. Only transforms move, so layout never shifts.
  const DRIFT = 3.5;              // s before the detumble starts
  const WN = 4;                   // rad/s, detumble natural frequency (ζ = 1)
  let tumbling = false;
  const zeroG = () => {
    if (tumbling) return;
    if (reduced.matches) { toast('ZERO-G SKIPPED — reduced motion is on'); return; }
    const sel = '.site-header, footer, main h1, main h2, main h3, main p, main img, main iframe, main .card, main canvas';
    const onScreen = [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width && r.bottom > 0 && r.top < innerHeight;
    });
    const bodies = onScreen
      .filter((el) => !onScreen.some((o) => o !== el && o.contains(el)))
      .slice(0, 40)
      .map((el) => {
        const speed = 60 + 100 * Math.random(), dir = 2 * Math.PI * Math.random();
        return {
          el, rect: el.getBoundingClientRect(), style: el.style.transform,
          x: 0, y: 0, th: 0, vx: speed * Math.cos(dir), vy: speed * Math.sin(dir), w: (Math.random() - 0.5) * 180,
        };
      });
    if (!bodies.length) return;
    tumbling = true;
    toast('ATTITUDE CONTROL LOST');
    let t0 = 0, last = 0, detumbling = false;
    const tick = (ms) => {
      const t = ms / 1000;
      const dt = last ? Math.min(1 / 30, t - last) : 0;
      last = t;
      if (!t0) t0 = t;
      if (!detumbling && t - t0 > DRIFT) { detumbling = true; toast('DETUMBLE'); }
      let settled = detumbling;
      for (const b of bodies) {
        if (detumbling) {
          b.vx += (-WN * WN * b.x - 2 * WN * b.vx) * dt;
          b.vy += (-WN * WN * b.y - 2 * WN * b.vy) * dt;
          b.w += (-WN * WN * b.th - 2 * WN * b.w) * dt;
          if (Math.abs(b.x) + Math.abs(b.y) + Math.abs(b.th) > 0.5) settled = false;
        } else {
          const { left, right, top, bottom } = b.rect;
          if ((left + b.x < 0 && b.vx < 0) || (right + b.x > innerWidth && b.vx > 0)) b.vx *= -0.9;
          if ((top + b.y < 0 && b.vy < 0) || (bottom + b.y > innerHeight && b.vy > 0)) b.vy *= -0.9;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.th += b.w * dt;
        b.el.style.transform = `translate(${b.x}px, ${b.y}px) rotate(${b.th}deg)`;
      }
      if (settled) {
        for (const b of bodies) b.el.style.transform = b.style;
        tumbling = false;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // Two N-waves, one from the bow shock and one from the tail.
  const shake = () => {
    if (reduced.matches) return;
    document.querySelector('main')?.animate(
      [0, -5, 5, 0, -4, 4, 0].map((y) => ({ transform: `translateY(${y}px)` })),
      { duration: 420, easing: 'linear' },
    );
  };

  // Badge launch: countdown, a vertical rise, a small pitch-over kick, then a gravity turn. Thrust
  // stays along the velocity and γ̇ = −g cos γ / V, so gravity alone bends the path over.
  // Units are screen pixels; only the shape of the trajectory is physical. The badge sits at the
  // very top of the page, so the page itself is the camera: it slides down to make sky, then keeps
  // falling away as the rocket climbs.
  const L_G = 400, L_A1 = 800, L_A2 = 700;    // px/s²: gravity, first-stage and upper-stage thrust
  const KICK_T = 0.4, KICK = 10 * Math.PI / 180, STAGE_T = 1.4;
  const SLIDE = 0.8, COUNT = 3, RETURN = 0.9; // s
  const LETTERS_ASPECT = 1375 / 1000;         // jc-letters.svg viewBox
  const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  let launching = false;
  const launchBadge = () => {
    const badge = document.querySelector('.site-name');
    if (launching || !badge) return;
    if (reduced.matches) { toast('LAUNCH SCRUBBED — reduced motion is on'); return; }
    launching = true;
    scrollTo(0, 0);
    const size = 1.6 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const br = badge.getBoundingClientRect();
    const x0 = br.left + size / 2, y0 = br.top + br.height / 2;
    const page = [...document.querySelectorAll('body > header, body > main, body > footer')];
    const setOffset = (y) => { for (const el of page) el.style.transform = y ? `translateY(${y}px)` : ''; };
    const pad = innerHeight * 0.6 - y0;       // page slide that puts the pad 60% down the screen
    const camLine = innerHeight * 0.3;        // above this the camera follows the rocket up
    const img = Object.assign(new Image(), { src: '/images/jc-letters.svg' });

    const ov = overlay();
    const { ctx } = ov;
    let sprite = null, spriteColor = '';
    const letters = (x, y, ang) => {
      if (!img.complete) return;
      const w = size * 0.5, h = w / LETTERS_ASPECT, k = 2 * (devicePixelRatio || 1);
      if (spriteColor !== ov.colors.fg) {
        // The SVG is black; recolour it to the theme's foreground once per theme.
        sprite = Object.assign(document.createElement('canvas'), { width: Math.ceil(w * k), height: Math.ceil(h * k) });
        const c = sprite.getContext('2d');
        c.drawImage(img, 0, 0, sprite.width, sprite.height);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = ov.colors.fg;
        c.fillRect(0, 0, sprite.width, sprite.height);
        spriteColor = ov.colors.fg;
      }
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
      ctx.restore();
    };
    const frame = (x, y, ang) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.strokeStyle = ov.colors.fg;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-size / 2 + 1, -size / 2 + 1, size - 2, size - 2, size / 4); ctx.stroke();
      ctx.restore();
    };
    const plume = (x, y, ang, len, t, base = size / 2) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.fillStyle = ov.colors.accent;
      const flick = 0.85 + 0.15 * Math.sin(t * 40), w = size * 0.18;
      for (const [g, a] of [[1.6, 0.2], [1, 0.9]]) {
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.moveTo(-w * g, base); ctx.lineTo(w * g, base); ctx.lineTo(0, base + len * g * flick);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    };

    let t0 = 0, lifted = false, ft = 0, V = 0, gam = Math.PI / 2, h = 0, d = 0, kicked = false, booster = null, offset = 0, back = 0, backFrom = 0;
    badge.classList.add('launched');
    ov.run((t, dt) => {
      if (!t0) t0 = t;
      const T = t - t0, c = ov.colors;
      if (T < SLIDE + COUNT) {
        offset = pad * smooth(T / SLIDE);
        setOffset(offset);
        frame(x0, y0 + offset, 0);
        letters(x0, y0 + offset, 0);
        if (T > SLIDE) {
          ctx.fillStyle = c.muted;
          ctx.font = '12px "B612 Mono", ui-monospace, monospace';
          ctx.fillText(`T−${Math.ceil(SLIDE + COUNT - T)}`, x0 - size / 2, y0 + offset - size);
        }
        return true;
      }
      if (!lifted) { lifted = true; toast('LIFTOFF'); }

      if (!back) {
        for (let k = 0; k < 8; k++) {
          const s = dt / 8;
          ft += s;
          if (!kicked && ft >= KICK_T) { kicked = true; gam -= KICK; }
          V += ((ft < STAGE_T ? L_A1 : L_A2) - L_G * Math.sin(gam)) * s;
          if (kicked) gam -= ((L_G * Math.cos(gam)) / V) * s;
          h += V * Math.sin(gam) * s;
          d += V * Math.cos(gam) * s;
          if (booster) {
            booster.vh -= L_G * s;
            booster.h += booster.vh * s;
            booster.d += booster.vd * s;
            booster.ang += booster.w * s;
          }
        }
        if (!booster && ft >= STAGE_T) {
          // The spent frame separates a little slower than the upper stage, then falls and tumbles.
          booster = { h, d, vh: (V - 80) * Math.sin(gam), vd: (V - 80) * Math.cos(gam), ang: Math.PI / 2 - gam, w: 5 };
          toast('STAGING');
        }
        offset = Math.max(pad, camLine - y0 + h);
        setOffset(offset);
        const x = x0 + d, y = y0 + offset - h, ang = Math.PI / 2 - gam;
        if (booster) {
          frame(x0 + booster.d, y0 + offset - booster.h, booster.ang);
          plume(x, y, ang, size * 0.5, t, size * 0.2);
        } else {
          plume(x, y, ang, size * 0.9, t);
          frame(x, y, ang);
        }
        letters(x, y, ang);
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.muted;
        ctx.font = '10px "B612 Mono", ui-monospace, monospace';
        ctx.fillText(`γ ${Math.round((gam * 180) / Math.PI)}°  V ${Math.round(V)} px/s`, x + size, y - size / 2);
        const gone = x > innerWidth + size && (!booster || y0 + offset - booster.h > innerHeight + size);
        if (gone || ft > 12) { back = T; backFrom = offset; }
        return true;
      }
      const u = (T - back) / RETURN;
      setOffset(backFrom * (1 - smooth(u)));
      if (u < 1) return true;
      setOffset(0);
      badge.classList.remove('launched');
      launching = false;
      return false;
    });
  };

  onSequence([...'barrelroll'], barrelRoll);
  onSequence(['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'], zeroG);

  Object.assign(window.fun, { barrelRoll, zeroG, shake, launchBadge });
})();
