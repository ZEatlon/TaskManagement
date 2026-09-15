/**
 * Bridge 输出 sanitize helper
 *
 * 历史背景：tools/registry.ts 里三个 tag 工具（applyTagToNote /
 * applyTagToSticky / removeTagFromSticky）的 execute 各自手抄
 * `...(res.error ? { error: escapeToolText(res.error) } : {})` 这套
 * 字段透传+escape 包装逻辑。新增字段时（比如加 tagId escape）三个工具都要
 * 同步改。R32-02 修复已经把 escape 字符集收敛到 escapeToolText 单一函数，
 * 但「哪些字段需要 escape」仍散落三处。
 *
 * R32-Corr-2 修复 (MEDIUM structure)：抽出本 helper，统一一个字段白名单 +
 * 一个 sanitize + stringify helper。三个 tag 工具的 execute 改走
 * `sanitizeAndStringifyBridgeResult(res)` 即可；未来增字段只需在本文件
 * 一处加白名单。
 *
 * 与 validators.ts 的职责切分：
 *   - validators.ts = *输入* 校验（enum 白名单 / parseSafeDate / 日期上下界）
 *   - sanitize.ts    = *输出* 净化（用户可控字段 escape 后回灌给 LLM）
 */
import { escapeToolText } from '../tools/validators'

/**
 * 字段名约定：哪些 user-controlled 标量字段需要 escapeToolText。
 *
 * 触发 escape 的理由：标签名 / 便签标题 / 错误消息等字段可能被 LLM 拿来
 * 注入 `<system>` / `<note_meta>` 等 markup 片段覆写 system prompt 语义。
 * escapeToolText 把 `[&<>"']` 转成 HTML 实体，从源头阻断注入向量。
 *
 * 新增桥接字段 → 在这里加一项，三个 tag 工具自动跟着 escape，无需改
 * tools/registry.ts。
 */
const TEXT_FIELDS_TO_ESCAPE = ['error', 'tagName', 'target'] as const

/** user-controlled string[] 字段（每个元素都 escape） */
const STRING_ARRAY_FIELDS_TO_ESCAPE = ['tags'] as const

/**
 * 把 BridgeResult 中 user-controlled 字段 escape 后返回新对象。
 *
 * 行为对齐旧 registry.ts 内联逻辑：
 *   - 字段值为 truthy string → escape 后写入
 *   - 字段值为空串 / undefined / 非 string → 整体移除该 key
 *     （与旧代码 `...(res.error ? {...} : {})` 条件展开等价 —— JSON.stringify
 *     时不存在 key 与 undefined key 都等价，但移除 key 让输出对象保持与原版
 *     字段集合完全一致，避免下游消费者按 `'error' in obj` 判断时漂移）
 *   - 不在白名单的字段透传（值不变），不影响 ok / tagId / matchKind /
 *     alreadyTagged / removed 等结构字段
 *
 * 泛型约束用 object 而非 Record<string, unknown>：原 ApplyTagResult /
 * ApplyTagResult & { removed?: boolean } 等接口没有 index signature，
 * TS 不允许赋给 Record<string, unknown>。改用 object 后保留调用方原有
 * 精确类型（sanitize 只读枚举 key，不修改结构），输出仍是同一类型。
 */
export function sanitizeBridgeResult<T extends object>(res: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(res)) {
    if ((TEXT_FIELDS_TO_ESCAPE as readonly string[]).includes(k)) {
      if (typeof v === 'string' && v.length > 0) {
        out[k] = escapeToolText(v)
      }
      // else: skip，匹配旧 conditional spread 语义
    } else if ((STRING_ARRAY_FIELDS_TO_ESCAPE as readonly string[]).includes(k)) {
      if (Array.isArray(v) && v.length > 0) {
        out[k] = v.map((x) => (typeof x === 'string' ? escapeToolText(x) : x))
      }
    } else {
      out[k] = v
    }
  }
  return out as T
}

/**
 * sanitize + JSON.stringify 一站式 helper。tag 三个工具的 execute 共用。
 */
export function sanitizeAndStringifyBridgeResult<T extends object>(res: T): string {
  return JSON.stringify(sanitizeBridgeResult(res))
}