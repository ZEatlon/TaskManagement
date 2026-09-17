# Code Signing — Windows 安装包

TaskPilot 在 Windows 上发布时建议做代码签名。签名后的安装包：
- 安装时 Windows SmartScreen 不弹"未知发布者"警告
- 用户在 Edge SmartScreen、Defender SmartScreen 看到发布者名字
- 升级时 Windows 不会因签名变更提示"新发布者"

本文档说明：
1. [证书获取](#证书获取)
2. [本地签名配置](#本地签名配置)
3. [CI / GitHub Actions 配置](#ci--github-actions-配置)
4. [签名工作原理](#签名工作原理)
5. [故障排查](#故障排查)

---

## 证书获取

代码签名证书（Code Signing Certificate）从 CA 颁发机构购买：

| 类型 | 价格 | SmartScreen 立即信任 | 适用 |
|---|---|---|---|
| **EV Code Signing** | $300-500 / 年 | ✅ 安装即信任 | 商业发布（推荐） |
| **普通 OV Code Signing** | $70-200 / 年 | ❌ 需积累下载量建立信誉 | 试用 / 内部 |

### 推荐 CA

- **Certum**（最便宜的 EV，含 USB token，~$250 / 年）：<https://shop.certum.eu/code-signing-certificates.html>
- **Sectigo**（Comodo）：<https://www.sectigo.com/products/code-signing>
- **DigiCert / GlobalSign**：商业级，技术支持好
- **SSL.com**：性价比高

### 申请步骤

1. CA 验证你的公司 / 个人身份
2. 拿到 `.pfx` 或 `.p12` 文件（私钥 + 证书）
3. 妥善保存密码（CI 用 secret manager）

---

## 本地签名配置

### 1. 准备 .pfx 文件

放到不会被 git 跟踪的位置，例如：
```
C:\Users\James\certs\taskpilot.pfx
```

### 2. 设置环境变量

**PowerShell（当前会话）**：
```powershell
$env:WINDOWS_CERT_FILE = "C:\Users\James\certs\taskpilot.pfx"
$env:WINDOWS_CERT_PASSWORD = "your-pfx-password"
$env:WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com"
```

**永久（用户级）**：
```powershell
[System.Environment]::SetEnvironmentVariable('WINDOWS_CERT_FILE', 'C:\Users\James\certs\taskpilot.pfx', 'User')
[System.Environment]::SetEnvironmentVariable('WINDOWS_CERT_PASSWORD', 'your-pfx-password', 'User')
```

### 3. 验证 signtool 可用

```powershell
where signtool.exe
# 应输出: C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\signtool.exe
```

如果没装，装 Windows SDK：
- 下载：<https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/>
- 勾选 "Windows SDK Signing Tools"

### 4. 构建并签名

```bash
npm run dist
```

预期日志（成功）：
```
• signing with signtool.exe  path=dist\__uninstaller-nsis-taskpilot.exe
[sign] signature verified: __uninstaller-nsis-taskpilot.exe
• signing with signtool.exe  path=dist\TaskPilot-1.0.0-setup.exe
[sign] signature verified: TaskPilot-1.0.0-setup.exe
```

### 5. 验证签名

**PowerShell**：
```powershell
Get-AuthenticodeSignature "dist\TaskPilot-1.0.0-setup.exe"
```

**signtool**：
```cmd
signtool verify /pa "dist\TaskPilot-1.0.0-setup.exe"
```

**Windows 资源管理器**：右键 → 属性 → 数字签名

---

## CI / GitHub Actions 配置

### 1. 在 GitHub 仓库添加 Secret

- `WINDOWS_CERT_BASE64` — `.pfx` 文件的 base64 编码
  ```bash
  base64 -w 0 taskpilot.pfx > cert.b64
  # 把 cert.b64 内容粘到 GitHub Secret
  ```
- `WINDOWS_CERT_PASSWORD` — `.pfx` 密码

### 2. 工作流示例（.github/workflows/release.yml）

```yaml
name: Release signed installer

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run typecheck
      - run: npm test

      - name: Decode cert
        env:
          WINDOWS_CERT_BASE64: ${{ secrets.WINDOWS_CERT_BASE64 }}
        run: |
          [System.IO.File]::WriteAllBytes("taskpilot.pfx", [Convert]::FromBase64String($env:WINDOWS_CERT_BASE64))

      - name: Build NSIS + sign
        env:
          WINDOWS_CERT_FILE: ${{ github.workspace }}\taskpilot.pfx
          WINDOWS_CERT_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run dist

      - name: Upload release assets
        uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/TaskPilot-${{ github.ref_name }}-setup.exe
            dist/TaskPilot-${{ github.ref_name }}-setup.exe.blockmap
            dist/latest.yml
```

### 3. 触发发布

```bash
# 1. 改 package.json 的 version 为新版本
# 2. 提交
git add package.json CHANGELOG.md
git commit -m "chore: release v1.1.0"

# 3. 打 tag（必须 v 前缀让 electron-builder 识别）
git tag v1.1.0
git push --tags
```

工作流会自动构建 + 签名 + 上传到 GitHub Release。

---

## 签名工作原理

### 时序

```
electron-builder 流程：
1. 打包 win-unpacked/TaskPilot.exe
2. rcedit 修改版本号 / 图标资源
3. [sign.js] 用 signtool 签 TaskPilot.exe
4. 打包 NSIS 安装包（unpacked 形式）
5. [sign.js] 用 signtool 签 setup.exe
6. [sign.js] 用 signtool 签 __uninstaller-nsis-taskpilot.exe
7. 生成 latest.yml（更新清单）
8. （可选）上传到 GitHub Releases
```

### 双签名（dual signing）

EV 证书需要 SHA1 + SHA256 双签名才能在 Windows 7 上工作。signtool 默认只用 SHA256。

如果需要 SHA1 fallback，把 `build/sign.js` 里的 signtool 命令改成：
```javascript
args = [
  'sign',
  '/as',  // 追加签名（不替换）
  '/fd', 'sha256',
  '/td', 'sha256',
  '/tr', timestampUrl,
  // SHA1 fallback
  '/sha1',
  '/t', legacyTimestampUrl,
  // ... 证书
]
```

大多数新项目不需要 SHA1 fallback（Win7 已 EOL）。

### 与 electron-updater 的协作

`latest.yml` 里的 `sha512` 字段是 setup.exe 的 SHA-512 哈希。升级时 electron-updater：
1. 拉 `latest.yml` 看 `version` 是否更高
2. 下载 `setup.exe`（带 blockmap 差分）
3. 校验 `sha512`（防中间人篡改）
4. 运行新 installer 替换旧版本

签名是 Windows 层面的额外保证，不影响 electron-updater 的版本检查。

---

## 故障排查

### "No code-signing cert found"

确认：
- `WINDOWS_CERT_FILE` 指向存在的 `.pfx` 文件
- 文件可读（PowerShell `Test-Path` 验证）
- 没有拼写错误

### "No signer found"

- Windows：装 Windows SDK
- Linux/macOS：`apt install osslsigncode` 或 `brew install osslsigncode`

### "signtool exited with 1"

常见原因：
- 证书密码错（看 stderr "The specified network password is not correct"）
- 时间戳服务器不可达（换 `WINDOWS_TIMESTAMP_URL`）
- 证书已过期（看证书属性）

### Windows SmartScreen 仍警告"未知发布者"

EV 证书：安装即信任，普通证书需要积累下载量或申请 [Microsoft Defender SmartScreen Program](https://www.microsoft.com/en-us/wdsi/filesubmission/)。

### "无法在证书存储中找到证书"

.pfx 格式问题。用 OpenSSL 重新打包：
```bash
openssl pkcs12 -export -out taskpilot.pfx -inkey private.key -in cert.crt -certfile ca-bundle.crt
```

---

## 参考

- electron-builder 签名文档：<https://www.electron.build/code-signing>
- signtool 文档：<https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool>
- Authenticode 规范：<https://learn.microsoft.com/en-us/windows-hardware/drivers/install/authenticode>
