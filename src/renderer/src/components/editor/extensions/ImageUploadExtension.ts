/**
 * TipTap 图片上传扩展（模块 6）
 *
 * 功能：
 *   - 监听 paste 事件：检测 image/* 文件 → 上传主进程 → 插入 image 节点
 *   - 监听 drop 事件：检测 image/* 文件 → 上传主进程 → 插入 image 节点
 *   - 提供 uploadImage 公开命令：从外部（工具栏按钮 / 文件选择器）触发
 *
 * 不接管原 Image 扩展的 schema/命令；只是在输入路径上做"文件 → 附件 URL"转换。
 */
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { attachmentsApi } from '../../../lib/ipc'

export interface ImageUploadOptions {
  /** 单文件大小上限（字节），默认 20MB */
  maxSize?: number
  /** 接受哪些 MIME 子类型，默认全部 image/* */
  accept?: string[]
  /** 拖拽进入时是否高亮（光标变 + 装饰） */
  highlightOnDragOver?: boolean
  /** 上传中回调（用于 UI 提示） */
  onUploadStart?: (file: File) => void
  /** 上传结束（成功或失败）回调 */
  onUploadEnd?: (file: File, url: string | null, error: string | null) => void
  /** 出错回调 */
  onError?: (message: string) => void
}

/** 把 File 转 base64 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader 返回非字符串'))
        return
      }
      // result 是 data URL：data:image/png;base64,xxxx
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 在光标处插入 image 节点 */
function insertImage(view: EditorView, url: string, alt: string) {
  const node = view.state.schema.nodes['image']
  if (!node) {
    console.warn('[image-upload] schema 中没有 image 节点')
    return
  }
  const imageNode: PMNode = node.create({ src: url, alt })
  const tr = view.state.tr.replaceSelectionWith(imageNode, false)
  view.dispatch(tr)
}

/** 上传单张图片，返回 URL 或抛错 */
async function uploadFile(file: File): Promise<string> {
  const base64 = await fileToBase64(file)
  const res = await attachmentsApi.upload({
    base64,
    mime: file.type || 'image/png',
    filename: file.name,
  })
  return res.url
}

/** 提取 event 中所有 image 文件 */
function extractImageFiles(
  dt: DataTransfer | null,
  accept?: string[],
): File[] {
  if (!dt) return []
  const files: File[] = []
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files.item(i)
    if (!f) continue
    if (!f.type.startsWith('image/')) continue
    if (accept && accept.length && !accept.includes(f.type)) continue
    files.push(f)
  }
  return files
}

async function processFiles(
  files: File[],
  view: EditorView,
  opts: ImageUploadOptions,
): Promise<void> {
  const max = opts.maxSize ?? 20 * 1024 * 1024
  for (const file of files) {
    if (file.size > max) {
      opts.onError?.(`文件 ${file.name} 超过 20MB 限制`)
      continue
    }
    opts.onUploadStart?.(file)
    try {
      const url = await uploadFile(file)
      insertImage(view, url, file.name)
      opts.onUploadEnd?.(file, url, null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      opts.onError?.(`上传失败：${msg}`)
      opts.onUploadEnd?.(file, null, msg)
    }
  }
}

export const ImageUploadExtension = Extension.create<ImageUploadOptions>({
  name: 'imageUpload',

  addOptions() {
    return {
      maxSize: 20 * 1024 * 1024,
      accept: undefined,
      highlightOnDragOver: true,
      onUploadStart: undefined,
      onUploadEnd: undefined,
      onError: undefined,
    }
  },

  addCommands() {
    return {
      uploadImage:
        (files: FileList | File[]) =>
        ({ view }) => {
          const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
          if (arr.length === 0) return false
          void processFiles(arr, view, this.options)
          return true
        },
    } as never
  },

  addProseMirrorPlugins() {
    const opts = this.options
    return [
      new Plugin({
        props: {
          handleDrop(view, event) {
            const files = extractImageFiles(event.dataTransfer, opts.accept)
            if (files.length === 0) return false
            event.preventDefault()
            void processFiles(files, view, opts)
            return true
          },
          handlePaste(view, event) {
            const items = event.clipboardData
            if (!items) return false
            const files: File[] = []
            for (let i = 0; i < items.files.length; i++) {
              const f = items.files.item(i)
              if (f && f.type.startsWith('image/')) {
                if (!opts.accept || opts.accept.length === 0 || opts.accept.includes(f.type)) {
                  files.push(f)
                }
              }
            }
            if (files.length === 0) return false
            event.preventDefault()
            void processFiles(files, view, opts)
            return true
          },
        },
        view(editorView) {
          const dom = editorView.dom as HTMLElement
          let counter = 0
          function onDragEnter(e: DragEvent) {
            if (!e.dataTransfer) return
            const hasImage = Array.from(e.dataTransfer.items).some(
              (it) => it.type?.startsWith('image/'),
            )
            if (!hasImage) return
            counter++
            dom.classList.add('image-upload-dragover')
          }
          function onDragLeave() {
            counter = Math.max(0, counter - 1)
            if (counter === 0) dom.classList.remove('image-upload-dragover')
          }
          function onDragOver(e: DragEvent) {
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          }
          function onDrop() {
            counter = 0
            dom.classList.remove('image-upload-dragover')
          }
          dom.addEventListener('dragenter', onDragEnter)
          dom.addEventListener('dragleave', onDragLeave)
          dom.addEventListener('dragover', onDragOver)
          dom.addEventListener('drop', onDrop)
          return {
            destroy() {
              dom.removeEventListener('dragenter', onDragEnter)
              dom.removeEventListener('dragleave', onDragLeave)
              dom.removeEventListener('dragover', onDragOver)
              dom.removeEventListener('drop', onDrop)
              dom.classList.remove('image-upload-dragover')
            },
          }
        },
      }),
    ]
  },
})

/** 命令类型扩展声明 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageUpload: {
      uploadImage: (files: FileList | File[]) => ReturnType
    }
  }
}
