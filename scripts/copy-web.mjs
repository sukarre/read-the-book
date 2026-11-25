// Copies the web app into www/ for the Android build (Capacitor's webDir).
// The repo root itself stays the GitHub Pages site.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const FILES = ['index.html', 'styles.css', 'app.js', 'extract.js', 'reader.js', 'segment.js', 'native.js',
  'manifest.webmanifest', 'icons'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www/vendor', { recursive: true });
for (const f of FILES) cpSync(f, `www/${f}`, { recursive: true });
cpSync('node_modules/@capacitor/core/dist/index.js', 'www/vendor/capacitor-core.js');
console.log('www/ ready');
