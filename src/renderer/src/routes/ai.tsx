/**
 * AI 助手独立路由页
 * 渲染完整的 ChatPanel。
 */
import { ChatPanel } from '../components/ai/ChatPanel'
import { CreateNoteConfirmDialog } from '../components/ai/CreateNoteConfirmDialog'

export function AiRoute() {
  return (
    <div className="ai-page">
      <ChatPanel />
      <CreateNoteConfirmDialog />
    </div>
  )
}
