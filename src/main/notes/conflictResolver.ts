/**
 * 笔记冲突解决器（三态机）
 *
 * 状态机：
 *   clean      → 磁盘 == 内存（无变化）
 *   modified   → 内存或磁盘一方发生了变化
 *   conflict   → 内存与磁盘双方都发生了变化
 *
 * 转换规则：
 *   - 用户内存编辑         → modified（若 diskHash == memHash 则回到 clean）
 *   - 磁盘 change 事件     → 若 memHash != diskHash 且 memDirty 为 true → conflict
 *                          → 否则仅更新 diskHash
 *   - 内存成功写入磁盘     → clean
 *   - 用户主动选择 keepLocal / keepRemote / merge → clean
 *
 * 用 SHA1 哈希跟踪每个文件的 diskHash 与 memHash，以及 memDirty 标志。
 */
import { createHash } from 'node:crypto'

/** 文件状态枚举 */
export type FileStateKind = 'clean' | 'modified' | 'conflict'

/** 单个文件的状态条目 */
export interface FileState {
  /** 文件绝对路径作为 key */
  path: string
  /** 磁盘当前内容哈希（最后一次观察到） */
  diskHash: string | null
  /** 内存中的内容哈希（最近一次设置） */
  memHash: string | null
  /** 内存是否有未持久化的改动 */
  memDirty: boolean
  /** 最近一次计算得到的展示状态 */
  state: FileStateKind
  /** 最近一次转换时间 ISO */
  updatedAt: string
  /** 触发最近一次变化的来源（用于调试/展示） */
  reason?: string
}

/** 冲突解决动作 */
export type ConflictResolution = 'keepLocal' | 'keepRemote' | 'merge'

export class ConflictResolver {
  private states = new Map<string, FileState>()

  /**
   * 计算字符串的 SHA1（用于差异检测）
   */
  static hash(text: string | null | undefined): string {
    if (text == null) return ''
    return createHash('sha1').update(text, 'utf8').digest('hex')
  }

  /**
   * 获取或创建某路径的状态条目
   */
  private ensure(path: string): FileState {
    let s = this.states.get(path)
    if (!s) {
      s = {
        path,
        diskHash: null,
        memHash: null,
        memDirty: false,
        state: 'clean',
        updatedAt: new Date().toISOString(),
      }
      this.states.set(path, s)
    }
    return s
  }

  /**
   * 报告一次磁盘侧变化（chokidar add/change 事件）
   * - 更新 diskHash
   * - 若 memDirty 为 true 且 memHash != 新 diskHash → 进入 conflict
   * - 否则若 memDirty 且相等 → clean
   */
  onDiskChange(path: string, content: string, reason = 'disk-change'): FileState {
    const s = this.ensure(path)
    const newDiskHash = ConflictResolver.hash(content)
    const newHash = newDiskHash === s.memHash
    s.diskHash = newDiskHash
    if (s.memDirty) {
      // 内存脏，但磁盘已变 → 冲突
      s.state = newHash ? 'clean' : 'conflict'
    } else {
      // 内存无改动 → 同步内存哈希
      s.memHash = newDiskHash
      s.state = 'clean'
    }
    s.updatedAt = new Date().toISOString()
    s.reason = reason
    return { ...s }
  }

  /**
   * 报告一次内存侧编辑（用户输入）
   * - 更新 memHash 并标记 memDirty=true
   * - 与 diskHash 对比，决定 clean / modified
   *
   * 注意：单边（内存）变化只能进入 `modified`，不能直接进入 `conflict`。
   * `conflict` 必须由 `onDiskChange` 在检测到 memDirty=true 时升格（外部写入）。
   */
  onMemoryEdit(path: string, content: string, reason = 'memory-edit'): FileState {
    const s = this.ensure(path)
    const newMemHash = ConflictResolver.hash(content)
    s.memHash = newMemHash
    s.memDirty = true
    s.state = s.diskHash === newMemHash ? 'clean' : 'modified'
    s.updatedAt = new Date().toISOString()
    s.reason = reason
    return { ...s }
  }

  /**
   * 报告一次成功写入磁盘（内存→磁盘）
   * - 把磁盘哈希与内存哈希同步
   * - 清空 memDirty
   */
  onMemoryWrite(path: string, content: string, reason = 'memory-write'): FileState {
    const s = this.ensure(path)
    const newHash = ConflictResolver.hash(content)
    s.memHash = newHash
    s.diskHash = newHash
    s.memDirty = false
    s.state = 'clean'
    s.updatedAt = new Date().toISOString()
    s.reason = reason
    return { ...s }
  }

  /**
   * 报告文件被删除
   */
  onDelete(path: string, _reason = 'delete'): void {
    this.states.delete(path)
  }

  /**
   * 解决冲突：keepLocal / keepRemote / merge
   * - keepLocal：保留内存内容（视为再次写入磁盘）
   * - keepRemote：丢弃内存改动（恢复 memHash = diskHash，memDirty = false）
   * - merge：调用方传入合并后内容，视为写入
   */
  resolve(
    path: string,
    resolution: ConflictResolution,
    mergedContent?: string,
  ): FileState | null {
    const s = this.states.get(path)
    if (!s) return null

    if (resolution === 'keepRemote') {
      // 以磁盘版本覆盖内存
      s.memHash = s.diskHash
      s.memDirty = false
      s.state = 'clean'
    } else if (resolution === 'keepLocal') {
      // R7G-7 修复：原三元表达式两边都是 'modified'，纯粹是死代码。
      // 真正意图：mem 与 disk 不一致 → 标记 modified（待写盘）；一致 → clean。
      s.memDirty = true
      s.state = s.memHash !== s.diskHash ? 'modified' : 'clean'
      if (s.memHash === s.diskHash) {
        s.memDirty = false
      }
    } else if (resolution === 'merge' && mergedContent !== undefined) {
      const newHash = ConflictResolver.hash(mergedContent)
      s.memHash = newHash
      s.memDirty = true
      // 合并后视作待写盘状态：modified（待 write 后转 clean）
      s.state = 'modified'
    }
    s.updatedAt = new Date().toISOString()
    s.reason = `resolve:${resolution}`
    return { ...s }
  }

  /** 获取某文件的当前状态 */
  get(path: string): FileState | null {
    const s = this.states.get(path)
    return s ? { ...s } : null
  }

  /** 获取全部状态 */
  all(): FileState[] {
    return Array.from(this.states.values()).map((s) => ({ ...s }))
  }

  /** 清空所有状态 */
  clear(): void {
    this.states.clear()
  }

  /**
   * 根据给定文件路径集合重建状态（用于扫描后初始化）。
   * 给定 path → content 映射后，等同于一次磁盘变更。
   */
  hydrate(files: Array<{ path: string; content: string }>): void {
    for (const f of files) {
      this.onDiskChange(f.path, f.content, 'hydrate')
    }
  }
}

/** 单例 */
export const conflictResolver = new ConflictResolver()
