/**
 * 文件状态徽章
 *
 * 显示当前笔记文件的同步状态：
 *   - clean      灰（已同步）
 *   - modified   黄（本地有未保存改动）
 *   - conflict   红（本地与磁盘冲突）
 */
import type { FileStateKind } from '../../stores/notes'

interface Props {
  state: FileStateKind
  compact?: boolean
}

const LABEL: Record<FileStateKind, string> = {
  clean: '已同步',
  modified: '未保存',
  conflict: '冲突',
}

const ICON: Record<FileStateKind, string> = {
  clean: '●',
  modified: '◐',
  conflict: '⚠',
}

export function StatusBadge({ state, compact = false }: Props) {
  // R32-A11yPerf-7 修复 (MEDIUM compact-no-aria-label)：compact 模式
  // 下文字标签（<span className="label">）不渲染，只剩单字符 dot。`title`
  // 属性仅在 hover 时被 sighted 用户看到，屏幕阅读器不会主动播报
  // title 属性 → SR 用户拿不到「这是已同步 / 未保存 / 冲突」的状态信息。
  // 修复：compact 时加 aria-label，值与可见 dot 语义对齐。完整标签仍
  // 存在（innerText），aria-label 不会覆盖 innerText —— 这里 compact 模式
  // innerText 只剩 dot 字符，需要 aria-label 兜底。
  const ariaLabel = compact ? `文件状态：${LABEL[state]}` : undefined
  return (
    <span
      className={`status-badge state-${state}${compact ? ' compact' : ''}`}
      title={LABEL[state]}
      aria-label={ariaLabel}
    >
      <span className="dot" aria-hidden>{ICON[state]}</span>
      {!compact && <span className="label">{LABEL[state]}</span>}
    </span>
  )
}

export default StatusBadge
