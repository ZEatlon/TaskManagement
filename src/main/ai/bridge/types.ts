/**
 * AI bridge 层共享类型与命名约定
 *
 * 历史背景：四个 ai/*Bridge.ts 文件（pomodoroBridge / tagBridge /
 * navigateBridge / statsBridge）各自手写 StartResult / StopResult /
 * PauseResult / ApplyTagResult / NavigateResult / PomodoroStats |
 * PomodoroStatsError 等 result interface，shape 漂移、字段命名不一致、
 * ok:boolean + error?:string 模板被重复 N 次。新增桥接字段时（例如
 * 给 tag result 加 tagId escape）需要逐个工具的 execute 同步改 —— R32
 * 修复（escapeToolText 收敛）已经踩过同样的坑。
 *
 * R32-Corr-2 修复 (MEDIUM structure)：抽出共享 BridgeResult<T> 联合类型
 * + escapeApplyResult 字段透传 helper，让四个 bridge + tools/registry.ts
 * 的 tag 工具走同一份契约。未来新增桥接字段（escape / sanitize / 新维度）
 * 只需在 helper / 类型一处改动。
 *
 * 历史命名（暂未统一，按各自 bridge 既有风格）：
 *   - tagBridge:     实体对偶 — applyTagToNote / applyTagToSticky / removeTagFromSticky
 *   - pomodoroBridge: 动作单入参 + read-only 前缀 — applyPomodoroAction(action, payload)
 *                    / getPomodoroState / getPomodoroStats
 *   - navigateBridge: 动宾 — navigateTo(route, focusStickyId?)
 *
 * 注意：三套风格并非由本文件统一收敛。未来新增 bridge 或新方法时，先看
 * registry.ts / tools/ 实际消费入口，再选与该 bridge 现有 export 对齐的
 * 命名；不要默认套用 tagBridge 的 XToY 模板。统一收敛留作后续重构题目。
 *
 * 老函数名（start / stop / pause / state / go）作为 deprecated 别名保留
 * 一轮，方便历史调用方平滑过渡，但 tools/registry.ts 已直接切换到新名字。
 */

/**
 * 桥接层标准返回结构。
 *
 *   - 成功：{ ok: true, ...T }（T 的字段平铺到根）
 *   - 失败：{ ok: false, error: string }（error 一定存在；非空字符串）
 *
 * 不强制 ok:false 分支带 extra field（个别 bridge 需要时单独扩展
 * BridgeFailure<T>，保持基础形态不变）。
 *
 * R39-fix-bridge-guards-live (low structure)：类型守卫 `isBridgeFailure`
 * 被 tools/registry.ts executeTool 用来在工具结果 JSON 解析后做统一出口
 * —— 失败时集中 warn 一行（与异常分支对齐格式），成功路径不需要守卫
 * 因为代码本来就直接透传 result（不需要 narrowing 出 ok:true 分支）。
 * 后续如果需要在调用点拿到成功分支的强类型，可以再补一个
 * `isBridgeSuccess(r): r is { ok: true } & T`，与 isBridgeFailure 风格
 * 对齐；本轮只留真正被消费的那个。
 */
export type BridgeResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | BridgeFailure

export interface BridgeFailure {
  ok: false
  error: string
}

/**
 * 类型守卫：失败分支。
 *
 * 注意：接受 `{ ok: unknown }` 形状而不是严格 BridgeResult<T>，让
 * `JSON.parse` 出来的 `unknown` 在工具层做宽松 narrowing 而不必先断言成
 * 完整 BridgeResult——这是 type guard 在边界处的常见用法。
 */
export function isBridgeFailure(
  r: { ok: unknown } | null | undefined,
): r is BridgeFailure {
  return (
    !!r &&
    typeof r === 'object' &&
    (r as { ok: unknown }).ok === false
  )
}