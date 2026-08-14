import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const staticDir = path.resolve(process.cwd(), '.next', 'static');
function fail(message) { console.error(`CSS_BUILD_GATE_FAILED: ${message}`); process.exit(1); }
const cssFiles = [];
async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { fail(`missing ${dir}: ${error instanceof Error ? error.message : String(error)}`); }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && entry.name.endsWith('.css')) cssFiles.push(full);
  }
}
await walk(staticDir);
if (!cssFiles.length) fail('no compiled CSS files were emitted by Next.js');
let totalBytes=0, compiledCss='';
for (const file of cssFiles) { const s=await stat(file); totalBytes+=s.size; compiledCss+=`\n${await readFile(file,'utf8')}`; }
if (totalBytes < 2000) fail(`compiled CSS is unexpectedly small (${totalBytes} bytes)`);
const required=['.min-h-screen','.grid-cols-2','.rounded-3xl','.bg-slate-50','.text-primary-900'];
const missing=required.filter(x=>!compiledCss.includes(x));
if (missing.length) fail(`Tailwind utilities missing from compiled CSS: ${missing.join(', ')}`);
console.log(`CSS_BUILD_GATE_PASS: ${cssFiles.length} CSS file(s), ${totalBytes} bytes, Tailwind utilities verified.`);
