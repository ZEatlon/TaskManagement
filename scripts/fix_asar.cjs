/**
 * Asar hoisting fixup
 *
 * electron-builder's packer (app-builder-lib) sometimes leaves certain packages
 * nested under their parent (e.g. node_modules/call-bind/node_modules/call-bind-apply-helpers/)
 * instead of hoisting them to root. At runtime, Node's module resolution from
 * another sibling (e.g. node_modules/dunder-proto/get.js) walks UP looking for
 * node_modules/call-bind-apply-helpers — but only finds it NESTED under call-bind/,
 * which is invisible from dunder-proto's perspective.
 *
 * Fix: copy the nested copy up to root, then remove the nested copy and
 * repack. Idempotent — safe to run multiple times.
 */
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');

const ASAR = 'dist/win-unpacked/resources/app.asar';
const SEP = String.fromCharCode(92); // backslash

// Known hoisting issues: <root-name>: <nested-path-template>
// Paths use single-backslash separators in asar listPackage output (with a leading SEP on Windows).
const HOIST_FIXES = [
  { root: 'call-bind-apply-helpers', nested: ['node_modules', 'call-bind', 'node_modules', 'call-bind-apply-helpers'].join(SEP) },
];

const list = asar.listPackage(ASAR);
const tops = new Set();
for (const p of list) {
  let s = p.replace(/^\\+/, '').replace(/^\/+/, '');
  if (!s.startsWith('node_modules')) continue;
  s = s.slice('node_modules'.length).replace(/^\\+/, '').replace(/^\/+/, '');
  if (!s) continue;
  const idx = s.indexOf(SEP) >= 0 ? s.indexOf(SEP) : s.indexOf('/');
  if (idx < 0) tops.add(s);
  else tops.add(s.slice(0, idx));
}

async function main() {
  let totalFixed = 0;
  for (const fix of HOIST_FIXES) {
    const { root: rootName, nested: nestedBase } = fix;
    // Find any nested copies (regardless of whether root already exists).
    const nestedFiles = [];
    for (const p of list) {
      const norm = p.replace(/^\\+/, '').replace(/^\/+/, '');
      if (!norm.startsWith(nestedBase + SEP)) continue;
      const rest = norm.slice(nestedBase.length).replace(/^\\+/, '').replace(/^\/+/, '');
      if (!rest) continue;
      nestedFiles.push(norm);
    }
    if (nestedFiles.length === 0) {
      console.log(`[fix-asar] No nested copy of ${rootName} to hoist.`);
      continue;
    }
    console.log(`[fix-asar] Hoisting ${rootName} (${nestedFiles.length} files) from ${nestedBase}`);
    const tmp = path.join('dist', '_asar_unpack_' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      await asar.extractAll(ASAR, tmp);
      const destBase = path.join(tmp, 'node_modules', rootName);
      fs.mkdirSync(destBase, { recursive: true });
      for (const fileKey of nestedFiles) {
        const relFromBase = fileKey.slice(nestedBase.length).replace(/^\\+/, '').replace(/^\/+/, '');
        const srcPath = path.join(tmp, ...fileKey.split(/[\\\/]/));
        const destPath = path.join(destBase, ...relFromBase.split(/[\\\/]/));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        if (!fs.existsSync(destPath)) fs.copyFileSync(srcPath, destPath);
      }
      // Remove the nested directory entirely so the asar isn't bloated.
      const nestedAbs = path.join(tmp, ...nestedBase.split(SEP));
      fs.rmSync(nestedAbs, { recursive: true, force: true });
      const tmpAsar = ASAR + '.tmp';
      await asar.createPackage(tmp, tmpAsar);
      fs.renameSync(tmpAsar, ASAR);
      console.log(`[fix-asar] ${rootName} hoisted (and nested copy removed).`);
      totalFixed++;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`[fix-asar] Done. Fixed: ${totalFixed}`);
}

main().catch(err => {
  console.error('[fix-asar] Fatal:', err);
  process.exit(1);
});