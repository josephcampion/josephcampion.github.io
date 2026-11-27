// Shared pieces for the easter eggs: a full-screen overlay canvas, toasts, typed key sequences,
// and the hotkey/persistence scaffolding for the cursor toys.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const isTyping = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  const readColors = (into = {}) => {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return Object.assign(into, {
      accent: get('--accent', 'currentColor'), muted: get('--muted', 'gray'), fg: get('--fg', 'black'),
      card: get('--card', 'white'), line: get('--line', 'gray'),
    });
  };

  const toast = (text) => {
    const el = document.createElement('div');
    el.textContent = text;
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);z-index:2147483001;'
      + 'padding:0.45rem 0.8rem;font:0.75rem/1.4 var(--mono, monospace);letter-spacing:0.06em;'
      + 'color:var(--fg);background:var(--card);border:1px solid var(--accent);border-radius:4px;'
      + 'pointer-events:none;transition:opacity 0.4s;';
    document.body.append(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2000);
    setTimeout(() => el.remove(), 2500);
  };

  // run(frame) calls frame(t, dt) each animation frame on a cleared canvas; returning false removes the overlay.
  const overlay = () => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000;';
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const colors = readColors();
    const recolor = () => readColors(colors);
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    resize();
    addEventListener('resize', resize);
    document.addEventListener('themechange', recolor);
    scheme.addEventListener('change', recolor);
    let raf = 0;
    const o = {
      ctx, colors,
      remove() {
        cancelAnimationFrame(raf);
        removeEventListener('resize', resize);
        document.removeEventListener('themechange', recolor);
        scheme.removeEventListener('change', recolor);
        canvas.remove();
      },
      run(frame) {
        let last = 0;
        const tick = (ms) => {
          const t = ms / 1000;
          const dt = Math.min(0.1, last ? t - last : 0);
          last = t;
          ctx.clearRect(0, 0, innerWidth, innerHeight);
          ctx.globalAlpha = 1;
          if (frame(t, dt) === false) { o.remove(); return; }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return o;
      },
    };
    return o;
  };

  // Matches e.key values (lowercased) against the tail of a rolling buffer; spaces are skipped so
  // "barrel roll" and "barrelroll" both work.
  const onSequence = (seq, fn) => {
    let buf = [];
    addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || e.key === ' ') return;
      buf.push(e.key.toLowerCase());
      if (buf.length > seq.length) buf = buf.slice(-seq.length);
      if (buf.length === seq.length && buf.every((k, i) => k === seq[i])) { buf = []; fn(); }
    });
  };

  // A hotkey-toggled overlay that follows the pointer. frame(ctx, t, dt, ptr, colors) draws one frame;
  // ptr.pointer is null once the pointer has left, and ptr.leftAt is when it left. onKey, if given,
  // replaces the plain on/off toggle on the hotkey (and on window[global].press).
  const funToy = ({ key, name, global, frame, reset, onKey }) => {
    let ov = null;
    const ptr = { pointer: null, leftAt: 0 };
    const onMove = (e) => { ptr.pointer = { x: e.clientX, y: e.clientY }; ptr.leftAt = 0; };
    const onLeave = (e) => {
      if (e.type === 'pointerout' && e.relatedTarget) return;
      if (e.type === 'pointerup' && e.pointerType === 'mouse') return;
      if (ptr.pointer) { ptr.pointer = null; ptr.leftAt = performance.now() / 1000; }
    };
    const events = [['pointermove', onMove], ['pointerdown', onMove], ['pointerout', onLeave], ['pointerup', onLeave], ['pointercancel', onLeave]];
    const save = () => { try { sessionStorage.setItem(global, ov ? '1' : '0'); } catch {} };

    const on = (quiet) => {
      if (ov) return;
      ov = overlay();
      for (const [type, fn] of events) addEventListener(type, fn, { passive: true });
      ov.run((t, dt) => frame(ov.ctx, t, dt, ptr, ov.colors));
      save();
      if (quiet !== true) toast(`${name} ON — press ${key} to turn off`);
    };
    const off = () => {
      if (!ov) return;
      ov.remove();
      ov = null;
      for (const [type, fn] of events) removeEventListener(type, fn);
      ptr.pointer = null;
      ptr.leftAt = 0;
      reset();
      save();
      toast(`${name} OFF`);
    };
    const toggle = () => (ov ? off() : on());
    const press = onKey ? () => onKey({ on, off, enabled: !!ov }) : toggle;

    addEventListener('keydown', (e) => {
      if (e.key !== key || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      press();
    });
    window[global] = { on: () => on(), off, toggle, press, get enabled() { return !!ov; } };
    try { if (sessionStorage.getItem(global) === '1') on(true); } catch {}
  };

  window.fun = Object.assign(window.fun || {}, { reduced, isTyping, toast, overlay, onSequence, funToy });
})();
