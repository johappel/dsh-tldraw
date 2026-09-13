import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const vendor = fileURLToPath(new URL('../vendor/', import.meta.url));

await mkdir(vendor, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('tldraw-runtime-entry.mjs', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: fileURLToPath(new URL('../vendor/tldraw-runtime.mjs', import.meta.url)),
  legalComments: 'none'
});
await copyFile(new URL('../node_modules/tldraw/tldraw.css', import.meta.url), new URL('../vendor/tldraw.css', import.meta.url));
console.log('Built local tldraw runtime in ' + vendor);
