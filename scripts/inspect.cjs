const asar = require('@electron/asar');
const buf = asar.extractFile('dist/win-unpacked/resources/app.asar', 'node_modules\\call-bind\\package.json');
console.log('--- call-bind/package.json ---');
console.log(buf.toString('utf8'));
console.log('--- call-bind-apply-helpers/package.json ---');
console.log(asar.extractFile('dist/win-unpacked/resources/app.asar', 'node_modules\\call-bind\\node_modules\\call-bind-apply-helpers\\package.json').toString('utf8'));