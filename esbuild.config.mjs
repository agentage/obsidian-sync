import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';

const banner = `/*
Agentage Memory — Obsidian plugin
This is a generated bundle. Source lives in src/. Do not edit directly.
*/`;

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  // Externalize node builtins in BOTH the bare and `node:` form. The desktop-only
  // paths (auth.json/vaults.json under ~/.agentage) load these lazily; mobile never
  // reaches them. Without the `node:`-prefixed entries esbuild leaves the raw
  // specifier and the Obsidian renderer can't resolve it.
  external: ['obsidian', 'electron', ...builtins, ...builtins.map((m) => `node:${m}`)],
  // Browser platform so the bundle is mobile-safe; the couch sync channel uses Obsidian
  // requestUrl + Web Crypto (no node builtins), js-yaml is pure-JS. A couple of Node
  // globals are shimmed for browser resolution.
  platform: 'browser',
  define: {
    global: 'window',
    'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
  },
  format: 'cjs',
  // Lower lazy `import('node:fs/promises')` to a `require()`: the Obsidian (Electron)
  // renderer CORS-blocks dynamic import of a `node:`/bare specifier (app://obsidian.md
  // origin), but require() works. Keeps desktop auth.json/vaults.json fs access alive.
  supported: { 'dynamic-import': false },
  target: 'es2024',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
