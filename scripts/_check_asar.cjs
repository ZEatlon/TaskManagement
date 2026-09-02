const asar = require('@electron/asar');
const list = asar.listPackage('dist/win-unpacked/resources/app.asar');
const tops = new Set();
for (const p of list) {
  let s = p.replace(/^\\+/, '');
  if (!s.startsWith('node_modules')) continue;
  s = s.slice('node_modules'.length).replace(/^\\+/, '');
  if (!s) continue;
  const idx = s.indexOf('\\');
  if (idx < 0) tops.add(s);
  else tops.add(s.slice(0, idx));
}
const all = [...tops].sort();
console.log('Total top-level packages:', all.length);
const keys = ['call-bind','call-bind-apply-helpers','dunder-proto','get-intrinsic','es-errors','has-symbols','function-bind','es-define-property','gopd','hasown','isarray','object-keys','@anthropic-ai'];
console.log('=== Chain packages at root ===');
for (const k of keys) console.log(k, ':', all.includes(k) ? 'YES' : 'NO');
console.log('=== All top-level (sorted) ===');
console.log(all.join('\n'));