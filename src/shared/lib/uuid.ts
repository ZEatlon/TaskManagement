/**
 * UUID 格式校验共享权威源
 *
 * 历史来源：UUID regex `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
 * （RFC 4122 8-4-4-4-12 hex）在 src/main/ipc/ai-handlers.ts 三处（AI_CONFIRM_CREATE_NOTE /
 * NOTE_OPENED / NOTE_CLOSED）与 src/main/ai/tools/note.ts（summarizeNote）各自
 * inline 重复，规则微调（如加 version/variant 校验、nanoid-style 替代格式）需
 * 4+ 处同步修改。新增 IPC handler / 工具时漏改概率高。
 *
 * 收口：
 *   - UUID_PATTERN：常量正则（喂 JSON Schema pattern / 其它需原样 regex 的场景）
 *   - isUuid(s)：纯函数 helper（IPC handler / 工具 execute 一行调用）
 *
 * 新增字段时一处加规则、全栈自动同步。
 */

/** RFC 4122 8-4-4-4-12 hex UUID（大小写不敏感） */
export const UUID_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * JSON Schema 字段用的字面正则源（不带前后 `/` 与 flags）。
 *
 * 直接喂给 `{ type: 'string', pattern: '...' }`，与 UUID_PATTERN 同源同义，
 * 避免 6+ 处 schema inline 复刻同一字面量（R-fix-uuid-schema-dedup）：
 * 规则微调（加 version/variant 校验、改大小写策略、放宽到 nanoid-style 等）
 * 一处改全栈自动同步，不留 schema 与运行时漂移的口子。
 *
 * 注意：必须是字符串（`.source`），不是 RegExp —— JSON Schema 反序列化
 * （LLM 工具集 / ipc 序列化）会把 RegExp 拍平成空对象，pattern 字段丢失。
 */
export const UUID_SCHEMA_PATTERN: string = UUID_PATTERN.source

/**
 * 判断字符串是否为合法 UUID（RFC 4122 8-4-4-4-12 hex）。
 *
 * 注意：与 `crypto.randomUUID()` 输出完全兼容；历史 noteId / stickyId /
 * toolCallId 一律是 v4，对外校验保持旧规则不变（不强制 version 位）。
 */
export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}