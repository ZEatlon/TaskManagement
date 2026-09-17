/**
 * 自动更新相关的共享类型（main + preload + renderer 共用）
 */

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'disabled'

export interface UpdaterProgress {
  transferred: number
  total: number
  percent: number
}

export interface UpdaterState {
  status: UpdaterStatus
  version?: string
  releaseDate?: string
  releaseNotes?: string
  progress?: UpdaterProgress
  error?: string
  /** 当前应用版本（用于 UI 显示 "v1.0.0 → v1.1.0" 之类） */
  currentVersion: string
}
