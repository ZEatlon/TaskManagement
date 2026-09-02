/**
 * 流式光标
 * 在正在输出的消息末尾显示一个闪烁的竖线。
 */
import { CSSProperties } from 'react'

interface Props {
  visible?: boolean
  style?: CSSProperties
}

export function StreamingCursor({ visible = true, style }: Props) {
  if (!visible) return null
  return <span className="ai-streaming-cursor" style={style} />
}

export default StreamingCursor
