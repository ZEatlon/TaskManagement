const asar = require('@electron/asar');
const list = asar.listPackage('dist/win-unpacked/resources/app.asar');
const search = ['call-bind-apply-helpers','available-typed-arrays'];
for (const s of search) {
  console.log('---', s, '---');
  list.filter(p => p.toLowerCase().includes(s.toLowerCase())).forEach(p => console.log(p));
}