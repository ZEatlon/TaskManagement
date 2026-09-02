/**
 * Git 设置 Tab
 *
 * 字段：远程仓库 URL、自动推送 toggle、推送间隔（分钟）、PAT Token、测试连接、当前同步状态
 *
 * Token 经 securityApi 存入 keychain；其余写入 settings.git 子键。
 */
import { useEffect, useState } from 'react'
import { securityApi } from '../../../lib/ipc'
import { useGitStore } from '../../../stores/git'
import { SettingField } from '../SettingField'

/** Git 配置 */
interface GitConfig {
  remoteUrl: string
  autoPushEnabled: boolean
  pushIntervalMinutes: number
}

const DEFAULT_GIT: GitConfig = {
  remoteUrl: '',
  autoPushEnabled: false,
  pushIntervalMinutes: 5,
}

export function GitTab() {
  const [cfg, setCfg] = useState<GitConfig>(DEFAULT_GIT)
  const [loaded, setLoaded] = useState(false)
  const [token, setToken] = useState('')
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [keychainAvailable, setKeychainAvailable] = useState(true)

  // 实时同步状态从 git store 订阅（main 进程通过 IPC 推送变化）
  const phase = useGitStore((s) => s.phase)
  const lastSyncAt = useGitStore((s) => s.lastSyncAt)
  const lastError = useGitStore((s) => s.lastError)
  const online = useGitStore((s) => s.online)
  const isRepo = useGitStore((s) => s.isRepo)
  const status = useGitStore((s) => s.status)

  /** 加载：git 配置 + keychain 可用性 + token 占位 */
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
        const raw = await window.api.invoke<string, GitConfig | null>('setting:get', 'app.git')
        if (!cancelled && raw) setCfg({ ...DEFAULT_GIT, ...raw })
      } catch (_) {
        // ignore
      }
      try {
        const t = await securityApi.get('git.token')
        if (!cancelled) setToken(t ? '••••••••' : '')
      } catch (_) {
        // ignore
      }
      if (!cancelled) setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 通用更新 */
  async function patch(p: Partial<GitConfig>) {
    const next = { ...cfg, ...p }
    setCfg(next)
    try {
      await window.api.invoke('setting:set', { key: 'app.git', value: next })
    } catch (err) {
      console.error('[git] save failed', err)
    }
  }

  /** 保存 PAT Token */
  async function handleSaveToken() {
    if (!token || token.startsWith('••')) return
    await securityApi.set('git.token', token)
    setToken('••••••••')
  }

  /** 测试连接：本地仅校验 URL 格式与 token 是否存在 */
  async function handleTestConnection() {
    setBusy(true)
    setTestStatus(null)
    try {
      if (!cfg.remoteUrl) {
        setTestStatus('请先填写远程仓库 URL')
        return
      }
      const t = await securityApi.get('git.token')
      setTestStatus(t ? 'Token 已配置；远程 URL 格式有效' : '尚未配置 Git Token，远程推送将失败')
    } catch (err) {
      setTestStatus(`失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // 根据真实状态（phase + 仓库 dirty + 在线）渲染
  const statusLabel = (() => {
    if (!isRepo) return '未初始化仓库'
    if (phase !== 'idle') {
      if (phase === 'committing') return '正在提交…'
      if (phase === 'pulling') return '正在拉取…'
      if (phase === 'pushing') return '正在推送…'
    }
    if (lastError && !online) return '离线'
    if (status?.dirty) return `有 ${status.modified.length + status.untracked.length} 项待提交`
    if (status?.ahead) return `待推送 ${status.ahead} 项`
    if (status?.behind) return `待拉取 ${status.behind} 项`
    if (lastSyncAt) return '已同步'
    return '就绪'
  })()

  const statusClass = (() => {
    if (lastError && !online) return 'is-muted'
    if (phase !== 'idle') return 'is-warn'
    if (status?.dirty || status?.ahead) return 'is-warn'
    return 'is-success'
  })()

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">Git</h2>
      <p className="settings-tab-subtitle">库目录同步到远程仓库</p>

      <SettingField
        label="远程仓库 URL"
        description="GitHub / GitLab 等仓库的 SSH/HTTPS 地址"
        type="text"
        value={cfg.remoteUrl}
        onChange={(v) => patch({ remoteUrl: String(v) })}
        placeholder="https://github.com/your-name/your-repo.git"
        disabled={!loaded}
      />

      <SettingField
        label="自动推送"
        description="按间隔自动将本地修改推送到远程"
        type="toggle"
        value={cfg.autoPushEnabled}
        onChange={(v) => patch({ autoPushEnabled: Boolean(v) })}
      />

      <SettingField
        label="推送间隔（分钟）"
        description="自动推送的间隔时长"
        type="number"
        value={cfg.pushIntervalMinutes}
        onChange={(v) => {
          const n = Number(v)
          if (Number.isFinite(n)) patch({ pushIntervalMinutes: Math.max(1, Math.min(1440, n)) })
        }}
        onBlur={() => patch({ pushIntervalMinutes: cfg.pushIntervalMinutes })}
        min={1}
        max={1440}
        step={1}
        disabled={!cfg.autoPushEnabled}
      />

      <SettingField
        label="PAT Token"
        description="通过系统 keychain 加密保存（仅 HTTPS + 私有仓库需要）"
        type="password"
        value={token}
        onChange={(v) => setToken(String(v))}
        disabled={!keychainAvailable}
        placeholder="ghp_xxx / glpat-xxx"
      />
      <div className="settings-actions">
        <button className="btn" onClick={handleSaveToken} disabled={!keychainAvailable}>
          保存 PAT Token
        </button>
      </div>

      <SettingField label="当前状态" description="本次会话的远程同步情况" type="custom">
        <span className={`git-status-pill ${statusClass}`}>{statusLabel}</span>
      </SettingField>

      <div className="settings-actions">
        <button className="btn primary" onClick={handleTestConnection} disabled={busy}>
          {busy ? '检测中…' : '测试连接'}
        </button>
        {testStatus && <span className="settings-info-inline">{testStatus}</span>}
      </div>
    </div>
  )
}
