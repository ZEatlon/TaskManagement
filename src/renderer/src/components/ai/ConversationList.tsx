/**
 * 对话历史侧栏（带文件夹分组）
 *
 * 布局（完全镜像 NoteFoldersSidebar 的 2 级 tree 模式）：
 *   - 顶部：「全部对话」「未分类」（folder 过滤器）
 *   - 中间：用户文件夹列表（可展开）
 *   - 每个文件夹展开：直接列出该 folder 下的对话（前 5 条 + 「+N 更多」）
 *   - 底部：「+ 新建对话」按钮；hover 文件夹行显示重命名 / 删除
 *
 * Round 5 新增：
 *   - 文件夹 CRUD（创建 / 重命名 / 改色 / 删除）
 *   - 拖拽 conversation 行到 folder 行（drop target）
 *   - 当前选中 folder 时「新建对话」自动归入该 folder
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAiStore } from '../../stores/ai'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useTreeExpansionStore, useTreeExpanded } from '../../stores/treeExpansion'
import type { AiConversation, AiConversationFolder, NoteFolderColor } from '@shared/types/ai'

const FOLDER_PALETTE: NoteFolderColor[] = [
  'yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'teal', 'rose',
]

/** 稳定空数组引用 —— Map.get(k) ?? EMPTY_CONVS 始终返回同一引用，
 *  防止破坏下游 React.memo comparator 的引用相等。 */
const EMPTY_CONVS: AiConversation[] = []

interface Props {
  onNew: () => void
}

interface PendingDelete {
  folder: AiConversationFolder
  detachedConversations: number
}

export function ConversationList({ onNew }: Props) {
  // Perf-fix #9：data 字段 selector fan-out 收敛到一个 shallow 订阅。
  // 原版 6 个独立订阅（conversations / currentId / folders / foldersLoaded /
  // activeFolderId）每次 store set 跑 6 次 equality check；新版 1 次 shallow。
  // Action refs（select / remove / load / loadFolders / setActiveFolderId /
  // createFolder / renameFolder / deleteFolder / moveConversationToFolder）
  // 走单独订阅 —— 它们是 stable fn ref，每次渲染返回同一引用，零开销。
  const { conversations, currentId, folders, foldersLoaded, activeFolderId } = useAiStore(
    useShallow((s) => ({
      conversations: s.conversations,
      currentId: s.currentId,
      folders: s.folders,
      foldersLoaded: s.foldersLoaded,
      activeFolderId: s.activeFolderId,
    })),
  )
  const select = useAiStore((s) => s.selectConversation)
  const remove = useAiStore((s) => s.deleteConversation)
  const load = useAiStore((s) => s.loadConversations)
  const loadFolders = useAiStore((s) => s.loadFolders)
  const setActiveFolderId = useAiStore((s) => s.setActiveFolderId)
  const createFolder = useAiStore((s) => s.createFolder)
  const renameFolder = useAiStore((s) => s.renameFolder)
  const deleteFolder = useAiStore((s) => s.deleteFolder)
  const moveConversationToFolder = useAiStore((s) => s.moveConversationToFolder)

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [pendingConvDelete, setPendingConvDelete] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<NoteFolderColor>('blue')
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  // 当前 hover 的 drop target：undefined = 无；null = 未分类行；string = folder 行
  const [hoverDrop, setHoverDrop] = useState<string | null | undefined>(undefined)

  // 树展开状态
  // 用 useTreeExpanded 单 key 订阅替代 isExpanded() 命令式调用 —— 后者
  // 返回稳定的函数引用，Zustand 不会通知；前者订阅 boolean，状态变化触发重渲染。
  const uncategorizedExpanded = useTreeExpanded('ai-conv-uncategorized')
  // 当 activeFolderId 指向具体 folder 时（≠ undefined/null），订阅其展开状态。
  // 无效时用占位 key —— 永远不会被 toggle，所以值恒为 false。
  // 必须无条件调用（Rules of Hooks），用 typeof + sentinel 避免 null 传入。
  const activeFolderExpanded = useTreeExpanded(
    typeof activeFolderId === 'string' ? activeFolderId : '__ai_conv_none__',
  )
  const toggleExpansion = useTreeExpansionStore((s) => s.toggle)

  // 各 folder 下的对话预览（folder 展开时显示前 5 条 + N 更多）
  // 与 conversations 列表的关系：conversations 已是按 activeFolderId 过滤后的结果；
  // 展开 folder 时按 folderId 本地二次过滤即可。
  const conversationsByFolder = useMemo(() => {
    const m = new Map<string | null, AiConversation[]>()
    m.set(null, conversations.filter((c) => c.folderId === null))
    for (const f of folders) {
      m.set(f.id, conversations.filter((c) => c.folderId === f.id))
    }
    return m
  }, [conversations, folders])

  const uncategorized = conversationsByFolder.get(null) ?? EMPTY_CONVS
  const all = conversations // 已按 activeFolderId 过滤

  useEffect(() => {
    if (!foldersLoaded) void loadFolders()
  }, [foldersLoaded, loadFolders])

  useEffect(() => {
    // 进入页面后一次性 load conversations（即便 activeFolderId===undefined 也需要拉一次）
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // R13 修复：listbox 键盘导航 —— ref Map 保存 li 节点，避免字符串拼 selector
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map())

  /* ===================== 拖拽 ===================== */
  function handleDragStart(e: React.DragEvent, convId: string) {
    e.dataTransfer.setData('application/x-conv-id', convId)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOverFolder(e: React.DragEvent, folderId: string | null) {
    // 仅当确实在拖 conv-id 时接受
    const types = Array.from(e.dataTransfer.types)
    if (!types.includes('application/x-conv-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (hoverDrop !== folderId) setHoverDrop(folderId)
  }

  function handleDragLeaveFolder(e: React.DragEvent, folderId: string | null) {
    // relatedTarget 在 dragleave 时可能为 null（移到子元素），不能立即清掉。
    // 只有当 currentTarget 不再包含 relatedTarget 时才算真的离开。
    if (
      e.currentTarget instanceof Node &&
      e.relatedTarget instanceof Node &&
      e.currentTarget.contains(e.relatedTarget)
    ) {
      return
    }
    if (hoverDrop === folderId) setHoverDrop(undefined)
  }

  async function handleDropToFolder(e: React.DragEvent, folderId: string | null) {
    e.preventDefault()
    setHoverDrop(undefined)
    const convId = e.dataTransfer.getData('application/x-conv-id')
    if (!convId) return
    await moveConversationToFolder(convId, folderId)
  }

  /* ===================== 文件夹操作 ===================== */
  async function handleCreateFolder() {
    const name = newName.trim()
    if (!name) return
    const folder = await createFolder({ name, color: newColor })
    if (folder) {
      // 默认展开新建的文件夹
      toggleExpansion(folder.id)
    }
    setNewName('')
    setNewColor('blue')
    setCreating(false)
  }

  async function handleRenameFolder() {
    if (!renameId) return
    const name = renameText.trim()
    if (!name) return
    await renameFolder(renameId, name)
    setRenameId(null)
    setRenameText('')
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return
    const result = await deleteFolder(pendingDelete.folder.id)
    // 不强依赖 result.detachedConversations，UI 主流程已完成
    void result
    setPendingDelete(null)
  }

  /* ===================== 渲染 ===================== */
  return (
    <aside className="ai-conv-list">
      <div className="ai-conv-header">
        <span>对话历史</span>
        <button className="ai-conv-new" onClick={onNew}>
          + 新建
        </button>
      </div>

      {/* 「全部对话」行 */}
      <button
        type="button"
        className={`ai-folder-row ${activeFolderId === undefined ? 'active' : ''}`}
        onClick={() => setActiveFolderId(undefined)}
      >
        <ChevronRight className="ai-folder-chevron" aria-hidden />
        <span className="ai-folder-color-dot" style={{ background: 'var(--text-secondary)' }} />
        <span className="ai-folder-name">全部对话</span>
        <span className="ai-folder-count">{all.length}</span>
      </button>

      {/* 「未分类」行（drop target） */}
      <div
        className={`ai-folder-row ai-folder-row-drop ${activeFolderId === null ? 'active' : ''} ${hoverDrop === null ? 'drop-hover' : ''}`}
        onClick={() => setActiveFolderId(null)}
        onDragOver={(e) => handleDragOverFolder(e, null)}
        onDragLeave={(e) => handleDragLeaveFolder(e, null)}
        onDrop={(e) => handleDropToFolder(e, null)}
      >
        <ChevronRight
          className={`ai-folder-chevron ${uncategorizedExpanded ? 'expanded' : ''}`}
          aria-hidden
          onClick={(e) => {
            e.stopPropagation()
            toggleExpansion('ai-conv-uncategorized')
          }}
        />
        <span className="ai-folder-color-dot empty" />
        <span className="ai-folder-name">未分类</span>
        <span className="ai-folder-count">{uncategorized.length}</span>
      </div>

      {uncategorizedExpanded && activeFolderId === null && (
        <ul className="ai-conv-ul ai-conv-ul-child" role="listbox" aria-label="未分类对话">
          {uncategorized.length === 0 ? (
            <li className="ai-conv-empty" role="status" aria-live="polite">
              暂无对话
            </li>
          ) : (
            uncategorized.map((c) => (
              <ConvRow
                key={c.id}
                conv={c}
                selected={c.id === currentId}
                onSelect={() => void select(c.id)}
                onDelete={() => setPendingConvDelete(c.id)}
                onDragStart={handleDragStart}
                itemRefs={itemRefs}
              />
            ))
          )}
        </ul>
      )}

      {/* 用户文件夹 */}
      {folders.map((folder) => (
        <UserConvFolderBlock
          key={folder.id}
          folder={folder}
          conversations={conversationsByFolder.get(folder.id) ?? EMPTY_CONVS}
          isActive={activeFolderId === folder.id}
          isHovering={hoverDrop === folder.id}
          currentId={currentId}
          renameId={renameId}
          renameText={renameText}
          onSelect={() => setActiveFolderId(folder.id)}
          onToggleExpand={() => toggleExpansion(folder.id)}
          onDragOver={(e) => handleDragOverFolder(e, folder.id)}
          onDragLeave={(e) => handleDragLeaveFolder(e, folder.id)}
          onDrop={(e) => void handleDropToFolder(e, folder.id)}
          onStartRename={() => {
            setRenameId(folder.id)
            setRenameText(folder.name)
          }}
          onRenameTextChange={setRenameText}
          onRenameConfirm={handleRenameFolder}
          onRenameCancel={() => {
            setRenameId(null)
            setRenameText('')
          }}
          onDelete={() =>
            setPendingDelete({ folder, detachedConversations: 0 })
          }
          onSelectConv={(id) => void select(id)}
          onDeleteConv={(id) => setPendingConvDelete(id)}
          onDragStartConv={handleDragStart}
          itemRefs={itemRefs}
        />
      ))}

      {/* 「+ 新建文件夹」 */}
      <div className="ai-folder-create-block">
        {creating ? (
          <div className="ai-folder-create-form">
            <div className="ai-folder-create-colors">
              {FOLDER_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`ai-folder-color-chip ${newColor === c ? 'selected' : ''}`}
                  style={{ background: `var(--folder-${c})` }}
                  onClick={() => setNewColor(c)}
                  aria-label={`颜色 ${c}`}
                />
              ))}
            </div>
            <input
              autoFocus
              className="ai-folder-create-input"
              placeholder="文件夹名"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleCreateFolder()
                } else if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
            />
            <div className="ai-folder-create-actions">
              <button className="btn ghost" onClick={() => { setCreating(false); setNewName('') }}>
                取消
              </button>
              <button className="btn primary" onClick={() => void handleCreateFolder()}>
                创建
              </button>
            </div>
          </div>
        ) : (
          <button className="ai-folder-create-btn" onClick={() => setCreating(true)}>
            + 新建文件夹
          </button>
        )}
      </div>

      {/* 当 activeFolderId 指向具体 folder 时显示该 folder 下对话的 listbox
          （folder 已展开时已经在上方显示；这里保留 ALL 视图作为「选中 folder 但
          不展开」的快速预览）。 */}
      {typeof activeFolderId === 'string' && !activeFolderExpanded && (
        <ul
          className="ai-conv-ul"
          role="listbox"
          aria-label={`${folders.find((f) => f.id === activeFolderId)?.name ?? ''} 对话`}
          onKeyDown={(e) => {
            if (
              e.key !== 'ArrowDown' &&
              e.key !== 'ArrowUp' &&
              e.key !== 'Home' &&
              e.key !== 'End'
            ) return
            e.preventDefault()
            const idx = all.findIndex((c) => c.id === currentId)
            let nextIdx = idx < 0 ? 0 : idx
            if (e.key === 'ArrowDown') nextIdx = Math.min(all.length - 1, nextIdx + 1)
            else if (e.key === 'ArrowUp') nextIdx = Math.max(0, nextIdx - 1)
            else if (e.key === 'Home') nextIdx = 0
            else if (e.key === 'End') nextIdx = all.length - 1
            const target = all[nextIdx]
            if (target) {
              select(target.id)
              itemRefs.current.get(target.id)?.focus()
            }
          }}
        >
          {all.length === 0 ? (
            <li className="ai-conv-empty" role="status" aria-live="polite">
              该文件夹下暂无对话
            </li>
          ) : (
            all.map((c) => (
              <ConvRow
                key={c.id}
                conv={c}
                selected={c.id === currentId}
                onSelect={() => void select(c.id)}
                onDelete={() => setPendingConvDelete(c.id)}
                onDragStart={handleDragStart}
                itemRefs={itemRefs}
              />
            ))
          )}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除文件夹"
        body={
          pendingDelete
            ? `「${pendingDelete.folder.name}」下的对话将自动移至「未分类」，不会丢失对话历史。确认删除？`
            : ''
        }
        confirmLabel="删除"
        tone="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
      <ConfirmDialog
        open={pendingConvDelete !== null}
        title="删除对话"
        body="删除后无法恢复该对话历史。确认继续？"
        confirmLabel="删除"
        tone="danger"
        onCancel={() => setPendingConvDelete(null)}
        onConfirm={() => {
          if (pendingConvDelete) void remove(pendingConvDelete)
          setPendingConvDelete(null)
        }}
      />
    </aside>
  )
}

/* ===================== 子组件：单个对话行（memo） ===================== */
interface ConvRowProps {
  conv: AiConversation
  selected: boolean
  onSelect: () => void
  onDelete: () => void
  onDragStart: (e: React.DragEvent, convId: string) => void
  itemRefs: React.MutableRefObject<Map<string, HTMLLIElement>>
}

/** 单条对话行 —— memo 化避免 conversations 列表里无关 conv 的重渲染。
 *  comparator 忽略 handler refs（父组件 inline arrow 每次渲染新建；只要
 *  conv 引用 + selected + itemRefs 不变，本行就不重渲染）。 */
const ConvRow = memo(function ConvRow({
  conv,
  selected,
  onSelect,
  onDelete,
  onDragStart,
  itemRefs,
}: ConvRowProps) {
  return (
    <li
      data-conv-id={conv.id}
      role="option"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      draggable
      className={`ai-conv-item ${selected ? 'active' : ''}`}
      ref={(node) => {
        if (node) itemRefs.current.set(conv.id, node)
        else itemRefs.current.delete(conv.id)
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onDragStart={(e) => onDragStart(e, conv.id)}
    >
      <div className="ai-conv-title" title={conv.title ?? ''}>
        {conv.title ?? '未命名对话'}
      </div>
      <div className="ai-conv-meta">
        <span>{conv.provider}</span>
        <span>·</span>
        <span>{conv.messages.length} 条</span>
      </div>
      <button
        className="ai-conv-del"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
        }}
        title="删除对话"
        aria-label={`删除对话 ${conv.title ?? '未命名'}`}
      >
        ×
      </button>
    </li>
  )
},
/** 仅当数据字段变化才重渲染 —— handler refs 由父组件 inline arrow 每次
 *  渲染新建，比较它们会无谓失效 memo；handler 行为是「按当前 conv/folder
 *  上下文调用最外层 store」，不依赖自身闭包里的状态，可安全忽略。 */
(prev, next) =>
  prev.conv === next.conv &&
  prev.selected === next.selected &&
  prev.itemRefs === next.itemRefs)

/* ===================== 子组件：用户文件夹块（memo + 隔离订阅） ===================== */
interface UserConvFolderBlockProps {
  folder: AiConversationFolder
  conversations: AiConversation[]
  isActive: boolean
  isHovering: boolean
  currentId: string | null
  renameId: string | null
  renameText: string
  onSelect: () => void
  onToggleExpand: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onStartRename: () => void
  onRenameTextChange: (v: string) => void
  onRenameConfirm: () => void
  onRenameCancel: () => void
  onDelete: () => void
  onSelectConv: (id: string) => void
  onDeleteConv: (id: string) => void
  onDragStartConv: (e: React.DragEvent, id: string) => void
  itemRefs: React.MutableRefObject<Map<string, HTMLLIElement>>
}

/** 单个用户文件夹块。
 * 关键隔离点：每个 folder 内部用 `useTreeExpanded(folder.id)` 订阅自己的展开状态，
 * 其他 folder 展开/折叠不会让本块重渲染。
 *
 * 父组件不重渲染 → UserConvFolderBlock 由 React.memo 短路；
 * 同级 folder 展开状态变化 → 该块不订阅其 key → 不重渲染。
 */
const UserConvFolderBlock = memo(function UserConvFolderBlock({
  folder,
  conversations,
  isActive,
  isHovering,
  currentId,
  renameId,
  renameText,
  onSelect,
  onToggleExpand,
  onDragOver,
  onDragLeave,
  onDrop,
  onStartRename,
  onRenameTextChange,
  onRenameConfirm,
  onRenameCancel,
  onDelete,
  onSelectConv,
  onDeleteConv,
  onDragStartConv,
  itemRefs,
}: UserConvFolderBlockProps) {
  const expanded = useTreeExpanded(folder.id)
  const isRenaming = renameId === folder.id

  return (
    <div className="ai-folder-block">
      <div
        className={`ai-folder-row ai-folder-row-drop ${isActive ? 'active' : ''} ${isHovering ? 'drop-hover' : ''}`}
        onClick={onSelect}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <ChevronRight
          className={`ai-folder-chevron ${expanded ? 'expanded' : ''}`}
          aria-hidden
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
        />
        <span
          className="ai-folder-color-dot"
          style={{
            background: folder.color ? `var(--folder-${folder.color})` : 'transparent',
          }}
        />
        {isRenaming ? (
          <input
            autoFocus
            className="ai-folder-rename-input"
            value={renameText}
            onChange={(e) => onRenameTextChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={onRenameConfirm}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onRenameConfirm()
              } else if (e.key === 'Escape') {
                onRenameCancel()
              }
            }}
          />
        ) : (
          <span className="ai-folder-name" title={folder.name}>
            {folder.name}
          </span>
        )}
        <span className="ai-folder-count">{conversations.length}</span>
        {!isRenaming && (
          <span className="ai-folder-actions">
            <button
              className="ai-folder-action-btn"
              title="重命名"
              onClick={(e) => {
                e.stopPropagation()
                onStartRename()
              }}
            >
              ✎
            </button>
            <button
              className="ai-folder-action-btn danger"
              title="删除文件夹"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              ×
            </button>
          </span>
        )}
      </div>

      {expanded && (
        <ul className="ai-conv-ul ai-conv-ul-child" role="listbox" aria-label={`${folder.name} 对话`}>
          {conversations.length === 0 ? (
            <li className="ai-conv-empty-child">（该文件夹下暂无对话）</li>
          ) : (
            conversations.map((c) => (
              <ConvRow
                key={c.id}
                conv={c}
                selected={c.id === currentId}
                onSelect={() => onSelectConv(c.id)}
                onDelete={() => onDeleteConv(c.id)}
                onDragStart={onDragStartConv}
                itemRefs={itemRefs}
              />
            ))
          )}
        </ul>
      )}
    </div>
  )
},
/** 仅当数据/UI 状态变化才重渲染 —— handler refs 由父组件 inline arrow 每次
 *  渲染新建；handler 行为依赖外部 store，可安全忽略其引用。
 *
 *  同时把「展开状态」放到子组件内的 useTreeExpanded 里订阅（line 564），所以
 *  同级 folder 的展开/折叠不会让本块重渲染。                              */
(prev, next) =>
  prev.folder === next.folder &&
  prev.conversations === next.conversations &&
  prev.isActive === next.isActive &&
  prev.isHovering === next.isHovering &&
  prev.currentId === next.currentId &&
  prev.renameId === next.renameId &&
  prev.renameText === next.renameText &&
  prev.itemRefs === next.itemRefs)

export default ConversationList
