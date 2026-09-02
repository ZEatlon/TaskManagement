# MiniMax Provider 集成说明

本文档说明 TaskPilot 中 **MiniMax（minimax）** 这一第三方 AI Provider 的接入方式、可用模型与使用注意事项。

## 1. 背景

MiniMax 提供与 Anthropic Messages API 完全兼容的端点：

- Base URL：`https://api.minimaxi.com`
- Endpoint：`POST /anthropic/v1/messages`
- 鉴权：`Authorization: Bearer <API_KEY>`（也支持 `x-api-key`）

因此我们直接复用 `@anthropic-ai/sdk`，通过覆盖 `baseURL` + `authToken` 来指向 MiniMax，
**消息 / 工具的转换逻辑与 Anthropic 完全一致**，没有额外的协议适配层。

## 2. 入口：如何启用

1. 打开应用 → **设置** → **AI** Tab
2. Provider 下拉框选择 **MiniMax**
3. 在弹出的 **MiniMax API Key** 输入框中填入形如 `sk-cp-...` 的密钥
4. 点击 **保存 MiniMax Key**（密钥会通过 Electron `safeStorage` 加密后存入系统 keychain）
5. 模型下拉框中选择要使用的模型（默认 `MiniMax-M3`）
6. 回到 AI 聊天面板，顶部模型选择器选择 **MiniMax** + 对应模型即可开始对话

> **可暂时不填 API Key**：未配置时应用不会崩溃，仅在真正发起对话 / 测试连接时会提示「MiniMax API Key 未配置，请前往设置页面填写」。

## 3. 可用模型

`MinimaxProvider.listModels()` 静态返回以下模型：

| 模型 ID                  | 类型         | 上下文 | 备注                                          |
| ------------------------ | ------------ | ------ | --------------------------------------------- |
| `MiniMax-M3`             | 多模态       | 1M     | 支持 thinking 扩展、tool use、图文、视频理解  |
| `MiniMax-M2.7-highspeed` | 文本 + 工具  | —      | 高速版                                        |
| `MiniMax-M2.7`           | 文本 + 工具  | —      |                                               |
| `MiniMax-M2.5`           | 文本 + 工具  | —      |                                               |
| `MiniMax-M2.5-highspeed` | 文本 + 工具  | —      | 测试连接默认用这个                            |
| `MiniMax-M2.1`           | 文本 + 工具  | —      |                                               |
| `MiniMax-M2.1-highspeed` | 文本 + 工具  | —      |                                               |
| `MiniMax-M2`             | 文本 + 工具  | —      |                                               |

### 3.1 关于 `MiniMax-M3` 多模态

- 当前 UI 仅走文本流，**图片 / 视频理解通道尚未启用**。
- 后续如需在附件管线中接入多模态，可直接利用 Anthropic SDK 的 `image` block：
  ```ts
  messages.push({
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
      { type: 'text', text: '请描述这张图片' },
    ],
  })
  ```
  协议层无需任何额外改动。

### 3.2 关于 `thinking` 扩展

`thinking: { type: 'adaptive' }` 是 MiniMax-M3 的扩展参数，
Anthropic SDK 的官方类型里没有声明字段，Provider 内通过 `as unknown as Parameters<...>[0]`
透传；切换到 M3 时会自动附加，其他模型不会下发该参数，避免被服务端拒绝。

## 4. 代码结构

| 文件                                       | 说明                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/main/ai/anthropicCompat.ts`           | 抽出 `toAnthropicMessages` / `toAnthropicTools`，Anthropic / MiniMax 共用     |
| `src/main/ai/anthropic.ts`                 | Anthropic 官方 Provider；改用共享 helper 实现                                  |
| `src/main/ai/minimax.ts`                   | MiniMax Provider：自定义 `baseURL` + `authToken`，复用 Anthropic SDK 流式逻辑 |
| `src/main/ai/router.ts`                    | 把 `ProviderId` 联合类型扩展为 `'openai' \| 'anthropic' \| 'minimax'`         |
| `src/main/security/keychain.ts`            | 在 `SECRET_KEYS` 中新增 `MINIMAX_API_KEY: 'minimax.apiKey'`                   |
| `src/main/ipc/ai-handlers.ts`              | 把硬编码的 `'openai' \| 'anthropic'` 改为共享的 `ProviderId`                  |
| `src/shared/ipc/channels.ts`               | `AppSettings` / `DEFAULT_SETTINGS` 增加 `aiMinimaxModel`                      |
| `src/renderer/src/lib/ipc.ts`              | `securityApi` / `aiApi` / `AiProviderInfo` 联合类型扩展                       |
| `src/renderer/src/stores/ai.ts`            | `newConversation` 接受 `'minimax'`                                            |
| `src/renderer/src/components/ai/ModelSelector.tsx` | Provider 下拉中包含 MiniMax 模型列表                                |
| `src/renderer/src/components/ai/ChatPanel.tsx`     | `effectiveProvider` 支持 minimax，`onChangeProvider` / `onChangeModel` 分发 |
| `src/renderer/src/components/settings/tabs/AITab.tsx` | AITab 增加 MiniMax 选项 + Key 输入框                              |

## 5. 兼容性与降级

- `AppSettings.aiProvider` 现在是 `'openai' \| 'anthropic' \| 'minimax' \| null`。
  旧版本持久化的 `aiOpenaiModel` / `aiAnthropicModel` 字段保持不变；
  新增的 `aiMinimaxModel` 在首次访问 settings 时会被 `DEFAULT_SETTINGS` 合并进去。
- `app.ai` 这个旧 key 仍是 AITab 的写入位置；ChatPanel 在切换 Provider 时会同步写一份兼容值。
- `security:set` / `security:get` / `security:delete` 通过 `SecretKey` 联合类型校验，
  新增 `minimax.apiKey` 自动获得支持，无需改 IPC 处理器签名。
- 测试连接默认使用 `MiniMax-M2.5-highspeed`（轻量、便宜、几乎一定能跑通），
  不会消耗大量 token。

## 6. 已知限制 / 后续工作

- **多模态 UI**：当前 MessageInput 仅支持文本；接入图片附件后即可使用 `MiniMax-M3` 的多模态能力。
- **思考模式（thinking）**：仅 M3 默认开启 `adaptive`，后续如需让用户手动切换，
  可以在 AITab 的模型下拉旁加一个开关，把 `thinking.type` 改成 `'enabled' | 'disabled'`。
- **API Key 校验**：测试连接只发一条 `max_tokens: 8` 的 ping；如果 MiniMax 在限流时段内拒绝，
  错误信息会原样透出到 UI。
