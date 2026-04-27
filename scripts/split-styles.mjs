// One-shot helper used during the styles.css split refactor.
// Reads the legacy styles.css and writes the new src/styles/*.css modules.
// Safe to delete after the split lands and the bundled output is verified.

import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync('styles.css', 'utf8').split(/\r?\n/);

const sections = [
  ['base.css',                         1,    55],
  ['repo-selector.css',               56,    71],
  ['status.css',                      72,   107],
  ['file-list-legacy.css',           108,   143],
  ['commit-section-legacy.css',      144,   208],
  ['repository-modal.css',           209,   244],
  ['branches-legacy.css',            245,   331],
  ['sync-status.css',                332,   355],
  ['action-buttons-legacy.css',      356,   387],
  ['conflict-resolution-inline.css', 388,   428],
  ['loading.css',                    429,   455],
  ['file-explorer.css',              456,   587],
  ['repo-browser.css',               588,   694],
  ['branch-modals.css',              695,   730],
  ['commit-history.css',             731,   770],
  ['git-graph.css',                  771,   916],
  ['diff-view.css',                  917,  1037],
  ['file-history-view.css',         1038,  1253],
  ['conflict-resolution-view.css',  1254,  1415],
  ['mr-modal.css',                  1416,  1444],
  ['file-actions.css',              1445,  1467],
  ['stash.css',                     1468,  1574],
  ['tags.css',                      1575,  1613],
  ['template-selector.css',         1614,  1637],
  ['tag-label.css',                 1638,  1642],
  ['info-help.css',                 1643,  1666],
  ['guide-modal.css',               1667,  1698],
  ['collapsible.css',               1699,  1725],
  ['quick-commit-modal.css',        1726,  1871],
  ['quick-action-modal.css',        1872,  1931],
  ['upload-files-modal.css',        1932,  1991],
  ['move-files-modal.css',          1992,  2063],
  ['side-panel-redesign.css',       2064,  2282],
  ['changes-tab.css',               2283, src.length],
];

const outDir = 'src/styles';
fs.mkdirSync(outDir, { recursive: true });

let totalLines = 0;
const imports = [];

for (const [name, start, end] of sections) {
  const slice = src.slice(start - 1, end);
  while (slice.length > 0 && slice[slice.length - 1].trim() === '') slice.pop();
  const body = slice.join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, name), body);
  totalLines += slice.length;
  imports.push(`@import "./${name}";`);
}

const indexHeader = [
  '/* GitLab Plugin Styles — bundled by esbuild from src/styles/. */',
  '/* Edit per-surface modules; do not hand-edit the generated styles.css. */',
  '',
].join('\n');
fs.writeFileSync(
  path.join(outDir, 'index.css'),
  indexHeader + imports.join('\n') + '\n',
);

console.log(`Wrote ${sections.length} modules + index.css covering ${totalLines} lines (source: ${src.length}).`);
