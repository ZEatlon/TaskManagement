/**
 * AI 聊天面板
 *
 * 三段式布局：
 *   - 左侧：对话历史 (ConversationList)
 *   - 中部：消息流 (MessageList) + 输入框 (MessageInput)
 *   - 顶栏：模型选择器 + Token 用量
 */
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAiStore } from '../../stores/ai'
import { useSettingsStore } from '../../stores/settings'
import { ConversationList } from './ConversationList'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { ModelSelector } from './ModelSelector'
import { TokenUsage } from './TokenUsage'
import { ToolConfirmDialog } from './ToolConfirmDialog'
import { aiApi, settingsApi } from '../../lib/ipc'
import { announce } from '../common/AriaAnnouncer'

export function ChatPanel() {
  const providers = useAiStore((s) => s.providers)
  const loadProviders = useAiStore((s) => s.loadProviders)
  const providersLoaded = providers.length > 0

  const settings = useSettingsStore(
    useShallow((s) => ({
      aiProvider: s.aiProvider,
      aiOpenaiModel: s.aiOpenaiModel,
      aiAnthropicModel: s.aiAnthropicModel,
      aiMinimaxModel: s.aiMinimaxModel,
      update: s.update,
    })),
  )
  const tokenInput = useAiStore((s) => s.tokenInput)
  const tokenOutput = useAiStore((s) => s.tokenOutput)
  const currentId = useAiStore((s) => s.currentId)
  const newConv = useAiStore((s) => s.newConversation)
  const error = useAiStore((s) => s.error)
  const streaming = useAiStore((s) => s.streaming)
  // R13 修复 (high)：之前 stores/ai.ts 写入 pendingConfirm 后没有任何 UI
  // 组件订阅，导致 acceptPendingConfirm/dismissPendingConfirm 永远不会被
  // 调用 —— 30s 超时 → 主进程告诉 LLM 用户拒绝 → 所有 destructive AI 工具
  // 失效。这里订阅并渲染确认对话框。
  const pendingConfirm = useAiStore((s) => s.pendingConfirm)
  const acceptPendingConfirm = useAiStore((s) => s.acceptPendingConfirm)
  const dismissPendingConfirm = useAiStore((s) => s.dismissPendingConfirm)

  /** 旧版 app.ai 中的 provider/model，作为兼容来源（AITab 写入）。
   *  R37-fix #M4：'dual' provider 在 0.x 早期版本用过，迁移到 AppSettings
   *  时已统一丢弃（只有 openai / anthropic 能落到 aiProvider 字段）。
   *  这里的 legacy 仅作为"读旧 key 的兜底来源"——如果旧值是 'dual'，
   *  不该让本地 state 收到它。类型从联合中移除 'dual'。 */
  const [legacy, setLegacy] = useState<{
    provider: 'openai' | 'anthropic' | null
    model: string | null
  }>({ provider: null, model: null })

  // 首次加载 Provider 列表
  useEffect(() => {
    if (!providersLoaded) loadProviders()
  }, [providersLoaded, loadProviders])

  // 尝试同步 app.ai 旧配置：仅当 useSettingsStore 中 aiProvider 未设置时填充
  useEffect(() => {
    if (settings.aiProvider) return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await settingsApi.get<{
          provider?: 'openai' | 'anthropic'
          model?: string
        } | null>('app.ai')
        if (cancelled || !raw) return
        const p: 'openai' | 'anthropic' =
          raw.provider === 'anthropic' ? 'anthropic' : 'openai'
        setLegacy({ provider: raw.provider ?? null, model: raw.model ?? null })
        if (raw.model) {
          await settings.update({
            aiProvider: p,
            aiEnabled: true,
            [p === 'openai' ? 'aiOpenaiModel' : 'aiAnthropicModel']: raw.model,
          })
        } else {
          await settings.update({ aiProvider: p, aiEnabled: true })
        }
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
    // R6R-5：去掉 settings 整体 deps —— useShallow 让 settings 引用随任一字段变化，
    // 加进 deps 会让用户在切 model 时也触发这次 legacy 同步 IPC。Zustand actions 稳定。
  }, [settings.aiProvider, setLegacy])

  // 派生实际 provider / model：useSettingsStore 优先，否则用 legacy
  const effectiveProvider: 'openai' | 'anthropic' | 'minimax' | null =
    settings.aiProvider ??
    (legacy.provider === 'anthropic'
      ? 'anthropic'
      : legacy.provider === 'openai'
        ? 'openai'
        : null)
  const effectiveModel =
    effectiveProvider === 'openai'
      ? settings.aiOpenaiModel || legacy.model || 'gpt-4o-mini'
      : effectiveProvider === 'anthropic'
        ? settings.aiAnthropicModel || legacy.model || 'claude-3-5-sonnet-latest'
        : effectiveProvider === 'minimax'
          ? settings.aiMinimaxModel || 'MiniMax-M3'
          : ''

  const onNew = async () => {
    const provider = effectiveProvider ?? 'openai'
    const model = effectiveModel
    await newConv(provider, model)
  }

  const onChangeProvider = async (p: 'openai' | 'anthropic' | 'minimax') => {
    // R15 修复 (high)：原版同时写 aiOpenaiModel / aiAnthropicModel / aiMinimaxModel
    // 三个字段，每次切换 provider 都会把另两个 provider 的 model 重置成 models[0]，
    // 切回去之后用户原本选的 model 全没了。改为只更新选中 provider 的 model 字段。
    const newModel =
      providers.find((x) => x.id === p)?.models[0] ??
      (p === 'openai'
        ? settings.aiOpenaiModel
        : p === 'anthropic'
          ? settings.aiAnthropicModel
          : settings.aiMinimaxModel)
    const patch: Record<string, string | boolean> = { aiProvider: p, aiEnabled: true }
    if (p === 'openai') patch['aiOpenaiModel'] = newModel
    else if (p === 'anthropic') patch['aiAnthropicModel'] = newModel
    else patch['aiMinimaxModel'] = newModel
    await settings.update(patch)
    // 同步写一份到旧 key 兼容 AITab 的读取
    await settingsApi.set('app.ai', { provider: p, model: newModel })
  }

  const onChangeModel = async (m: string) => {
    if (effectiveProvider === 'openai') {
      await settings.update({ aiOpenaiModel: m })
    } else if (effectiveProvider === 'anthropic') {
      await settings.update({ aiAnthropicModel: m })
    } else if (effectiveProvider === 'minimax') {
      await settings.update({ aiMinimaxModel: m })
    }
    // 同步写旧 key
    await settingsApi.set('app.ai', { provider: effectiveProvider, model: m })
  }

  const onTest = async () => {
    const p = effectiveProvider
    // R12 修复 (high)：原版用 window.alert() 弹原生对话框，screen reader 无法
    // 通过 AriaAnnouncer 朗读，且打断用户当前操作。改用 announce() 走全局 live
    // region，失败用 assertive 通道、成功用 polite。
    if (!p) {
      announce('请先选择 Provider', 'assertive')
      return
    }
    // 把当前选中的模型也传过去，让后端真正用「用户选的模型」做 ping
    // （修复：之前 minimax/anthropic 硬编码 fallback 模型，导致提示的模型名与选择不一致）
    const res = await aiApi.testConnection(p, effectiveModel || undefined)
    if (res.ok) {
      announce(`连接成功：${res.message ?? ''}`, 'polite')
    } else {
      announce(`连接失败：${res.message ?? ''}`, 'assertive')
    }
  }

  return (
    <div className="ai-chat-panel">
      <ConversationList onNew={onNew} />

      <section className="ai-chat-main">
        <header className="ai-chat-topbar">
          <ModelSelector
            provider={effectiveProvider}
            model={effectiveModel}
            onChangeProvider={onChangeProvider}
            onChangeModel={onChangeModel}
          />
          <div className="ai-chat-topbar-right">
            <button className="btn ghost ai-test-btn" onClick={onTest} disabled={!effectiveProvider}>
              测试连接
            </button>
            <TokenUsage input={tokenInput} output={tokenOutput} />
          </div>
        </header>

        {error && <div className="ai-error-bar" role="alert" aria-live="assertive" aria-atomic="true">⚠ {error}</div>}

        <div className="ai-chat-content">
          <MessageList />
        </div>

        <footer className="ai-chat-footer">
          <MessageInput disabled={!currentId || streaming === undefined} />
        </footer>
      </section>

      {pendingConfirm && (
        <ToolConfirmDialog
          pending={pendingConfirm}
          onAccept={() => void acceptPendingConfirm()}
          onDismiss={dismissPendingConfirm}
        />
      )}
    </div>
  )
}

export default ChatPanel
