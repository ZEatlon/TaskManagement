/**
 * App 顶层组件
 * 由 __root.tsx 直接使用
 */
import type { ReactNode } from 'react'

export function App({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export default App