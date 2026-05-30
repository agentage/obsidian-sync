#!/usr/bin/env node
// Mobile-safety invariant: the production bundle (main.js) must be browser/
// IndexedDB-only — no node builtins. This is the technical premise behind
// `isDesktopOnly: false`; if a node builtin ever sneaks into the bundle the
// plugin would crash on Obsidian mobile. Run after `npm run build`.
import { readFileSync, existsSync } from 'node:fs';

const BUNDLE = 'main.js';
if (!existsSync(BUNDLE)) {
  console.error(`✖ ${BUNDLE} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const src = readFileSync(BUNDLE, 'utf8');

// Node builtins that must never be bundled (esbuild marks them external; if one
// is actually reachable it shows up as a require()/import of the bare name).
const FORBIDDEN = ['fs', 'path', 'crypto', 'os', 'net', 'http', 'https', 'child_process', 'electron'];

const hits = [];
for (const mod of FORBIDDEN) {
  // require('fs') / require("node:fs") / from 'fs' — match the bare/node: forms.
  const re = new RegExp(`require\\(\\s*["'](?:node:)?${mod}["']\\s*\\)|from\\s*["'](?:node:)?${mod}["']`, 'g');
  if (re.test(src)) hits.push(mod);
}
// Any `node:` specifier at all is a red flag (the `events` browser polyfill
// esbuild injects is bundled inline, not as a `node:` import, so it's allowed).
if (/require\(\s*["']node:/.test(src) || /from\s*["']node:/.test(src)) {
  hits.push('node: specifier');
}

if (hits.length) {
  console.error(`✖ ${BUNDLE} references node builtins (breaks mobile): ${[...new Set(hits)].join(', ')}`);
  process.exit(1);
}
console.log(`✓ ${BUNDLE} is browser-only — no node builtins (isDesktopOnly:false holds)`);
