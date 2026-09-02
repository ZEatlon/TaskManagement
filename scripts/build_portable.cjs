/**
 * Rebuild portable.exe with the fixed asar.
 *
 * Strategy:
 *   1. Extract the existing .nsis.7z (the old electron-builder artifact).
 *   2. Replace resources/app.asar with the freshly fixed one.
 *   3. Repack as a new .nsis.7z.
 *   4. Take the NSIS stub portion from the OLD portable.exe (first N bytes),
 *      where N = old_portable_size - old_nsis7z_size.
 *   5. Concatenate stub + new 7z → new portable.exe.
 *
 * If the old nsis.7z is missing, recompute N by reading the old portable.exe
 * and locating the 7z magic header (signature: 0x377ABCAF271C or 0x377ABCAF271D).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const SEVENZA = path.join(ROOT, 'node_modules/7zip-bin/win/x64/7za.exe');
const DIST = path.join(ROOT, 'dist');
const OLD_EXE = path.join(DIST, 'TaskPilot-1.0.0-portable.exe');
const NSIS_7Z = path.join(DIST, 'taskpilot-1.0.0-x64.nsis.7z');
const STAGING = path.join(DIST, '_staging');
const FRESH_ASAR = path.join(ROOT, 'dist/win-unpacked/resources/app.asar');
const NEW_7Z = path.join(DIST, 'taskpilot-1.0.0-x64.nsis.7z.new');
const NEW_EXE = path.join(DIST, 'TaskPilot-1.0.0-portable.exe.new');

function log(msg) { console.log(`[portable] ${msg}`); }
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

// Find the offset of the 7z archive inside a portable.exe by scanning for 7z magic
function find7zOffset(buf) {
  // 7z magic: 37 7A BC AF 27 1C (old) or 37 7A BC AF 27 1D (newer)
  const magics = [
    Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]),
    Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1D]),
  ];
  for (let i = 0; i < buf.length - 6; i++) {
    for (const m of magics) {
      if (buf[i] === m[0] && buf[i + 1] === m[1] && buf[i + 2] === m[2] &&
          buf[i + 3] === m[3] && buf[i + 4] === m[4] && buf[i + 5] === m[5]) {
        return i;
      }
    }
  }
  return -1;
}

async function main() {
  if (!fs.existsSync(SEVENZA)) throw new Error(`7za not found at ${SEVENZA}`);
  if (!fs.existsSync(FRESH_ASAR)) throw new Error(`Fixed asar not found at ${FRESH_ASAR}`);
  if (!fs.existsSync(OLD_EXE)) throw new Error(`Old portable.exe not found at ${OLD_EXE}`);

  log(`Reading ${OLD_EXE} to find stub/7z boundary`);
  const oldBuf = fs.readFileSync(OLD_EXE);
  const offset = find7zOffset(oldBuf);
  if (offset < 0) throw new Error(`7z magic not found in ${OLD_EXE}`);
  log(`7z archive starts at offset ${offset} (stub size = ${offset} bytes)`);
  const stubBuf = oldBuf.subarray(0, offset);
  const old7zBuf = oldBuf.subarray(offset);
  log(`Stub: ${stubBuf.length} bytes, old 7z: ${old7zBuf.length} bytes`);

  // Write stub to a temp file (just to use 7za to extract old 7z for staging replacement)
  const OLD_7Z_TMP = path.join(DIST, '_old_payload.7z');
  fs.writeFileSync(OLD_7Z_TMP, old7zBuf);

  // Extract old payload
  rmrf(STAGING);
  fs.mkdirSync(STAGING, { recursive: true });
  log(`Extracting old 7z payload into staging`);
  execSync(`"${SEVENZA}" x "${OLD_7Z_TMP}" -o"${STAGING}" -snl- -y`, { stdio: 'inherit' });

  // Replace app.asar with fixed version
  const asarInStaging = path.join(STAGING, 'resources', 'app.asar');
  if (!fs.existsSync(asarInStaging)) throw new Error(`app.asar not found in staging`);
  log(`Replacing ${asarInStaging} with fixed asar`);
  fs.copyFileSync(FRESH_ASAR, asarInStaging);

  // Repack as new .nsis.7z with low compression (faster)
  rmrf(NEW_7Z);
  log(`Repacking into ${NEW_7Z}`);
  execSync(`"${SEVENZA}" a -mx=5 -mtc=off -mtm=off -mta=off -bb3 "${NEW_7Z}" "${STAGING}\\*"`, { stdio: 'inherit', shell: true });

  // Read new 7z
  const new7zBuf = fs.readFileSync(NEW_7Z);
  log(`New 7z: ${new7zBuf.length} bytes`);

  // Concatenate stub + new 7z → new portable.exe
  log(`Writing ${NEW_EXE}`);
  const out = fs.createWriteStream(NEW_EXE);
  out.write(stubBuf);
  out.write(new7zBuf);
  out.end();
  await new Promise(resolve => out.on('finish', resolve));
  log(`New portable.exe size: ${fs.statSync(NEW_EXE).size} bytes`);

  // Cleanup
  fs.unlinkSync(OLD_7Z_TMP);
  fs.unlinkSync(NEW_7Z);
  rmrf(STAGING);

  // Replace original (use copy+unlink since rename fails if target is in use)
  log(`Replacing ${OLD_EXE} with new portable.exe`);
  try {
    fs.renameSync(NEW_EXE, OLD_EXE);
  } catch (err) {
    if (err.code === 'EPERM') {
      log('Rename failed (target locked) — using copy+unlink fallback');
      fs.copyFileSync(NEW_EXE, OLD_EXE);
      fs.unlinkSync(NEW_EXE);
    } else throw err;
  }
  log(`✓ Replaced ${OLD_EXE}`);
}

main().catch(err => { console.error(err); process.exit(1); });