// Built at runtime so the address never appears in the HTML that scrapers read.
for (const a of document.querySelectorAll('a.email')) {
  a.href = `mailto:${a.dataset.user}@${a.dataset.domain}`;
  a.hidden = false;
}

const picker = document.querySelector('.theme-picker');
if (picker) {
  const root = document.documentElement;
  const show = () => {
    const current = root.dataset.theme || 'auto';
    for (const b of picker.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.themeChoice === current);
  };
  picker.addEventListener('click', (ev) => {
    const choice = ev.target.closest('button')?.dataset.themeChoice;
    if (!choice) return;
    if (choice === 'auto') delete root.dataset.theme;
    else root.dataset.theme = choice;
    try {
      if (choice === 'auto') localStorage.removeItem('theme');
      else localStorage.setItem('theme', choice);
    } catch {}
    show();
    document.dispatchEvent(new Event('themechange'));
  });
  show();
  picker.hidden = false;
}

// Telemetry-style stamp. The page's Last-Modified date (set by GitHub Pages at deploy) shows at once;
// the latest commit from GitHub's API replaces it with the exact build when it answers.
const footer = document.querySelector('.site-footer .wrap > div');
if (footer) {
  const stamp = document.createElement('p');
  stamp.className = 'telemetry';
  const show = (date, build) => {
    stamp.textContent = `LAST UPDATE ${date.toISOString().slice(0, 16).replace('T', ' ')}Z${build ? ` · BUILD ${build}` : ''}`;
  };
  const modified = new Date(document.lastModified);
  if (!Number.isNaN(modified.getTime())) { show(modified); footer.append(stamp); }
  fetch('https://api.github.com/repos/josephcampion/josephcampion.github.io/commits/main')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((c) => { show(new Date(c.commit.committer.date), c.sha.slice(0, 7)); if (!stamp.isConnected) footer.append(stamp); })
    .catch(() => {});
}
