/**
 * Diagnostic: verify the portable.exe structure is correct.
 * 1. Find 7z magic boundary
 * 2. Extract the embedded payload
 * 3. Verify resources/app.asar exists and check hoisting
 * 4. Verify resources/node/node.exe exists
 * 5. Verify TaskPilot.exe exists at root
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXE = 'dist/TaskPilot-1.0.0-portable.exe';
const SEVENZA = path.join(process.cwd(), 'node_modules/7zip-bin/win/x64/7za.exe');
const VERIFY = path.join(process.cwd(), 'dist/_diag');

function log(m) { console.log('[diag]', m); }
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

function find7zOffset(buf) {
  const magics = [
    Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]),
    Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1D]),
  ];
  for (let i = 0; i < buf.length - 6; i++) {
    for (const m of magics) {
      if (buf[i]===m[0]&&buf[i+1]===m[1]&&buf[i+2]===m[2]&&buf[i+3]===m[3]&&buf[i+4]===m[4]&&buf[i+5]===m[5]) return i;
    }
  }
  return -1;
}

const exeBuf = fs.readFileSync(EXE);
const offset = find7zOffset(exeBuf);
log(`Total portable.exe size: ${exeBuf.length}`);
log(`7z magic offset: ${offset}`);
log(`NSIS stub size: ${offset} bytes`);

const stubBuf = exeBuf.subarray(0, offset);
const payloadBuf = exeBuf.subarray(offset);
log(`Embedded payload size: ${payloadBuf.length}`);

// Check if first 2 bytes of stub are 'MZ' (PE signature)
log(`Stub starts with 'MZ': ${stubBuf[0] === 0x4D && stubBuf[1] === 0x5A}`);

// Write payload to a temp file and extract
const PAYLOAD_TMP = path.join(process.cwd(), 'dist/_diag_payload.7z');
fs.writeFileSync(PAYLOAD_TMP, payloadBuf);

rmrf(VERIFY);
fs.mkdirSync(VERIFY, { recursive: true });
log(`Extracting payload to ${VERIFY}`);
execSync(`"${SEVENZA}" x "${PAYLOAD_TMP}" -o"${VERIFY}" -snl- -y`, { stdio: 'pipe' });

// Check key files exist
const checks = [
  'TaskPilot.exe',
  'resources/app.asar',
  'resources/node/node.exe',
  'resources/scripts/db-worker.cjs',
  'resources/build/icon.png',
];
for (const rel of checks) {
  const full = path.join(VERIFY, rel);
  const exists = fs.existsSync(full);
  const sz = exists ? fs.statSync(full).size : 0;
  log(`  ${exists ? 'OK' : 'MISSING'}  ${rel} (${sz} bytes)`);
}

// Cleanup
fs.unlinkSync(PAYLOAD_TMP);
rmrf(VERIFY);
log('Diagnostic complete.');