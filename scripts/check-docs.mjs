#!/usr/bin/env node
// Store-disclosure guard: README must carry the required network/privacy/ToS
// disclosures with the correct hosts. Prose accuracy is a human read; this only
// asserts the load-bearing strings are present (and the wrong host is absent).
import { readFileSync } from 'node:fs';

const readme = readFileSync('README.md', 'utf8');

const required = [
  'memory.agentage.io',
  'sync.agentage.io',
  'agentage.io/privacy',
  'agentage.io/terms',
];
const forbidden = ['mcp.agentage.io'];

const missing = required.filter((s) => !readme.includes(s));
const present = forbidden.filter((s) => readme.includes(s));

if (missing.length || present.length) {
  if (missing.length) console.error(`✖ README missing required disclosure(s): ${missing.join(', ')}`);
  if (present.length) console.error(`✖ README contains forbidden string(s): ${present.join(', ')}`);
  process.exit(1);
}
console.log('✓ README discloses both hosts + privacy + terms; no forbidden host');
