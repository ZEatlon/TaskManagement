/**
 * 注册测试用 ESM loader。由 `--import` 加载，先于测试文件本身运行。
 */
import { register } from 'node:module'

// 用 URL 相对解析而不是 pathToFileURL —— 后者会把 import.meta.url 当成
// 文件路径二次转换，与 `./test-loader.mjs` 拼接时把 file:// 前缀嵌套两次。
const loaderUrl = new URL('./test-loader.mjs', import.meta.url).href
register(loaderUrl)
