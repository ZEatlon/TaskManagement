/**
 * electron-builder signing hook for Windows
 *
 * Exported as a function (electron-builder 25 loads this file via require()
 * and calls the default export with { path, options, packager }).
 * See: https://www.electron.build/code-signing#custom-signing-function
 *
 * Reads code-signing material from environment variables and signs the
 * given file using `signtool.exe` (Windows SDK). Cross-platform
 * fallback via osslsigncode is stubbed for future use.
 *
 * Required env vars (production):
 *   - WINDOWS_CERT_FILE       path to .pfx / .p12 file
 *   - WINDOWS_CERT_PASSWORD   password for the cert
 *   - WINDOWS_TIMESTAMP_URL   (optional) RFC 3161 timestamp server
 *                              default: http://timestamp.digicert.com
 *   - WINDOWS_PUBLISHER_NAME  (optional) publisher name in metadata
 *                              default: TaskPilot
 *
 * If env vars are missing, returns immediately so dev builds work.
 * Set CSC_FORCE_SIGNING=1 to make a missing cert a hard error.
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function resolveCert() {
  const fromProject = {
    file: process.env.WINDOWS_CERT_FILE,
    password: process.env.WINDOWS_CERT_PASSWORD,
  }
  const fromElectronBuilder = {
    file: process.env.CSC_LINK,
    password: process.env.CSC_KEY_PASSWORD,
  }
  return fromProject.file ? fromProject : fromElectronBuilder
}

/** Decode base64 .pfx if needed, write to a temp file, return path. */
function materializeCert(certRef) {
  if (!certRef) return null
  if (fs.existsSync(certRef)) return certRef
  if (/^[A-Za-z0-9+/=\s]+$/.test(certRef) && certRef.length > 200) {
    const decoded = Buffer.from(certRef, 'base64')
    const out = path.join(os.tmpdir(), 'taskpilot-cert.pfx')
    fs.writeFileSync(out, decoded)
    console.log(`[sign] decoded base64 cert to ${out} (${decoded.length} bytes)`)
    return out
  }
  return certRef
}

function findSigntool() {
  const candidates = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe',
    'C:\\Program Files\\Windows Kits\\10\\bin\\x64\\signtool.exe',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Fallback: rely on PATH
  const which = spawnSync('where', ['signtool.exe'], { encoding: 'utf8' })
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/)[0]?.trim()
    if (first) return first
  }
  return null
}

function signWithSigntool(targetPath, opts) {
  const cert = resolveCert()
  if (!cert.file) {
    if (process.env.CSC_FORCE_SIGNING === '1') {
      console.error(
        '[sign] WINDOWS_CERT_FILE / CSC_LINK not set, but CSC_FORCE_SIGNING=1 — refusing to skip',
      )
      return 1
    }
    console.warn(
      `[sign] No code-signing cert found. Skipping signing of ${path.basename(targetPath)}.`,
      'Set WINDOWS_CERT_FILE + WINDOWS_CERT_PASSWORD to enable (see build/SIGNING.md).',
    )
    return 0
  }

  const signtool = findSigntool()
  if (!signtool) {
    console.error(
      '[sign] signtool.exe not found. Install Windows SDK (signtool) to enable signing.',
    )
    return 1
  }

  const certPath = materializeCert(cert.file)
  if (!certPath || !fs.existsSync(certPath)) {
    console.error(`[sign] cert file not found: ${cert.file}`)
    return 1
  }

  const timestampUrl =
    opts?.timestampUrl ||
    process.env.WINDOWS_TIMESTAMP_URL ||
    'http://timestamp.digicert.com'
  const publisherName =
    opts?.publisherName || process.env.WINDOWS_PUBLISHER_NAME || 'TaskPilot'

  const args = [
    'sign',
    '/fd', 'sha256',
    '/td', 'sha256',
    '/tr', timestampUrl,
    '/d', publisherName,
    '/f', certPath,
  ]
  if (cert.password) args.push('/p', cert.password)
  args.push(targetPath)

  const sizeKb = (fs.statSync(targetPath).size / 1024).toFixed(1)
  console.log(
    `[sign] signtool sign ${path.basename(targetPath)} (${sizeKb} KB)`,
  )
  const r = spawnSync(signtool, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[sign] signtool failed: exit ${r.status}`)
    return r.status || 1
  }

  // Best-effort verify
  const verify = spawnSync(signtool, ['verify', '/pa', targetPath], {
    stdio: 'pipe',
  })
  if (verify.status === 0) {
    console.log(`[sign] signature verified: ${path.basename(targetPath)}`)
  } else {
    console.warn(
      `[sign] verify returned ${verify.status} (signature may still be valid)`,
    )
  }
  return 0
}

/**
 * electron-builder invokes this default export with the sign context.
 *
 * @param {{
 *   path: string,             // file to sign
 *   options: object,          // signtoolOptions from package.json
 *   packager: any             // electron-builder Packager instance
 * }} config
 */
async function signHook(config) {
  if (!config || !config.path) {
    console.error('[sign] hook called without config.path')
    return
  }
  const exit = signWithSigntool(config.path, config.options)
  if (exit !== 0) {
    throw new Error(`[sign] failed to sign ${config.path}`)
  }
}

// electron-builder may require() this module and look up either `default` or
// the module itself. Expose both.
module.exports = signHook
module.exports.default = signHook

// Allow direct execution for ad-hoc signing: `node build/sign.js <path>`
if (require.main === module) {
  const target = process.argv[2]
  if (!target || !fs.existsSync(target)) {
    console.error(`[sign] usage: node build/sign.js <file-to-sign>`)
    process.exit(1)
  }
  const exit = signWithSigntool(target)
  process.exit(exit)
}
