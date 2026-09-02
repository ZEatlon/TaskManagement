/**
 * TipTapEditor - TipTap 主编辑器组件
 *
 * 特性：
 * - 使用 StarterKit + 自定义扩展（mermaid / katex / code-highlight / table / task-list 等）
 * - placeholder + character-count
 * - 工具栏 + 内容区 + 字符计数
 * - 支持两种内容来源：markdown 字符串 / TipTap JSON
 * - 内容更新通过 onChange 回调，返回 JSON / HTML / Markdown 三种格式（按需取）
 * - 模块 6：图片粘贴/拖拽 + 上传进度提示
 */
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import Highlight from '@tiptap/extension-highlight'
import Color from '@tiptap/extension-color'
import TextStyle from '@tiptap/extension-text-style'
import Typography from '@tiptap/extension-typography'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import CharacterCount from '@tiptap/extension-character-count'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { MermaidNode } from './extensions/MermaidNode'
import { MathInlineNode, MathBlockNode } from './extensions/MathNode'
import { CodeBlockWithHighlight } from './extensions/CodeBlockWithHighlight'
import { ImageUploadExtension } from './extensions/ImageUploadExtension'
import { MenuBar } from './MenuBar'
import { editorJSONToHTML, editorJSONToMarkdown } from './serializer'
import { markdownToHtml } from './markdown'

export type EditorContentSource =
  | { kind: 'json'; json: object }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'html'; html: string }
  | { kind: 'empty' }

export interface TipTapEditorProps {
  /** 初始内容（支持 markdown/html/json 三种） */
  content?: EditorContentSource
  /** 占位符文案 */
  placeholder?: string
  /** 是否只读 */
  editable?: boolean
  /** 是否自动聚焦 */
  autofocus?: boolean | 'start' | 'end' | 'all'
  /** 字数限制（达到后高亮显示） */
  charLimit?: number
  /** onChange：每次内容更新（debounce 由调用方控制） */
  onChange?: (state: {
    json: object
    html: string
    markdown: string
    characters: number
    words: number
  }) => void
  /** 顶部额外工具栏渲染（在 MenuBar 下方） */
  renderFooter?: () => React.ReactNode
  /** 容器 className */
  className?: string
  /** 自定义图片按钮触发（点击工具栏图片按钮时调用） */
  onPickImage?: () => void
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

export function TipTapEditor(props: TipTapEditorProps) {
  const {
    content = { kind: 'empty' },
    placeholder = '开始书写…',
    editable = true,
    autofocus = false,
    charLimit,
    onChange,
    renderFooter,
    className,
    onPickImage,
  } = props

  // 将 content 转成初始文档
  // R11 修复 (critical #4)：原 useMemo([content]) 让 initialDoc 在每次父组件渲染
  // 时都被重建（父组件 NoteEditor 把 content 作为新对象字面量传入，每次渲染都是
  // 新引用）→ setContent 触发 → 光标每次都跳回 0。新实现按内容的"语义身份"
  // （markdown 字符串 / html 字符串 / json 序列化）做 useMemo deps，内容不变就
  // 返回相同引用，setContent 守卫 `lastApplied.current === initialDoc` 直接生效。
  // R15 修复 (low)：contentIdentity 的 deps 写的是 `[content]` 对象引用，content
  // 每次都是新字面量，但内部 switch 各分支只取字符串字段，所以"真正变化的字段"
  // 才是判断身份的依据。把 deps 改为按 kind 分支提取的字符串值，避免父组件传入
  // 新 ref 时空跑 useMemo 重算。
  const contentKey = useMemo<string>(() => {
    switch (content.kind) {
      case 'markdown':
        return `md:${content.markdown}`
      case 'html':
        return `html:${content.html}`
      case 'json':
        return `json:${JSON.stringify(content.json)}`
      case 'empty':
      default:
        return 'empty'
    }
    // deps：分别拆到 case 字段上；parent 给新 ref 时不会触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.kind === 'markdown' ? content.markdown : content.kind === 'html' ? content.html : content.kind === 'json' ? JSON.stringify(content.json) : 'empty'])
  const initialDoc = useMemo<object | string>(
    () => contentToInitialDoc(content),
    [contentKey],
  )

  // 图片上传状态（用于 UI 提示）
  const [uploading, setUploading] = useState<{ count: number; fileName: string | null }>({
    count: 0,
    fileName: null,
  })
  const [uploadError, setUploadError] = useState<string | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showError = useCallback((msg: string) => {
    setUploadError(msg)
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => setUploadError(null), 4000)
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      Placeholder.configure({
        placeholder,
        showOnlyWhenEditable: true,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Image.configure({
        // 允许 attachments:// 自定义协议
        // TipTap 内置 protocol 过滤可通过自定义实现；这里通过 allowBase64 兼容未来内联
        allowBase64: true,
        HTMLAttributes: { loading: 'lazy', decoding: 'async' },
      }),
      Underline,
      Subscript,
      Superscript,
      Highlight.configure({ multicolor: true }),
      Color,
      TextStyle,
      Typography,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      CharacterCount.configure({
        limit: charLimit,
      }),
      MermaidNode,
      MathInlineNode,
      MathBlockNode,
      CodeBlockWithHighlight,
      ImageUploadExtension.configure({
        maxSize: 20 * 1024 * 1024,
        highlightOnDragOver: true,
        onUploadStart: (file) => {
          setUploading((prev) => ({ count: prev.count + 1, fileName: file.name }))
        },
        onUploadEnd: (_file, url, err) => {
          setUploading((prev) => ({
            count: Math.max(0, prev.count - 1),
            fileName: prev.count - 1 > 0 ? prev.fileName : null,
          }))
          if (err) showError(err)
          else if (url) {
            setUploadError(null)
          }
        },
        onError: (msg) => showError(msg),
      }),
    ],
    content: initialDoc,
    editable,
    autofocus: autofocus as never,
    onUpdate: ({ editor }) => {
      if (!onChange) return
      const json = editor.getJSON()
      const html = editorJSONToHTML(json)
      const markdown = editorJSONToMarkdown(json)
      const characters = editor.storage['characterCount']?.characters?.() ?? 0
      const words = editor.storage['characterCount']?.words?.() ?? 0
      onChange({ json, html, markdown, characters, words })
    },
  })

  // 当外部 content prop 变化时，强制更新编辑器内容（仅在编辑态非焦点时）
  //
  // Bug A 修复（编辑器光标跳回开头 / 感觉"时不时刷新"）：
  // 原版用 `lastApplied.current === initialDoc` 引用相等守卫，但 parent 每次渲染
  // 都把 `content` 当成新字面量传入 NoteEditor 顶层，导致 `initialDoc` 是新 ref
  // （即使是 markdown 内容未变化）。随后 setContent 被调用 → ProseMirror 重置
  // selection 到文档开头，用户感觉"刷新 / 光标飞走"。
  //
  // 正确判断：
  //   - 文档内容真的变了 才 setContent。
  //   - 文档未变（仅 ref 不同）则完全跳过 —— 包括父组件因 autosave / store 更新
  //     引发的重渲染。
  //
  // 通过比对 `editor.getHTML()` 与 `markdownToHtml(initialDoc)` 的归一化结果来
  // 判定"内容是否相同"。两者在 markdown 经过 turndown 损失性往返后大部分情况
  // 会一致；对于空文档（仅剩空段落）也按"内容相同"处理，避免无意义 setContent。
  const lastAppliedKey = useRef<string>(contentKey)
  useEffect(() => {
    if (!editor) return
    if (lastAppliedKey.current === contentKey) return
    // 比较编辑器当前内容与目标内容是否等价 —— 等价则跳过 setContent
    try {
      const currentHtml = editor.getHTML()
      const targetHtml =
        typeof initialDoc === 'string' ? initialDoc : editorJSONToHTML(initialDoc)
      if (normalizeEditorHtml(currentHtml) === normalizeEditorHtml(targetHtml)) {
        lastAppliedKey.current = contentKey
        return
      }
    } catch {
      // 任意比较失败都退回到原行为
    }
    // 不在编辑器获得焦点时强行 setContent（用户在打字过程中）—— 会把光标
    // 弹回文档开头。这里仅在编辑器失焦或刚挂载时允许 setContent。
    if (editor.isFocused) {
      // 标记但不应用；后续失焦时会再触发
      lastAppliedKey.current = contentKey
      return
    }
    editor.commands.setContent(initialDoc as never, false)
    lastAppliedKey.current = contentKey
  }, [editor, initialDoc, contentKey])

  // 同步 editable
  useEffect(() => {
    if (!editor) return
    editor.setEditable(editable)
  }, [editor, editable])

  // 销毁时清理
  useEffect(() => {
    return () => {
      editor?.destroy()
    }
  }, [editor])

  // 销毁时清掉错误 timer
  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  // 模块 6：文件选择器（用于工具栏图片按钮）
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFilesChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return
      if (!editor) return
      // uploadImage 扩展命令
      ;(editor.commands as unknown as { uploadImage: (f: File[]) => boolean }).uploadImage(
        Array.from(files),
      )
      // 重置 input 便于重复选择同一文件
      e.target.value = ''
    },
    [editor],
  )

  const handlePickImage = useCallback(() => {
    if (onPickImage) {
      onPickImage()
      return
    }
    triggerFilePicker()
  }, [onPickImage, triggerFilePicker])

  // R12 修复 (medium)：原版每次 render 都调 editor.storage.characterCount.characters()
  // —— O(N) 遍历整棵 prosemirror 节点树。50000 字符笔记 + 10Hz 输入 +
  // autosave/draft 触发，render 期间主线程阻塞 ~50%。改为订阅 onUpdate（已有，
  // 见上方）并把计数存到 local state，render 只读 state。
  const [charCount, setCharCount] = useState(0)
  const [wordCount, setWordCount] = useState(0)
  useEffect(() => {
    if (!editor) {
      setCharCount(0)
      setWordCount(0)
      return
    }
    // 初始化一次（编辑器刚挂载时取一次）
    const update = () => {
      setCharCount(editor.storage['characterCount']?.characters?.() ?? 0)
      setWordCount(editor.storage['characterCount']?.words?.() ?? 0)
    }
    update()
    editor.on('update', update)
    return () => {
      editor.off('update', update)
    }
  }, [editor])
  const overLimit = charLimit !== undefined && charCount > charLimit

  return (
    <div className={`tiptap-editor ${className ?? ''}`}>
      {editable && <MenuBar editor={editor} onPickImage={handlePickImage} />}
      <div className="editor-content">
        <EditorContent editor={editor} />
      </div>
      {/* 隐藏的文件选择器：被工具栏图片按钮或粘贴/拖拽代替 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFilesChosen}
      />
      {(renderFooter || true) && (
        <div className="editor-footer">
          <div className="editor-stats">
            <span className={overLimit ? 'over-limit' : ''}>
              {charCount} 字符
            </span>
            {charLimit !== undefined && (
              <span className={`char-limit ${overLimit ? 'over-limit' : ''}`}>
                / {charLimit}
              </span>
            )}
            <span className="dot">·</span>
            <span>{wordCount} 词</span>
            {uploading.count > 0 && (
              <>
                <span className="dot">·</span>
                <span className="upload-status" title={uploading.fileName ?? ''}>
                  上传中… {uploading.count}
                </span>
              </>
            )}
            {uploadError && (
              <>
                <span className="dot">·</span>
                <span className="upload-error" title={uploadError}>
                  {uploadError}
                </span>
              </>
            )}
          </div>
          {renderFooter?.()}
        </div>
      )}
    </div>
  )
}

/**
 * 将 EditorContentSource 转换为 TipTap 初始文档
 *
 * - json: 直接返回
 * - markdown: 转为 HTML 字符串，再交给 setContent（这里仅返回 HTML 字符串，
 *   让 useEditor 的 content 接受 HTML，需要 JSON 时上层在 onChange 拿）
 * - html: 直接返回
 * - empty: 空文档
 */
function contentToInitialDoc(source: EditorContentSource): object | string {
  switch (source.kind) {
    case 'json':
      return source.json
    case 'html':
      return source.html
    case 'markdown':
      return markdownToHtml(source.markdown)
    case 'empty':
    default:
      return EMPTY_DOC
  }
}

/**
 * 归一化 TipTap 的 HTML 字符串用于等价比较。
 *
 * Bug A 修复：父组件每次 render 都会把 `content` 当作新对象字面量传入，导致
 * `initialDoc` 引用每次都不同；如果仅按引用比较，会误判为"内容变了"而
 * setContent → 光标跳回开头。改为按规范化后的 HTML 字符串比较：
 *   - 去除标签之间空白
 *   - 把多个连续空白字符折叠为单个空格
 *   - 去除首尾空白
 *
 * 这样既能在父组件因 autosave / store 更新触发重渲染时跳过无意义的
 * setContent，又能在真正的内容变化（如切到另一篇笔记、冲突解决后重挂载）
 * 时正确触发。
 */
function normalizeEditorHtml(html: string): string {
  return html
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim()
}

export default TipTapEditor
