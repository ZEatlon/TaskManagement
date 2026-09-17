/**
 * Tabler Icons 适配层
 *
 * 为什么需要这个文件：项目之前用 lucide-react（`X` / `Plus` / `Loader2` 等）
 * 命名，迁移到 @tabler/icons-react 后变成 `IconX` / `IconPlus` / `IconLoader`，
 * 而且 `Loader2` 的旋转动画是 lucide 自带的，Tabler 的 `IconLoader` 是静态
 * SVG，需要调用方手动加 `className="animate-spin"`。
 *
 * 这层提供：
 *   1. `AppIcon` 类型：所有 icon 组件的统一签名（代替 lucide 的 `LucideIcon`）
 *   2. 友好别名导出：用 lucide 旧名 import 即可（如 `import { X } from '../lib/icon'`）
 *   3. `Spinner` 组件：把 `IconLoader` + `animate-spin` 打包，避免每个
 *      调用方手写 className
 *
 * 设计原则：调用方代码 0 改动量。原本 `import { X, Plus } from 'lucide-react'`
 * 改成 `import { X, Plus } from '../lib/icon'`，用法（`<X size={14} />`）不变。
 */
import type { FunctionComponent } from 'react'
import type { IconProps } from '@tabler/icons-react'
import {
  IconCheck,
  IconChevronRight,
  IconDatabaseImport,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFilePlus,
  IconFileText,
  IconFolderOpen,
  IconFolderPlus,
  IconGripVertical,
  IconLoader,
  IconMinus,
  IconNotebook,
  IconPencil,
  IconPin,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconSquare,
  IconTag,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react'

/** 调用方写 `import type { AppIcon }` —— 替代 lucide 的 `LucideIcon`。 */
export type AppIcon = FunctionComponent<IconProps>

// ─── 友好别名（lucide 旧名 → Tabler 实际组件）───
// 命名映射表：左边是 lucide 旧名，右边是 Tabler 组件。
// 不在这表的图标（比如 lucide 独有的 `HardDriveDownload`）走下方单独的
// 语义重定向。

export const X = IconX
export const ChevronRight = IconChevronRight
export const Download = IconDownload
export const Eye = IconEye
export const EyeOff = IconEyeOff
export const GripVertical = IconGripVertical
export const Pencil = IconPencil
export const Plus = IconPlus
export const Check = IconCheck
export const Tag = IconTag
export const Sparkles = IconSparkles
export const FileText = IconFileText
export const Pin = IconPin
export const FolderPlus = IconFolderPlus
export const FilePlus2 = IconFilePlus
export const Minus = IconMinus
export const NotebookPen = IconNotebook
export const Play = IconPlayerPlay
export const Settings = IconSettings
export const SkipForward = IconPlayerSkipForward
export const Square = IconSquare
export const Volume2 = IconVolume
export const VolumeX = IconVolumeOff

// ─── 语义重定向（lucide 独有 → Tabler 最接近语义）───
// `FolderInput`：lucide 是「打开/输入文件夹」，Tabler 没有完全对应的，
// `IconFolderOpen` 在视觉上最接近「打开一个目录选择器」语义。
export const FolderInput = IconFolderOpen
// `HardDriveDownload`：lucide 是「下载/导入到本机」，用于 library 导入入口。
// `IconDatabaseImport` 直接表达「把外部库导入到本地数据库」语义。
export const HardDriveDownload = IconDatabaseImport

// ─── Spinner：自带 animate-spin 的加载图标 ───

/**
 * `Loader2` 在 lucide 里是带旋转的 spinner；Tabler 的 `IconLoader` 是静态 SVG。
 * 这个组件把「旋转 + 加载中」语义集中到一处，调用方写 `<Spinner size={14} />`
 * 即可，不再需要在每个调用点手写 `className="animate-spin"`。
 */
export function Spinner(props: IconProps): JSX.Element {
  return <IconLoader {...props} className={`animate-spin ${props.className ?? ''}`.trim()} />
}

/** 老代码里 `Loader2` 直接 import 使用 —— 别名同步导出，避免一处遗漏。 */
export const Loader2 = Spinner
