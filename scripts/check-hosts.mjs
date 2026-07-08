#!/usr/bin/env node
// Regression guard: the wrong host `mcp.agentage.io` must never reappear.
// The API/MCP host is `memory.agentage.io`; the discovery host is `sync.agentage.io`.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const FORBIDDEN = 'mcp.agentage.io';
const files = execSync('git ls-files src manifest.json README.md CLAUDE.md versions.json package.json', {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const hits = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(FORBIDDEN)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (hits.length) {
  console.error(`✖ forbidden host "${FORBIDDEN}" found (use memory.agentage.io):`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`✓ no "${FORBIDDEN}" in tracked source/docs`);
