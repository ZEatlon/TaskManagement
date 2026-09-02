/**
 * AI 对话文件夹 IPC 处理器
 *
 * 暴露给渲染端的通道：
 *   - ai-conv-folder:list    列出所有文件夹（按 order_num ASC）
 *   - ai-conv-folder:create  新建文件夹
 *   - ai-conv-folder:update  重命名 / 改色 / 改 order
 *   - ai-conv-folder:delete  删除文件夹（关联 conversations folder_id → NULL）
 *   - ai:set-conversation-folder 把对话移到指定文件夹
 *   - ai:count-by-folder 统计某 folder 下对话数
 */
import { handle } from './channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { aiConversationFoldersRepo } from '../db/repositories/aiConversationFolders'
import { conversationsRepo } from '../db/repositories/conversations'
import type { AiConversationFolder, NoteFolderColor } from '@shared/types/ai'

const COLOR_PALETTE: NoteFolderColor[] = [
  'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose',
]

export function registerAiFolderHandlers(): void {
  /** 列出所有文件夹 */
  handle<undefined, AiConversationFolder[]>(
    IPC_CHANNELS.AI_LIST_CONV_FOLDERS,
    async () => {
      return aiConversationFoldersRepo.findAllOrdered()
    },
  )

  /** 新建文件夹 */
  handle<{ name: string; color?: NoteFolderColor | null }, AiConversationFolder>(
    IPC_CHANNELS.AI_CREATE_CONV_FOLDER,
    async (_e, args) => {
      const name = String(args?.name ?? '').trim()
      if (!name) throw new Error('AI_CREATE_CONV_FOLDER: 文件夹名不能为空')
      const color = args?.color ?? null
      if (color !== null && !COLOR_PALETTE.includes(color)) {
        throw new Error(`AI_CREATE_CONV_FOLDER: 非法 color 值 ${color}`)
      }
      return aiConversationFoldersRepo.create({ name, color })
    },
  )

  /** 重命名 / 改色 / 改 order */
  handle<
    { id: string; patch: { name?: string; color?: NoteFolderColor | null; order?: number } },
    AiConversationFolder | null
  >(IPC_CHANNELS.AI_UPDATE_CONV_FOLDER, async (_e, args) => {
    if (!args?.id) throw new Error('AI_UPDATE_CONV_FOLDER: 缺少 id')
    const patch = { ...args.patch }
    if (typeof patch.name === 'string') {
      patch.name = patch.name.trim()
      if (!patch.name) throw new Error('AI_UPDATE_CONV_FOLDER: 文件夹名不能为空')
    }
    if (patch.color !== undefined && patch.color !== null) {
      if (!COLOR_PALETTE.includes(patch.color)) {
        throw new Error(`AI_UPDATE_CONV_FOLDER: 非法 color 值 ${patch.color}`)
      }
    }
    return aiConversationFoldersRepo.update(args.id, patch)
  })

  /** 删除文件夹（关联 conversations folder_id → NULL） */
  handle<string, { deleted: boolean; detachedConversations: number }>(
    IPC_CHANNELS.AI_DELETE_CONV_FOLDER,
    async (_e, id) => {
      return aiConversationFoldersRepo.deleteAndDetach(id)
    },
  )

  /** 把对话移入指定文件夹（folderId = null = 未分类） */
  handle<{ id: string; folderId: string | null }, { ok: true }>(
    IPC_CHANNELS.AI_SET_CONVERSATION_FOLDER,
    async (_e, args) => {
      if (!args?.id) throw new Error('AI_SET_CONVERSATION_FOLDER: 缺少 id')
      // folderId 非 null 时校验 folder 存在
      if (args.folderId !== null && args.folderId !== undefined) {
        const folder = await aiConversationFoldersRepo.findById(args.folderId)
        if (!folder) {
          throw new Error(`AI_SET_CONVERSATION_FOLDER: 文件夹不存在 ${args.folderId}`)
        }
      }
      await conversationsRepo.setFolder(args.id, args.folderId ?? null)
      return { ok: true }
    },
  )

  /** 统计某 folder 下的对话数（null = 未分类） */
  handle<{ folderId: string | null }, number>(
    IPC_CHANNELS.AI_COUNT_BY_FOLDER,
    async (_e, args) => {
      return conversationsRepo.countByFolder(args?.folderId ?? null)
    },
  )
}