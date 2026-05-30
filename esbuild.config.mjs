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
  external: ['obsidian', 'electron', ...builtins],
  // PouchDB ships as browser code; tell esbuild to use browser resolution
  // and stub a few Node globals it references.
  platform: 'browser',
  define: {
    global: 'window',
    'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
  },
  format: 'cjs',
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
