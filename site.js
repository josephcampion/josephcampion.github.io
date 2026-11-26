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
