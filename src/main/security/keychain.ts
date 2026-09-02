/**
 * API Key 安全存储
 *
 * 使用 Electron safeStorage API（Windows DPAPI / macOS Keychain / Linux libsecret）
 * 加密后存入 electron-store（明文仅文件名含明文存储于用户数据目录）
 */
import { safeStorage } from 'electron'
import log from '../log'

interface EncryptedSecret {
  /** 加密后的 base64 字符串 */
  cipher: string
  /** 平台/算法标识 */
  algo: 'safeStorage-v1'
}

const STORE_FILE = 'secrets.json'

/**
 * 使用 lazy import 避免循环依赖
 */
async function getStore(): Promise<{
  get: (k: string) => unknown
  set: (k: string, v: unknown) => void
  delete: (k: string) => void
}> {
  const Store = (await import('electron-store')).default
  // 注：数据已通过 safeStorage (DPAPI/Keychain/libsecret) 加密，
  // 不再在 electron-store 层重复加密；这也避免了对 32 字节 AES 密钥的硬编码。
  // electron-store v10 的 get/set/delete 类型签名变化较大，这里用 untyped 引用桥接
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any = new Store({ name: STORE_FILE })
  return {
    get: (k) => store.get(k),
    set: (k, v) => {
      store.set(k, v)
    },
    delete: (k) => {
      store.delete(k)
    },
  }
}

/** 是否可用（safeStorage 在某些 Linux 环境可能不可用） */
export function isAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** 加密并存入 */
export async function setSecret(key: string, plaintext: string): Promise<void> {
  if (!isAvailable()) {
    throw new Error('safeStorage not available on this system')
  }
  const cipher = safeStorage.encryptString(plaintext).toString('base64')
  const payload: EncryptedSecret = { cipher, algo: 'safeStorage-v1' }
  const store = await getStore()
  store.set(key, payload)
  log.info(`[security] secret '${key}' stored`)
}

/** 取出并解密 */
export async function getSecret(key: string): Promise<string | null> {
  const store = await getStore()
  const raw = store.get(key) as EncryptedSecret | undefined
  if (!raw) return null
  if (raw.algo !== 'safeStorage-v1') return null
  try {
    const buf = Buffer.from(raw.cipher, 'base64')
    return safeStorage.decryptString(buf)
  } catch (err) {
    log.warn(`[security] failed to decrypt '${key}': ${err}`)
    // 清掉被 OS keyring 状态变更破坏的槽位，避免后续读取持续失败
    store.delete(key)
    return null
  }
}

export async function deleteSecret(key: string): Promise<void> {
  const store = await getStore()
  store.delete(key)
}

/** 已知密钥集合 */
export const SECRET_KEYS = {
  OPENAI_API_KEY: 'openai.apiKey',
  ANTHROPIC_API_KEY: 'anthropic.apiKey',
  MINIMAX_API_KEY: 'minimax.apiKey',
  GIT_TOKEN: 'git.token',
} as const

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS]