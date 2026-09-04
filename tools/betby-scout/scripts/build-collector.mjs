#!/usr/bin/env node
// Builds the collector into its two shipping shapes from one source tree.
//
//   dist/collector/extension/       - unpacked MV3 extension (load in Chrome)
//   dist/collector/betby-scout.user.js - Tampermonkey userscript
//
// Each entry is bundled as a standalone IIFE. Rollup only allows one input per
// IIFE build, so we run one Vite build per entry instead of a single multi-entry
// build. Chrome content scripts cannot be ES modules, which is why IIFE and not
// ESM.
import { build } from 'vite';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'dist/collector');
const WATCH = process.argv.includes('--watch');

const ENTRIES = [
  ['hook', 'src/collector/hook.entry.ts'],
  ['content', 'src/collector/content.entry.ts'],
  ['background', 'src/collector/extension/background.ts'],
  ['popup', 'src/collector/extension/popup.ts'],
  ['userscript-boot', 'src/collector/userscript.entry.ts'],
];

async function buildEntry(name, input) {
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: 'dist/collector',
      emptyOutDir: false,
      target: 'es2022',
      minify: false, // readable: this runs on a page we are actively debugging
      watch: WATCH ? {} : null,
      lib: { entry: resolve(ROOT, input), formats: ['iife'], name: `BetbyScout_${name}`, fileName: () => `${name}.js` },
      rollupOptions: { output: { extend: true } },
    },
  });
}

function packageTargets() {
  const extDir = resolve(OUT, 'extension');
  mkdirSync(extDir, { recursive: true });

  const shell = resolve(ROOT, 'src/collector/extension');
  for (const f of ['manifest.json', 'popup.html']) {
    const src = resolve(shell, f);
    if (existsSync(src)) cpSync(src, resolve(extDir, f));
  }
  const icons = resolve(shell, 'icons');
  if (existsSync(icons)) cpSync(icons, resolve(extDir, 'icons'), { recursive: true });
  for (const f of ['hook.js', 'content.js', 'background.js', 'popup.js']) {
    const src = resolve(OUT, f);
    if (existsSync(src)) cpSync(src, resolve(extDir, f));
  }

  // Userscript: the hook is inlined, so nothing is fetched from a remote host.
  const hook = readFileSync(resolve(OUT, 'hook.js'), 'utf8');
  const meta = readFileSync(resolve(ROOT, 'src/collector/userscript.meta.js'), 'utf8');
  const bootPath = resolve(OUT, 'userscript-boot.js');
  const boot = existsSync(bootPath) ? readFileSync(bootPath, 'utf8') : '';
  writeFileSync(resolve(OUT, 'betby-scout.user.js'), `${meta}\n${hook}\n${boot}\n`, 'utf8');
}

if (!WATCH) rmSync(OUT, { recursive: true, force: true });
for (const [name, input] of ENTRIES) await buildEntry(name, input);
packageTargets();
console.log(WATCH ? '[collector] watching' : `[collector] built -> ${OUT}`);
