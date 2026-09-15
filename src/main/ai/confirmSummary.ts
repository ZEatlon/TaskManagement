/**
 * 工具调用确认摘要生成器
 *
 * 渲染端 ConfirmDialog 用一行中文摘要告诉用户「这次副作用工具会做什么」。
 * 原版直接埋在 src/main/ai/stream.ts 232-315，与流编排无关。抽到独立
 * 文件后，新增工具时改一处即可，无需 review 整个 stream.ts。
 *
 * 设计要点（来源：原 stream.ts 注释 R-fix-confirm-summary-coverage / R-fix-addTag-confirm-summary）：
 *   - id 统一取前 8 位（UUID 前 8 字符已在便签 / 笔记列表里稳定可点击；
 *     取整段会撑爆 dialog 宽度且不会提升可读性）。
 *   - 批量工具（batchUpdateStickies）必须列出 patch 各字段影响条数 →
 *     用户能在一行里看出「这是不是 prompt injection 让我把大批便签
 *     标 done」。
 *   - startPomodoro 显式标注「N 分钟 / 绑定便签 <id> / 未绑定」——
 *     用户必须看清楚这次是否带了持久化副作用（minutes 会改全局默认）。
 *   - addTag 在 R-fix-addTag-confirm-summary 修复后正确标注 risk='side-effect'
 *     → 流级确认弹窗会触发，落到 default `执行 addTag` 用户看不到任何参数
 *     摘要。补一个 case 把 name / parentName 渲染出来，用户一眼能看出
 *     「是不是被 prompt-injection 驱动建了陌生标签」。
 */

/**
 * 把工具参数翻译成一行中文摘要，用于 ConfirmDialog。
 *
 * @param toolName 工具名（与 ALL_TOOLS 中的 name 一致）
 * @param args     LLM 传来的参数对象
 * @returns 中文摘要字符串；不在白名单的工具走 default `执行 <toolName>`。
 */
export function buildConfirmSummary(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'createSticky':
      return `创建便签 "${String(args['title'] ?? '').slice(0, 40)}"`
    case 'updateSticky':
      return `更新便签 ${String(args['id'] ?? '').slice(0, 8)}`
    case 'completeSticky':
      return `标记便签 ${String(args['id'] ?? '').slice(0, 8)} 为完成`
    case 'createNote':
      return `创建笔记 "${String(args['title'] ?? '').slice(0, 40)}"`
    case 'startPomodoro': {
      const minutesRaw = args['minutes']
      const minutes =
        typeof minutesRaw === 'number' && Number.isFinite(minutesRaw)
          ? Math.max(1, Math.floor(minutesRaw))
          : 25
      const sticky = String(args['stickyNoteId'] ?? '').trim()
      const stickyLabel = sticky ? `绑定便签 ${sticky.slice(0, 8)}` : '未绑定便签'
      return `启动 ${minutes} 分钟番茄钟（${stickyLabel}）`
    }
    case 'stopPomodoro':
      return '停止当前番茄钟'
    case 'pausePomodoro':
      return '暂停 / 恢复番茄钟'
    case 'navigate': {
      const route = String(args['route'] ?? '').trim() || '/'
      const dateRaw = args['date']
      const date = typeof dateRaw === 'string' && dateRaw.trim() ? dateRaw.trim() : ''
      const routeLabel = date && route === '/today' ? `${route}?date=${date}` : route
      const focus = String(args['focusStickyId'] ?? '').trim()
      const focusLabel = focus ? `（便签 ${focus.slice(0, 8)} 高亮）` : ''
      return `跳转到 ${routeLabel}${focusLabel}`
    }
    case 'applyTagToNote': {
      const tag = String(args['tagName'] ?? '').trim()
      const note = String(args['noteFilename'] ?? '').trim()
      return `把标签 #${tag} 贴到笔记 ${note}`
    }
    case 'addTag': {
      // R-fix-addTag-confirm-summary (HIGH ai-quality)：addTag 现在正确标注
      // risk='side-effect' → 流级确认弹窗会触发，落到 default `执行 addTag`
      // 用户看不到任何参数摘要。补一个 case 把 name / parentName 渲染出来，
      // 用户一眼能看出「是不是被 prompt-injection 驱动建了陌生标签」。
      const name = String(args['name'] ?? '').trim()
      const parent = String(args['parentName'] ?? '').trim()
      const scope = parent ? `父标签 ${parent}` : '根作用域'
      return `创建标签 "${name}"（${scope}）`
    }
    case 'applyTagToSticky': {
      const tag = String(args['tagName'] ?? '').trim()
      const id = String(args['stickyNoteId'] ?? '').trim()
      return `把标签 #${tag} 贴到便签 ${id.slice(0, 8)}`
    }
    case 'removeTagFromSticky': {
      const tag = String(args['tagName'] ?? '').trim()
      const id = String(args['stickyNoteId'] ?? '').trim()
      return `从便签 ${id.slice(0, 8)} 摘掉标签 #${tag}`
    }
    case 'batchUpdateStickies': {
      const ids = Array.isArray(args['ids']) ? (args['ids'] as unknown[]) : []
      const total = ids.length
      const patch = (args['patch'] ?? {}) as Record<string, unknown>
      const parts: string[] = []
      if (patch['priority'] !== undefined) {
        parts.push(`${total} 条 priority → ${String(patch['priority'])}`)
      }
      if (patch['status'] !== undefined) {
        parts.push(`${total} 条 status → ${String(patch['status'])}`)
      }
      if (patch['date'] !== undefined) {
        parts.push(`${total} 条 date → ${String(patch['date'])}`)
      }
      if (patch['archived'] !== undefined) {
        const v = patch['archived']
        const label = v === true ? '归档' : v === false ? '取消归档' : `archived=${String(v)}`
        parts.push(`${total} 条 ${label}`)
      }
      const detail = parts.length > 0 ? `（${parts.join(' / ')}）` : '（patch 为空）'
      return `批量修改 ${total} 条便签 ${detail}`
    }
    default:
      return `执行 ${toolName}`
  }
}