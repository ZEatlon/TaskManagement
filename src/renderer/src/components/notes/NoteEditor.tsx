/**
 * 笔记编辑器（升级版：WYSIWYG + 分屏左右切换）
 *
 * 本组件是把原 textarea 版 NoteEditor 和独立 /editor 路由（TipTap WYSIWYG）
 * 合并后的统一编辑器：
 *
 * - 左侧 NotesTree（笔记管理） + 右侧本组件（编辑） + 远右 NoteMetaPanel（元数据）
 *   —— 由 /notes 页面统一编排。
 * - 编辑能力由 TipTap 提供（mermaid / katex / 表格 / 任务列表 / 代码高亮 / 图片粘贴）
 * - 内容变更 → 序列化为 markdown → 写 IndexedDB 草稿 + 防抖自动保存
 * - "渲染" 视图通过 NotePreview（markdown → HTML）实现；分屏时两栏并排
 * - 用户可在工具栏切换：
 *   - 布局：仅编辑 / 仅预览 / 分屏
 *   - 分屏方向：编辑在左 ↔ 编辑在右（满足不同阅读 / 校对习惯）
 *
 * 注意：保留与旧版同名的 Props 接口（path / onSaved），由 /notes 路由直接传入，
 * 无需修改路由层。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { useNotesStore } from '../../stores/notes'
import { TipTapEditor, type EditorContentSource } from '../editor/TipTapEditor'
import { NotePreview } from './NotePreview'
import { StatusBadge } from './StatusBadge'
import { useAutosave } from '../../lib/useAutosave'
import { aiApi, notesApi } from '../../lib/ipc'
import { TagChipSelector } from './TagChipSelector'
import { InlineAIButton } from '../ai/InlineAIButton'
import { useAiStore } from '../../stores/ai'
import { mdastToHtml, wrapPrintableHtml } from '../../notes/mdastToHtml'
import { announce } from '../common/AriaAnnouncer'
import type { RootContent } from 'mdast'

interface Props {
  /** 受控路径 */
  path: string | null
  /** 编辑完成回调（用于父组件感知保存） */
  onSaved?: () => void
}

type Layout = 'edit-only' | 'preview-only' | 'split'
type SplitDirection = 'edit-left' | 'edit-right'

/** 防抖落盘间隔 */
const AUTOSAVE_DELAY = 1500

export function NoteEditor({ path, onSaved }: Props) {
  const currentNote = useNotesStore((s) => s.currentNote)
  const fileState = useNotesStore((s) => (path ? s.fileStates[path] : undefined))
  const reportEdit = useNotesStore((s) => s.reportEdit)
  const save = useNotesStore((s) => s.save)
  // R11 修复 (high #4)：resolve 后 store 自增 reloadSignals[path]，TipTap 用此作 key
  // 强制重挂载，避免 TipTap 仍持有旧本地内容导致下次 autosave 把磁盘覆盖回去。
  const reloadSignal = useNotesStore((s) => (path ? s.reloadSignals[path] ?? 0 : 0))

  const [draftMd, setDraftMd] = useState('')
  // 默认单栏（仅编辑）—— 用户反馈：之前的双栏默认占据太多横向空间
  // 仍可通过工具栏切换到「分屏」或「仅预览」
  const [layout, setLayout] = useState<Layout>('edit-only')
  const [splitDir, setSplitDir] = useState<SplitDirection>('edit-left')
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  // 模块 7：IndexedDB 草稿恢复提示
  const [restorePrompt, setRestorePrompt] = useState<{
    draftContent: string
    draftUpdatedAt: string
  } | null>(null)

  const autosaveTimer = useRef<NodeJS.Timeout | null>(null)
  const lastNotePath = useRef<string | null>(null)
  // 切换笔记 / 还原草稿时短暂抑制 autosave
  const suppressAutosaveRef = useRef(false)
  // R28 修复 (low)：restoreDraft 的 IndexedDB 读取是异步的；effect 在
  // currentNote.path 变化时重跑产生新闭包，但旧 effect 启动的 restoreDraft
  // Promise 仍可能在飞行中。快切笔记（A → B → C）时三个 Promise 全部 in-flight，
  // 最后 resolve 的 .then 不一定对应当前 currentNote → 旧闭包持有的 currentNote
  // 把 A 的草稿写到 C 上 → 用户在 C 上点「恢复草稿」会把 C 当前内容替换成 A 的。
  // 用 generation 计数器：每次 effect 入口 ++，then 回调里若非最新直接丢弃。
  const restoreDraftGenRef = useRef(0)

  const autosave = useAutosave({
    notePath: path,
    kind: 'markdown',
    debounceMs: 1000,
  })
  const { scheduleSave, clearDraft } = autosave

  // PDF 导出状态：'idle' / 'exporting' / 'error'
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'error'>('idle')
  const [exportError, setExportError] = useState<string | null>(null)

  /**
   * 导出当前笔记为 PDF：把 markdown 渲染成自包含 HTML（含内联样式），
   * 主进程用隐藏 BrowserWindow 调用 webContents.printToPDF() 落盘。
   *
   * 不直接复用 NotePreview 的渲染（依赖 React 上下文），改用纯 HTML
   * 字符串 + 共享 CSS 样式 —— 保证 PDF 输出与编辑器预览视觉一致，
   * 同时也避免把 React DOM 树序列化进 PDF。
   */
  const handleExportPdf = useCallback(async () => {
    if (!currentNote || !path) return
    if (exportState === 'exporting') return
    setExportState('exporting')
    setExportError(null)
    try {
      const safeTitle = (currentNote.title || 'note').replace(/[\\/:*?"<>|]/g, '_')
      // 动态 import remark（renderer 是 ESM，require 不可用）
      const { remark } = await import('remark')
      const remarkGfm = (await import('remark-gfm')).default
      const file = remark().use(remarkGfm).parse(draftMd || '')
      const body = mdastToHtml(file.children as RootContent[])
      const html = wrapPrintableHtml({
        title: currentNote.title || '未命名笔记',
        body,
      })
      const result = await notesApi.exportPdf(html, safeTitle)
      if (!result) {
        // 用户取消保存对话框
        setExportState('idle')
        return
      }
      setExportState('idle')
    } catch (err) {
      console.warn('[note-editor] export PDF failed:', err)
      setExportError(err instanceof Error ? err.message : String(err))
      setExportState('error')
    }
  }, [currentNote, path, draftMd, exportState])

  // 切换笔记：同步本地状态 + 检测草稿
  useEffect(() => {
    if (currentNote && currentNote.path !== lastNotePath.current) {
      lastNotePath.current = currentNote.path
      suppressAutosaveRef.current = true
      setDraftMd(currentNote.content)
      setDirty(false)
      setSavedAt(null)
      setRestorePrompt(null)

      // R15 修复 (low)：原 effect deps 含整个 `autosave` 对象 —— useAutosave
      // 每次 render 都返回新字面量 { scheduleSave, clearDraft, ... }，导致
      // 切换 currentNote 之外还会在每次父组件渲染时跑一遍 restoreDraft()，
      // 频繁去 IndexedDB 查草稿。改成只依赖真正会被用到的 restoreDraft 引用
      // （其它字段 scheduleSave/clearDraft 是稳定闭包）。
      //
      // R28 修复 (low)：restoreDraft 的 IndexedDB 读异步，effect 重跑产生新闭包
      // 但旧 Promise 仍可能 in-flight。快切笔记时旧闭包持 currentNote=A，把
      // A 的草稿写到当前打开的 C 上 → 数据误覆盖。用 generation 计数器在
      // .then 里丢弃陈旧回调。
      const myGen = ++restoreDraftGenRef.current
      // 捕获当前 path 与 content 的局部变量，避免 .then 里读陈旧闭包
      const notePathAtStart = currentNote.path
      const noteContentAtStart = currentNote.content
      void autosave.restoreDraft().then((draft) => {
        if (myGen !== restoreDraftGenRef.current) return // stale，回调过期
        if (draft && draft.content !== noteContentAtStart) {
          // 二次校验：path 没变才显示提示（理论上 generation 已保证，但保险）
          if (lastNotePath.current !== notePathAtStart) return
          setRestorePrompt({
            draftContent: draft.content,
            draftUpdatedAt: draft.updatedAt,
          })
        }
      })
      requestAnimationFrame(() => {
        suppressAutosaveRef.current = false
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNote, autosave.restoreDraft])

  const doSave = useCallback(
    async (mdOverride?: string) => {
      if (!path) return
      const md = mdOverride ?? draftMd
      // R11 修复 (medium #12)：doSave 之前从来不 clearTimeout(autosaveTimer.current)，
      // 手动 Ctrl+S / 工具栏保存后 autosaveTimer 仍会在 1.5s 后再跑一次 → 重复写盘 +
      // 第二次 setSavedAt + clearDraft。同一次保存触发两次 IPC。更糟：如果用户在
      // Ctrl+S 后又敲了几个字符但尚未触发新的 handleChange，pending 的 autosaveTimer
      // 仍带着保存时刻的 mdOverride（已被覆盖为最新）跑，但若 IPC 失败 / race 时
      // 旧 md 可能覆盖刚写好的最新内容。先清 timer 再 await save。
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current)
        autosaveTimer.current = null
      }
      await save(path, md)
      await clearDraft()
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString('zh-CN'))
      // R30-a11y-1 修复 (medium)：保存成功后通过 announce() 让屏幕阅读器
      // 用户也能感知「笔记已保存」—— 视觉上的 save-status 徽章 SR 不可见。
      announce('笔记已保存')
      onSaved?.()
    },
    [path, draftMd, save, clearDraft, onSaved],
  )

  // TipTap → markdown 回写
  const reportEditTimerRef = useRef<number | null>(null)
  const handleChange = useCallback(
    (state: { json: object; html: string; markdown: string }) => {
      // 仅当内容真的变化才标 dirty + 触发外层 effect
      setDraftMd((prev) => (prev === state.markdown ? prev : state.markdown))
      setDirty(true)
      if (path) {
        // R7F-5：debounce reportEdit IPC 400ms —— 每按一个字母都触发 IPC
        // 会让主进程的 conflictResolver 状态机被刷爆。仅在用户停止输入 400ms
        // 后再上报一次最新内容即可。
        if (reportEditTimerRef.current !== null) {
          window.clearTimeout(reportEditTimerRef.current)
        }
        reportEditTimerRef.current = window.setTimeout(() => {
          reportEditTimerRef.current = null
          void reportEdit(path, state.markdown)
        }, 400)
      }
      if (suppressAutosaveRef.current) return
      scheduleSave(state.markdown)
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      autosaveTimer.current = setTimeout(() => {
        void doSave(state.markdown)
      }, AUTOSAVE_DELAY)
    },
    [path, reportEdit, scheduleSave, doSave],
  )

  function applyDraft() {
    if (!restorePrompt) return
    setDraftMd(restorePrompt.draftContent)
    setDirty(true)
    setRestorePrompt(null)
  }
  function discardDraft() {
    void clearDraft()
    setRestorePrompt(null)
  }

  // Ctrl/Cmd + S 立即保存
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doSave])

  // 卸载清 timer
  useEffect(() => {
    return () => {
      // H18 修复 (high data-integrity)：原版仅 clearTimeout(autosaveTimer)，
      // 组件卸载前若用户敲了字符但 1.5s autosave 还没触发 → timer 直接被
      // 清掉 → 那段字符永远没机会落盘。修复：清理 timer **之前** 先把
      // pending 内容同步落盘（fire-and-forget，cleanup 不能 await）。调用
      // autosave.flush 走 IndexedDB 草稿 store（同步函数实现，cleanup
      // 里可同步完成），同时 doSave 走笔记文件 IPC（异步，promise 保留
      // 在事件循环里跑）。两条路都覆盖：即便 IPC 失败，至少 IndexedDB
      // 草稿还在，下次打开同一笔记还能恢复。
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current)
        autosaveTimer.current = null
        // 把最新内容刷成 IndexedDB 草稿 —— 即便 unmount 也保留在 disk。
        try {
          void autosave.flush(draftMd)
        } catch (err) {
          console.warn('[NoteEditor] autosave flush on unmount failed', err)
        }
      }
      // R7F-5：顺手清掉 reportEdit debounce，避免组件卸载后还触发陈旧 IPC
      if (reportEditTimerRef.current !== null) {
        window.clearTimeout(reportEditTimerRef.current)
        reportEditTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // AI 集成：当用户打开笔记时把 ID 同步给主进程（summarizeNote 工具据此决定是否返回正文）；
  // 关闭笔记时传 null。effect 仅依赖 currentNote.id，避免 path 抖动导致重复 IPC。
  //
  // R27-Sec-9：summarizeNote 现在要求 noteId 已在该 webContents 的
  // `openedNotesByWebContents` 集合里（由 note:opened / note:closed 注册）。
  // NoteEditor mount/unmount 时分别调 note:opened / note:closed；切换笔记
  // 时先 closed 旧的再 opened 新的。失败的 IPC 不能让编辑器 UI 卡住，记日志即可。
  useEffect(() => {
    const noteId = currentNote?.id ?? null
    void aiApi.setCurrentNoteId(noteId).catch(() => {
      /* IPC 失败不应阻塞编辑器；主进程仍以"未知笔记"对待 */
    })
    // 把 noteId 也写到 useAiStore.context，让 InlineAIButton / CommandBar 的
    // prompt 模板可以引用。卸载 / 切换笔记时由 setContext 浅合并覆盖。
    useAiStore.getState().setContext({ noteId: noteId ?? undefined })
    // 不在此处 cleanup。cleanup 会随 dep 变化在每次切换笔记时跑，但此时
    // currentNote 已经是新笔记，会出现"上一份笔记清空 → 紧接着又被设为新 id"
    // 的竞态，且卸载时的 currentNote 也是最后打开的那一份，currentNote 始终 truthy
    // 所以原 cleanup 条件 `if (!currentNote)` 永远不命中 → 主进程永远拿着最后
    // 一个打开过的 noteId，直到下次切换/卸载（实际上从不卸载）。
    // 真正的卸载清理放在下面的独立 effect。
  }, [currentNote?.id])

  // R27-Sec-9：NoteEditor mount 时注册 noteId 到主进程 openedNotes 集合；
  // unmount / 切换时反注册（先 closed 旧的再 opened 新的，避免主进程短暂持有
  // 跨笔记的脏上下文）。note:opened / note:closed 走 aiApi.noteOpened / noteClosed。
  useEffect(() => {
    const noteId = currentNote?.id
    if (!noteId) return
    void aiApi.noteOpened(noteId).catch(() => undefined)
    return () => {
      void aiApi.noteClosed(noteId).catch(() => undefined)
    }
  }, [currentNote?.id])

  // 组件卸载时（包括用户离开 /notes 路由）显式清空 AI 上下文，避免下次
  // summarizeNote 把别的笔记内容当作"当前打开笔记"返回。
  useEffect(() => {
    return () => {
      void aiApi.setCurrentNoteId(null).catch(() => undefined)
      // 同步清 useAiStore.context 里的 noteId（避免 stale id 残留到下次进入）
      useAiStore.getState().setContext({ noteId: undefined })
    }
  }, [])

  const isEmpty = !path || !currentNote
  const showEdit = layout === 'edit-only' || layout === 'split'
  const showPreview = layout === 'preview-only' || layout === 'split'

  // split 时根据方向决定 DOM 顺序（CSS Grid order 控制视觉）
  const editOrder = splitDir === 'edit-left' ? 0 : 1
  const previewOrder = splitDir === 'edit-left' ? 1 : 0

  // TipTap 的初始内容（切换笔记时强制重挂载避免残留）
  const content: EditorContentSource = currentNote
    ? { kind: 'markdown', markdown: draftMd || currentNote.content }
    : { kind: 'empty' }

  return (
    <div className={['note-editor', isEmpty ? 'is-empty' : '', `layout-${layout}`].filter(Boolean).join(' ')}>
      <header className="editor-toolbar">
        <div className="editor-toolbar-info">
          <h2 className="editor-note-title" title={path ?? ''}>
            {currentNote?.title || '无标题笔记'}
          </h2>
          {currentNote && (
            <span className="editor-note-path muted">
              {currentNote.path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/')}
            </span>
          )}
        </div>

        <div className="toolbar-actions">
          {/* 布局切换 */}
          <div
            className="layout-toggle"
            role="radiogroup"
            aria-label="编辑布局"
            onKeyDown={(e) => {
              // R29 修复 (high a11y)：原 role="tablist" / role="tab" 缺少配套
              // role="tabpanel" 容器与 aria-controls 关联（实际只有一个 edit-only
              // / preview-only / split 决定显示哪个面板，没有 3 个 tabpanel），
              // NVDA / VoiceOver 会报 "tab N of 3" 但读不到 tabpanel 内容变更。
              // 改为 radiogroup + radio（互斥三选一）：单个 Tab 落点（roving
              // tabindex），Arrow 切换选项（沿用原 R13 的方向键处理）。
              const order = ['edit-only', 'split', 'preview-only'] as const
              const idx = order.indexOf(layout)
              if (idx < 0) return
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                setLayout(order[(idx + 1) % order.length])
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                setLayout(order[(idx - 1 + order.length) % order.length])
              }
            }}
          >
            {(['edit-only', 'split', 'preview-only'] as const).map((k) => {
              const isActive = layout === k
              const meta = {
                'edit-only': { label: '仅编辑器', icon: '✎' },
                split: { label: '分屏', icon: '⬌' },
                'preview-only': { label: '仅预览', icon: '👁' },
              }[k]
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  tabIndex={isActive ? 0 : -1}
                  className={`layout-btn ${isActive ? 'active' : ''}`}
                  onClick={() => setLayout(k)}
                  title={meta.label}
                  aria-label={meta.label}
                >
                  {meta.icon}
                </button>
              )
            })}
          </div>

          {/* 分屏方向切换：仅在 split 时启用 */}
          {layout === 'split' && (
            <button
              className="split-direction-btn"
              onClick={() =>
                setSplitDir((d) => (d === 'edit-left' ? 'edit-right' : 'edit-left'))
              }
              title={splitDir === 'edit-left' ? '当前：编辑在左，点击切换到编辑在右' : '当前：编辑在右，点击切换到编辑在左'}
              aria-label="切换分屏方向"
            >
              {splitDir === 'edit-left' ? '◧ 编辑在左' : '◨ 编辑在右'}
            </button>
          )}

          {fileState && <StatusBadge state={fileState} />}
          {/*
           * R30-a11y-1 修复 (medium a11y)：原版三个 save-status 徽章（草稿缓存 /
           * 未保存 / 已保存）只在视觉上闪烁，NVDA / VoiceOver 用户收不到任何
           * 状态变化通知。补一层 aria-live="polite" + aria-atomic="true" 把它们
           * 整体包成一个 status 区域，每次徽章文本变化时 SR 自动播报；保存成功
           * 路径另发 announce() 兜底（即便焦点不在工具栏也能听到）。
           */}
          <span
            className="save-status-group"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {autosave.hasDraft && !dirty && (
              <span
                className="save-status draft"
                title={`未保存草稿 ${new Date(autosave.pendingDraft?.updatedAt ?? Date.now()).toLocaleString('zh-CN')}`}
              >
                草稿缓存
              </span>
            )}
            {dirty ? (
              <span className="save-status dirty">未保存</span>
            ) : savedAt ? (
              <span className="save-status saved">已保存 · {savedAt}</span>
            ) : null}
          </span>
          {currentNote && (
            /*
             * AI 触发按钮 —— 放在保存 / 导出 PDF 按钮前。
             *   - target="note" + id=currentNote.id：菜单 prompt 会带 noteId
             *   - size="md" 比 sticky 的 sm 稍大，更适合编辑器工具栏
             *   - 浮层 fixed 定位，不会被 toolbar 的 overflow 截断
             */
            <InlineAIButton
              target="note"
              id={currentNote.id}
              size="md"
              title="AI 助手（总结 / 续写 / 重写）"
            />
          )}
          <button className="btn primary" onClick={() => doSave()} disabled={!dirty}>
            保存
          </button>
          <button
            className="btn ghost"
            onClick={() => void handleExportPdf()}
            disabled={!currentNote || exportState === 'exporting'}
            title={exportError ? `导出失败：${exportError}` : '导出当前笔记为 PDF'}
            aria-label="导出当前笔记为 PDF"
          >
            <Download size={14} aria-hidden />
            {exportState === 'exporting' ? '导出中…' : '导出 PDF'}
          </button>
        </div>
      </header>

      {restorePrompt && (
        <div className="draft-restore-banner">
          <div className="draft-restore-text">
            <strong>检测到未保存的草稿</strong>
            <span className="muted">
              （{new Date(restorePrompt.draftUpdatedAt).toLocaleString('zh-CN')}）
            </span>
          </div>
          <div className="draft-restore-actions">
            <button className="btn primary" onClick={applyDraft}>
              恢复草稿
            </button>
            <button className="btn ghost" onClick={discardDraft}>
              丢弃
            </button>
          </div>
        </div>
      )}

      {/* Phase 4 (tag-chip-selector)：固定在 editor-toolbar 下的 chip 选择条，
          点击 toggle 当前笔记的 tag。空 store（未配置任何自定义标签）时
          TagChipSelector 自身返回 null，不占空间。 */}
      {currentNote && <TagChipSelector noteId={currentNote.id} />}

      <div className={`editor-body layout-${layout}`}>
        {isEmpty ? (
          <div className="editor-pane edit-pane empty-pane">
            <div className="empty-tip">
              <div className="empty-icon">📝</div>
              <p className="muted">从左侧选择一篇笔记开始编辑，或点击下方按钮新建一篇。</p>
              <button
                className="btn primary"
                onClick={() =>
                  void useNotesStore.getState().create('untitled.md', '# 无标题笔记\n\n开始书写…\n')
                }
              >
                新建笔记
              </button>
            </div>
          </div>
        ) : (
          <>
            {showEdit && (
              <div className="editor-pane edit-pane" style={{ order: editOrder }}>
                <TipTapEditor
                  // R11 修复 (high #4)：path + reloadSignal 一起作为 key，
                  // 解决冲突 keepRemote/merge 时让 TipTap 重挂载读到最新磁盘内容。
                  key={`${currentNote?.path ?? ''}::${reloadSignal}`}
                  content={content}
                  placeholder="开始书写…支持 Markdown / Mermaid / KaTeX / 表格 / 任务列表"
                  charLimit={50000}
                  onChange={handleChange}
                />
              </div>
            )}
            {showPreview && (
              <div className="editor-pane preview-pane" style={{ order: previewOrder }}>
                <NotePreview content={draftMd} notePath={path} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default NoteEditor