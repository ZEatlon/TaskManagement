/**
 * 通知设置 Tab
 *
 * 字段：启用系统通知 toggle、免打扰时段（开始/结束）、测试通知按钮
 */
import { useState } from 'react'
import { useSettingsStore } from '../../../stores/settings'
import { SettingField } from '../SettingField'

export function NotificationsTab() {
  const settings = useSettingsStore()
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
        value={settings.enableNotifications}
        onChange={(v) => settings.update({ enableNotifications: Boolean(v) })}
      />

      <SettingField
        label="免打扰时段"
        description="在指定时间范围内不弹出通知"
        type="toggle"
        value={settings.quietHoursEnabled}
        onChange={(v) => settings.update({ quietHoursEnabled: Boolean(v) })}
      />

      <div className="settings-row">
        <SettingField
          label="开始时间"
          description="免打扰开始（HH:mm）"
          type="time"
          value={settings.quietHoursStart}
          onChange={(v) => settings.update({ quietHoursStart: String(v) })}
          disabled={!settings.quietHoursEnabled}
        />
        <SettingField
          label="结束时间"
          description="免打扰结束（HH:mm）"
          type="time"
          value={settings.quietHoursEnd}
          onChange={(v) => settings.update({ quietHoursEnd: String(v) })}
          disabled={!settings.quietHoursEnabled}
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
