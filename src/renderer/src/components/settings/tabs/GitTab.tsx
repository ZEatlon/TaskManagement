/**
 * Git 设置 Tab
 *
 * 字段：远程仓库 URL、自动推送 toggle、推送间隔（分钟）、PAT Token、测试连接、当前同步状态
 *
 * 存储拆分（与 git-handlers / autoSync 对齐）：
 *   - remoteUrl            → .git/config（专用通道 git:remote-set / git:remote-get）
 *   - autoPushEnabled      → app.settings（专用通道 git:set-config）
 *   - pushIntervalMinutes  → app.settings（专用通道 git:set-config）
 *   - PAT Token            → 系统 keychain（专用通道 securityApi）
 *
 * R-fix-git-tab-broken (critical correctness)：原版把所有字段都塞进
 * setting:set({key:'app.git', value:{...}}) 通用通道 —— 三者都是 app.git
 * 的 privileged 字段，主进程 assertPrivilegedFieldsNotTouched 拒收，
 * 设置 UI 静默失效（原 error 被 console.error 吞掉）。现在按字段归属拆到
 * 三条专用通道。
 */
import { useEffect, useState } from 'react'
import { securityApi, gitApi, settingsApi } from '../../../lib/ipc'
import { useGitStore } from '../../../stores/git'
import { SettingField } from '../SettingField'

/** UI 配置（与实际存储位置解耦——见文件顶部注释） */
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
  /** 上次成功保存的远端 URL；新 URL 与之不同 → 主进程要求 confirmHostChange=true */
  const [lastSavedRemoteUrl, setLastSavedRemoteUrl] = useState<string>('')

  // 实时同步状态从 git store 订阅（main 进程通过 IPC 推送变化）
  const phase = useGitStore((s) => s.phase)
  const lastSyncAt = useGitStore((s) => s.lastSyncAt)
  const lastError = useGitStore((s) => s.lastError)
  const online = useGitStore((s) => s.online)
  const isRepo = useGitStore((s) => s.isRepo)
  const status = useGitStore((s) => s.status)

  /** 加载：远端 URL（专用通道）→ 自动推送配置（直接读 app.settings）→ keychain 可用性 → token 占位 */
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
        // 远端 URL 来自 .git/config（专用通道 git:remote-get），不走 settings 表
        const remote = await gitApi.getRemote()
        if (!cancelled && remote?.url) {
          setCfg((c) => ({ ...c, remoteUrl: remote.url }))
          setLastSavedRemoteUrl(remote.url)
        }
      } catch (_) {
        // ignore
      }
      try {
        // 自动推送配置实际在 app.settings 顶层字段（不是 app.git 子文档）。
        // setting:get 没有 assertPrivilegedFieldsNotTouched 的写路径检查，
        // 可以安全读。
        const appSettings = (await settingsApi.get<Record<string, unknown>>('app.settings')) ?? {}
        if (!cancelled) {
          setCfg((c) => ({
            ...c,
            autoPushEnabled: Boolean(appSettings.gitAutoPushEnabled),
            pushIntervalMinutes:
              typeof appSettings.gitPushIntervalMinutes === 'number'
                ? appSettings.gitPushIntervalMinutes
                : c.pushIntervalMinutes,
          }))
        }
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

  /** 远端 URL 改动：走 git:remote-set 专用通道。
   *  主进程在主机变更时要求 confirmHostChange=true —— 这里把"已保存的 URL"
   *  当作基线，与之不同就视为换主机。 */
  async function patchRemoteUrl(url: string) {
    const prev = cfg.remoteUrl
    setCfg((c) => ({ ...c, remoteUrl: url }))
    try {
      await gitApi.setRemote(url, 'origin', url !== lastSavedRemoteUrl)
      setLastSavedRemoteUrl(url)
    } catch (err) {
      // 回滚 + 重抛，让 UI 弹错误提示而非 console.error 静默吞掉
      setCfg((c) => ({ ...c, remoteUrl: prev }))
      throw err
    }
  }

  /** 自动推送配置改动：走 git:set-config 专用通道 */
  async function patchAutoConfig(p: { enabled?: boolean; intervalMinutes?: number }) {
    const prev = { enabled: cfg.autoPushEnabled, intervalMinutes: cfg.pushIntervalMinutes }
    setCfg((c) => ({
      ...c,
      ...(p.enabled !== undefined ? { autoPushEnabled: p.enabled } : {}),
      ...(p.intervalMinutes !== undefined ? { pushIntervalMinutes: p.intervalMinutes } : {}),
    }))
    try {
      await gitApi.setConfig(p)
    } catch (err) {
      setCfg((c) => ({
        ...c,
        autoPushEnabled: prev.enabled,
        pushIntervalMinutes: prev.intervalMinutes,
      }))
      throw err
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
        onChange={(v) => {
          // 失败时让用户看到错误，而非 console.error 静默吞掉
          void patchRemoteUrl(String(v)).catch((err) =>
            setTestStatus(`保存远端 URL 失败：${err instanceof Error ? err.message : String(err)}`),
          )
        }}
        placeholder="https://github.com/your-name/your-repo.git"
        disabled={!loaded}
      />

      <SettingField
        label="自动推送"
        description="按间隔自动将本地修改推送到远程"
        type="toggle"
        value={cfg.autoPushEnabled}
        onChange={(v) => {
          void patchAutoConfig({ enabled: Boolean(v) }).catch((err) =>
            setTestStatus(`保存自动推送设置失败：${err instanceof Error ? err.message : String(err)}`),
          )
        }}
      />

      <SettingField
        label="推送间隔（分钟）"
        description="自动推送的间隔时长（cron minute 字段合法值 1-59，更大间隔会在主进程被 clamp）"
        type="number"
        value={cfg.pushIntervalMinutes}
        onChange={(v) => {
          const n = Number(v)
          if (Number.isFinite(n)) {
            void patchAutoConfig({ intervalMinutes: Math.max(1, Math.min(1440, n)) }).catch(
              (err) =>
                setTestStatus(
                  `保存推送间隔失败：${err instanceof Error ? err.message : String(err)}`,
                ),
            )
          }
        }}
        onBlur={() => {
          // 失焦时再次写入当前 cfg 值，确保主进程返回 clamp 后的真实值被本地 state 同步
          void patchAutoConfig({ intervalMinutes: cfg.pushIntervalMinutes }).catch(() => {})
        }}
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
