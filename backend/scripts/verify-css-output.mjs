import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const cssDir = path.resolve(process.cwd(), '.next', 'static', 'css');

function fail(message) {
  console.error(`CSS_BUILD_GATE_FAILED: ${message}`);
  process.exit(1);
}

let names;
try {
  names = await readdir(cssDir);
} catch (error) {
  fail(`missing ${cssDir}: ${error instanceof Error ? error.message : String(error)}`);
}

const cssFiles = names.filter((name) => name.endsWith('.css'));
if (cssFiles.length === 0) fail('no compiled CSS files were emitted by Next.js');

let totalBytes = 0;
let compiledCss = '';
for (const name of cssFiles) {
  const file = path.join(cssDir, name);
  const fileStat = await stat(file);
  totalBytes += fileStat.size;
  compiledCss += `\n${await readFile(file, 'utf8')}`;
}

if (totalBytes < 2_000) {
  fail(`compiled CSS is unexpectedly small (${totalBytes} bytes)`);
}

// These are representative Tailwind utilities used by app/page.tsx. Their
// presence proves Tailwind directives were processed rather than shipped raw.
const requiredSelectors = [
  '.min-h-screen',
  '.grid-cols-2',
  '.rounded-3xl',
  '.bg-slate-50',
  '.text-primary-900',
];

const missing = requiredSelectors.filter((selector) => !compiledCss.includes(selector));
if (missing.length > 0) {
  fail(`Tailwind utilities missing from compiled CSS: ${missing.join(', ')}`);
}

console.log(`CSS_BUILD_GATE_PASS: ${cssFiles.length} CSS file(s), ${totalBytes} bytes, Tailwind utilities verified.`);
