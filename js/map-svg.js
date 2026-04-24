const ALL_HIGHLIGHT_CLASSES = ['highlight-company', 'highlight-self-ded', 'highlight-self-none'];

export function clearHighlights() {
  document.querySelectorAll('#map-svg .ic-node').forEach(el => {
    el.classList.remove(...ALL_HIGHLIGHT_CLASSES);
  });
}

export function highlightIc(icId, variant) {
  const el = document.querySelector(`#map-svg .ic-node[data-ic-id="${icId}"]`);
  if (!el) return;
  el.classList.remove(...ALL_HIGHLIGHT_CLASSES);
  el.classList.add(`highlight-${variant}`);
}
