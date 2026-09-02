/**
 * 模型选择器
 *
 * 顶部 select，下拉选择 Provider 和对应模型。
 * 触发 handleSelect，外部 store 拿到后切换 aiOpenaiModel / aiAnthropicModel / aiMinimaxModel 设置。
 */
import { useEffect } from 'react'
import { useAiStore } from '../../stores/ai'

interface Props {
  provider: 'openai' | 'anthropic' | 'minimax' | null
  model: string
  onChangeProvider: (p: 'openai' | 'anthropic' | 'minimax') => void
  onChangeModel: (m: string) => void
}

export function ModelSelector({ provider, model, onChangeProvider, onChangeModel }: Props) {
  const providers = useAiStore((s) => s.providers)
  const loadProviders = useAiStore((s) => s.loadProviders)

  useEffect(() => {
    if (providers.length === 0) loadProviders()
  }, [providers.length, loadProviders])

  const currentProvider = providers.find((p) => p.id === provider)

  return (
    <div className="ai-model-selector">
      <select
        className="ai-select"
        value={provider ?? ''}
        // R12 修复 (medium)：两个 <select> 没有 aria-label，屏幕阅读器只读
        // "combobox, 选择项"，无法区分 provider/model。
        aria-label="模型提供商"
        onChange={(e) =>
          onChangeProvider(e.target.value as 'openai' | 'anthropic' | 'minimax')
        }
      >
        <option value="" disabled>
          选择提供商
        </option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <select
        className="ai-select"
        value={model}
        aria-label="具体模型"
        onChange={(e) => onChangeModel(e.target.value)}
        disabled={!currentProvider}
      >
        {(currentProvider?.models ?? []).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  )
}

export default ModelSelector
