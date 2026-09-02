/**
 * 笔记模块状态管理（Zustand）
 *
 * 缓存笔记列表、当前打开笔记的文件状态机。
 * 通过 window.api（IPC）调用主进程笔记服务。
 */
import { create } from 'zustand'
import type { ID, Note, NoteFolder, NoteFolderColor, NoteMeta } from '@shared/types'
import { noteFoldersApi } from '../lib/ipc'

/** 文件三态：clean / modified / conflict */
export type FileStateKind = 'clean' | 'modified' | 'conflict'

/** 笔记筛选模式 */
export type NotesFilter = 'all' | 'starred' | 'archived'

/**
 * 当前选中的文件夹过滤：
 *   - undefined：不过滤（"全部笔记"视图）
 *   - null    ：仅展示「未分类」笔记（folder_id IS NULL）
 *   - string  ：仅展示该文件夹下的笔记
 */
export type FolderSelection = ID | null | undefined

interface NotesState {
  /** 笔记元数据列表 */
  notes: NoteMeta[]
  /** 加载状态 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 当前打开的笔记路径 */
  currentPath: string | null
  /** 当前打开的笔记完整内容 */
  currentNote: Note | null
  /** 当前笔记的本地编辑草稿（未保存） */
  draftContent: string | null
  /** 各文件的冲突状态机 */
  fileStates: Record<string, FileStateKind>
  /** 搜索关键词 */
  searchQuery: string
  /** 筛选模式 */
  filter: NotesFilter
  /** 当前选中的标签（null = 全部） */
  activeTag: string | null

  /** 文件夹列表（按 order_num ASC） */
  folders: NoteFolder[]
  /** 当前选中的文件夹过滤（undefined = 全部） */
  activeFolderId: FolderSelection

  /** 拉取笔记列表（按 filter / activeFolderId / activeTag / searchQuery） */
  fetch: () => Promise<void>
  /** 拉取文件夹列表 */
  fetchFolders: () => Promise<void>
  /** 创建文件夹 */
  createFolder: (input: { name: string; color?: NoteFolderColor | null }) => Promise<NoteFolder | null>
  /** 重命名 / 改色文件夹 */
  renameFolder: (id: ID, patch: { name?: string; color?: NoteFolderColor | null }) => Promise<void>
  /** 删除文件夹（关联笔记 folder_id → NULL） */
  deleteFolder: (id: ID) => Promise<{ deleted: boolean; detachedNotes: number } | null>
  /** 设置当前选中文件夹 */
  setActiveFolder: (id: FolderSelection) => void
  /** 把笔记移到指定文件夹（id = null = 未分类） */
  moveNoteToFolder: (noteId: ID, folderId: ID | null) => Promise<void>

  /** 打开笔记 */
  open: (path: string) => Promise<void>
  /** 关闭当前笔记 */
  close: () => void
  /** 新建笔记 */
  create: (filename?: string, content?: string) => Promise<Note | null>
  /** 保存草稿（可选 frontmatter 用于 tags / starred / archived 等元数据写入） */
  save: (
    path: string,
    content: string,
    frontmatter?: Record<string, unknown>,
  ) => Promise<void>
  /** 删除笔记 */
  remove: (path: string) => Promise<void>
  /** 搜索 */
  search: (query: string) => Promise<void>
  /** 设置筛选 */
  setFilter: (f: NotesFilter) => void
  setActiveTag: (tag: string | null) => void
  /** 上报本地编辑（驱动 conflict 状态机） */
  reportEdit: (path: string, content: string) => Promise<void>
  /** 解决冲突 */
  resolve: (
    path: string,
    resolution: 'keepLocal' | 'keepRemote' | 'merge',
    mergedContent?: string,
  ) => Promise<void>
  /**
   * R11 修复 (high #4)：每个 path 一个递增计数器；resolve(keepRemote|merge) 后
   * 自增，NoteEditor 用 `${path}::${reloadSignals[path]}` 作 key 强制 TipTap 重挂载，
   * 读到磁盘 / 合并后的最新内容。否则 TipTap 仍持有用户的旧本地内容，autosave
   * 在下一个 1.5s tick 把它覆盖回磁盘 → 用户的"解决"动作被悄悄撤销。
   */
  reloadSignals: Record<string, number>
  /** 重置 */
  reset: () => void
}

/** 防止快速切换 folder 时旧请求覆盖新结果（BUG 1：stale fetch race） */
let fetchSeq = 0
/** `open()` 的 path-based stale 守卫（B1-fix）：以发起请求时的路径为准，回包时若 currentPath 已变则丢弃 */
let openSeq = 0
/** `create()` 的 stale 守卫（B4-fix）：并多次点新建时只有最后一次的回包才被采纳 */
let createSeq = 0
/** `search()` 的 stale 守卫（B2-fix）：typing 时只采纳最后一次 query 的回包 */
let searchSeq = 0
/** `setActiveTag()` 的 stale 守卫（B3-fix）：快速切换 tag 时只有最后一次的回包才被采纳 */
let tagSeq = 0

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  loading: false,
  error: null,
  currentPath: null,
  currentNote: null,
  draftContent: null,
  fileStates: {},
  searchQuery: '',
  filter: 'all',
  activeTag: null,
  folders: [],
  activeFolderId: undefined,
  reloadSignals: {},

  async fetch() {
    const seq = ++fetchSeq
    set({ loading: true, error: null })
    try {
      const { filter, activeFolderId } = get()
      // 文件夹过滤与 filter（all/starred/archived）独立 —— 先按文件夹收窄，再叠加 archived/starred
      const folderPart =
        activeFolderId === undefined
          ? null
          : activeFolderId === null
            ? { folderId: null as ID | null }
            : { folderId: activeFolderId }

      // 若用户选定了具体文件夹，使用文件夹级接口，避免拉全表后在客户端筛选
      let notes: NoteMeta[]
      if (folderPart !== null) {
        notes = await noteFoldersApi.listByFolder(folderPart.folderId, {
          archived: filter === 'archived' ? true : false,
        })
        // star 过滤仍然在客户端做（folder API 没有 starred 参数）
        if (filter === 'starred') {
          notes = notes.filter((n) => n.isFavorite)
        }
      } else if (filter === 'starred') {
        notes = await window.api.invoke('note:list', { starred: true, archived: false })
      } else if (filter === 'archived') {
        notes = await window.api.invoke('note:list', { archived: true })
      } else {
        notes = await window.api.invoke('note:list', { archived: false })
      }
      // 只在 seq 仍是当前最新一次时才提交 —— 否则丢弃这次结果
      if (seq !== fetchSeq) return
      set({ notes, loading: false })
    } catch (err) {
      if (seq !== fetchSeq) return
      set({ error: (err as Error).message, loading: false })
    }
  },

  async fetchFolders() {
    try {
      const folders = await noteFoldersApi.list()
      set({ folders })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async createFolder(input) {
    try {
      const folder = await noteFoldersApi.create(input)
      set((s) => ({ folders: [...s.folders, folder].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)) }))
      return folder
    } catch (err) {
      set({ error: (err as Error).message })
      return null
    }
  },

  async renameFolder(id, patch) {
    try {
      const updated = await noteFoldersApi.update(id, patch)
      if (updated) {
        set((s) => ({
          folders: s.folders
            .map((f) => (f.id === id ? updated : f))
            .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
        }))
      }
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async deleteFolder(id) {
    try {
      const result = await noteFoldersApi.delete(id)
      set((s) => ({
        folders: s.folders.filter((f) => f.id !== id),
        // 若删除的是当前激活文件夹，回退到 "全部"
        activeFolderId: s.activeFolderId === id ? undefined : s.activeFolderId,
      }))
      // 关联笔记的 folder_id 已被置 NULL —— 重拉列表以刷新视图
      await get().fetch()
      return result
    } catch (err) {
      set({ error: (err as Error).message })
      return null
    }
  },

  setActiveFolder(id) {
    // B6-fix：切换文件夹时同时清掉 searchQuery —— 否则搜索框留着旧文本，
    // 但 notes 已经变成该文件夹的列表，造成 UI 与列表不一致。
    set({ activeFolderId: id, activeTag: null, searchQuery: '' })
    void get().fetch()
  },

  async moveNoteToFolder(noteId, folderId) {
    // BUG 5：跳过 no-op 移动（同 folder → 同 folder）—— 避免无谓 IPC + DB UPDATE
    const existing = get().notes.find((n) => n.id === noteId)
    if (existing && (existing.folderId ?? null) === (folderId ?? null)) return
    try {
      await noteFoldersApi.moveNote(noteId, folderId)
      // BUG 2：按当前 activeFolderId 决定该笔记是否仍在视野中
      const { activeFolderId } = get()
      const inScope =
        activeFolderId === undefined ||
        (activeFolderId === null && folderId === null) ||
        activeFolderId === folderId

      // BUG 4：同时更新 currentNote 引用 —— 防止 NoteMetaPanel 重新打开时读旧值
      set((s) => ({
        notes: inScope
          ? s.notes.some((n) => n.id === noteId)
            ? s.notes.map((n) => (n.id === noteId ? { ...n, folderId } : n))
            : // 笔记原本不在视野里，现在进入了 —— 这里保守地重新拉一次
              s.notes
          : s.notes.filter((n) => n.id !== noteId),
        currentNote:
          s.currentNote && s.currentNote.id === noteId
            ? { ...s.currentNote, folderId }
            : s.currentNote,
      }))
      // 笔记从视野外移入视野时，重新拉一次以拿到完整 row
      if (inScope && existing === undefined) {
        void get().fetch()
      }
    } catch (err) {
      set({ error: (err as Error).message })
      // 失败时回拉一次
      void get().fetch()
    }
  },

  async open(path) {
    // B1-fix：path-based stale 守卫。
    // 若在 readNote 进行中用户又 open() 了别的 note，回包时只采纳 currentPath 仍是
    // 本次发起 path 的那个。
    const seq = ++openSeq
    try {
      const note = await window.api.invoke<string, Note | null>('note:read', path)
      if (seq !== openSeq) return
      if (note) {
        set({
          currentPath: path,
          currentNote: note,
          draftContent: note.content,
        })
        // 初始化 fileState 为 clean
        set((s) => ({
          fileStates: { ...s.fileStates, [path]: 'clean' },
        }))
      }
    } catch (err) {
      if (seq !== openSeq) return
      set({ error: (err as Error).message })
    }
  },

  close() {
    set({ currentPath: null, currentNote: null, draftContent: null })
  },

  async create(filename, content = '') {
    // B4-fix：createSeq 守卫 + 把 folderId 传给后端，让新建笔记直接落到当前文件夹
    const seq = ++createSeq
    try {
      const { activeFolderId } = get()
      const folderId = activeFolderId === undefined ? null : activeFolderId
      const note = await window.api.invoke<
        { content: string; filename?: string; folderId?: string | null },
        Note
      >('note:write', { content, filename, folderId })
      if (seq !== createSeq) return null
      // 重新拉取列表（fetchSeq 已是最新，会覆盖前面的结果）
      await get().fetch()
      if (seq !== createSeq) return null
      set({ currentPath: note.path, currentNote: note, draftContent: note.content })
      return note
    } catch (err) {
      if (seq !== createSeq) return null
      set({ error: (err as Error).message })
      return null
    }
  },

  async save(path, content, frontmatter) {
    // B4-fix：path-based 守卫。如果保存进行中用户切换到了别的笔记，回包时只采纳
    // currentPath 仍是本次 path 的那个。
    const prevPath = get().currentPath
    try {
      // R11 修复 (high #8)：save 支持可选 frontmatter，让 NoteMetaPanel 改 tags
      // 时也能真正落盘到磁盘。原版 NoteMetaPanel.persistTags() 是个空函数，
      // UI 上加了 chip 但磁盘没写，下次打开笔记 chip 消失。frontmatter 字段会
      // 透传到主进程 writeNote 的 stringifyFrontmatter，写进文件 YAML 头。
      const note = await window.api.invoke<
        { path: string; content: string; frontmatter?: Record<string, unknown> },
        Note
      >('note:write', frontmatter ? { path, content, frontmatter } : { path, content })
      // currentPath 已被其他操作改走则丢弃（用 prevPath 比较避免 open() 的 seq 误伤）
      if (get().currentPath !== path && prevPath === path) {
        // 仍要更新 fileStates，避免状态机停留在 modified
        set((s) => ({
          fileStates: { ...s.fileStates, [path]: 'clean' },
        }))
        return
      }
      set((s) => ({
        currentNote: note,
        draftContent: content,
        fileStates: { ...s.fileStates, [path]: 'clean' },
      }))
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async remove(path) {
    try {
      await window.api.invoke<string, boolean>('note:delete', path)
      set((s) => ({
        notes: s.notes.filter((n) => n.path !== path),
        currentPath: s.currentPath === path ? null : s.currentPath,
        currentNote: s.currentPath === path ? null : s.currentNote,
        draftContent: s.currentPath === path ? null : s.draftContent,
      }))
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async search(query) {
    // B2-fix：searchSeq 守卫 + 把 activeFolderId 透传给后端，
    // 让搜索在指定文件夹内进行，而不是跨文件夹合并结果。
    const seq = ++searchSeq
    const trimmed = query.trim()
    // B-search-state-1-fix：state 里也存 trimmed 版本，避免 input 显示与实际查询不一致
    set({ searchQuery: trimmed })
    if (!trimmed) {
      // B-search-state-2-fix：跨计数器的清空 —— 让 searchSeq 增加后立刻清空 notes，
      // 防止随后的 fetch() 拿到一个非空结果，但 seq 已经领先了。
      set({ notes: [] })
      await get().fetch()
      return
    }
    try {
      const folderIdAtStart = get().activeFolderId
      const folderId =
        folderIdAtStart === undefined ? undefined : folderIdAtStart
      const results = await window.api.invoke<
        { query: string; limit?: number; folderId?: string | null },
        NoteMeta[]
      >('note:search', { query: trimmed, folderId })
      if (seq !== searchSeq) return
      // B-search-state-3-fix：IPC 进行中若 activeFolderId 变了，结果属于旧文件夹，不能覆盖。
      if (get().activeFolderId !== folderIdAtStart) return
      set({ notes: results })
    } catch (err) {
      if (seq !== searchSeq) return
      // B7-fix：错误路径下也清空结果，避免「输入框显示错误查询但列表还展示旧结果」
      set({ error: (err as Error).message, notes: [] })
    }
  },

  setFilter(f) {
    set({ filter: f, activeTag: null, searchQuery: '' })
    // 触发 fetch
    void get().fetch()
  },

  setActiveTag(tag) {
    // B3-fix：tagSeq 守卫 + 把 activeFolderId 透传给后端 + 切换 tag 时清掉 searchQuery
    const seq = ++tagSeq
    set({ activeTag: tag, searchQuery: '' })
    if (!tag) {
      // B-tag-state-1-fix：跨计数器清空 —— 避免随后的 fetch() 把陈旧结果盖上来
      set({ notes: [] })
      void get().fetch()
      return
    }
    const folderIdAtStart = get().activeFolderId
    const folderId =
      folderIdAtStart === undefined ? undefined : folderIdAtStart
    void window.api
      .invoke<
        { tag: string; folderId?: string | null },
        NoteMeta[]
      >('note:tag-list', { tag, folderId })
      .then((notes) => {
        if (seq !== tagSeq) return
        // B-tag-state-2-fix：IPC 进行中若 activeFolderId 变了，结果属于旧文件夹
        if (get().activeFolderId !== folderIdAtStart) return
        set({ notes })
      })
      .catch((err) => {
        if (seq !== tagSeq) return
        set({ error: (err as Error).message, notes: [] })
      })
  },

  async reportEdit(path, content) {
    try {
      const res = await window.api.invoke<{ path: string; content: string }, { state: FileStateKind }>(
        'note:report-edit',
        { path, content },
      )
      set((s) => ({
        fileStates: { ...s.fileStates, [path]: res.state },
        draftContent: content,
      }))
    } catch (err) {
      // 静默失败
      console.warn('[notes] reportEdit failed', err)
    }
  },

  async resolve(path, resolution, mergedContent) {
    try {
      const res = await window.api.invoke<
        { path: string; resolution: 'keepLocal' | 'keepRemote' | 'merge'; mergedContent?: string },
        { state: FileStateKind | null }
      >('note:resolve', { path, resolution, mergedContent })
      // R11 修复 (high #4)：resolve 后 bump reloadSignals[path]，NoteEditor 据此
      // 重挂载 TipTap 读到磁盘最新版本。否则 TipTap 仍持有用户旧本地内容，下一次
      // autosave 把磁盘覆盖回去，用户的"解决"动作被悄悄撤销。同时对 keepRemote /
      // merge 路径重新读笔记，更新 currentNote.content / draftContent；keepLocal
      // 只 bump 信号即可，TipTap 会自然带用户的本地内容（path 不变）。
      const needsReload = resolution === 'keepRemote' || resolution === 'merge'
      set((s) => ({
        fileStates: {
          ...s.fileStates,
          [path]: res.state ?? 'clean',
        },
        reloadSignals: {
          ...s.reloadSignals,
          [path]: (s.reloadSignals[path] ?? 0) + 1,
        },
      }))
      if (needsReload && get().currentPath === path) {
        // 重新打开同一 path 拉最新 Note，NoteEditor 的 useEffect 会读到 currentNote.content
        // 并把 draftMd 同步到 store；reloadSignals 已经让 TipTap 重挂载，二者一致。
        try {
          await get().open(path)
        } catch (err) {
          set({ error: (err as Error).message })
        }
      }
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  reset() {
    set({
      notes: [],
      loading: false,
      error: null,
      currentPath: null,
      currentNote: null,
      draftContent: null,
      fileStates: {},
      searchQuery: '',
      filter: 'all',
      activeTag: null,
      folders: [],
      activeFolderId: undefined,
    })
  },
}))
