/**
 * Rebuild TaskPilot-1.0.0-portable.exe with the fixed app.asar.
 *
 * Why: electron-builder's NSIS step compiles the .nsis.7z into the stub via
 *      `File /oname=$PLUGINSDIR\app-64.7z "${APP_64}"`. The 7z bytes are baked
 *      into the stub — you can't simply splice in a new 7z.
 *
 * Strategy:
 *   1. Repack dist/win-unpacked/  →  new taskpilot-1.0.0-x64.nsis.7z
 *   2. Extract the NSI script content captured in dist/builder-debug.yml
 *      (electron-builder saves the EXACT script + defines it would compile)
 *   3. Invoke makensis with the correct defines (APP_64, APP_64_HASH, ...)
 *   4. Output → TaskPilot-1.0.0-portable.exe
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const yaml = require('js-yaml');

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const SEVENZA = path.join(ROOT, 'node_modules/7zip-bin/win/x64/7za.exe');
const MAKENSIS = 'C:/temp/eb-cache/nsis/3.0.4.1/Bin/makensis.exe';
const PLUGIN_DIR = 'C:/temp/eb-cache/nsis/nsis-resources-3.4.1/plugins/x86-unicode';
const INCLUDE_DIR = path.join(ROOT, 'node_modules/app-builder-lib/templates/nsis/include');
// NSIS's makensis.exe is ANSI-only — it can't open files whose paths contain
// non-ASCII characters (the CJK chars in our project root break it). We copy
// the templates to an ASCII directory and rewrite all !include / !addincludedir
// paths to point there.
const ASCII_TPL = 'C:/temp/eb-cache/nsis-templates';

const NEW_7Z = path.join(DIST, 'taskpilot-1.0.0-x64.nsis.7z');
const NSI_PATH = path.join(DIST, '_portable.nsi');
const PORTABLE_EXE = path.join(DIST, 'TaskPilot-1.0.0-portable.exe');

function log(m) { console.log(`[rebuild] ${m}`); }
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

function die(msg) { console.error(`[rebuild] FATAL: ${msg}`); process.exit(1); }

async function main() {
  // --- Preconditions ---
  for (const [label, p] of [
    ['7za', SEVENZA], ['makensis', MAKENSIS], ['plugins', PLUGIN_DIR],
    ['includes', INCLUDE_DIR], ['win-unpacked', path.join(DIST, 'win-unpacked')],
    ['fixed asar', path.join(DIST, 'win-unpacked/resources/app.asar')],
    ['builder-debug.yml', path.join(DIST, 'builder-debug.yml')],
  ]) {
    if (!fs.existsSync(p)) die(`${label} missing: ${p}`);
  }

  // --- 1. Repack win-unpacked → new .nsis.7z ---
  rmrf(NEW_7Z);
  log(`Repacking win-unpacked → ${NEW_7Z} (mx=5)`);
  execSync(
    `"${SEVENZA}" a -mx=5 -m0=LZMA -bb0 -bso0 "${NEW_7Z}" "${DIST}\\win-unpacked\\*"`,
    { stdio: 'inherit', shell: true }
  );
  const sz7z = fs.statSync(NEW_7Z).size;
  log(`New 7z: ${sz7z} bytes`);

  // --- 2. Extract NSI script from builder-debug.yml ---
  log('Reading NSI script from builder-debug.yml');
  const debugYaml = yaml.load(fs.readFileSync(path.join(DIST, 'builder-debug.yml'), 'utf8'));
  if (!debugYaml?.nsis?.script) die('Could not locate nsis.script in builder-debug.yml');
  let decoded = debugYaml.nsis.script;

  // Rewrite every `!include "<path>"` and `!addincludedir "<path>"` that
  // points into node_modules/app-builder-lib/templates/nsis/... to use the
  // ASCII mirror at C:/temp/eb-cache/nsis-templates/... — the ANSI makensis
  // can't open paths with CJK characters. Use backslashes since that's what
  // we proved works with NSIS.
  const SRC_BASE = INCLUDE_DIR.replace(/[\\/]include$/, '');   // single backslashes
  const DST_BASE = ASCII_TPL.replace(/\//g, '\\');             // backslashes
  const SRC_RE = SRC_BASE.replace(/[\\/]/g, '\\\\');           // escape for regex
  decoded = decoded.replace(
    new RegExp(`"(${SRC_RE}[^"]*)"`, 'g'),
    (_, p) => `"${p.replace(SRC_BASE, DST_BASE)}"`
  );

  // Rewrite `!addplugindir` to use forward slashes and the x86-ansi arch.
// The makensis.exe bundled in this build is ANSI-only — its plugin loader
// silently ignores /x86-unicode directives, so the /x86-unicode unicode
// plugin set we get from electron-builder's cache doesn't get enumerated.
// ANSI plugins live at the same cache path under plugins/x86-ansi.
  decoded = decoded.replace(
    /^!addplugindir \/x86-unicode "([^"]+)"/m,
    (m, p) => `!addplugindir /x86-ansi "${p.replace(/x86-unicode/g, 'x86-ansi')}"`
  );

  // Add the ASCII template root to the include search path so unqualified
  // `!include "common.nsh"` / `"extractAppPackage.nsh"` resolve.
  decoded = decoded.replace(
    /^(!include "[^"]+"\r?\n)/m,
    `$1!addincludedir "${DST_BASE}"\n`
  );

  // Strip the `!include "...0-messages.nsh"` line — that file lived in a temp
  // dir electron-builder created at build time and is gone now. We replace it
  // with the two LangStrings that extractAppPackage.nsh actually references:
  // $(decompressionFailed) and $(appCannotBeClosed).
  decoded = decoded.replace(
    /^!include ".*0-messages\.nsh"\r?\n/m,
    ''
  );
  // The two LangStrings electron-builder would have generated into messages.nsh.
  // Replicates nsisLang.js's newline → $\r$\n conversion (NSIS escape syntax:
  // literally the 6 characters `$`, `\`, `r`, `$`, `\`, `n` — JS source needs
  // `\\r` / `\\n` to produce a single backslash before the letter).
  const lcidEn = 1033;
  const NL_NSIS = '$\\r$\\n';
  const cannotCloseEn = '${PRODUCT_NAME} cannot be closed. \nPlease close it manually and click Retry to continue.'.replace(/\n/g, NL_NSIS);
  const decompressFailedEn = 'Failed to decompress files. Please try running the installer again.';
  const langStrings = [
    `LangString appCannotBeClosed ${lcidEn} "${cannotCloseEn}"`,
    `LangString decompressionFailed ${lcidEn} "${decompressFailedEn}"`,
  ].join('\n');

  // The decoded script has no OutFile directive; electron-builder passes the
  // output path via its NsisTarget.js, not via the NSI script. We must inject
  // OutFile ourselves before passing to makensis.
  const withOutFile =
    `OutFile "${PORTABLE_EXE}"\n` +
    langStrings + '\n' +
    decoded;

  fs.writeFileSync(NSI_PATH, withOutFile, 'utf8');
  log(`Wrote ${NSI_PATH} (${withOutFile.length} chars)`);

  // --- 3. Invoke makensis ---
  // Defines that electron-builder would pass (see NsisTarget.js).
  const hashB64 = crypto.createHash('sha512').update(fs.readFileSync(NEW_7Z)).digest('base64');

  // Compute unpacked size in KB (electron-builder uses Math.ceil(bytes / 1024)).
  const TMP = path.join(DIST, '_size_check');
  rmrf(TMP);
  execSync(`"${SEVENZA}" x "${NEW_7Z}" -o"${TMP}" -snl- -y`, { stdio: 'pipe' });
  let total = 0;
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) total += fs.statSync(f).size;
    }
  })(TMP);
  rmrf(TMP);
  const unpackedKB = Math.ceil(total / 1024);
  log(`Unpacked size: ${total} bytes (${unpackedKB} KB)`);
  log(`APP_64_HASH:   ${hashB64.slice(0, 16)}...`);

  // Remove old portable.exe (will be locked if user is running it).
  try { fs.unlinkSync(PORTABLE_EXE); } catch (e) { /* ignore */ }

  log('Running makensis...');
  // Use execFile (no shell) to avoid Git Bash mangling forward-slash /D
  // defines into Windows paths. Pass the script via stdin with -INPUTCHARSET
  // UTF8 (same as electron-builder does) so CJK chars in the script survive.
  const { execFileSync } = require('child_process');
  const args = [
    '-INPUTCHARSET', 'UTF8',
    `/DAPP_64=${NEW_7Z}`,
    `/DAPP_64_HASH=${hashB64}`,
    `/DAPP_64_UNPACKED_SIZE=${unpackedKB}`,
    `/DAPP_FILENAME=TaskPilot.exe`,
    // Note: don't /DAPP_EXECUTABLE_FILENAME — common.nsh defines it from
    // ${PRODUCT_FILENAME}.exe, and a duplicate !define aborts the script.
    `/DPRODUCT_NAME=TaskPilot`,
    `/DPRODUCT_FILENAME=TaskPilot`,
    `/DAPP_PRODUCT_FILENAME=TaskPilot`,
    `/DUNPACK_DIR_NAME=TaskPilot-1.0.0`,
    `/DREQUEST_EXECUTION_LEVEL=user`,
    `/DCOMPRESSION_METHOD=7z`,
    `/DPRODUCT_VERSION=1.0.0`,
    `/DVERSION=1.0.0`,  // for common.nsh's BrandingText "${VERSION}"
    `/DAPP_PACKAGE_NAME=TaskPilot-1.0.0-portable.exe`,
    // Drop -WX — the common.nsh we use has harmless warnings about unused
    // macros (e.g. isUpdated). electron-builder's build pulls in a more
    // complete common.nsh that doesn't trigger them.
    '-',
  ];
  execFileSync(MAKENSIS, args, { stdio: ['pipe', 'inherit', 'inherit'], input: withOutFile });

  if (!fs.existsSync(PORTABLE_EXE)) die('makensis did not produce output');
  log(`✓ ${PORTABLE_EXE}: ${fs.statSync(PORTABLE_EXE).size} bytes`);

  // Cleanup intermediates
  rmrf(NSI_PATH);
  rmrf(NEW_7Z);
}

main().catch(err => { console.error(err); process.exit(1); });