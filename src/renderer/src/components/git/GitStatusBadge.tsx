/**
 * Git 同步状态徽章
 *
 * 行为：
 *   - 显示当前同步状态（4 种 + 未配置）
 *   - 点击展开操作菜单：拉取 / 推送 / 查看日志 / 初始化
 *
 * 状态判定优先级：
 *   1. 未配置库目录或非 Git 仓库 → 未配置
 *   2. 离线（最近一次操作失败） → 离线
 *   3. 同步中 → 同步中
 *   4. 有 ahead 提交（待推送） → 未推送(N)
 *   5. 有 behind 提交（待拉取） → 待拉取
 *   6. 默认 → 已同步 ✓
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useGitStore, selectLastSyncRelative, computeOnline } from '../../stores/git'
import type { GitStatusInfo, GitSyncPhase } from '@shared/ipc/channels'

interface Props {
  /** 是否显示文字（默认 true）；false 时只显示图标 */
  showLabel?: boolean
  /** 自定义 className */
  className?: string
}

type BadgeState =
  | 'unconfigured'
  | 'offline'
  | 'syncing'
  | 'unpushed'
  | 'behind'
  | 'synced'
  | 'dirty'

/** 状态对应的元信息（颜色 / 图标 / 标题） */
const STATE_META: Record<
  BadgeState,
  { label: string; color: string; icon: string; title: string }
> = {
  unconfigured: {
    label: 'Git 未配置',
    color: 'var(--text-muted)',
    icon: '○',
    title: '尚未初始化 Git 仓库或未配置远程地址',
  },
  offline: {
    label: '离线',
    color: 'var(--danger)',
    icon: '⚠',
    title: '最近一次同步失败（网络错误）',
  },
  syncing: {
    label: '同步中…',
    color: 'var(--accent)',
    icon: '↻',
    title: '正在与远端同步',
  },
  unpushed: {
    label: '未推送',
    color: 'var(--warning)',
    icon: '↑',
    title: '本地有提交待推送',
  },
  behind: {
    label: '待拉取',
    color: 'var(--accent)',
    icon: '↓',
    title: '远端有更新可拉取',
  },
  synced: {
    label: '已同步',
    color: 'var(--success)',
    icon: '✓',
    title: '与远端一致',
  },
  dirty: {
    label: '有变更',
    color: 'var(--warning)',
    icon: '•',
    title: '工作区有未提交变更',
  },
}

/** 根据当前状态计算展示状态 */
function deriveBadgeState(
  isRepo: boolean,
  status: GitStatusInfo | null,
  phase: GitSyncPhase,
  online: boolean,
  lastError: string | null,
): BadgeState {
  if (!isRepo) return 'unconfigured'
  if (!online) return 'offline'
  if (phase !== 'idle') return 'syncing'
  if (!status) return 'unconfigured'
  if (!status.hasRemote) return 'unconfigured'
  if (status.ahead > 0) return 'unpushed'
  if (status.behind > 0) return 'behind'
  if (status.modified.length > 0 || status.untracked.length > 0) return 'dirty'
  if (lastError) return 'offline'
  return 'synced'
}

export function GitStatusBadge({ showLabel = true, className }: Props) {
  const phase = useGitStore((s) => s.phase)
  const isRepo = useGitStore((s) => s.isRepo)
  const status = useGitStore((s) => s.status)
  const lastError = useGitStore((s) => s.lastError)
  const lastSyncAt = useGitStore((s) => s.lastSyncAt)
  const init = useGitStore((s) => s.init)
  const refresh = useGitStore((s) => s.refresh)
  const pull = useGitStore((s) => s.pull)
  const pushAction = useGitStore((s) => s.push)
  const syncNow = useGitStore((s) => s.syncNow)
  const initRepo = useGitStore((s) => s.initRepo)

  const [menuOpen, setMenuOpen] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showSyncDialog, setShowSyncDialog] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 初始化：注册主进程事件 + 拉取初始状态
  useEffect(() => {
    void init()
  }, [init])

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const online = useMemo(() => {
    const s = { lastSyncAt, lastError }
    return computeOnline(s)
  }, [lastSyncAt, lastError])

  const state = useMemo(
    () => deriveBadgeState(isRepo, status, phase, online, lastError),
    [isRepo, status, phase, online, lastError],
  )

  const meta = STATE_META[state]
  const lastSyncLabel = useGitStore((s) => selectLastSyncRelative(s))

  const handleAction = async (fn: () => Promise<unknown>) => {
    setMenuOpen(false)
    try {
      await fn()
    } catch (err) {
      console.error('[git-badge] action failed', err)
    }
  }

  return (
    <div className={`git-status-badge-wrap ${className ?? ''}`} ref={menuRef}>
      <button
        className={`git-status-badge state-${state}`}
        onClick={() => setMenuOpen((v) => !v)}
        title={meta.title}
        style={{ color: meta.color }}
      >
        <span className={`git-icon ${state === 'syncing' ? 'spin' : ''}`}>{meta.icon}</span>
        {showLabel && (
          <span className="git-label">
            {state === 'unpushed' && status
              ? `未推送 (${status.ahead})`
              : state === 'behind' && status
                ? `待拉取 (${status.behind})`
                : meta.label}
          </span>
        )}
      </button>

      {menuOpen && (
        <div className="git-menu">
          <div className="git-menu-info">
            {lastSyncAt && <div className="muted">上次同步：{lastSyncLabel}</div>}
            {lastError && <div className="git-menu-error">{lastError}</div>}
            {status && (
              <div className="muted" style={{ marginTop: 4 }}>
                ahead={status.ahead} · behind={status.behind} · modified={status.modified.length} · untracked={status.untracked.length}
              </div>
            )}
          </div>

          <div className="git-menu-actions">
            {!isRepo && (
              <button className="git-menu-item" onClick={() => handleAction(initRepo)}>
                <span>📁</span> 初始化仓库
              </button>
            )}
            <button
              className="git-menu-item"
              onClick={() => handleAction(refresh)}
              disabled={!isRepo}
            >
              <span>↻</span> 刷新状态
            </button>
            <button
              className="git-menu-item"
              onClick={() => handleAction(pull)}
              disabled={!isRepo || !status?.hasRemote}
            >
              <span>↓</span> 拉取远端
            </button>
            <button
              className="git-menu-item"
              onClick={() => handleAction(pushAction)}
              disabled={!isRepo || !status?.hasRemote || (status?.ahead ?? 0) === 0}
            >
              <span>↑</span> 推送本地
            </button>
            <button
              className="git-menu-item primary"
              onClick={() => {
                setMenuOpen(false)
                setShowSyncDialog(true)
              }}
              disabled={!isRepo}
            >
              <span>⟳</span> 同步（提交+推送）
            </button>
            <button
              className="git-menu-item"
              onClick={() => {
                setMenuOpen(false)
                setShowLog((v) => !v)
              }}
              disabled={!isRepo}
            >
              <span>📜</span> {showLog ? '隐藏日志' : '查看日志'}
            </button>
          </div>
        </div>
      )}

      {showLog && (
        <GitLogPanel onClose={() => setShowLog(false)} />
      )}

      {showSyncDialog && (
        <SyncConfirmDialogHost
          onClose={() => setShowSyncDialog(false)}
          onConfirm={async (message) => {
            setShowSyncDialog(false)
            return syncNow(message)
          }}
        />
      )}
    </div>
  )
}

/**
 * 嵌入式日志面板（轻量内联实现）
 */
function GitLogPanel({ onClose }: { onClose: () => void }) {
  const recentLog = useGitStore((s) => s.recentLog)
  const refresh = useGitStore((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="git-log-panel">
      <div className="git-log-header">
        <strong>最近提交</strong>
        <button className="btn ghost xs" onClick={onClose}>
          关闭
        </button>
      </div>
      {recentLog.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          暂无提交记录
        </div>
      ) : (
        <ul className="git-log-list">
          {recentLog.map((entry) => (
            <li key={entry.sha} className="git-log-item">
              <div className="git-log-sha">{entry.sha.slice(0, 7)}</div>
              <div className="git-log-message">{entry.message.split('\n')[0]}</div>
              <div className="git-log-meta muted">
                {entry.author.name} · {new Date(entry.date).toLocaleString('zh-CN')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 同步确认对话框的本地桥接（避免在 Badge 内直接导入大文件依赖）
 */
function SyncConfirmDialogHost({
  onClose,
  onConfirm,
}: {
  onClose: () => void
  onConfirm: (message: string) => Promise<{ ok: boolean; error?: string }>
}) {
  // 动态 import 避免循环依赖
  const [Dialog, setDialog] = useState<React.ComponentType<{
    open: boolean
    onClose: () => void
    onConfirm: (message: string) => Promise<{ ok: boolean; error?: string }>
  }> | null>(null)

  useEffect(() => {
    let mounted = true
    import('./SyncConfirmDialog').then((mod) => {
      if (mounted) setDialog(() => mod.SyncConfirmDialog)
    })
    return () => {
      mounted = false
    }
  }, [])

  if (!Dialog) return null
  return <Dialog open={true} onClose={onClose} onConfirm={onConfirm} />
}

export default GitStatusBadge
