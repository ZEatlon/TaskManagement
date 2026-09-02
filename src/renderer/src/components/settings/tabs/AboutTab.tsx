/**
 * 关于 Tab
 *
 * 显示版本号、Electron 版本、Node 版本、关键依赖、开源协议、GitHub 链接。
 * 应用版本通过 window.api.ping 获取。
 */
import { useEffect, useState } from 'react'
import { BrandMark } from '../../brand/BrandMark'

/** 应用版本信息（来自主进程 ping） */
interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
}

/** 关键依赖及其版本（package.json 的子集） */
const KEY_DEPENDENCIES = [
  { name: 'React', version: '18.x' },
  { name: 'TanStack Router', version: '1.x' },
  { name: 'Zustand', version: '4.x' },
  { name: 'Electron', version: '33.x' },
  { name: 'better-sqlite3', version: '11.x' },
  { name: 'electron-vite', version: '2.x' },
]

export function AboutTab() {
  const [info, setInfo] = useState<AppInfo>({
    version: '0.1.0',
    electron: '-',
    node: '-',
    platform: '-',
  })

  /** 拉取版本号（ping 提供 app 版本；Electron/Node 由 preload 暴露） */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pong = await window.api.ping()
        const platform = window.api.platform
        if (!cancelled) {
          setInfo({
            version: pong.version || '0.1.0',
            electron: '33.x',
            node: process.versions?.node ?? (window as unknown as { versions?: { node?: string } }).versions?.node ?? '-',
            platform,
          })
        }
      } catch (_) {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">关于</h2>
      <p className="settings-tab-subtitle">TaskPilot 版本与环境</p>

      <div className="about-section">
        <div className="about-brand">
          <BrandMark size={48} className="about-brand-icon" title="TaskPilot" />
          <span>TaskPilot</span>
        </div>
        <div className="about-version">v{info.version}</div>
        <div className="about-tagline">本地优先的任务与笔记桌面助手</div>
      </div>

      <dl className="about-meta">
        <div>
          <dt>Electron</dt>
          <dd>{info.electron}</dd>
        </div>
        <div>
          <dt>Node</dt>
          <dd>{info.node}</dd>
        </div>
        <div>
          <dt>平台</dt>
          <dd>{info.platform}</dd>
        </div>
        <div>
          <dt>许可证</dt>
          <dd>MIT</dd>
        </div>
      </dl>

      <h3 className="about-subhead">主要依赖</h3>
      <ul className="about-deps">
        {KEY_DEPENDENCIES.map((dep) => (
          <li key={dep.name}>
            <span>{dep.name}</span>
            <code>{dep.version}</code>
          </li>
        ))}
      </ul>

      <h3 className="about-subhead">致谢</h3>
      <p className="muted">
        TaskPilot 基于开源社区的力量构建，特别感谢 Electron、React、Vite、TanStack、Zustand、better-sqlite3 等项目的贡献者。
      </p>

      <div className="about-links">
        <button
          type="button"
          className="btn ghost"
          onClick={() =>
            window.api.invoke('system:open-external', { url: 'https://github.com/taskpilot/taskpilot' })
          }
        >
          GitHub 仓库（占位）
        </button>
      </div>
    </div>
  )
}
