# TaskPilot 安装说明

## 快速开始

```bash
cd "E:/个人项目/任务进度管理"
npm install
npm run dev
```

## 重要：原生模块策略

本项目使用 **sidecar 进程模式**运行 `better-sqlite3`：

- `better-sqlite3 v13` 需要 Node 22+
- Electron 33 自带 Node 20 ABI，与 better-sqlite3 的预编译产物不兼容
- 我们用**系统 Node 24**（已安装）作为子进程运行 `better-sqlite3`，通过 JSON-RPC over stdio 与 Electron 主进程通信
- 因此 `better-sqlite3` **不需要为 Electron ABI 重新编译**，`npm install` 会直接下载 Node 24 的预编译产物

`package.json` 已配置：
- `"postinstall": "node scripts/postinstall.cjs"` — 优雅处理 native rebuild 失败
- `better-sqlite3` / `@img/sharp-*` 显式列入 `asarUnpack`（原生模块的 .node / .dll 必须落在 asar 外才能被 Electron 加载）
- 注：`better-sqlite3` 走 sidecar 进程模式（在系统 Node 下用预编译 .node），无需为 Electron ABI 重新编译

## 常见安装问题

### 1. `Could not find any Visual Studio installation to use`

**原因**：Windows 平台，`electron-builder install-app-deps` 默认会尝试用 node-gyp 重新编译原生模块给 Electron ABI。

**我们已处理**：
- `scripts/postinstall.cjs` 在 rebuild 失败时**不会阻塞** `npm install`
- `better-sqlite3` 通过 sidecar 进程在系统 Node 下运行，**不**走 Electron ABI rebuild
- `sharp` 等使用 prebuild 预编译产物，无需本地编译

**如果遇到运行时模块加载错误**：
1. 安装 Visual Studio Build Tools：https://visualstudio.microsoft.com/visual-studio-build-tools/
2. 或手动重建：`npm run rebuild:native`

### 2. better-sqlite3 预编译产物下载失败

如果是网络问题导致 better-sqlite3 预编译下载失败，可手动指定镜像：
```bash
npm config set better_sqlite3_binary_host_mirror https://npmmirror.com/mirrors/better-sqlite3/
npm install
```

### 3. sharp 预编译下载失败

```bash
npm config set sharp_binary_host https://npmmirror.com/mirrors/sharp
npm install
```

### 4. 全部跳过原生重建

如果本机环境特殊（无编译器、无网络），可以彻底跳过 postinstall：
```bash
npm install --ignore-scripts
```

然后首次启动前手动检查 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 是否存在（应已由预编译产物提供）。

### 5. `Error: Electron uninstall` 启动失败

**原因**：Electron 二进制没下载成功。`electron-vite` 启动 Electron 时找不到 `electron.exe`。

**我们已处理**：`scripts/postinstall.cjs` 默认通过 `https://cdn.npmmirror.com/binaries/electron/` 下载 Electron 二进制，避开 github.com 在国内常见的不稳定。同时会自动修复 `path.txt` 末尾换行符导致的 ENOENT。

**手动重试**：
```bash
# Windows PowerShell
$env:ELECTRON_MIRROR = "https://cdn.npmmirror.com/binaries/electron/"
node node_modules/electron/install.js
```

### 6. 启动后立即窗口关闭 + 错误 `Cannot read properties of undefined (reading 'isPackaged')`

**原因**：环境变量 `ELECTRON_RUN_AS_NODE=1` 被设置，导致 Electron 二进制以 Node 模式运行（拿不到 electron API）。

**解决**：
```powershell
# PowerShell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# 或临时单次：
$env:ELECTRON_RUN_AS_NODE = $null
npm run dev
```

排查是否设置：
```bash
echo $env:ELECTRON_RUN_AS_NODE  # 应为空
```

## 环境要求

- Node.js **v22+**（推荐 v24）
- npm v9+
- Windows 10/11、macOS 12+、或 Linux（X11/Wayland）
- 推荐：Visual Studio Build Tools（仅当你需要重建其他原生模块时）
