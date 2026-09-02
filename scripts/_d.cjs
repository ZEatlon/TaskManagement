const asar = require('@electron/asar');
const ASAR = 'dist/win-unpacked/resources/app.asar';
const list = asar.listPackage(ASAR);
console.log('Total entries:', list.length);
// Find entries under node_modules\call-bind\node_modules\call-bind-apply-helpers
const needle = 'call-bind-apply-helpers';
const cb = list.filter(p => p.includes(needle));
console.log('call-bind-apply-helpers entries:', cb.length);
cb.slice(0, 5).forEach(p => console.log(JSON.stringify(p)));
// Try statFile on the first one
const sample = cb[0];
console.log('Sample:', JSON.stringify(sample));
try {
  const s = asar.statFile(ASAR, sample);
  console.log('stat OK:', s);
} catch (e) { console.log('stat err:', e.message); }