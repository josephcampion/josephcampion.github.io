// Built at runtime so the address never appears in the HTML that scrapers read.
for (const a of document.querySelectorAll('a.email')) {
  a.href = `mailto:${a.dataset.user}@${a.dataset.domain}`;
  a.hidden = false;
}
