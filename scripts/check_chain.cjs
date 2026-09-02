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
const chain = ['isomorphic-git','sha.js','readable-stream','typed-array-buffer','call-bound','call-bind-apply-helpers','get-intrinsic','function-bind','es-errors','es-define-property','es-object-atoms','get-proto','dunder-proto','gopd','has-symbols','hasown','has-tostringtag','available-typed-arrays','which-typed-array','is-typed-array','for-each','math-intrinsics','inherits','safe-buffer','string_decoder','to-buffer','util-deprecate','mimic-response','wrappy','once','simple-get','decompress-response','simple-concat','minimist','minimisted','pako','pify','ignore','diff3','crc-32','clean-git-ref','async-lock','isarray'];
console.log('=== Chain packages — root level? ===');
let missing = [];
for (const k of chain) {
  const yes = all.includes(k);
  console.log(k.padEnd(30), yes ? 'YES' : 'NO');
  if (!yes) missing.push(k);
}
console.log('---');
console.log('Missing from asar root:', missing.join(', '));