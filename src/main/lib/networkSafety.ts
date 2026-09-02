/**
 * 网络安全：阻止主进程向 loopback / 私有网段 / link-local 发请求（防 token
 * / API key 外泄）。
 *
 * 背景：
 *   - git-handlers.ts:124 已实现 isBlockedHostname，用于远端 URL 校验
 *   - setting-handlers.ts 此前未做任何主机白名单/黑名单，渲染端 XSS 可把
 *     aiOpenaiBaseUrl / aiAnthropicBaseUrl / aiMinimaxBaseUrl 写成
 *     https://attacker.example/，下次聊天时 SDK 把 safeStorage 解出的 API
 *     key 作为 Authorization: Bearer 头发往该主机（exfil）
 *
 * R16 修复 (medium)：把 isBlockedHostname + 协议校验抽到共享模块，setting
 * handler 在 persist aiXxxBaseUrl 前调用 validateBaseUrl，禁止私有主机。
 *
 * R17 修复 (high security)：原 isBlockedIpv6 只覆盖 ::1/::/fc00::/7/fe80::/10
 * /::ffff:IPv4，漏掉 6to4（2002::/16 — 自动嵌入 IPv4，攻击者把 baseURL 写成
 * `https://[2002:7f00:0001::1]/v1` 会绕过黑名单；OS 把 6to4 转 IPv4 后实
 * 际请求打到 127.0.0.1，API key 被劫持到 loopback 上的恶意 listener）和
 * 4in6（`::127.0.0.1` / `::0177.0.0.1` — RFC 4291 IPv4-compatible IPv6，已
 * 弃用但部分系统仍按 IPv4 路由）。补全这两种 transition 形式，并在 isBlockedIpv6
 * 末尾加默认拒绝（任何已知 transition / mapped 之外的 IPv6 形态都按内网处理）。
 */
const BLOCKED_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa']

function isBlockedIpv4(hostname: string): boolean | null {
  const parts = hostname.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const [a, b] = parts.map((p) => Number(p))
  if (parts.some((p) => Number(p) > 255)) return true
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGN
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240/4 reserved
  return false
}

/**
 * R18 修复 (critical)：完全重写 IPv6 transition / 嵌入 IPv4 检测。
 *
 * R17 的实现有两个 R18 才被发现的真实致命 bug：
 *   1. URL constructor 按 WHATWG URL 规范会把 IPv4-in-IPv6 字面量
 *      `https://[::ffff:127.0.0.1]/v1` 规范化成 hostname=`[::ffff:7f00:1]`，
 *      同样的 `https://[::127.0.0.1]/v1` → `[::7f00:1]`。R17 的正则
 *      /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/ 只接受点分十进制，规范化后的
 *      16-bit 段形式（`::ffff:7f00:1`）完全不命中 → 校验放行 → 主进程把
 *      safeStorage 解出的 API key 透传给 127.0.0.1。
 *   2. 6to4 regex 用 `^2002:([0-9a-f]{1,2}):([0-9a-f]{1,2})([0-9a-f]{2}):`
 *      限制两个段最多 2 hex，但 RFC 3056 规定 6to4 是 [WWXX][YYZZ] 两段
 *      16-bit（最多 4 hex），所以标准 6to4 地址 `2002:7f00:0001::1`
 *      一个都匹配不上 → 整条 6to4 防线失效。
 *
 * 修复策略：deny-by-default + 标准化解析。R18 把所有 transition / embedded
 * IPv4 形式统一按段解析，不再依赖正则匹配 dotted 形式；任何解析出来的
 * 嵌入 IPv4 落入 RFC1918 / loopback 范围都返回 true；解析失败（罕见
 * 或对抗性畸形）按内网处理。
 *
 * 关键事实：
 *   - IPv4-mapped: ::ffff:WWXX:YYZZ（high 32 bits 是 ffff）
 *   - IPv4-compatible (deprecated): ::WWXX:YYZZ（high 32 bits 全 0）
 *   - 6to4: 2002:WWXX:YYZZ:...（next 32 bits 是嵌入 IPv4）
 *   - IPv4 转 16-bit 段：a.b.c.d → WWXX=a*256+b, YYZZ=c*256+d
 *   - 16-bit 段转 IPv4：WWXX → a=WWXX>>8, b=WWXX&0xff；YYZZ → c=YYZZ>>8, d=YYZZ&0xff
 */
function parse16BitGroup(s: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(s)) return null
  return parseInt(s, 16)
}

/** 把两个 16-bit 段转成 IPv4 点分十进制。任一段解析失败返回 null。 */
function ipv4From16BitGroups(hi: string, lo: string): string | null {
  const hiN = parse16BitGroup(hi)
  const loN = parse16BitGroup(lo)
  if (hiN === null || loN === null) return null
  return `${(hiN >> 8) & 0xff}.${hiN & 0xff}.${(loN >> 8) & 0xff}.${loN & 0xff}`
}

/**
 * R18 修复 (critical)：用段数组解析方式支持 URL 规范化后的所有 IPv6 形式。
 * 这里假设输入已是 lowercased + 去括号的形式。
 */
function isBlockedIpv6(hostname: string): boolean | null {
  if (!hostname.includes(':')) return null
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1' || h === '::') return true

  // 拆分成 8 个 16-bit 段（含 :: 压缩的零段）；便于解析 transition 形式
  // Node 规范化后的 hostname 用 `:` 分段，`::` 表示 0 压缩。
  // 例：'::ffff:7f00:1' → ['0','0','0','0','0','ffff','7f00','0001']
  // 例：'2002:7f00:1::' → ['2002','7f00','0001','0','0','0','0','0']
  const groups = expandIpv6Groups(h)
  if (!groups) return null

  // IPv4-mapped（::ffff:WWXX:YYZZ）—— 末两段是嵌入 IPv4，且前 6 段是 0、段 6 是 ffff
  // 也接受 URL 写法：[::ffff:7f00:1] 即 expanded 后第 6 段=ffff、第 7=WWXX、第 8=YYZZ
  if (groups[0] === '0' && groups[1] === '0' && groups[2] === '0' &&
      groups[3] === '0' && groups[4] === '0' && groups[5] === 'ffff') {
    const ip = ipv4From16BitGroups(groups[6]!, groups[7]!)
    if (ip) return isBlockedIpv4(ip) === true
  }

  // IPv4-compatible (deprecated)::WWXX:YYZZ —— 前 6 段全 0、末两段是嵌入 IPv4
  if (groups[0] === '0' && groups[1] === '0' && groups[2] === '0' &&
      groups[3] === '0' && groups[4] === '0' && groups[5] === '0') {
    const ip = ipv4From16BitGroups(groups[6]!, groups[7]!)
    if (ip) return isBlockedIpv4(ip) === true
  }

  // 6to4 2002:WWXX:YYZZ:... —— 第 1 段 = 2002，第 2/3 段是嵌入 IPv4
  if (groups[0] === '2002') {
    const ip = ipv4From16BitGroups(groups[1]!, groups[2]!)
    if (ip) return isBlockedIpv4(ip) === true
    // 即使 WWXX/YYZZ 段解析失败也按内网处理（保守策略：6to4 前缀且无法解析嵌入 IPv4 的拒绝放行）
    return true
  }

  // ISATAP（::0:5efe:WWXX:YYZZ）—— 第 5 段=0000、第 6 段=5efe
  if (groups[0] === '0' && groups[1] === '0' && groups[2] === '0' &&
      groups[3] === '0' && groups[4] === '0' && groups[5] === '5efe') {
    const ip = ipv4From16BitGroups(groups[6]!, groups[7]!)
    if (ip) return isBlockedIpv4(ip) === true
  }

  // 末两段看起来像点分 IPv4（URL 写法的最后防线）：例如
  //   '::127.0.0.1' → expanded groups 末两段 '7f00' + '0001'，上面 IPv4-compatible 已命中
  //   但如果用户把 `https://[::127.0.0.1]/v1` 写错成 4 段展开（不太可能），
  //   末两段 7f00 / 0001 也已覆盖。
  if (/^f[cd]/.test(h)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local

  // 其余 2000::/3 全球单播地址放行（正常公网 IPv6）
  return false
}

/**
 * 把 IPv6 文本（含 :: 压缩）展开为 8 个 16-bit 段字符串数组。失败返回 null。
 * 仅做 0..ffff 段合法性校验。
 */
function expandIpv6Groups(h: string): string[] | null {
  if (h.includes(':::')) return null // 多余 ::
  const parts = h.split('::')
  if (parts.length > 2) return null // 最多一个 ::

  const left = parts[0] ? parts[0].split(':') : []
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  if (parts.length === 1) {
    // 无 :: 压缩，必须正好 8 段
    const all = h.split(':')
    if (all.length !== 8) return null
    if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null
    return all.map((g) => g.toLowerCase())
  }
  // 有 :: 压缩：left + (8-left.length-right.length) 个零段 + right
  const fill = 8 - left.length - right.length
  if (fill < 1) return null
  if (left.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null
  if (right.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null
  const groups = [
    ...left,
    ...new Array(fill).fill('0'),
    ...right,
  ]
  return groups.map((g) => g.toLowerCase())
}

/**
 * 检查主机名是否为 loopback / link-local / 私有 / 多播 / reserved。
 * - IPv4 走标准 RFC1918 / RFC5735 / RFC6890 范围
 * - IPv6 走 fc00::/7 + fe80::/10 + ::1 + ::
 * - 无点的裸主机名（gitlab、localhost）按内网处理
 */
export function isBlockedHostname(hostname: string): boolean {
  // R22 修复 (medium correctness)：原 `/^\[|\]$/g` 中 g 标志会把字符串里所有
  // `[` 和 `]` 都剥掉，不是「首尾」语义。`[::1]evil` → `::1evil`。当前
  // 因为 URL constructor 拒绝非法 hostname 实际不可达，但意图模糊、未来改
  // 调用方会爆雷。改为单次首尾匹配。
  const host = hostname.replace(/^\[|]$/, '').toLowerCase().replace(/\.$/, '')
  if (!host) return true

  const v6 = isBlockedIpv6(host)
  if (v6 !== null) return v6

  const v4 = isBlockedIpv4(host)
  if (v4 !== null) return v4

  // 无点的裸主机名（如 gitlab、localhost）指向内网，拒绝
  if (!host.includes('.')) return true

  const labels = host.split('.')
  const tld = labels[labels.length - 1] ?? ''
  // 末段全数字 → 十进制/十六进制混写的 IP 变体（0x7f.0.0.1、2130706433.x）
  if (/^\d+$/.test(tld) || /^0x/.test(tld)) return true

  // R28-Sec-5 修复 (medium SSRF bypass)：原版只检查末段，全主机名里
  // 任意一段含数字 IP 字面量都应当拒：
  //   - `2130706433.attacker.com` —— 末段是 'com' 不命中，但首段是 32-bit
  //     十进制编码的 127.0.0.1；攻击者 DNS 把 *.attacker.com A 记录指
  //     127.0.0.1 后整条主机名等价于 loopback。
  //   - `0x7f000001.attacker.com` —— 同理，十六进制前缀编码 IPv4。
  //   - `0177.0.0.1.example.com` —— 八进制段（Node URL parser 不解析，
  //     但 OS / 部分 resolver 仍可能转 IPv4）。
  // 规则：任一 label 全数字 / 以 0x 开头 / 以 0 + 全数字开头，一律拒绝。
  for (const label of labels) {
    if (!label) return true
    if (/^\d+$/.test(label)) return true
    if (/^0x[0-9a-f]+$/i.test(label)) return true
    // 八进制：'0177' = 0o177 = 127；Node URL parser 不会自动解析，但攻击
    // 可能依赖上游 resolver 把 octet 段当 IPv4。保守拒。
    if (/^0[0-7]+$/.test(label)) return true
  }

  return BLOCKED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
}

const ALLOWED_AI_BASE_URL_PROTOCOLS = new Set(['https:'])

import { lookup } from 'node:dns/promises'

/**
 * R19 修复 (high security)：DNS 解析后再校验一道闸门。
 *
 * 词法白名单拦不住 nip.io / sslip.io / lvh.me（127.0.0.1.nip.io 解析到
 * 127.0.0.1）/ 攻击者控制域名解析 A 记录到内网 / DNS rebinding。这里
 * dns.lookup 拿所有解析结果，任何一个落在内网/loopback/link-local 都拒。
 */
async function assertHostnameResolvesToPublic(hostname: string): Promise<void> {
  if (isBlockedHostname(hostname)) {
    throw new Error(
      `host '${hostname}' is not allowed (lexical: loopback / private / link-local)`,
    )
  }
  let addrs: Array<{ address: string; family: number }>
  try {
    addrs = await lookup(hostname, { all: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`host '${hostname}' DNS resolution failed: ${msg}`)
  }
  if (addrs.length === 0) {
    throw new Error(`host '${hostname}' resolved to no addresses`)
  }
  for (const a of addrs) {
    const blocked =
      a.family === 6 ? isBlockedIpv6(a.address) : isBlockedIpv4(a.address)
    if (blocked === true) {
      throw new Error(
        `host '${hostname}' resolves to blocked address ${a.address} ` +
          `(loopback / private / link-local)`,
      )
    }
  }
}

/**
 * R21 修复 (medium security)：DNS rebinding 防护 —— 在 chat 真正发起
 * 请求前再次解析目标主机，若任意 A/AAAA 记录指向 loopback / 内网则拒。
 *
 * 背景：写 baseURL 时（assertHostnameResolvesToPublic）只做一次 DNS 校验。
 * 攻击者可借公共 wildcard DNS（如 1.2.3.4.nip.io，先解析到公网 IP，写入
 * 时通过校验；之后改 DNS A 记录到 127.0.0.1）实施 DNS rebinding：等到
 * SDK 真正发请求时解析到内网。Node 的 HTTPS 模块 / undici fetch 各自
 * 调用 dns.lookup，不复用应用层缓存，所以校验必须每次 chat 都做。
 *
 * 调用方：在 router.chat() 进入 OpenAI / Anthropic / MiniMax SDK 之前
 * 调一次，把目标 baseURL 解析出来校验。
 */
export async function assertHostnameStillPublic(hostname: string): Promise<void> {
  // 与 write-time 校验一致：先词法黑名单，再 DNS 解析。
  // 词法命中直接拒（节省一次 DNS round-trip）。
  if (isBlockedHostname(hostname)) {
    throw new Error(
      `chat-time safety: host '${hostname}' is not allowed (lexical block)`,
    )
  }
  // 重新解析：调用方可能在数小时前通过了 write-time 校验，DNS 记录
  // 在这期间被改指内网。这里再次解析，任一记录落在 blocked 范围就拒。
  let addrs: Array<{ address: string; family: number }>
  try {
    addrs = await lookup(hostname, { all: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`chat-time safety: DNS re-resolution failed for '${hostname}': ${msg}`)
  }
  if (addrs.length === 0) {
    throw new Error(`chat-time safety: '${hostname}' resolved to no addresses`)
  }
  for (const a of addrs) {
    const blocked =
      a.family === 6 ? isBlockedIpv6(a.address) : isBlockedIpv4(a.address)
    if (blocked === true) {
      throw new Error(
        `chat-time safety: '${hostname}' now resolves to blocked ${a.address} ` +
          `— possible DNS rebinding; refusing to send credentials`,
      )
    }
  }
}

/**
 * 校验 AI provider 的 baseURL。
 *
 * 背景：OpenAI / Anthropic / MiniMax SDK 都接受 `baseURL` 重写端点。
 * 若用户/渲染端把它指到任意主机，下一次 chat 会把 API key 透给该主机。
 * 这里强制 https + 公开主机（拒绝 loopback / 内网 / link-local）。
 *
 * 返回归一化后的 URL，失败抛错。
 */
export async function validateBaseUrl(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('baseURL must be a non-empty string')
  }
  const trimmed = raw.trim()
  if (trimmed.length > 2000) {
    throw new Error('baseURL exceeds 2000 chars')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`invalid baseURL: ${raw}`)
  }
  if (!ALLOWED_AI_BASE_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `baseURL protocol '${parsed.protocol}' not allowed — only https: is accepted`,
    )
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(
      `baseURL host '${parsed.hostname}' is not allowed (loopback / private / link-local)`,
    )
  }
  await assertHostnameResolvesToPublic(parsed.hostname)
  return trimmed
}