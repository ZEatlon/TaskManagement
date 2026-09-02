/**
 * 主进程日志模块
 * 基于 electron-log，统一日志格式与输出位置
 */
import logger from 'electron-log/main'

logger.transports.file.level = 'info'
logger.transports.console.level = 'debug'
logger.transports.file.fileName = 'taskpilot-main.log'
logger.transports.file.maxSize = 10 * 1024 * 1024 // 10 MB
logger.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

// 捕获未处理错误
logger.errorHandler.startCatching({
  showDialog: false,
  onError({ error }) {
    logger.error('Unhandled error:', error)
  },
})

export default logger
export const log = logger