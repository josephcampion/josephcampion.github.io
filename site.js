// Built at runtime so the address never appears in the HTML that scrapers read.
for (const a of document.querySelectorAll('a.email')) {
  a.href = `mailto:${a.dataset.user}@${a.dataset.domain}`;
  a.hidden = false;
}

console.log(
  '%cJC%c joeycampion.com %c Plain HTML, no build step. Source: https://github.com/josephcampion/josephcampion.github.io',
  'background:#45e08a;color:#0d1014;font-weight:700;padding:1px 5px;border-radius:3px',
  'background:#26303a;color:#e8ebee;padding:1px 5px;border-radius:3px',
  '',
);

const root = document.documentElement;
const picker = document.querySelector('.theme-picker');
const showTheme = () => {
  const current = root.dataset.theme || 'auto';
  for (const b of picker?.querySelectorAll('button') ?? []) b.setAttribute('aria-pressed', b.dataset.themeChoice === current);
};
const setTheme = (choice) => {
  if (choice === 'auto') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', choice);
  } catch {}
  showTheme();
  document.dispatchEvent(new Event('themechange'));
};
if (picker) {
  picker.addEventListener('click', (ev) => {
    const choice = ev.target.closest('button')?.dataset.themeChoice;
    if (choice) setTheme(choice);
  });
  showTheme();
  picker.hidden = false;
}

// Phones and tablets have no hovering pointer, so the cursor toys (Kalman, PID) are left out there.
const touch = matchMedia('(hover: none)').matches;
// async = false keeps injected scripts in insertion order; the eggs need fun.js first.
const loadScript = (src, type = 'text/javascript') => document.head.append(Object.assign(document.createElement('script'), { src, type, async: false }));
for (const src of ['/fun.js', ...(touch ? [] : ['/kalman.js', '/pid.js']), '/eggs.js']) loadScript(src);
loadScript('/flybys.js', 'module');

// Command palette, opened with ⌘K / Ctrl+K or the key-cap button in the header.
const commands = [
  ['Pages', 'Home', '/'],
  ['Fun', 'Launch the badge  (or click it 10\u00d7 on Home)', () => window.fun?.launchBadge()],
  ['Pages', 'Work', '/work'],
  ['Fun', 'Freighter flyby  (hidden on the Work page)', () => window.fun?.flyby()],
  ['Fun', 'Droid whirl  (hidden on the Work page)', () => window.fun?.droid()],
  ['Pages', 'Projects', '/projects'],
  ['Pages', 'School', '/school'],
  ['Pages', 'Essays', '/essays/'],
  ['Pages', 'Life', '/life'],
  ['Pages', 'Resume (PDF)', '/resume.pdf'],
  ['Demos', 'X-Wing Path Following', '/projects/xwing-follow/'],
  ['Fun', 'X-wing vs TIE  (or click 5 empty spots)', () => window.fun?.xwingVsTie()],
  ['Demos', 'Death Star Orbit & Attitude', '/projects/death-star-pointing/'],
  ['Demos', 'Droid Arm Reach', '/projects/droid-arm/'],
  ...(touch ? [] : [['Fun', 'PID drone: step damping  [P]', () => window.pidDrone?.press()]]),
  ['Demos', 'Millennium Falcon: Turbojet to Ramjet', '/projects/falcon/'],
  ['Fun', 'Sonic boom  (or scroll really fast)', () => window.fun?.boom()],
  ['Demos', 'Tumbling satellite (the 404 page)', '/lost-in-space'],
  ...(touch ? [] : [['Fun', 'Toggle Kalman-filter cursor  [K]', () => window.kalmanCursor?.toggle()]]),
  ['Essays', 'Hogwarts Pedagogy', '/essays/hogwarts-pedagogy'],
  ['Essays', 'Droids vs. Jedi', '/essays/droids-vs-jedis'],
  ['Essays', 'Blue Pill Suicide', '/essays/blue-pill-suicide'],
  ['Theme', 'Auto', () => setTheme('auto')],
  ['Theme', 'Day', () => setTheme('light')],
  ['Theme', 'HUD (green on dark)', () => setTheme('dark')],
  ['Theme', 'Night Ops (red)', () => setTheme('night')],
  ['Fun', 'Barrel roll  (or type "barrel roll")', () => window.fun?.barrelRoll()],
  ['Fun', 'Zero-g  (or the Konami code)', () => window.fun?.zeroG()],
  ['Link', 'Copy link to this page', () => navigator.clipboard?.writeText(location.href)],
  ['Link', 'GitHub', 'https://github.com/josephcampion'],
  ['Link', 'LinkedIn', 'https://www.linkedin.com/in/joseph-campion-9736123a3/'],
];
const header = document.querySelector('.site-header nav');
if (header && window.HTMLDialogElement) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  // Phones and tablets have no ⌘K, so they get a tappable prompt glyph instead of the key cap.
  const dlg = document.createElement('dialog');
  dlg.className = 'palette';
  dlg.innerHTML = '<label class="palette-prompt"><span aria-hidden="true">&gt;</span><input type="text" placeholder="Go to a page or run a command" aria-label="Command" autocomplete="off" spellcheck="false" role="combobox" aria-controls="palette-list" aria-expanded="true"></label><ul id="palette-list" role="listbox"></ul><p class="palette-foot"></p>';
  dlg.querySelector('.palette-foot').textContent = touch ? 'TAP TO RUN · TAP OUTSIDE TO CLOSE' : '↑↓ SELECT · ↵ EXECUTE · ESC CLOSE';
  document.body.append(dlg);
  const input = dlg.querySelector('input');
  const list = dlg.querySelector('ul');
  let shown = [];
  let sel = 0;
  // Subsequence match so "dsa" finds "Death Star Orbit & Attitude".
  const matches = (q, s) => { let i = 0; for (const ch of s.toLowerCase()) if (ch === q[i]) i++; return i === q.length; };
  const render = () => {
    const q = input.value.trim().toLowerCase().replace(/\s+/g, '');
    shown = commands.filter(([g, label]) => matches(q, g + label));
    sel = Math.min(sel, Math.max(shown.length - 1, 0));
    list.replaceChildren(...shown.map(([g, label], i) => {
      const li = document.createElement('li');
      li.role = 'option';
      li.id = `palette-${i}`;
      li.setAttribute('aria-selected', i === sel);
      li.innerHTML = '<span class="palette-group"></span><span></span>';
      li.firstChild.textContent = g;
      li.lastChild.textContent = label;
      li.addEventListener('click', () => run(i));
      li.addEventListener('pointermove', () => { if (sel !== i) { sel = i; render(); } });
      return li;
    }));
    if (shown.length) input.setAttribute('aria-activedescendant', `palette-${sel}`);
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => {
    const action = shown[i]?.[2];
    if (!action) return;
    dlg.close();
    if (typeof action === 'function') action();
    else if (/^https?:/.test(action)) window.open(action, '_blank', 'noopener');
    else location.href = action;
  };
  const open = () => { input.value = ''; sel = 0; render(); dlg.showModal(); if (touch) input.blur(); else input.focus(); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      sel = (sel + (ev.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
      render();
    } else if (ev.key === 'Enter') { ev.preventDefault(); run(sel); }
  });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key.toLowerCase() === 'k' && (isMac ? ev.metaKey : ev.ctrlKey)) {
      ev.preventDefault();
      if (dlg.open) dlg.close(); else open();
    }
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'palette-btn';
  btn.setAttribute('aria-label', 'Open command menu');
  btn.innerHTML = touch ? '<kbd>&gt;_</kbd>' : `<kbd>${isMac ? '⌘' : 'Ctrl '}K</kbd>`;
  btn.addEventListener('click', open);
  header.append(btn);
}

// Clicking the homepage badge kicks it like an underdamped rotational spring; six quick clicks
// command a full turn, which settles as a step response, and ten launch it (eggs.js).
const badge = document.querySelector('.site-name');
if (badge && location.pathname === '/' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const wn = 12, zeta = 0.15;
  let theta = 0, omega = 0, ref = 0, last = 0, running = false;
  const clicks = [];
  const tick = (t) => {
    const dt = Math.min(Math.max(t - last, 0) / 1000, 1 / 30);
    last = t;
    omega += (wn * wn * (ref - theta) - 2 * zeta * wn * omega) * dt;
    theta += omega * dt;
    badge.style.setProperty('--wobble', `${theta}deg`);
    if (Math.abs(ref - theta) < 0.05 && Math.abs(omega) < 0.5) {
      ref %= 360; theta = ref; running = false;
      badge.style.setProperty('--wobble', `${theta}deg`);
      return;
    }
    requestAnimationFrame(tick);
  };
  badge.addEventListener('click', (ev) => {
    ev.preventDefault();
    const now = performance.now();
    clicks.push(now);
    while (clicks[0] < now - 3500) clicks.shift();
    if (clicks.length >= 10) { clicks.length = 0; window.fun?.launchBadge(); return; }
    if (clicks.length === 6) ref += 360; else omega += clicks.length % 2 ? 260 : -260;
    if (!running) { running = true; last = now; requestAnimationFrame(tick); }
  });
}

// Hover previews: internal pages show their description, #ref links show the citation, PDFs show their name.
if (matchMedia('(hover: hover)').matches) {
  const tip = document.createElement('div');
  tip.className = 'preview';
  tip.role = 'tooltip';
  tip.hidden = true;
  document.body.append(tip);
  const cache = new Map();
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const describe = async (a) => {
    const url = new URL(a.href);
    if (url.pathname === location.pathname && url.hash) {
      const el = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      return el && { kicker: 'Source', text: clean(el.textContent) };
    }
    if (url.origin !== location.origin) return { kicker: 'External ↗', title: url.hostname.replace(/^www\./, '') };
    if (url.pathname.endsWith('.pdf')) {
      return { kicker: 'PDF', title: decodeURIComponent(url.pathname.split('/').pop()).replace(/\.pdf$/, '').replace(/[_-]+/g, ' ') };
    }
    const doc = new DOMParser().parseFromString(await (await fetch(url.pathname)).text(), 'text/html');
    const section = url.hash && doc.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (section) {
      return { kicker: clean(doc.title.replace(/ — Joey Campion$/, '')), title: clean(section.querySelector('h2, h3')?.textContent ?? section.textContent), text: clean(section.querySelector('p:not(.meta)')?.textContent ?? '') };
    }
    return { kicker: 'Page', title: clean(doc.title.replace(/ — Joey Campion$/, '')), text: doc.querySelector('meta[name="description"]')?.content ?? '' };
  };
  let timer = 0;
  let current = null;
  const hide = () => { clearTimeout(timer); current = null; tip.hidden = true; };
  const show = (a) => {
    current = a;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!cache.has(a.href)) cache.set(a.href, describe(a).catch(() => null));
      const d = await cache.get(a.href);
      if (current !== a || !d) return;
      tip.replaceChildren(...[['kicker', d.kicker], ['title', d.title], ['text', d.text]].filter(([, v]) => v).map(([cls, v]) => {
        const p = document.createElement('p');
        p.className = `preview-${cls}`;
        p.textContent = v.length > 260 ? `${v.slice(0, 257)}…` : v;
        return p;
      }));
      tip.hidden = false;
      const r = a.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8)) + scrollX}px`;
      tip.style.top = `${(r.bottom + tip.offsetHeight + 8 > innerHeight ? r.top - tip.offsetHeight - 6 : r.bottom + 6) + scrollY}px`;
    }, 250);
  };
  for (const a of document.querySelectorAll('main a[href]:not(.card a)')) {
    a.addEventListener('mouseenter', () => show(a));
    a.addEventListener('mouseleave', hide);
    a.addEventListener('focus', () => show(a));
    a.addEventListener('blur', hide);
  }
}

document.querySelectorAll('.reveal').forEach((b) => b.addEventListener('click', () => {
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', on);
  b.setAttribute('aria-label', on ? 'Zoom back in' : 'Zoom out');
  const cap = b.nextElementSibling;
  cap.querySelector('.hint').hidden = on;
  cap.querySelector('.cap').hidden = !on;
}));

// Telemetry-style stamp. The page's Last-Modified date (set by GitHub Pages at deploy) shows at once;
// the latest commit from GitHub's API replaces it with the exact build when it answers.
const footer = document.querySelector('.site-footer .footer-meta');
if (footer) {
  const stamp = document.createElement('span');
  stamp.className = 'telemetry';
  const show = (date, build) => {
    stamp.textContent = ` · LAST UPDATE ${date.toISOString().slice(0, 16).replace('T', ' ')}Z${build ? ` · BUILD ${build}` : ''}`;
  };
  const modified = new Date(document.lastModified);
  if (!Number.isNaN(modified.getTime())) { show(modified); footer.append(stamp); }
  fetch('https://api.github.com/repos/josephcampion/josephcampion.github.io/commits/main')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((c) => { show(new Date(c.commit.committer.date), c.sha.slice(0, 7)); if (!stamp.isConnected) footer.append(stamp); })
    .catch(() => {});
}
