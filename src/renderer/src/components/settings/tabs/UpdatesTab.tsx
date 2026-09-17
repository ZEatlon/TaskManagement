/**
 * 设置 → 更新 Tab
 *
 * UI:
 *   - 当前版本
 *   - 自动更新状态（idle / checking / available / not-available / downloading / downloaded / error / disabled）
 *   - 进度条（downloading 阶段）
 *   - 操作按钮：检查更新 / 下载更新 / 重启并安装
 *   - 错误信息（error 阶段）
 *   - 发布说明（available / downloaded 阶段）
 */
import { useEffect, useState } from 'react'
import type { IpcRendererEvent } from 'electron'
import type { UpdaterState } from '@shared/types/updater'

/**
 * dev 模式与 packaging 模式区分：
 *   - dev 模式：electron-updater 自动 disable，状态显示「dev 模式不检查更新」
 *   - packaging 模式：正常工作
 */
function describeStatus(state: UpdaterState): { text: string; tone: 'idle' | 'busy' | 'ok' | 'warn' | 'err' } {
  switch (state.status) {
    case 'idle':
      return { text: '未检查', tone: 'idle' }
    case 'checking':
      return { text: '正在检查更新…', tone: 'busy' }
    case 'available':
      return { text: `发现新版本 v${state.version ?? '?'}（当前 v${state.currentVersion}）`, tone: 'ok' }
    case 'not-available':
      return { text: `已是最新版本（v${state.currentVersion}）`, tone: 'ok' }
    case 'downloading':
      return { text: `正在下载 v${state.version ?? '?'}（${state.progress?.percent.toFixed(1) ?? 0}%）`, tone: 'busy' }
    case 'downloaded':
      return { text: `已下载 v${state.version ?? '?'}，点击下方按钮重启安装`, tone: 'ok' }
    case 'error':
      return { text: `更新失败：${state.error ?? '未知错误'}`, tone: 'err' }
    case 'disabled':
      return { text: 'dev 模式不检查更新；打包后生效', tone: 'idle' }
  }
}

export function UpdatesTab() {
  const [state, setState] = useState<UpdaterState | null>(null)
  const [busy, setBusy] = useState(false)

  // 初次挂载：取当前状态 + 订阅 UPDATER_STATUS
  useEffect(() => {
    let mounted = true
    void window.api.updater.getState().then((s) => {
      if (mounted) setState(s)
    })
    const off = window.api.updater.onStatus((_e: IpcRendererEvent, s: UpdaterState) => {
      if (mounted) setState(s)
    })
    return () => {
      mounted = false
      off()
    }
  }, [])

  async function handleCheck() {
    setBusy(true)
    try {
      const next = await window.api.updater.check()
      setState(next)
    } finally {
      setBusy(false)
    }
  }

  async function handleDownload() {
    setBusy(true)
    try {
      const next = await window.api.updater.download()
      setState(next)
    } finally {
      setBusy(false)
    }
  }

  function handleInstall() {
    // install 会在主进程触发 quitAndInstall，UI 端不需要等结果
    void window.api.updater.install()
  }

  if (!state) {
    return <div className="settings-tab updates-tab">加载中…</div>
  }

  const desc = describeStatus(state)
  const showDownload = state.status === 'available'
  const showInstall = state.status === 'downloaded'
  const showCheck = !['checking', 'downloading'].includes(state.status)

  return (
    <div className="settings-tab updates-tab">
      <h2>更新</h2>
      <p className="settings-tab__hint">
        TaskPilot 通过 GitHub Releases 发布新版本。打开本页面时应用会在后台自动检查更新；
        也可手动点「检查更新」立即触发。
      </p>

      <section className="updates-card">
        <div className="updates-row">
          <div className="updates-row__label">当前版本</div>
          <div className="updates-row__value">v{state.currentVersion}</div>
        </div>

        <div className="updates-row">
          <div className="updates-row__label">状态</div>
          <div className={`updates-row__value updates-tone updates-tone--${desc.tone}`}>
            {desc.text}
          </div>
        </div>

        {state.status === 'downloading' && state.progress && (
          <div className="updates-progress" role="progressbar" aria-valuenow={state.progress.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="updates-progress__bar" style={{ width: `${state.progress.percent}%` }} />
          </div>
        )}

        {state.status === 'available' && state.releaseNotes && (
          <details className="updates-notes">
            <summary>本次更新内容</summary>
            <pre>{state.releaseNotes}</pre>
          </details>
        )}

        {state.status === 'error' && state.error && (
          <div className="updates-error" role="alert">
            错误详情：{state.error}
          </div>
        )}

        <div className="updates-actions">
          {showCheck && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleCheck}
              disabled={busy || state.status === 'disabled'}
            >
              检查更新
            </button>
          )}
          {showDownload && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDownload}
              disabled={busy}
            >
              下载更新
            </button>
          )}
          {showInstall && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleInstall}
            >
              重启并安装
            </button>
          )}
        </div>
      </section>

      <section className="updates-info">
        <h3>更新流程说明</h3>
        <ul>
          <li>应用启动 5 秒后会在后台自动检查一次；后续可手动检查。</li>
          <li>发现新版本时弹通知（系统托盘 + 状态栏），用户点「下载」才开始下载。</li>
          <li>下载完成后需用户点「重启并安装」才会退出当前应用并替换新版本。</li>
          <li>更新源在 package.json 的 <code>build.publish</code> 配置（默认 GitHub Releases）。</li>
        </ul>
      </section>
    </div>
  )
}
