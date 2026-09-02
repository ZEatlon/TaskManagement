const asar = require('@electron/asar');
const buf = asar.extractFile('dist/win-unpacked/resources/app.asar', 'node_modules\\dunder-proto\\get.js');
console.log('--- dunder-proto/get.js ---');
console.log(buf.toString('utf8'));
console.log('--- dunder-proto/package.json ---');
console.log(asar.extractFile('dist/win-unpacked/resources/app.asar', 'node_modules\\dunder-proto\\package.json').toString('utf8'));
console.log('--- call-bind/package.json ---');
console.log(asar.extractFile('dist/win-unpacked/resources/app.asar', 'node_modules\\call-bind\\package.json').toString('utf8'));