/**
 * IPC 入参边界常量 —— 主进程侧跨 handler 的统一上限 / 白名单
 *
 * 历史：R12 / R16 / R17 / R19 / R25 / R31 / R32 / R33 等多轮修复在
 * ai-handlers.ts 与 conversation-handlers.ts 各有一份近乎重复的
 * 字节上限 / role 白名单。两份实现已经多次因为「一边加约束、另一边
 * 忘了」而分叉：
 *   - R12 在 ai-handlers 引入 MAX_MESSAGE_CONTENT_BYTES = 200_000
 *   - R31-Sec-2 在 conversation-handlers 又引入同名的 200_000
 *     （之前是 ad-hoc 数字，R31 之后才显式对齐）
 *   - R16 在两边各引入 role 白名单
 *   - R19 才把 ai-handlers 收窄到 user|assistant
 *
 * 把字节上限、role 白名单提到本文件作为单一来源。当前消费方：
 *   - src/main/ipc/ai-handlers.ts              (ai:stream / ai:estimate-tokens)
 *   - src/main/ipc/conversation-handlers.ts    (AI_APPEND_MESSAGE)
 *
 * ipcSanitizers.ts 已统一了 toolCallKeyRe / helperKeyRe 的正则 + strip
 * 逻辑；本文件补齐「字节上限 / 角色白名单」这一组共享约束。下一次新增
 * 跨 handler 约束（如「消息标题长度上限」「跨 session 持久化的 token
 * 上限」）也放这里。
 */

/**
 * ai:stream / ai:estimate-tokens 单次请求允许的消息条数。R12 修复
 * 引入，防止被劫持渲染端发数千条巨型消息阻塞主进程 + 烧 token。
 */
export const MAX_STREAM_MESSAGES = 200

/**
 * 单条消息（含 content + 全部自定义字段）序列化后允许的最大字节数。
 * R12 在 ai-handlers 引入，R31-Sec-2 在 conversation-handlers 补齐。
 * R32-Corr-4 修复 bypass-via-extras：渲染端可发
 * `{role:'user', content:'hi', padding:'x'.repeat(500_000_000)}`，
 * content 字节 2 但整条 MB 级 —— 校验整条 message 的 byteLength。
 */
export const MAX_MESSAGE_CONTENT_BYTES = 200_000

/**
 * ai:confirm-create-note 通道允许的笔记 content 字节上限。R16 修复
 * 引入，与 note:write 的 5 MB 对齐。
 */
export const MAX_NOTE_CONTENT_BYTES = 5 * 1024 * 1024

/**
 * 对话标题允许的最大字节数（UTF-8）。conversation-handlers 的
 * AI_CREATE_CONVERSATION / AI_UPDATE_TITLE 使用。
 */
export const MAX_TITLE_BYTES = 500

/**
 * AI provider 字段允许的最大字节数（UTF-8）。conversation-handlers 的
 * AI_CREATE_CONVERSATION 使用。
 *
 * R45-fix-conversation-provider-model-oversize (medium input-validation-
 * resource-exhaustion)：原 handler 只校验 input.title 的 byteLength，
 * 对 provider / model 仅读 TS 类型。被攻渲染端可发
 * `{provider:'A'.repeat(50_000_000), model:'B'.repeat(50_000_000)}` 写
 * 入 ai_conversations 单条 ~100 MB 行，让 findAll(limit) 扫描撑爆
 * IPC reply 内存（JSON 化 + structured-clone 翻倍）。合法值集合已知
 * 且小（openai/anthropic/gemini/ollama/...），64 字节足够任何合理
 * provider 名。
 */
export const MAX_PROVIDER_BYTES = 64

/**
 * AI model 字段允许的最大字节数（UTF-8）。conversation-handlers 的
 * AI_CREATE_CONVERSATION 使用。详见 MAX_PROVIDER_BYTES 注释 —— model
 * 名可能更长（含版本号 / 日期戳 / 标识符后缀），128 字节足够但仍
 * 拒掉 MB 级攻击 payload。
 */
export const MAX_MODEL_BYTES = 128

/**
 * 渲染端允许写入历史 / 提交给 ai:stream 的 role 白名单。
 *
 * R16 修复 (critical security)：拒绝渲染端提交 role:'system' 消息，
 * 防止 XSS / 恶意依赖在历史里塞假 system 覆盖服务端 SYSTEM_PROMPT。
 *
 * R17 修复 (critical security)：进一步收窄到 user|assistant。role:'tool'
 * 消息由主进程工具循环（tools.ts / stream.ts）内部 append 调用
 * conversationsRepo.appendMessage 写入，绕过 IPC。渲染端伪造 tool 消息
 * 会让 LLM 误信之前工具已产生副作用。
 *
 * R19 修复：ai:stream 的 ALLOWED_MESSAGE_ROLES 也同步收窄。
 */
export const ALLOWED_MESSAGE_ROLES = new Set(['user', 'assistant'])

/**
 * 同 ALLOWED_MESSAGE_ROLES。conversation-handlers 历史上用了不同的
 * 命名以避免「两边都是同名常量但语义可能漂移」的歧义；本文件统一
 * 收敛到单一来源后，保留同名导出让 conversation-handlers 的代码不
 * 变（语义 = 渲染端可写角色集合 = user|assistant）。
 */
export const RENDERER_ALLOWED_MESSAGE_ROLES = ALLOWED_MESSAGE_ROLES
