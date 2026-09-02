/**
 * BrandMark —— TaskPilot 品牌图标（共用组件）
 *
 * 设计概念：
 *   - 圆角方形底：indigo → violet → cyan 对角渐变 + 顶光 + 暗角
 *   - 主图形：3 层「阶梯」（白色渐变）—— 象征任务持续完成 / 进步
 *   - 顶端：橙黄径向「光晕星」—— 象征突破 / 达成
 *   - 左下：2 颗小光斑 —— 增加层次
 *
 * 用法：
 *   <BrandMark size={20} />            // 顶部 Header 品牌字旁的紧凑图标
 *   <BrandMark size={48} />            // About 页 / 空态
 *   <BrandMark size={64} rounded />    // 大尺寸，可带圆角外框
 *
 * 颜色全部硬编码：与 build/icon.svg 的设计 1:1 对齐，
 * 不跟随主题切换（品牌色具有识别一致性）。
 */
interface Props {
  size?: number
  /** 是否显示圆角方形底（默认 true）。设为 false 时只渲染内部图形（用于 already-in-card 的内嵌） */
  withBg?: boolean
  className?: string
  title?: string
}

export function BrandMark({ size = 20, withBg = true, className, title }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id="bm-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5b6cff" />
          <stop offset="55%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
        <radialGradient id="bm-shine" cx="0.28" cy="0.22" r="0.75">
          <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
          <stop offset="60%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <radialGradient id="bm-vignette" cx="1" cy="1" r="0.85">
          <stop offset="0%" stopColor="rgba(0,0,0,0.22)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
        <linearGradient id="bm-icon" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.86)" />
        </linearGradient>
        <linearGradient id="bm-iconShadow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(45,27,105,0.55)" />
          <stop offset="100%" stopColor="rgba(45,27,105,0.15)" />
        </linearGradient>
        <radialGradient id="bm-spark" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#fff7c2" />
          <stop offset="40%" stopColor="#fde68a" />
          <stop offset="100%" stopColor="#fbbf24" />
        </radialGradient>
      </defs>

      {withBg && (
        <>
          <rect x="16" y="16" width="224" height="224" rx="56" ry="56" fill="url(#bm-bg)" />
          <rect x="16" y="16" width="224" height="224" rx="56" ry="56" fill="url(#bm-vignette)" />
          <rect x="16" y="16" width="224" height="224" rx="56" ry="56" fill="url(#bm-shine)" />
          <rect
            x="17"
            y="17"
            width="222"
            height="222"
            rx="55"
            ry="55"
            fill="none"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="1.5"
          />
        </>
      )}

      {/* 投影层：与主图形同形，偏移，紫黑色 */}
      <g opacity="0.42" transform="translate(128 138) rotate(-12) translate(-128 -138)">
        <path
          d="M 70 174 L 70 144 L 116 178 L 70 178 Z"
          fill="url(#bm-iconShadow)"
        />
        <path
          d="M 70 154 L 70 124 L 134 178 L 70 178 Z"
          fill="url(#bm-iconShadow)"
          opacity="0.85"
        />
        <path
          d="M 70 134 L 70 104 L 152 178 L 70 178 Z"
          fill="url(#bm-iconShadow)"
          opacity="0.7"
        />
      </g>

      {/* 主图形：3 层「台阶」 */}
      <g transform="translate(128 138) rotate(-12) translate(-128 -138)" fill="url(#bm-icon)">
        <path d="M 70 174 L 70 144 L 116 178 L 70 178 Z" />
        <path d="M 70 154 L 70 124 L 134 178 L 70 178 Z" />
        <path d="M 70 134 L 70 104 L 152 178 L 70 178 Z" />
      </g>

      {/* 顶端光晕星：4 角 + 对角光芒 + 高光 */}
      <g transform="translate(192 70)">
        <circle cx="0" cy="0" r="10" fill="url(#bm-spark)" />
        <path d="M 0 -22 L 4 -6 L 0 0 L -4 -6 Z" fill="#fde68a" />
        <path d="M 22 0 L 6 4 L 0 0 L 6 -4 Z" fill="#fde68a" />
        <path d="M 0 22 L -4 6 L 0 0 L 4 6 Z" fill="#fbbf24" opacity="0.9" />
        <path d="M -22 0 L -6 -4 L 0 0 L -6 4 Z" fill="#fde68a" />
        <path d="M 14 -14 L 5 -3 L 3 -5 L 12 -16 Z" fill="#fcd34d" opacity="0.85" />
        <path d="M -14 -14 L -5 -3 L -3 -5 L -12 -16 Z" fill="#fcd34d" opacity="0.85" />
        <path d="M 14 14 L 5 3 L 3 5 L 12 16 Z" fill="#fcd34d" opacity="0.7" />
        <path d="M -14 14 L -5 3 L -3 5 L -12 16 Z" fill="#fcd34d" opacity="0.7" />
        <circle cx="-2" cy="-2" r="3" fill="#ffffff" opacity="0.85" />
      </g>

      {/* 左下角装饰光斑 */}
      <circle cx="58" cy="200" r="6" fill="rgba(255,255,255,0.18)" />
      <circle cx="78" cy="212" r="3" fill="rgba(255,255,255,0.22)" />
    </svg>
  )
}

export default BrandMark
