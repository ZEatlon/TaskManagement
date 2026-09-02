/**
 * 库目录选择器
 *
 * 用法：
 *   <LibrarySelector
 *     value={chosenPath}
 *     onChange={(p) => setChosenPath(p)}
 *   />
 *
 * 行为：
 *   - 显示当前选中路径
 *   - "浏览..." 按钮：弹出系统目录选择器
 *   - 选中后立即回调 onChange
 *   - 可选 onValidate：在选中后立即校验，把 valid/reason 通过 prop 暴露
 */
import { useEffect, useRef, useState } from 'react'
import { libraryApi, type LibraryValidation } from '@renderer/lib/ipc'

interface Props {
  value: string | null
  onChange: (path: string) => void
  /** 选中后是否自动校验 */
  autoValidate?: boolean
  /** 自定义校验回调（默认使用 libraryApi.validate） */
  onValidate?: (result: LibraryValidation) => void
}

export function LibrarySelector({
  value,
  onChange,
  autoValidate = true,
  onValidate,
}: Props) {
  const [validation, setValidation] = useState<LibraryValidation | null>(null)
  const [busy, setBusy] = useState(false)

  const handleBrowse = async () => {
    setBusy(true)
    try {
      const picked = await libraryApi.selectDirectory()
      if (!picked) return
      onChange(picked)
      if (autoValidate) {
        const v = await libraryApi.validate(picked)
        setValidation(v)
        onValidate?.(v)
      } else {
        setValidation(null)
      }
    } catch (err) {
      console.error('[library-selector] selectDirectory failed', err)
      setValidation({ valid: false, reason: '选择失败' })
    } finally {
      setBusy(false)
    }
  }

  const handleManual = async (path: string) => {
    onChange(path)
    if (!path) {
      setValidation(null)
      return
    }
    // R26-perf-15 修复 (medium n+1 IPC)：原版 autoValidate 路径在用户每次
    // onChange（每个 keystroke）直接 await validate → IPC round-trip + DB
    // 同步 stat。粘贴长路径时 12+ 次 IPC。改为 300ms 防抖：用户连续打字
    // 只在停手后跑一次校验。
    if (autoValidate) {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = window.setTimeout(async () => {
        debounceTimer.current = null
        try {
          const v = await libraryApi.validate(path)
          setValidation(v)
          onValidate?.(v)
        } catch {
          setValidation({ valid: false, reason: '校验失败' })
        }
      }, 300)
    }
  }

  // 防抖 timer ref（避免每次 render 重建 setTimeout）
  const debounceTimer = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [])

  return (
    <div className="library-selector">
      <div className="library-selector-row">
        <input
          className="library-path-input"
          type="text"
          // R12 修复 (medium)：placeholder 不是无障碍 label，屏幕阅读器读
          // "edit, 例如：C:\Users\<you>..." 难以理解。加 aria-label 让 SR 知道
          // 这是库路径输入框。
          aria-label="资料库文件夹路径"
          placeholder="例如：C:\Users\<you>\Documents\TaskPilot"
          value={value ?? ''}
          onChange={(e) => handleManual(e.target.value)}
        />
        <button className="btn" onClick={handleBrowse} disabled={busy}>
          {busy ? '打开中…' : '浏览…'}
        </button>
      </div>

      {validation && (
        <div
          className={`library-validation ${validation.valid ? 'ok' : 'fail'}`}
          // R26-a11y-3 修复 (medium aria-live)：原版异步校验结果只更新视觉，
          // 屏幕阅读器读不到。补 role="status" + aria-live="polite"，让 SR
          // 在 IPC 完成时立即公告「目录可用 / 不可用」+ reason。
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {validation.valid ? (
            <span>✓ 目录可用</span>
          ) : (
            <span>✗ {validation.reason ?? '目录不可用'}</span>
          )}
        </div>
      )}
    </div>
  )
}
