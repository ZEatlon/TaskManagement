/**
 * 库设置 Tab
 *
 * 字段：当前库路径展示、更改目录、库大小/笔记数/便签数、打开目录按钮
 * 切换库目录走 LibrarySwitcherModal（多步流程：选新目录 → 扫描 → 选动作）。
 */
import { useEffect, useState, useCallback } from 'react'
import { useSettingsStore } from '../../../stores/settings'
import { stickyNotesApi } from '../../../lib/ipc'
import { SettingField } from '../SettingField'
import { LibrarySwitcherModal } from '../../library/LibrarySwitcherModal'

/** 库统计信息 */
interface LibraryStats {
  sizeBytes: number
  notes: number
  /** 便签数（替代原 tasks 统计） */
  stickies: number
}

const EMPTY_STATS: LibraryStats = { sizeBytes: 0, notes: 0, stickies: 0 }

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function LibraryTab() {
  const settings = useSettingsStore()
  const [stats, setStats] = useState<LibraryStats>(EMPTY_STATS)
  const [info, setInfo] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  /** 拉取统计信息：db 大小 + 便签数 */
  const refreshStats = useCallback(async () => {
    try {
      const status = await window.api.invoke<undefined, { sizeBytes: number }>('db:status', undefined)
      // listFiltered 不返回 total，用 fetchAll + 长度粗略估计（限 1000 以内足够首页展示）
      const stickies = await stickyNotesApi.listFiltered({ archived: false, limit: 1000 })
      setStats({
        sizeBytes: status?.sizeBytes ?? 0,
        notes: 0,
        stickies: Array.isArray(stickies) ? stickies.length : 0,
      })
    } catch (_) {
      // ignore
    }
  }, [])

  useEffect(() => {
    refreshStats()
  }, [refreshStats, settings.libraryPath])

  async function handleChangeDirectory() {
    // 走多步流程：选新目录 → 扫描 → 选动作（解析原有 / 在新建库 / 迁移）
    setSwitcherOpen(true)
  }

  async function handleOpenDirectory() {
    const path = settings.libraryPath
    if (!path) {
      setInfo('尚未配置库目录')
      return
    }
    try {
      const ok = await window.api.invoke<{ path: string }, string>('shell:open-path', { path })
      if (typeof ok === 'string' && ok) {
        setInfo(`打开失败：${ok}`)
      } else {
        setInfo(null)
      }
    } catch (err) {
      setInfo(`失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">库</h2>
      <p className="settings-tab-subtitle">TaskPilot 笔记与便签的存储位置</p>

      <SettingField label="当前库目录" description="所有笔记、附件、数据库都放在这里" type="custom">
        <div className="library-path-row">
          <input
            className="setting-input"
            type="text"
            value={settings.libraryPath ?? ''}
            readOnly
            placeholder="（未配置）"
          />
          <button className="btn" onClick={handleChangeDirectory}>
            切换库目录…
          </button>
          <button className="btn ghost" onClick={handleOpenDirectory} disabled={!settings.libraryPath}>
            打开目录
          </button>
        </div>
      </SettingField>

      {info && <div className="settings-info">{info}</div>}

      <LibrarySwitcherModal
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        onSwitched={() => {
          // 切完库后重拉统计
          setSwitcherOpen(false)
          refreshStats()
        }}
      />

      <div className="settings-stats">
        <div className="stat-card">
          <div className="stat-label">库目录大小</div>
          <div className="stat-value">{formatSize(stats.sizeBytes)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">笔记数</div>
          <div className="stat-value">{stats.notes}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">便签数</div>
          <div className="stat-value">{stats.stickies}</div>
        </div>
      </div>
    </div>
  )
}
