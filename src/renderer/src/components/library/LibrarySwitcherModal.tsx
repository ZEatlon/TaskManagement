/**
 * 切换库目录 Modal（多步流程）
 *
 * 流程：
 *   Step 1：选新目录（弹系统选择器）
 *   Step 2：扫描新目录，展示 .taskpilot 数据现状
 *           - 空 → "在新建库" 路径
 *           - 有数据 → "解析原有仓库数据" 路径
 *   Step 3：选动作
 *           - "在新建库"          → initialize + setCurrent
 *           - "使用新目录已有数据" → setCurrent（不动 dest 数据）
 *           - "从当前库迁移"        → migrate + setCurrent
 *   Step 4：完成提示
 *
 * 设计：所有 IPC 串行 await + 错误内联展示；modal 内部状态机自管理。
 */
import { useEffect, useState, useCallback } from 'react'
import { X, FolderInput, HardDriveDownload, FolderPlus, Loader2 } from 'lucide-react'
import { libraryApi, type LibraryScanResult } from '@renderer/lib/ipc'
import { useSettingsStore } from '../../stores/settings'

interface Props {
  open: boolean
  onClose: () => void
  /** 切换 / 迁移完成 → 通知父组件刷新统计 */
  onSwitched?: (newPath: string) => void
}

type Step = 'pick' | 'preview' | 'done'
type Action = 'init' | 'use-existing' | 'migrate'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function LibrarySwitcherModal({ open, onClose, onSwitched }: Props) {
  // R37-perf-2：精确订阅本 modal 实际用到的字段（libraryPath + update 方法）。
  // 全 store 订阅会让任意字段（如 accentColor）写入触发本 modal 重新挂载状态机。
  const currentLibraryPath = useSettingsStore((s) => s.libraryPath)
  const update = useSettingsStore((s) => s.update)
  const [step, setStep] = useState<Step>('pick')
  const [pickedPath, setPickedPath] = useState<string | null>(null)
  const [scan, setScan] = useState<LibraryScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [result, setResult] = useState<string | null>(null)

  // 打开时重置
  useEffect(() => {
    if (open) {
      setStep('pick')
      setPickedPath(null)
      setScan(null)
      setBusy(false)
      setError(null)
      setAction(null)
      setResult(null)
    }
  }, [open])

  const handlePick = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const picked = await libraryApi.selectDirectory()
      if (!picked) return
      setPickedPath(picked)
      // 立刻扫描
      const s = await libraryApi.scan(picked)
      setScan(s)
      setStep('preview')
    } catch (err) {
      console.warn('[library-switcher] pick failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleExecute = useCallback(
    async (chosen: Action) => {
      if (!pickedPath) return
      setError(null)
      setAction(chosen)
      setBusy(true)
      try {
        // 步骤 1：先校验（避免 setCurrent 写到非法路径）
        const validation = await libraryApi.validate(pickedPath)
        if (!validation.valid) {
          setError(`目标路径无效：${validation.reason ?? '未知'}`)
          setBusy(false)
          setAction(null)
          return
        }

        if (chosen === 'init') {
          // 在新目录建立新库：init + setCurrent
          await libraryApi.initialize(pickedPath)
          await libraryApi.setCurrent(pickedPath)
          await update({ libraryPath: pickedPath })
          setResult('已在新目录建立新库并切换')
        } else if (chosen === 'use-existing') {
          // 解析原有仓库数据：只 setCurrent，不动 dest 数据
          await libraryApi.setCurrent(pickedPath)
          await update({ libraryPath: pickedPath })
          setResult('已切换到新目录（新目录数据已就绪）')
        } else {
          // 从当前库迁移：migrate + setCurrent
          const current = await libraryApi.getCurrent()
          if (!current) {
            setError('当前未设置库目录，无法迁移')
            setBusy(false)
            setAction(null)
            return
          }
          if (current === pickedPath) {
            setError('源与目标路径相同，无需迁移')
            setBusy(false)
            setAction(null)
            return
          }
          const m = await libraryApi.migrate(pickedPath)
          await libraryApi.setCurrent(pickedPath)
          await update({ libraryPath: pickedPath })
          setResult(
            `已迁移 ${m.copiedFiles} 个文件（${formatBytes(m.copiedBytes)}），并切换到新目录`,
          )
        }

        setStep('done')
        onSwitched?.(pickedPath)
      } catch (err) {
        console.warn('[library-switcher] execute failed', err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
        setAction(null)
      }
    },
    [pickedPath, update, onSwitched],
  )

  if (!open) return null

  const currentPath = currentLibraryPath ?? '（未设置）'
  const isCurrent = pickedPath && pickedPath === currentLibraryPath

  return (
    <div className="library-switcher-backdrop" onClick={onClose}>
      <div
        className="library-switcher-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-switcher-title"
      >
        <header className="library-switcher-header">
          <h2 id="library-switcher-title">切换库目录</h2>
          <button
            className="btn ghost"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="library-switcher-body">
          {/* 当前目录显示（所有步骤都显示） */}
          <div className="library-switcher-section">
            <div className="library-switcher-label">当前库目录</div>
            <code className="library-switcher-current">{currentPath}</code>
          </div>

          {/* 步骤 1：选择新目录 */}
          {step === 'pick' && (
            <div className="library-switcher-section">
              <p className="muted small">
                选择新目录后，应用会扫描该目录是否已含 <code>.taskpilot</code> 数据，
                然后让你选择下一步：<strong>在新建库</strong> / <strong>解析原有数据</strong> / <strong>从当前库迁移</strong>。
              </p>
              <button
                className="btn primary"
                onClick={handlePick}
                disabled={busy}
              >
                {busy ? (
                  <>
                    <Loader2 size={14} className="spin" aria-hidden /> 扫描中…
                  </>
                ) : (
                  <>
                    <FolderInput size={14} aria-hidden /> 选择新目录
                  </>
                )}
              </button>
            </div>
          )}

          {/* 步骤 2：扫描结果 + 选择动作 */}
          {step === 'preview' && pickedPath && scan && (
            <>
              <div className="library-switcher-section">
                <div className="library-switcher-label">新目录</div>
                <code className="library-switcher-current">{pickedPath}</code>
                {isCurrent && (
                  <div className="library-switcher-warn">
                    ⚠️ 这就是当前库目录。无需切换。
                  </div>
                )}
              </div>

              <div className="library-switcher-section">
                <div className="library-switcher-label">扫描结果</div>
                {scan.error ? (
                  <div className="library-switcher-error">⚠️ {scan.error}</div>
                ) : !scan.hasTaskpilotDir ? (
                  <div className="muted small">
                    该目录下没有 <code>.taskpilot</code> —— 是个空目录或普通文件夹。
                  </div>
                ) : (
                  <div className="library-switcher-stats">
                    <div className="stat-cell">
                      <div className="stat-num">{scan.noteCount}</div>
                      <div className="stat-lbl">笔记</div>
                    </div>
                    <div className="stat-cell">
                      <div className="stat-num">{scan.attachmentCount}</div>
                      <div className="stat-lbl">附件</div>
                    </div>
                    <div className="stat-cell">
                      <div className="stat-num">{formatBytes(scan.totalBytes)}</div>
                      <div className="stat-lbl">占用</div>
                    </div>
                    {scan.extraSubdirCount > 0 && (
                      <div className="stat-cell">
                        <div className="stat-num">{scan.extraSubdirCount}</div>
                        <div className="stat-lbl">子目录</div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!isCurrent && !scan.error && (
                <div className="library-switcher-actions">
                  {scan.hasTaskpilotDir && scan.noteCount > 0 ? (
                    <>
                      <button
                        className="btn primary"
                        onClick={() => handleExecute('use-existing')}
                        disabled={busy}
                        title="把当前 libraryPath 切到这个目录；该目录里的 .taskpilot 数据原样使用"
                      >
                        {busy && action === 'use-existing' ? (
                          <Loader2 size={14} className="spin" aria-hidden />
                        ) : (
                          <FolderInput size={14} aria-hidden />
                        )}
                        解析原有仓库数据
                      </button>
                      <button
                        className="btn"
                        onClick={() => handleExecute('migrate')}
                        disabled={busy}
                        title="把当前库的所有笔记/附件复制到这个新目录后切换"
                      >
                        {busy && action === 'migrate' ? (
                          <Loader2 size={14} className="spin" aria-hidden />
                        ) : (
                          <HardDriveDownload size={14} aria-hidden />
                        )}
                        从当前库迁移
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn primary"
                      onClick={() => handleExecute('init')}
                      disabled={busy}
                      title="在选中的目录里创建 .taskpilot 子目录并切换"
                    >
                      {busy && action === 'init' ? (
                        <Loader2 size={14} className="spin" aria-hidden />
                      ) : (
                        <FolderPlus size={14} aria-hidden />
                      )}
                      在新目录建立数据
                    </button>
                  )}
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setStep('pick')
                      setPickedPath(null)
                      setScan(null)
                    }}
                    disabled={busy}
                  >
                    重新选择
                  </button>
                </div>
              )}
            </>
          )}

          {/* 步骤 3：完成 */}
          {step === 'done' && (
            <div className="library-switcher-section">
              <div className="library-switcher-success">
                ✅ {result ?? '切换成功'}
              </div>
              <button className="btn primary" onClick={onClose}>
                完成
              </button>
            </div>
          )}

          {error && <div className="library-switcher-error">⚠️ {error}</div>}
        </div>
      </div>
    </div>
  )
}
