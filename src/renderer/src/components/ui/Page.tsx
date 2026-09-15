/**
 * TaskPilot UI —— Page（统一页面布局容器）
 *
 * 设计目标：
 *   - 所有顶层路由（dashboard / today / tasks / notes ...）都应该用 <Page> 作为
 *     最外层容器，统一 padding / max-width / 滚动行为
 *   - padding / max-width 通过 CSS 变量驱动，方便个别页面单独 override：
 *       --page-padding-x
 *       --page-padding-y
 *       --page-max-width
 *   - 子组件 PageHeader / PageBody 仅做语义化排版：
 *       PageHeader  = 顶部一行：左边标题 + 副标题，右边操作区
 *       PageBody    = 主内容区（flex:1 + min-height:0，便于内部滚动容器对齐）
 *
 * 注意：本组件不复用 .page 全局类 —— 而是用 ui-page className 暴露成
 * 「样式来源」，把变量定义集中到 index.css，避免与既有 .page 旧命名冲突。
 * 后续若要全局迁移，可以让 .page 直接 alias 到 .ui-page。
 */
import * as React from 'react'
import { cn } from '@renderer/lib/utils'

/* ============================================================
 * Page —— 顶层容器
 * ============================================================ */
export interface PageProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 临时覆盖 max-width（不推荐，应优先改 CSS 变量） */
  maxWidth?: string | number
}

export const Page = React.forwardRef<HTMLDivElement, PageProps>(
  ({ className, maxWidth, style, ...props }, ref) => {
    const composedStyle: React.CSSProperties = { ...style }
    if (maxWidth != null) {
      composedStyle.maxWidth =
        typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth
    }
    return (
      <div
        ref={ref}
        className={cn('ui-page', className)}
        style={composedStyle}
        {...props}
      />
    )
  },
)
Page.displayName = 'Page'

/* ============================================================
 * PageHeader —— 顶部一行：标题 / 副标题 / 操作区
 * ============================================================ */
export interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 子节点：通常 <h1> + <p className="ui-page-subtitle"> + <div className="ui-page-actions"> */
  children: React.ReactNode
}

export const PageHeader = React.forwardRef<HTMLDivElement, PageHeaderProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('ui-page-header', className)}
      {...props}
    />
  ),
)
PageHeader.displayName = 'PageHeader'

/* ============================================================
 * PageBody —— 主内容区
 * ============================================================ */
export interface PageBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  /** true 时垂直方向占满父容器剩余高度（用于嵌套虚拟滚动列表） */
  fillHeight?: boolean
}

export const PageBody = React.forwardRef<HTMLDivElement, PageBodyProps>(
  ({ className, fillHeight = true, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('ui-page-body', fillHeight && 'ui-page-body--fill', className)}
      {...props}
    />
  ),
)
PageBody.displayName = 'PageBody'

export default Page