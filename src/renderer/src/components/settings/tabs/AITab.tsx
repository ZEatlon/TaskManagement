/**
 * AI 设置 Tab
 *
 * 字段：AI Provider 选择、API Key 输入（密码框）、模型选择、token 用量统计、测试连接
 *
 * API Key 通过 securityApi 写入系统 keychain，绝不入库；
 * Provider / 模型通过 useSettingsStore 写入 app.settings（与 ChatPanel / 主进程共用同一份 AppSettings）。
 *
 * 注意：旧的 'app.ai' 形状（{ provider, model }）已弃用。仍存在的旧值会在首次加载时一次性迁移到 AppSettings.aiProvider/aiOpenaiModel/aiAnthropicModel/aiMinimaxModel，然后删除 'app.ai'。
 */
import { useEffect, useState } from 'react'
import { securityApi, conversationsApi, settingsApi } from '../../../lib/ipc'
import { useSettingsStore } from '../../../stores/settings'
import { SettingField } from '../SettingField'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/channels'

/** Provider 选项（与 AppSettings['aiProvider'] 保持一致） */
const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'minimax', label: 'MiniMax' },
]

/** 与 AppSettings.aiProvider 严格对齐的类型别名（排除 null） */
type AIProvider = NonNullable<AppSettings['aiProvider']>

/** Provider -> 对应 AppSettings 中的模型字段 */
const PROVIDER_MODEL_FIELD: Record<AIProvider, 'aiOpenaiModel' | 'aiAnthropicModel' | 'aiMinimaxModel'> = {
  openai: 'aiOpenaiModel',
  anthropic: 'aiAnthropicModel',
  minimax: 'aiMinimaxModel',
}

/** Provider -> 对应 AppSettings 中的 baseURL 字段 */
const PROVIDER_BASEURL_FIELD: Record<AIProvider, 'aiOpenaiBaseUrl' | 'aiAnthropicBaseUrl' | 'aiMinimaxBaseUrl'> = {
  openai: 'aiOpenaiBaseUrl',
  anthropic: 'aiAnthropicBaseUrl',
  minimax: 'aiMinimaxBaseUrl',
}

/** 各 Provider 默认 baseURL（仅用于 placeholder 提示，运行时留空走 SDK 默认） */
const PROVIDER_DEFAULT_BASEURL: Record<AIProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  minimax: 'https://api.minimaxi.com/anthropic',
}

/** 各 Provider 对应的模型 */
const MODEL_OPTIONS: Record<AIProvider, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  ],
  anthropic: [
    { value: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
  ],
  minimax: [
    { value: 'MiniMax-M3', label: 'MiniMax-M3（多模态）' },
    { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax-M2.7 Highspeed' },
    { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
    { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
    { value: 'MiniMax-M2.1', label: 'MiniMax-M2.1' },
    { value: 'MiniMax-M2', label: 'MiniMax-M2' },
  ],
}

/** 从 AppSettings 中读取指定 provider 当前模型 */
function pickModel(s: AppSettings, p: AIProvider): string {
  return s[PROVIDER_MODEL_FIELD[p]]
}

export function AITab() {
  const settings = useSettingsStore()
  const updateSettings = useSettingsStore((s) => s.update)
  const loadSettings = useSettingsStore((s) => s.load)
  const settingsLoaded = useSettingsStore((s) => s.loaded)

  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [minimaxKey, setMinimaxKey] = useState('')
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('')
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('')
  const [minimaxBaseUrl, setMinimaxBaseUrl] = useState('')
  const [keychainAvailable, setKeychainAvailable] = useState(true)
  const [tokens, setTokens] = useState<{ input: number; output: number } | null>(null)
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** 启动加载：旧数据迁移 -> settings store 加载 -> keychain 可用性 -> token 统计 */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const available = await securityApi.isAvailable()
        if (!cancelled) setKeychainAvailable(Boolean(available))
      } catch (_) {
        if (!cancelled) setKeychainAvailable(false)
      }
      try {
        // 旧数据迁移：从 'app.ai'（{provider,model}）映射到 AppSettings.aiProvider/aiXxxModel
        // 仅 openai / anthropic / minimax 可迁移；'dual' 不再受支持，丢弃
        const legacy = await settingsApi.get<{ provider?: string; model?: string }>('app.ai')
        if (
          legacy &&
          (legacy.provider === 'openai' || legacy.provider === 'anthropic' || legacy.provider === 'minimax')
        ) {
          const p = legacy.provider as AIProvider
          const field = PROVIDER_MODEL_FIELD[p]
          const model = legacy.model ?? DEFAULT_SETTINGS[field]
          await updateSettings({
            aiProvider: p,
            [field]: model,
            aiEnabled: true,
          } as Partial<AppSettings>)
          await settingsApi.delete('app.ai')
        } else if (!settingsLoaded) {
          // 没有遗留数据，确保 store 加载完成
          await loadSettings()
        }
      } catch (_) {
        // ignore
      }
      try {
        // keychain 中是否已有 key（仅返回布尔意义；不会把值显示给 UI）
        const ok = await securityApi.get('openai.apiKey')
        if (!cancelled) setOpenaiKey(ok ? '••••••••' : '')
        const ak = await securityApi.get('anthropic.apiKey')
        if (!cancelled) setAnthropicKey(ak ? '••••••••' : '')
        const mk = await securityApi.get('minimax.apiKey')
        if (!cancelled) setMinimaxKey(mk ? '••••••••' : '')
      } catch (_) {
        // ignore
      }
      // baseURL 直接从 settings store 读（settings store 已 loadSettings 完成）
      try {
        if (!cancelled) {
          setOpenaiBaseUrl((settings.aiOpenaiBaseUrl ?? '').trim())
          setAnthropicBaseUrl((settings.aiAnthropicBaseUrl ?? '').trim())
          setMinimaxBaseUrl((settings.aiMinimaxBaseUrl ?? '').trim())
        }
      } catch (_) {
        // ignore
      }
      try {
        const total = await conversationsApi.getTotalTokens()
        if (!cancelled) setTokens(total)
      } catch (_) {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
    // 仅在挂载时跑一次；store 方法引用稳定，依赖项保留以避免 lint 误报
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Provider 切换：自动重置为该 Provider 第一个可用模型，并启用 AI */
  async function handleProviderChange(next: string | number | boolean) {
    const nextProvider = String(next) as AIProvider
    const field = PROVIDER_MODEL_FIELD[nextProvider]
    const firstModel = MODEL_OPTIONS[nextProvider]?.[0]?.value ?? DEFAULT_SETTINGS[field]
    await updateSettings({
      aiProvider: nextProvider,
      [field]: firstModel,
      aiEnabled: true,
    } as Partial<AppSettings>)
  }

  /** 模型切换：仅更新当前 Provider 对应的字段 */
  async function handleModelChange(next: string | number | boolean) {
    const provider = settings.aiProvider
    if (!provider) return
    const model = String(next)
    await updateSettings({ [PROVIDER_MODEL_FIELD[provider]]: model } as Partial<AppSettings>)
  }

  /** 保存 OpenAI Key */
  async function saveOpenaiKey() {
    if (!openaiKey || openaiKey.startsWith('••')) return
    await securityApi.set('openai.apiKey', openaiKey)
    setOpenaiKey('••••••••')
  }

  /** 保存 Anthropic Key */
  async function saveAnthropicKey() {
    if (!anthropicKey || anthropicKey.startsWith('••')) return
    await securityApi.set('anthropic.apiKey', anthropicKey)
    setAnthropicKey('••••••••')
  }

  /** 保存 MiniMax Key */
  async function saveMinimaxKey() {
    if (!minimaxKey || minimaxKey.startsWith('••')) return
    await securityApi.set('minimax.apiKey', minimaxKey)
    setMinimaxKey('••••••••')
  }

  /** 通用 baseURL 改动：即时写入 settings store（重启后生效） */
  async function handleBaseUrlChange(
    provider: AIProvider,
    value: string | number | boolean,
  ) {
    const trimmed = String(value)
    const field = PROVIDER_BASEURL_FIELD[provider]
    await updateSettings({ [field]: trimmed } as Partial<AppSettings>)
    // 同步本地 state，避免下次挂载时显示旧值
    if (provider === 'openai') setOpenaiBaseUrl(trimmed)
    if (provider === 'anthropic') setAnthropicBaseUrl(trimmed)
    if (provider === 'minimax') setMinimaxBaseUrl(trimmed)
  }

  /** 测试连接：本地仅校验是否已存有 key */
  async function handleTestConnection() {
    setBusy(true)
    setTestStatus(null)
    try {
      const currentProvider = settings.aiProvider ?? 'openai'
      const keyField: Record<typeof currentProvider, string> = {
        openai: 'openai.apiKey',
        anthropic: 'anthropic.apiKey',
        minimax: 'minimax.apiKey',
      }
      const keyName = keyField[currentProvider] as
        | 'openai.apiKey'
        | 'anthropic.apiKey'
        | 'minimax.apiKey'
      const providerLabel =
        PROVIDER_OPTIONS.find((o) => o.value === currentProvider)?.label ?? currentProvider
      const ok = await securityApi.get(keyName)
      setTestStatus(ok ? `${providerLabel} Key 已配置，可正常使用` : `尚未配置 ${providerLabel} Key`)
    } catch (err) {
      setTestStatus(`失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const provider = settings.aiProvider
  const modelList = provider ? MODEL_OPTIONS[provider] ?? [] : []
  const currentModel = provider ? pickModel(settings, provider) : ''

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">AI</h2>
      <p className="settings-tab-subtitle">Provider、API Key 与用量</p>

      {!keychainAvailable && (
        <div className="settings-warn">系统 keychain 不可用，API Key 将无法加密存储。</div>
      )}

      <SettingField
        label="Provider"
        description="选择默认 AI 服务商"
        type="select"
        value={provider ?? ''}
        onChange={handleProviderChange}
        options={PROVIDER_OPTIONS}
        disabled={!settingsLoaded}
      />

      <SettingField
        label="模型"
        description="对话默认使用的模型"
        type="select"
        value={currentModel}
        onChange={handleModelChange}
        options={modelList}
        disabled={!provider}
      />

      {provider && (
        <SettingField
          label="自定义 baseURL"
          description={`留空则使用默认 (${PROVIDER_DEFAULT_BASEURL[provider]})。可填第三方兼容端点或自部署代理`}
          type="text"
          value={
            provider === 'openai'
              ? openaiBaseUrl
              : provider === 'anthropic'
                ? anthropicBaseUrl
                : minimaxBaseUrl
          }
          onChange={(v) => handleBaseUrlChange(provider, v)}
          placeholder={PROVIDER_DEFAULT_BASEURL[provider]}
        />
      )}

      <SettingField
        label="OpenAI API Key"
        description="通过系统 keychain 加密保存（sk-...）"
        type="password"
        value={openaiKey}
        onChange={(v) => setOpenaiKey(String(v))}
        disabled={!keychainAvailable}
        placeholder="sk-..."
      />
      <div className="settings-actions">
        <button className="btn" onClick={saveOpenaiKey} disabled={!keychainAvailable}>
          保存 OpenAI Key
        </button>
      </div>

      <SettingField
        label="Anthropic API Key"
        description="通过系统 keychain 加密保存（sk-ant-...）"
        type="password"
        value={anthropicKey}
        onChange={(v) => setAnthropicKey(String(v))}
        disabled={!keychainAvailable}
        placeholder="sk-ant-..."
      />
      <div className="settings-actions">
        <button className="btn" onClick={saveAnthropicKey} disabled={!keychainAvailable}>
          保存 Anthropic Key
        </button>
      </div>

      <SettingField
        label="MiniMax API Key"
        description="通过系统 keychain 加密保存（sk-cp-...）。可暂时留空，未配置时不会崩溃"
        type="password"
        value={minimaxKey}
        onChange={(v) => setMinimaxKey(String(v))}
        disabled={!keychainAvailable}
        placeholder="sk-cp-..."
      />
      <div className="settings-actions">
        <button className="btn" onClick={saveMinimaxKey} disabled={!keychainAvailable}>
          保存 MiniMax Key
        </button>
      </div>

      <div className="settings-stats">
        <div className="stat-card">
          <div className="stat-label">总输入 token</div>
          <div className="stat-value">{tokens?.input ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">总输出 token</div>
          <div className="stat-value">{tokens?.output ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">合计</div>
          <div className="stat-value">
            {tokens ? tokens.input + tokens.output : 0}
          </div>
        </div>
      </div>

      <div className="settings-actions">
        <button className="btn primary" onClick={handleTestConnection} disabled={busy}>
          {busy ? '检测中…' : '测试连接'}
        </button>
        {testStatus && <span className="settings-info-inline">{testStatus}</span>}
      </div>
    </div>
  )
}
