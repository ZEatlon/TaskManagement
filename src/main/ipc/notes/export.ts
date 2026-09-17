/**
 * W2-A note-handlers 拆分 —— 导出子模块
 *
 * 注册以下通道：
 *   note:export-pdf      导出当前笔记为 PDF（隐藏 BrowserWindow + printToPDF）
 */
import { handle } from '../channels'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import log from '../../log'

const MAX_HTML_BYTES = 20 * 1024 * 1024 // 20 MiB（PDF 渲染比 note:write 允许大）

export function registerNoteExportHandlers(): void {
  /**
   * 导出当前笔记为 PDF。
   *
   * 实现要点：
   *   - 渲染端已经把 markdown → 自包含 HTML（含内联样式 / base64 图片）
   *   - 主进程在隐藏 BrowserWindow 里 loadURL('data:text/html,...') 渲染该 HTML
   *   - 调用 webContents.printToPDF() 拿 Buffer → writeFile
   *   - 隐藏窗口用完即关（不持久化）
   *
   * 入参 `{ html, defaultFilename }`：
   *   - html 待打印 HTML（包含 <style> 让 PDF 自带样式）
   *   - defaultFilename 默认保存文件名（用户可在 dialog 里改）
   *
   * 出参 `{ savedPath } | null`：
   *   - 用户在 save dialog 取消 → null
   *   - 写盘成功 → 返回绝对路径
   */
  handle<{ html: string; defaultFilename?: string }, { savedPath: string } | null>(
    IPC_CHANNELS.NOTE_EXPORT_PDF,
    async (_e, args) => {
      if (!args?.html || typeof args.html !== 'string') return null
      // 入参大小兜底：避免渲染端被劫持后塞 100MB HTML 让主进程分配整块内存
      if (Buffer.byteLength(args.html, 'utf8') > MAX_HTML_BYTES) {
        throw new Error('note:export-pdf: html exceeds 20 MiB')
      }

      // 弹出系统保存对话框
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const defaultPath = args.defaultFilename?.replace(/[\\/:*?"<>|]/g, '_') || 'note.pdf'
      const dialogResult = await dialog.showSaveDialog(win ?? undefined!, {
        title: '导出笔记为 PDF',
        defaultPath: defaultPath.endsWith('.pdf') ? defaultPath : `${defaultPath}.pdf`,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      })
      if (dialogResult.canceled || !dialogResult.filePath) return null
      const targetPath = dialogResult.filePath

      // 隐藏 BrowserWindow 渲染 HTML → printToPDF
      const tempWin = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      try {
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(args.html)}`
        await tempWin.loadURL(dataUrl)
        // 等图片等异步资源加载完成（macOS / Linux 上 printToPDF 偶尔在 loadURL
        // resolve 后立即调用会拿到空白页）
        await new Promise((r) => setTimeout(r, 50))
        const pdfBuffer = await tempWin.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: {
            top: 0.5,
            bottom: 0.5,
            left: 0.5,
            right: 0.5,
          },
        })
        await writeFile(targetPath, pdfBuffer)
        log.info(`[note:export-pdf] saved ${pdfBuffer.length} bytes to ${targetPath}`)
        return { savedPath: targetPath }
      } finally {
        if (!tempWin.isDestroyed()) tempWin.close()
      }
    },
  )
}
