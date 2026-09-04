/**
 * 通知设置 Tab
 *
 * 字段：启用系统通知 toggle、免打扰时段（开始/结束）、测试通知按钮
 */
import { useState } from 'react'
import { useSettingsStore } from '../../../stores/settings'
import { SettingField } from '../SettingField'

export function NotificationsTab() {
  // R37-perf-2：精确订阅这 4 个字段，避免 accentColor / theme 等无关字段
  // 写入触发本 tab 重渲染
  const enableNotifications = useSettingsStore((s) => s.enableNotifications)
  const quietHoursEnabled = useSettingsStore((s) => s.quietHoursEnabled)
  const quietHoursStart = useSettingsStore((s) => s.quietHoursStart)
  const quietHoursEnd = useSettingsStore((s) => s.quietHoursEnd)
  const update = useSettingsStore((s) => s.update)
  const [testStatus, setTestStatus] = useState<string | null>(null)

  /** 拉一条测试通知 */
  async function handleTestNotify() {
    try {
      const res = await window.api.notify.test()
      setTestStatus(res?.ok ? '已发送测试通知' : '发送失败')
    } catch (err) {
      setTestStatus(`失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="settings-tab-panel">
      <h2 className="settings-tab-title">通知</h2>
      <p className="settings-tab-subtitle">系统通知与免打扰设置</p>

      <SettingField
        label="启用系统通知"
        description="便签到期、提醒触发时弹出系统 toast"
        type="toggle"
        value={enableNotifications}
        onChange={(v) => update({ enableNotifications: Boolean(v) })}
      />

      <SettingField
        label="免打扰时段"
        description="在指定时间范围内不弹出通知"
        type="toggle"
        value={quietHoursEnabled}
        onChange={(v) => update({ quietHoursEnabled: Boolean(v) })}
      />

      <div className="settings-row">
        <SettingField
          label="开始时间"
          description="免打扰开始（HH:mm）"
          type="time"
          value={quietHoursStart}
          onChange={(v) => update({ quietHoursStart: String(v) })}
          disabled={!quietHoursEnabled}
        />
        <SettingField
          label="结束时间"
          description="免打扰结束（HH:mm）"
          type="time"
          value={quietHoursEnd}
          onChange={(v) => update({ quietHoursEnd: String(v) })}
          disabled={!quietHoursEnabled}
        />
      </div>

      <div className="settings-actions">
        <button className="btn" onClick={handleTestNotify}>
          测试通知
        </button>
        {testStatus && <span className="settings-info-inline">{testStatus}</span>}
      </div>
    </div>
  )
}
