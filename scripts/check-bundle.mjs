#!/usr/bin/env node
// Bundle invariants for main.js (run after `npm run build`):
//
//  1. Renderer-safe node access. The Obsidian (Electron) renderer runs at the
//     app://obsidian.md origin and CORS-blocks dynamic `import()` of a node:/bare
//     builtin specifier. Node builtins MUST therefore load via `require()` (esbuild
//     lowers our lazy `import('node:…')` to require via `supported:{'dynamic-import'
//     :false}`). A regression to the import() form silently breaks desktop
//     auth.json/vaults.json fs access (it's caught, so the plugin still loads).
//
//  2. Mobile safety (isDesktopOnly:false). The bundle may reference node builtins
//     ONLY for the desktop-only ~/.agentage fs path, lazily + behind `isDesktop`
//     guards so mobile never evaluates them. Allow that known trio; flag any OTHER
//     node builtin so a new node dependency can't silently crash Obsidian mobile.
import { readFileSync, existsSync } from 'node:fs';

const BUNDLE = 'main.js';
if (!existsSync(BUNDLE)) {
  console.error(`✖ ${BUNDLE} not found — run \`npm run build\` first.`);
  process.exit(1);
}
const src = readFileSync(BUNDLE, 'utf8');

// The node builtins a bundle could plausibly pull in.
const NODE_BUILTINS =
  '(?:fs/promises|fs|path|os|crypto|net|http|https|child_process|module|url|stream|util|events|tls|zlib|dns)';

// Lazy, desktop-guarded fs access — the only node builtins allowed in the bundle.
const ALLOWED = new Set(['node:fs/promises', 'node:os', 'node:path']);

// (1) No dynamic import() of a node builtin — the renderer CORS-blocks it.
const dynImports = [
  ...src.matchAll(new RegExp(`import\\(\\s*["'](?:node:)?${NODE_BUILTINS}["']\\s*\\)`, 'g')),
].map((m) => m[0]);
if (dynImports.length) {
  console.error(
    `✖ ${BUNDLE} dynamically import()s a node builtin — the Obsidian renderer CORS-blocks this ` +
      `(desktop fs silently fails). Use require() (esbuild supported.dynamic-import:false):\n  ` +
      [...new Set(dynImports)].join('\n  ')
  );
  process.exit(1);
}

// (2) Only the desktop-fs trio may be referenced; any other node builtin breaks mobile.
const referenced = new Set(
  [
    ...src.matchAll(new RegExp(`(?:require\\(|from)\\s*["']((?:node:)?${NODE_BUILTINS})["']`, 'g')),
  ].map((m) => m[1])
);
const unexpected = [...referenced].filter((m) => !ALLOWED.has(m) && !ALLOWED.has(`node:${m}`));
if (unexpected.length) {
  console.error(
    `✖ ${BUNDLE} references unexpected node builtins (breaks Obsidian mobile unless lazy + ` +
      `desktop-guarded): ${unexpected.join(', ')}. Allowed: ${[...ALLOWED].join(', ')}.`
  );
  process.exit(1);
}

console.log(
  `✓ ${BUNDLE}: node builtins load via require() (renderer-safe), limited to the desktop-fs trio ` +
    `(${[...ALLOWED].join(', ')}) — mobile-safe.`
);
