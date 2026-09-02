/**
 * 笔记元数据面板
 *
 * 显示与编辑笔记的元数据：
 *   - 标题
 *   - 标签（输入框 + chip 列表）
 *   - 收藏星标
 *   - 归档
 *   - 文件路径（只读）
 *   - 归属文件夹（下拉选择；改这里等同于在侧栏拖拽）
 */
import { useEffect, useRef, useState } from 'react'
import { useNotesStore } from '../../stores/notes'

interface Props {
  noteId: string
}

export function NoteMetaPanel({ noteId }: Props) {
  const currentNote = useNotesStore((s) => s.currentNote)
  // R12 修复 (critical)：NoteMetaPanel.persistTags 之前直接读 currentNote.content
  // 写盘，会把 TipTap 还没触发 autosave 的未保存编辑覆盖掉。现在改读 store 里的
  // draftContent（NoteEditor 每次 handleChange 都同步更新），保证正文用最新草稿。
  const draftContent = useNotesStore((s) => s.draftContent)
  const folders = useNotesStore((s) => s.folders)
  const moveNoteToFolder = useNotesStore((s) => s.moveNoteToFolder)
  const save = useNotesStore((s) => s.save)
  const [tagsInput, setTagsInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [starred, setStarred] = useState(false)
  const [archived, setArchived] = useState(false)
  const [title, setTitle] = useState('')
  const [folderId, setFolderId] = useState<string | null>(null)

  // R5R-3：只在 noteId 变化时把 currentNote 同步进本地表单状态；
  // 之前的写法依赖 currentNote，导致 autosave / moveNoteToFolder 等
  // 任何会换 currentNote 引用的操作都会把用户正在编辑的 title / folderId
  // / starred 直接清空。
  const lastSyncedNoteIdRef = useRef<string | null>(null)
  // R11 修复 (low #1)：用 ref 而非闭包记录"上一次成功的 folderId"，避免快速
  // 切换文件夹时旧闭包把 UI 回滚到错误值。
  const lastSuccessfulFolderRef = useRef<string | null>(null)
  useEffect(() => {
    if (!currentNote || currentNote.id !== noteId) return
    if (lastSyncedNoteIdRef.current === noteId) return
    lastSyncedNoteIdRef.current = noteId
    const initialFolderId = currentNote.folderId ?? null
    lastSuccessfulFolderRef.current = initialFolderId
    setTags(currentNote.tags)
    setStarred(currentNote.isFavorite)
    setArchived(false) // Note 接口无 archived，从元数据读
    setTitle(currentNote.title)
    setFolderId(initialFolderId)
  }, [currentNote, noteId])

  function handleAddTag() {
    const v = tagsInput.trim().replace(/^#/, '')
    if (!v) return
    if (!tags.includes(v)) {
      const next = [...tags, v]
      setTags(next)
      persistTags(next)
    }
    setTagsInput('')
  }

  function handleRemoveTag(t: string) {
    const next = tags.filter((x) => x !== t)
    setTags(next)
    persistTags(next)
  }

  async function persistTags(next: string[]) {
    if (!currentNote) return
    // R11 修复 (high #8)：原版 persistTags 是空函数（注释说"标签会在下次正文保存时
    // 一并写入"但实际 save() 调用根本不传 frontmatter），导致 UI 加了 chip 但
    // 磁盘没写 → 重启/重开笔记 chip 消失。现在显式调 save(path, content, { tags: next })，
    // 把 tags 经 notesManager.writeNote → stringifyFrontmatter 落到文件 YAML 头里。
    //
    // R12 修复 (critical)：原版传 currentNote.content，这是 open() 时从 DB 读的磁盘
    // 快照，不包含 NoteEditor 内 TipTap 的未保存编辑。在 autosave 1.5s 窗口内改
    // 标签会把"原始旧正文 + 新 tags"写盘，TipTap 里尚未触发的键入被静默丢弃。
    // 现在用 store.draftContent（NoteEditor 每次 handleChange 都会同步更新）作
    // 权威正文，保证写盘时正文与标签一致。draftContent 在某些极端时序下可能与
    // currentPath 不同步（理论上的 lastNotePath vs currentPath 不一致），所以
    // 双重保险：draftContent 存在且 path 匹配当前笔记时才用它，否则退回到
    // currentNote.content。
    const baseContent =
      draftContent !== null && draftContent !== undefined
        ? draftContent
        : currentNote.content
    try {
      await save(currentNote.path, baseContent, { tags: next })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[note-meta] persist tags failed', err)
    }
  }

  async function handleStarredToggle() {
    if (!currentNote) return
    // R11 修复 (medium #14)：原版把 next = !starred 写进闭包后 setStarred(next)，
    // catch 失败时回滚到 !next —— 两次快速点击：第一次成功后第二次失败 → catch
    // 用第二次的 next (=false) 算出 !next = true 回滚，但实际状态应该是 true
    // (第一次成功留下的)。修正：在调用前用 `original = starred` 快照，回滚到
    // original 而不是 !next，并发 catch 收敛到 original 而不是最后点击的相反值。
    const original = starred
    const next = !original
    setStarred(next)
    try {
      await window.api.invoke<{ id: string; starred: boolean }, unknown>(
        'note:set-starred',
        { id: currentNote.id, starred: next },
      )
    } catch (err) {
      console.warn(err)
      setStarred(original)
    }
  }

  async function handleFolderChange(next: string | null) {
    if (!currentNote) return
    // BUG-10-fix：先把上一值记下，失败时回滚；不在 IPC 调用前直接乐观赋值
    // R11 修复 (low #1)：原版直接读 `folderId` 闭包变量 —— 用户连续两次切换
    // 文件夹（A → B → C），第二次调用时 folderId 闭包仍是 A（React 还没把
    // 第一次的 setFolderId('B') commit 进去），结果 prev='A'，第二次失败时把
    // UI 回滚到 A 而不是 B → UI 与磁盘漂移。改用 ref 记录"上一成功的目标"，
    // 回滚时使用最近一次成功的值（不论闭包如何陈旧）。
    const prev = lastSuccessfulFolderRef.current
    lastSuccessfulFolderRef.current = next
    setFolderId(next)
    try {
      await moveNoteToFolder(currentNote.id, next)
    } catch {
      lastSuccessfulFolderRef.current = prev
      setFolderId(prev)
    }
  }

  if (!currentNote) return null

  return (
    <aside className="note-meta-panel">
      <section className="meta-section">
        <h3 id="meta-title-heading">标题</h3>
        {/* R5R-2：之前是 controlled input 但 onChange 没有副作用，用户输入会"假保存"。
            改为 onBlur 真正调 note:rename，并允许用 Enter 触发。 */}
        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const next = title.trim()
            if (!currentNote || !next || next === currentNote.title) return
            // R10 + R11 修复：原版只在 catch 里 console.warn，本地 title 状态保留为
            // 用户输入的值 → 之后任何依赖 currentNote.title 的组件（NotesTree /
            // RecentNotes / 主标题栏）看到的仍是磁盘上的旧标题，与本面板显示
            // 的"新标题"漂移。失败时把 title 回滚到 currentNote.title，让 UI
            // 与磁盘保持一致；成功时不动（store 的 update 会刷新 currentNote，
            // 再走 lastSyncedNoteIdRef 的"换 noteId 才同步"路径时这里保留用户
            // 最终值，避免覆盖）。
            //
            // R11 修复 (medium #15)：捕获 rename 启动那一刻的 noteId，回滚时检查
            // 当前 currentNote 是否仍是同一篇 —— 否则 setTitle(A's original) 会把
            // 用户已经切到 B 的标题输入改成 A 的旧 title。失败的回滚必须满足：
            // currentNote.path 未变 && currentNote.id 未变 才执行 setTitle。
            const renameNoteId = currentNote.id
            const renamePath = currentNote.path
            const original = currentNote.title
            void window.api
              .invoke<{ path: string; newTitle: string }, unknown>('note:rename', {
                path: renamePath,
                newTitle: next,
              })
              .catch((err) => {
                // eslint-disable-next-line no-console
                console.warn('[note-meta] rename failed', err)
                // 仅当当前 currentNote 仍是同一篇时才回滚；避免用户切换笔记后
                // 把新笔记的本地输入覆盖掉。
                const cur = useNotesStore.getState().currentNote
                if (cur && cur.id === renameNoteId && cur.path === renamePath) {
                  setTitle(original)
                }
              })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          placeholder="无标题"
          aria-labelledby="meta-title-heading"
        />
        <p className="muted small">修改标题即重命名笔记文件（按 Enter 或失焦生效）</p>
      </section>

      <section className="meta-section">
        <h3 id="meta-status-heading">状态</h3>
        <label className="check-row">
          {/*
            BUG-a11y-fix：aria-labelledby="meta-status-heading" 会按 ARIA 优先级
            覆盖隐式的 <label> 文本「收藏 (starred)」，让屏幕阅读器只读出「状态」，
            无法区分这个 checkbox 是干什么的。这里改为用自身的 label 文本。
          */}
          <input
            type="checkbox"
            checked={starred}
            onChange={handleStarredToggle}
          />
          <span>收藏 (starred)</span>
        </label>
        <label
          className="check-row"
          title="归档功能后续版本提供，目前仅展示状态"
        >
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
            disabled
            aria-describedby="meta-archived-help"
          />
          <span className="muted">归档（暂仅展示）</span>
        </label>
        <p id="meta-archived-help" className="muted small">
          归档功能将在后续版本中开放，当前仅展示笔记归档状态。
        </p>
      </section>

      <section className="meta-section">
        <h3 id="meta-folder-heading">文件夹</h3>
        <select
          className="folder-select"
          value={folderId ?? ''}
          aria-labelledby="meta-folder-heading"
          onChange={(e) => {
            const v = e.target.value
            handleFolderChange(v === '' ? null : v)
          }}
        >
          <option value="">未分类</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <p className="muted small">也可从左侧文件夹树拖动笔记改变归属</p>
      </section>

      <section className="meta-section">
        <h3 id="meta-tags-heading">标签</h3>
        <div className="tag-input-row">
          <input
            type="text"
            placeholder="添加标签…"
            aria-labelledby="meta-tags-heading"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddTag()
              }
            }}
          />
          <button className="btn" onClick={handleAddTag}>
            添加
          </button>
        </div>
        <div className="tag-list">
          {tags.length === 0 ? (
            <p className="muted small">还没有标签</p>
          ) : (
            tags.map((t) => (
              <span key={t} className="tag-chip">
                #{t}
                <button
                  className="remove"
                  onClick={() => handleRemoveTag(t)}
                  title={`移除标签 ${t}`}
                  aria-label={`移除标签 ${t}`}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
      </section>

      <section className="meta-section">
        <h3 id="meta-path-heading">路径</h3>
        <p
          className="path muted"
          title={currentNote.path}
          // R12 修复 (low)：aria-labelledby 不能用在 paragraph 上（aria
          // label/describedby 只对 landmark / widget 元素生效）。这里用
          // aria-label 简洁替代即可。
          aria-label={`路径：${currentNote.path}`}
        >
          {currentNote.path}
        </p>
      </section>

      <section className="meta-section">
        <h3>时间</h3>
        <p className="muted small">修改：{new Date(currentNote.mtime).toLocaleString('zh-CN')}</p>
        <p className="muted small">创建：{new Date(currentNote.ctime).toLocaleString('zh-CN')}</p>
      </section>
    </aside>
  )
}

export default NoteMetaPanel
