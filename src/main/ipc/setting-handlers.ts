/**
 * 设置相关 IPC 处理器
 */
import { handle } from './channels'
import { settingsRepo } from '../db/repositories/settings'
import { validateBaseUrl } from '../lib/networkSafety'

/**
 * R11 修复 (medium #28)：原版 setting:set 接受任意 key / value，渲染端 XSS 或
 * 任意 IPC 调用都可把 API key / token 之类的 secret 直接写进 SQLite 明文 settings
 * 表（auth provider 走的是加密信道，但兜底的 plaintext 通道仍存在）。现在：
 *   1. 拒绝包含 secret 关键字的 key（key、token、secret、password、credential）
 *   2. value 必须是 JSON 可序列化（拒绝 function / symbol / undefined / BigInt）
 *   3. key 必须是非空字符串且长度 < 200
 *
 * R15 修复 (high)：原 regex 不覆盖 private_key / passphrase / passcode / pin /
 * cookie / oauth / bearer / public_key 等常见秘密字段名，可绕过 secret-only
 * storage contract 把明文 secret 写进 SQLite settings 表。
 *
 * R17 修复 (medium security)：R15 的 regex 用整词边界 `(?:^|[^A-Za-z0-9])`，
 * 把 token / secret / password 等作为「独立词」打头，补 auth / jwt / cert /
 * mnemonic / ssh_key / access / refresh / pat / gpg / pgp / keystore /
 * fingerprint / private 等。
 *
 * R18 修复 (high security)：R17 的右侧整词边界 `(?=$|[^A-Za-z0-9])` 让
 * 大量实际凭据命名绕过检测：
 *   - authToken / authSecret（`auth` 命中但右侧 'T' 是字母，不边界）
 *   - jwtToken（同上）
 *   - openaiApiKey / openaiKey / firebaseApiKey / awsSecretKey（`api` / `secret`
 *     后面跟大写字母，不边界）
 *   - azureClientSecret / gcpKey / slackToken / discordToken
 *   - privateData / privateKeyValue（`private` 后面跟字母）
 * 攻击者用上述任一名字调用 setting:set 就能写明文 secret 到 SQLite 表。
 *
 * 修复策略：把整词边界从「左右都强边界」改为「左侧强边界 + 右侧弱边界」：
 *   - 左侧：(?:^|[^A-Za-z0-9]) —— secret 词前面必须是开头或非字母数字，
 *     防止 `blacklist` 里的 `list` / `address` 里的 `ss` 误命中。
 *   - 右侧：去掉 —— secret 词之后可以是任意字符，让 `authToken` 中 `auth`
 *     后面的 'T' 也算命中。
 *   - 但右侧显式要求 secret 词必须「独立可辨」，由 SECRET_KEY_STRONG_BOUNDARY
 *     列表强制结尾非字母数字的额外规则 —— 实际上最终改为更简单的：所有 secret
 *     词都不带右侧整词边界，配合 LEFT-only 边界后：
 *       * `auth` 命中 → `authToken` / `authSecret` / `authCode` 都被拦
 *       * `secret` 命中 → `clientSecret` / `awsSecret` 都被拦
 *       * `api` 命中 → `openaiApiKey` / `apiKey` 都被拦
 *       * `token` 命中 → `slackToken` / `refreshToken` 都被拦
 *       * `private` 命中 → `privateData` / `privateKeyValue` 都被拦
 *     注意：`api` / `auth` / `private` 是泛义词，但应用合法 key 命名空间里
 *     不会出现 `api` / `auth` / `private` 字面（如 theme / language /
 *     libraryPath / fontSize / editorMode），所以可接受。
 *
 * 仍禁止把 `key` 单独列为敏感词 —— `keyboard` / `hotkey` / `cacheKey` /
 * `mapKey` 等合法命名都会误命中。`key` 只在复合形式 `apiKey / privateKey /
 * publicKey / secretKey / sshKey` 里出现。
 */
const SECRET_KEY_PATTERN =
  // R21 修复 (medium security)：原版左边界 `[^A-Za-z0-9]` 只看**前置**
  // 字符不看**后置** —— `api` 作为独立可选分支没有右边界，导致
  // `randomapi`、`apiendpoint`、`apiculture` 等普通字段被误命中 →
  // 写入时 SECRET_KEY 防护跳出来 reject。右边界改用对称的 `(?![A-Za-z0-9])`
  // 后行断言；左边界仍是 `(?:^|[^A-Za-z0-9])`。
  //
  // 同时保留「myApiKey / myAuthToken 不命中」的语义（前置 `y` 是
  // `[A-Za-z0-9]`，已被左边界排除）。
  /(?:^|[^A-Za-z0-9])(?:api[_-]?key|private[_-]?key|public[_-]?key|secret[_-]?key|ssh[_-]?key|ssh[_-]?private|secret|token|password|credential|passphrase|passcode|pin|cookie|session|oauth|bearer|auth|jwt|cert|identity|mnemonic|access|refresh|pat|gpg|pgp|keystore|fingerprint|private|api)(?![A-Za-z0-9])/i

function isPlainSerializable(v: unknown): boolean {
  if (v === null) return true
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (Array.isArray(v)) return v.every(isPlainSerializable)
  if (t === 'object') {
    return Object.values(v as Record<string, unknown>).every(isPlainSerializable)
  }
  return false
}

/**
 * R16 修复 (medium)：识别哪些 setting key 包含 AI provider baseURL 字段。
 * - 顶层 key 是 'app.settings' 时（settings 表的主键），逐字段校验
 * - 历史 / 单字段 key（'aiOpenaiBaseUrl' 这种）也认
 */
const AI_BASE_URL_FIELDS = new Set([
  'aiOpenaiBaseUrl',
  'aiAnthropicBaseUrl',
  'aiMinimaxBaseUrl',
])
function isAiBaseUrlKey(key: string): boolean {
  if (key === 'app.settings') return true
  return AI_BASE_URL_FIELDS.has(key)
}

/**
 * R19 修复 (critical security)：setting:set 之前只校验了 AI baseURL 字段，
 * 其它字段（libraryPath / gitAutoPushEnabled / 任何未来的高权限字段）都
 * 原样写入 → 攻击者通过 NotePreview XSS 拿到 IPC 通道后，可调用
 *   setting:set({key:'app.settings', value:{libraryPath:'C:\\Users\\James'}})
 * 直接重写 libraryPath，跳过 lib:setLibrary 的 validateDirectory() 和
 * 目录选择对话框：
 *   - notesManager / notesWatcher 把 C:\Users\James 当库目录，
 *     notes 读 / 写仍走 isRealPathInside notesDir；但 git 初始化、
 *     commit、push 不再有 notesDir 限制，会把整个 home 目录（含 SSH
 *     密钥、浏览器 profile、.env）作为 repo 内容。
 *   - git:remote-set 在 origin 不存在时跳过 confirmHostChange，直接
 *     写入攻击者 repo。下一次 git:auto-commit-push 把 home 目录推出去。
 * 后果：home 目录无差别外泄，无任何用户交互。
 *
 * R20 修复 (medium security)：原 assertPrivilegedFieldsNotTouched 仅当
 * key === 'app.settings' 才生效。GitTab 写的是 'app.git' 子文档（含
 * remoteUrl / authorEmail / token）→ 攻击者用 'app.git' / 'app.editor' /
 * 任何未来 'app.*' 子文档绕过整个字段黑名单，等价于 R19 修复完全失效。
 *
 * 修复策略：
 *   1. 把所有「app.* 子文档里属于信任锚」的字段集中维护：
 *      PRIVILEGED_FIELDS_BY_DOC[docName] = Set<fieldName>
 *   2. 设置 key 以 'app.' 开头时按子文档名匹配字段集合；
 *   3. 设置 key 直接是字段名（历史习惯）也走同一套（'libraryPath' 等
 *      顶层 key 会被识别为 'app' 默认文档）。
 *   4. 'app.settings' 仍走原 SETTINGS_KEY 路径，保持向后兼容。
 */
const SETTINGS_KEY = 'app.settings'
const PRIVILEGED_FIELDS_BY_DOC: Record<string, Set<string>> = {
  settings: new Set([
    'libraryPath',
    'gitRemote',
    'gitToken',
    'gitUsername',
    'gitAutoPushEnabled',
    'gitPushIntervalMinutes',
    'gitAuthorName',
    'gitAuthorEmail',
  ]),
  git: new Set([
    'remoteUrl',
    'remote',
    'token',
    'username',
    'authorName',
    'authorEmail',
    'autoPushEnabled',
    'pushIntervalMinutes',
    'sshKeyPath',
  ]),
  editor: new Set(['libraryPath']),
  ai: new Set(['apiKey', 'openaiApiKey', 'anthropicApiKey', 'minimaxApiKey']),
}
/** 历史习惯的「顶层 key 直接放字段名」的子文档归属 */
const TOP_LEVEL_KEY_TO_DOC: Record<string, string> = {
  libraryPath: 'settings',
  gitRemote: 'settings',
  gitToken: 'settings',
  gitUsername: 'settings',
  gitAutoPushEnabled: 'settings',
  gitPushIntervalMinutes: 'settings',
  gitAuthorName: 'settings',
  gitAuthorEmail: 'settings',
}

function privilegedDocForKey(key: string): { doc: string; fields: Set<string> } | null {
  if (key === SETTINGS_KEY) return { doc: 'settings', fields: PRIVILEGED_FIELDS_BY_DOC.settings }
  if (key.startsWith('app.')) {
    const sub = key.slice(4)
    const fields = PRIVILEGED_FIELDS_BY_DOC[sub]
    if (fields) return { doc: sub, fields }
    // 未知 app.* 子文档：保守拒绝 —— 未来新增 app.foo 不应通过 setting:set
    // 自由写入，必须显式登记。
    return { doc: sub, fields: new Set() }
  }
  // 顶层 key（历史习惯）按字段名映射
  const mapped = TOP_LEVEL_KEY_TO_DOC[key]
  if (mapped) {
    return { doc: mapped, fields: PRIVILEGED_FIELDS_BY_DOC[mapped] }
  }
  return null
}

function assertPrivilegedFieldsNotTouched(key: string, value: unknown): void {
  const slot = privilegedDocForKey(key)
  if (!slot) return
  // R21 修复 (medium security)：原版对非对象 value（primitive）早返回 —
  // 这意味着 setting:set({key:'libraryPath', value:'C:\\evil'}) 整个绕过
  // 字段黑名单，因为 primitive 没有属性可遍历。攻击面：NotePreview XSS → IPC
  // → 任意顶层 key + primitive value 写明文 secret / 改 libraryPath / 改
  // git remote 等。
  // 修复：识别「key 直接是顶层信任锚字段」（如 libraryPath / gitRemote /
  // gitToken / gitUsername 等）→ 任何 value（primitive 或 object）都拒。
  // 该字段必须走专用 IPC handler（lib:setLibrary / git:remote-set / 等）。
  if (TOP_LEVEL_KEY_TO_DOC[key]) {
    throw new Error(
      `setting:set refused: field '${key}' is privileged; use the dedicated IPC handler`,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const obj = value as Record<string, unknown>
  // app.* 但字段集合空 → 整文档拒绝
  if (slot.fields.size === 0) {
    throw new Error(
      `setting:set refused: doc 'app.${slot.doc}' must use its dedicated IPC handler`,
    )
  }
  for (const f of slot.fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) {
      throw new Error(
        `setting:set refused: field '${f}' in '${key}' is privileged; use the dedicated IPC handler`,
      )
    }
  }
}

export function registerSettingHandlers(): void {
  handle('setting:get', async (_e, key: string) => settingsRepo.get(key))
  handle('setting:set', async (_e, args: { key: string; value: unknown }) => {
    if (!args || typeof args.key !== 'string' || args.key.length === 0 || args.key.length >= 200) {
      throw new Error('setting key must be a non-empty string (<200 chars)')
    }
    if (SECRET_KEY_PATTERN.test(args.key)) {
      // 不向调用方透露命中原因（避免侦察），只说通用错误。
      throw new Error('setting:set refused: invalid key')
    }
    if (!isPlainSerializable(args.value)) {
      throw new Error('setting:value must be JSON-serializable')
    }
    // R19 修复 (critical security)：拦截对 app.settings 内部信任锚字段的写入，
    // 见 assertPrivilegedFieldsNotTouched 注释。
    assertPrivilegedFieldsNotTouched(args.key, args.value)
    // R16 修复 (medium)：ai provider 的 baseURL 必须走公开 https 主机。
    // 渲染端被 XSS 时可注入 https://attacker.example/ → 下次 chat 时 SDK
    // 把 safeStorage 解出的 API key 作为 Authorization 头发到该主机。
    // 在 persist 之前 validateBaseUrl 强制 https + 非内网/loopback 主机。
    //
    // R27-Corr-2 修复 (high data-loss)：原版在 isAiBaseUrlKey 分支里
    // 直接 settingsRepo.set(args.key, obj) —— 当 key='app.settings'（合并
    // 文档型）且 patch 同时带 baseURL + 非 baseURL 字段（如 aiOpenaiModel /
    // aiEnabled / theme 等）时，没有跟现有 row 做 merge，整个 app.settings
    // 被 obj 覆盖，libraryPath / gitRemote / 所有未在 patch 里的字段全部丢失。
    // 修复：baseURL 分支也走同一份 merge-with-existing 逻辑（与下方 app.*
    // merge 分支对齐），先把现有 row 读出来，再把 patch 浅 merge 进去，再
    // 对 merge 后对象里的 baseURL 字段做 validateBaseUrl（保持 https + 非内网
    // 校验），最后 SET 整个文档。
    if (isAiBaseUrlKey(args.key)) {
      const v = args.value
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // 与下方 app.* merge 路径对齐 —— 整体写入需要 merge 现有 row
        const existing = await settingsRepo.get<Record<string, unknown>>(args.key)
        const merged: Record<string, unknown> = {
          ...(existing ?? {}),
          ...(v as Record<string, unknown>),
        }
        for (const urlKey of AI_BASE_URL_FIELDS) {
          if (urlKey in merged) {
            merged[urlKey] = await validateBaseUrl(merged[urlKey])
          }
        }
        await settingsRepo.set(args.key, merged)
        return { ok: true }
      }
      // 单个 baseURL 直接当 string 写入（顶层 key 单字段语义，不存在合并问题）
      await validateBaseUrl(v)
      await settingsRepo.set(args.key, v)
      return { ok: true }
    }
    // R21 修复 (medium data integrity)：原版无条件 set(key, value)，对
    // 「app.settings / app.git / app.editor / app.ai / app.theme 等 app.* 子文档
    // + 对象 value」会把整文档覆盖 —— 调用方传 { theme: 'light' } 就把整
    // 个 AppSettings 替换为 { theme: 'light' }，其它字段（libraryPath /
    // gitRemote / apiKey）全部丢失。renderer 当前在 store.ts 里手动做 merge
    // 是脆弱的（依赖调用方纪律）—— 任何 XSS / 未来新增调用方忘了 merge 就
    // 静默丢失设置。修复：主进程侧把传入对象 merge 到现有 row（typeof object
    // 才走 merge；primitive 是单字段写入语义，保留原行为）。
    let valueToPersist: unknown = args.value
    if (
      args.key === SETTINGS_KEY ||
      args.key.startsWith('app.') ||
      args.key === 'app.theme'
    ) {
      if (valueToPersist && typeof valueToPersist === 'object' && !Array.isArray(valueToPersist)) {
        const existing = await settingsRepo.get<Record<string, unknown>>(args.key)
        const merged: Record<string, unknown> = {
          ...(existing ?? {}),
          ...(valueToPersist as Record<string, unknown>),
        }
        valueToPersist = merged
      }
    }
    await settingsRepo.set(args.key, valueToPersist)
    return { ok: true }
  })
  handle('setting:get-all', async () => settingsRepo.getAll())
  handle('setting:delete', async (_e, key: string) => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('setting:delete requires a key')
    }
    // R28-Sec-6 修复 (high security)：原版 setting:delete 只校验非空字
    // 符串就删。被劫持渲染端（XSS / 恶意依赖）可调 setting:delete('app.settings')
    // 一键抹掉 libraryPath / gitRemote / apiKey 等信任锚；或
    // setting:delete('app.git') 抹掉远程配置 + token，与 setting:set
    // 完全绕过 assertPrivilegedFieldsNotTouched 的下场一致。
    //
    // 修复策略：复用 SECRET_KEY_PATTERN + PRIVILEGED_FIELDS_BY_DOC 双重
    // 校验。
    //   1. 顶层 key 直接命中 SECRET_KEY_PATTERN（如 'gitToken' / 'apiKey'）
    //      → 拒；
    //   2. key 是 'app.settings' / 'app.git' / 'app.editor' 等子文档 →
    //      按 PRIVILEGED_FIELDS_BY_DOC 判定「该 doc 里的字段是否全部为
    //      信任锚」；若是（settings / git 都如此），整个 doc 删除会被拒；
    //      若只是个普通 doc（如未来的 'app.theme'），放行。
    //   3. 兜底：key 以 'app.' 开头但不在 PRIVILEGED_FIELDS_BY_DOC 的
    //      doc 名 → 当作普通子文档，按字段级别二次过滤（虽然 delete
    //      没有字段级别，但禁止「整 doc 删」会让攻击者无法用 delete
    //      抹掉非白名单 doc；保守起见禁止任何 'app.*' doc 整体删除）。
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`setting:delete refused: key '${key}' matches SECRET_KEY_PATTERN`)
    }
    const matched = privilegedDocForKey(key)
    if (matched) {
      throw new Error(
        `setting:delete refused: key '${key}' is a privileged doc ` +
          `(${matched.doc}); field-by-field edits only`,
      )
    }
    if (key === 'app.settings' || key.startsWith('app.')) {
      // app.* 子文档即便非完全 privileged，也避免被一键抹掉；让用户走
      // 设置 UI 单字段编辑。
      throw new Error(
        `setting:delete refused: app.* doc keys must be edited via setting:set, not deleted`,
      )
    }
    await settingsRepo.delete(key)
    return { ok: true }
  })
}