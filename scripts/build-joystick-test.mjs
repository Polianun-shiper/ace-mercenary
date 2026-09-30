#!/usr/bin/env node
// scripts/build-joystick-test.mjs
//
// Builds the static joystick test harness:
//   dist-test/joystick-test.html
//
// Usage: node scripts/build-joystick-test.mjs
// Requires: esbuild (devDependency).

import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Same Tailwind pipeline as the main single-file build.
const cssSrc = readFileSync(join(ROOT, 'src/app/globals.css'), 'utf8');
const pc = await postcss([tailwindcss]).process(cssSrc, {
  from: join(ROOT, 'src/app/globals.css'),
});
const cssMin = await build({
  stdin: { contents: pc.css, loader: 'css', sourcefile: 'app.css' },
  write: false,
  minify: true,
});
const css = cssMin.outputFiles[0].text;

const jsResult = await build({
  entryPoints: [join(ROOT, 'src/standalone/joystick-test.tsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  alias: { '@': join(ROOT, 'src') },
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  write: false,
  logLevel: 'silent',
});
const js = jsResult.outputFiles[0].text;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>VirtualJoystick Test Harness</title>
<style>
  html, body { margin: 0; padding: 0; background: #0a0f14; height: 100%; overflow: hidden; }
  * { -webkit-user-select: none; user-select: none; }
  ${css}
</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;

mkdirSync(join(ROOT, 'dist-test'), { recursive: true });
const outFile = join(ROOT, 'dist-test', 'joystick-test.html');
writeFileSync(outFile, html, 'utf8');
console.log(`joystick test harness → ${outFile} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
