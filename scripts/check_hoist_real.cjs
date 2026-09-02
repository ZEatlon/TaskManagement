const asar = require('@electron/asar');
const path = 'dist/_verify/resources/app.asar';
const list = asar.listPackage(path);
const tops = new Set();
const BS = String.fromCharCode(92);
const FS = '/';
for (const p of list) {
  let s = p.replace(new RegExp('^\\\\+'), '').replace(new RegExp('^/+/'), '');
  if (!s.startsWith('node_modules')) continue;
  s = s.slice('node_modules'.length).replace(new RegExp('^\\\\+'), '');
  if (!s) continue;
  const idxBS = s.indexOf(BS);
  const idxFS = s.indexOf(FS);
  let idx = -1;
  if (idxBS >= 0 && idxFS >= 0) idx = Math.min(idxBS, idxFS);
  else if (idxBS >= 0) idx = idxBS;
  else idx = idxFS;
  if (idx < 0) tops.add(s);
  else tops.add(s.slice(0, idx));
}
console.log('Total top-level packages:', tops.size);
console.log('call-bind-apply-helpers at root:', tops.has('call-bind-apply-helpers'));
console.log('Total asar entries:', list.length);
console.log('asar file size:', require('fs').statSync(path).size);