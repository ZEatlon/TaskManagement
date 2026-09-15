/**
 * 安全（API Key 管理）IPC 处理器
 */
import { handle } from './channels'
import {
  setSecret,
  getSecret,
  deleteSecret,
  isAvailable,
  SECRET_KEYS,
  type SecretKey,
} from '../security/keychain'

/** 允许的 secret key 白名单 —— 防止任意字符串写入 secrets.json / 解密任意键 */
const ALLOWED_SECRET_KEYS: ReadonlySet<string> = new Set(Object.values(SECRET_KEYS))

/**
 * 单个 secret value 的字节上限 —— API key / token 实际都 < 1KB，
 * 4KB 给富余。防止 IPC 层把数百 MB 字符串直接喂给 safeStorage.encryptString，
 * 阻塞主进程（local DoS）。
 */
const MAX_SECRET_VALUE_BYTES = 4 * 1024

function isAllowedKey(key: unknown): key is SecretKey {
  return typeof key === 'string' && ALLOWED_SECRET_KEYS.has(key)
}

export function registerSecurityHandlers(): void {
  handle('security:is-available', async () => isAvailable())

  handle('security:set', async (_e, args: { key: SecretKey; value: string }) => {
    if (!isAllowedKey(args?.key)) {
      throw new Error(`security:set: 不允许的 key '${String(args?.key)}'`)
    }
    if (typeof args?.value !== 'string' || !args.value) {
      throw new Error('security:set: value 必须是非空字符串')
    }
    // 防止被利用的渲染端把超长字符串喂给 safeStorage.encryptString 阻塞主进程
    const bytes = Buffer.byteLength(args.value, 'utf8')
    if (bytes > MAX_SECRET_VALUE_BYTES) {
      throw new Error(
        `security:set: value exceeds ${MAX_SECRET_VALUE_BYTES} byte cap (got ${bytes} bytes)`
      )
    }
    await setSecret(args.key, args.value)
    return { ok: true }
  })

  handle('security:get', async (_e, key: SecretKey) => {
    // 仅返回是否存在，绝不解密并返回明文 —— 渲染端永远不需要看到密钥明文
    if (!isAllowedKey(key)) {
      throw new Error(`security:get: 不允许的 key '${String(key)}'`)
    }
    // R11 修复 (low #5)：原版返回 cipher.length —— 密文长度与明文长度近似相关，
    // 不同 provider 的 API key 长度差异明显（如 OpenAI sk-... 51 字符，
    // Anthropic sk-ant-... 108 字符），渲染端拿到 length 后能间接区分哪个 key
    // 已配置 → 信息泄漏（即使不返回明文）。现在只返回 present 布尔值。
    const cipher = await getSecret(key)
    return cipher ? { present: true } : null
  })

  handle('security:delete', async (_e, key: SecretKey) => {
    if (!isAllowedKey(key)) {
      throw new Error(`security:delete: 不允许的 key '${String(key)}'`)
    }
    await deleteSecret(key)
    return { ok: true }
  })

  handle('security:list-keys', async () => Object.values(SECRET_KEYS))
}