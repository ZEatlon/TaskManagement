const asar = require('@electron/asar');
const list = asar.listPackage('dist/win-unpacked/resources/app.asar');
const targets = ['node_modules\\call-bind-apply-helpers', 'node_modules\\call-bind-apply-helpers\\package.json', 'node_modules\\call-bind-apply-helpers\\index.js'];
for (const t of targets) {
  console.log(t, '->', list.includes(t) ? 'PRESENT' : 'MISSING');
}
// Also list everything starting with 'node_modules\\call-bind'
console.log('--- all node_modules\\call-bind* entries ---');
list.filter(p => /\\call-bind/.test(p)).forEach(p => console.log(p));
// Check package.json deps
console.log('--- app.asar package.json ---');
console.log(asar.extractFile('dist/win-unpacked/resources/app.asar', 'package.json').toString('utf8'));