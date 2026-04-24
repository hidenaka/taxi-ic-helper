#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const ics = JSON.parse(readFileSync(join(root, 'data/ics.json'), 'utf8')).ics;

const W = 1200, H = 1200, CX = 600, CY = 600;

const style = `
  .route-bg { fill: #0f1723; }
  .route-c1 { fill: none; stroke: #546478; stroke-width: 4; }
  .route-c2 { fill: none; stroke: #3e4e65; stroke-width: 4; }
  .route-gaikan { fill: none; stroke: #8e44ad; stroke-width: 3; stroke-dasharray: 8 4; opacity: 0.6; }
  .route-radial { fill: none; stroke: #34495e; stroke-width: 3; opacity: 0.7; }
  .ic-node { fill: #ecf0f1; stroke: #2c3e50; stroke-width: 1.5; cursor: pointer; }
  .ic-node.company-pay { fill: #95a5a6; }
  .ic-node.gaikan-ic { fill: #bdbbc8; }
  .ic-node.baseline-ic { fill: #7f8c8d; }
  .ic-node.highlight-company { fill: #27ae60; stroke: #fff; stroke-width: 2; }
  .ic-node.highlight-self-ded { fill: #3498db; stroke: #fff; stroke-width: 2; }
  .ic-node.highlight-self-none { fill: #95a5a6; stroke: #fff; stroke-width: 2; }
  .ic-label { font: 10px -apple-system, "Hiragino Sans", sans-serif; fill: #bdc3c7; text-anchor: middle; pointer-events: none; user-select: none; }
`;

const out = [];
out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" id="map-svg" role="img" aria-label="首都高 + 周辺高速 簡略路線図">`);
out.push(`  <style>${style}</style>`);
out.push(`  <rect class="route-bg" width="${W}" height="${H}" />`);

// Route skeleton (都心環状 C1, 中央環状 C2, 外環, radials) — schematic, not to scale
out.push(`  <circle cx="${CX}" cy="${CY}" r="80" class="route-c1" />`);
out.push(`  <circle cx="${CX}" cy="${CY}" r="220" class="route-c2" />`);
out.push(`  <path d="M 260 380 A 340 340 0 0 1 940 380" class="route-gaikan" />`);

// Radial suggestion lines: center to far corners (for visual orientation only)
const radials = [
  { to: [  90,  900 ], label: 'tomei-dir' },
  { to: [ 100,  300 ], label: 'kanetsu-dir' },
  { to: [  50,  600 ], label: 'chuo-dir' },
  { to: [ 600,   50 ], label: 'tohoku-dir' },
  { to: [1050,  250 ], label: 'joban-dir' },
  { to: [1100,  600 ], label: 'keiyo-dir' },
  { to: [1050,  900 ], label: 'tokan-dir' },
  { to: [ 900, 1100 ], label: 'aqua-dir' },
  { to: [ 450, 1100 ], label: 'yokohama-dir' },
];
for (const r of radials) {
  out.push(`  <line x1="${CX}" y1="${CY}" x2="${r.to[0]}" y2="${r.to[1]}" class="route-radial" />`);
}

// IC nodes
for (const ic of ics) {
  const x = ic.svg?.x ?? 600;
  const y = ic.svg?.y ?? 600;
  let cls = 'ic-node';
  if (ic.boundary_tag === 'company_pay_entry') cls += ' company-pay';
  else if (ic.boundary_tag === 'gaikan') cls += ' gaikan-ic';
  else if (ic.boundary_tag === null || ic.boundary_tag === undefined) cls += ' baseline-ic';
  out.push(`  <g class="ic-group">`);
  out.push(`    <circle class="${cls}" cx="${x}" cy="${y}" r="5" id="ic-${ic.id}" data-ic-id="${ic.id}"><title>${ic.name}</title></circle>`);
  // Label: small offset to the right
  out.push(`    <text class="ic-label" x="${x + 8}" y="${y + 3}">${ic.name}</text>`);
  out.push(`  </g>`);
}

out.push(`</svg>`);

const outPath = join(root, 'svg/map.svg');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.join('\n'));
console.log(`Wrote ${outPath} — ${ics.length} IC nodes`);
