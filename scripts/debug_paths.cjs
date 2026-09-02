const asar = require('@electron/asar');
const list = asar.listPackage('dist/win-unpacked/resources/app.asar');
const sample = list.filter(p => p.includes('call-bind-apply-helpers')).slice(0, 3);
console.log('Sample paths:');
sample.forEach(p => console.log(JSON.stringify(p), 'len=', p.length));
console.log('---');
console.log('StartsWith check:', list.filter(p => p.startsWith('node_modules\\call-bind\\node_modules\\call-bind-apply-helpers')).length);