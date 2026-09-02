/**
 * Verify the embedded 7z is structurally complete (has end-of-archive marker).
 */
const fs = require('fs');
const EXE = 'dist/TaskPilot-1.0.0-portable.exe';
const buf = fs.readFileSync(EXE);

const BS = String.fromCharCode(92);
function find7zOffset(buf) {
  const m1 = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]);
  const m2 = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1D]);
  for (let i = 0; i < buf.length - 6; i++) {
    for (const m of [m1, m2]) {
      if (buf[i]===m[0]&&buf[i+1]===m[1]&&buf[i+2]===m[2]&&buf[i+3]===m[3]&&buf[i+4]===m[4]&&buf[i+5]===m[5]) return i;
    }
  }
  return -1;
}

const off = find7zOffset(buf);
console.log('7z start offset:', off);
console.log('Payload size:', buf.length - off);

// Write the payload out and try to extract AND verify
const payload = buf.subarray(off);
const TMP = 'dist/_payload.7z';
fs.writeFileSync(TMP, payload);
console.log('Wrote payload:', payload.length, 'bytes');

// Check the END of 7z archive. 7z stores end header at the end of archive.
// The signature is again 37 7A BC AF 27 1C, but it's at end-of-archive offset.
// Just verify the file is not truncated by running 7za t (test).
const { execSync } = require('child_process');
console.log('Testing 7z integrity...');
try {
  const out = execSync(`"node_modules/7zip-bin/win/x64/7za.exe" t "${TMP}"`, { stdio: 'pipe' });
  console.log(out.toString());
} catch (e) {
  console.log('TEST FAILED:');
  console.log('stdout:', e.stdout?.toString());
  console.log('stderr:', e.stderr?.toString());
}

fs.unlinkSync(TMP);