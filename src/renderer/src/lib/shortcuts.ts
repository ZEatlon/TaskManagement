/**
 * 全局快捷键注册表 + 平台格式化工具
 *
 * 设计要点：
 * - 所有快捷键集中在 SHORTCUT_DEFS 注册，新增快捷键只需在此处追加
 * - binding 字符串语法（中性、跨平台）：
 *     "mod+k"             —— 主修饰键 + K（Mac=⌘K；Win/Linux=Ctrl+K）
 *     "mod+shift+d"       —— 主修饰键 + Shift + D
 *     "shift+mod+d"       —— 顺序无所谓，解析时统一按 mod/ctrl/alt/shift/meta 排序
 *     "/"                 —— 单字符快捷键（仅在非输入焦点下生效）
 *     "n" / "t"           —— 同上
 *     "ctrl+k"            —— 显式指定 Ctrl（不跟随平台）
 *     "meta+k"            —— 显式指定 Meta/Cmd
 * - formatShortcutForOS()：把 binding 渲染成当前平台友好字符
 *   - Windows / Linux：Ctrl + Shift + D
 *   - macOS：⇧⌘D
 * - 平台检测优先用 window.api.platform（preload 暴露 process.platform），
 *   navigator.platform 仅作兜底（preload 未加载时）
 */

export type ShortcutCategory = '导航' | 'AI' | '便签' | '笔记' | '编辑器'

export interface ShortcutDef {
  /** 唯一 id；用作用户覆盖 Record 的 key */
  id: string
  /** 中文标签（设置页展示） */
  label: string
  /** 分类（设置页分组） */
  category: ShortcutCategory
  /** 默认 binding */
  defaultBinding: string
  /** 说明文字（鼠标 hover 显示） */
  description?: string
}

/** 全部快捷键注册表 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  // ----- AI -----
  {
    id: 'command-bar.toggle',
    label: '打开 / 关闭 AI 命令栏',
    category: 'AI',
    defaultBinding: 'mod+k',
    description: '在任意页面唤起 AI 命令栏（Raycast 风格浮卡）',
  },
  // ----- 便签 -----
  {
    id: 'sticky.search',
    label: '搜索便签',
    category: '便签',
    defaultBinding: '/',
    description: '聚焦便签时间线顶部的搜索框',
  },
  {
    id: 'sticky.new',
    label: '新建便签',
    category: '便签',
    defaultBinding: 'mod+n',
    description: '在今日新建一条便签（聚焦标题）',
  },
  {
    id: 'sticky.today',
    label: '回到今日',
    category: '便签',
    defaultBinding: 't',
    description: '滚动到今日分组',
  },
  {
    id: 'sticky.next-day',
    label: '下一天',
    category: '便签',
    defaultBinding: 'j',
    description: '时间线向下滚一天',
  },
  {
    id: 'sticky.prev-day',
    label: '上一天',
    category: '便签',
    defaultBinding: 'k',
    description: '时间线向上滚一天',
  },
  {
    id: 'sticky.archive',
    label: '归档当前便签',
    category: '便签',
    defaultBinding: 'e',
    description: '归档或取消归档当前焦点便签',
  },
  {
    id: 'sticky.duplicate',
    label: '复制焦点便签到今日',
    category: '便签',
    defaultBinding: 'mod+shift+d',
    description: '把焦点便签的内容复制成今日新便签',
  },
]

/* ============================================================== */
/* 平台检测                                                        */
/* ============================================================== */

/**
 * 当前平台是否为 macOS。
 * 优先用 preload 暴露的 process.platform（更可靠），fallback 到 navigator.platform。
 */
export function isMacPlatform(): boolean {
  if (typeof window !== 'undefined' && (window as unknown as { api?: { platform?: string } }).api?.platform) {
    return (window as unknown as { api: { platform: string } }).api.platform === 'darwin'
  }
  if (typeof navigator !== 'undefined') {
    return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
  }
  return false
}

/* ============================================================== */
/* binding 解析 / 匹配                                              */
/* ============================================================== */

const MOD_ALIASES = new Set(['mod', 'cmd', 'ctrl', 'control', 'meta'])
const CTRL_ALIASES = new Set(['ctrl', 'control'])
const META_ALIASES = new Set(['mod', 'cmd', 'meta'])
const ALT_ALIASES = new Set(['alt', 'option'])
const SHIFT_ALIASES = new Set(['shift'])

export interface ParsedBinding {
  /** 是否需要主修饰键（Mac=Meta；其它=Ctrl） */
  mod: boolean
  /** 是否显式指定 Ctrl（即便在 Mac 上也用 Ctrl） */
  ctrl: boolean
  /** 是否显式指定 Meta（即便在 Win/Linux 上也用 Cmd） */
  meta: boolean
  alt: boolean
  shift: boolean
  /** 主按键（已经是小写字母 / 数字 / 单字符） */
  key: string
}

/** 解析 binding 字符串。空 / null 返回 null。 */
export function parseBinding(binding: string | null | undefined): ParsedBinding | null {
  if (!binding || typeof binding !== 'string') return null
  const parts = binding
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return null

  let mod = false
  let ctrl = false
  let meta = false
  let alt = false
  let shift = false
  let key = ''

  for (const p of parts) {
    if (MOD_ALIASES.has(p)) {
      if (CTRL_ALIASES.has(p)) ctrl = true
      else if (META_ALIASES.has(p)) meta = true
      else mod = true
    } else if (CTRL_ALIASES.has(p)) ctrl = true
    else if (META_ALIASES.has(p)) meta = true
    else if (ALT_ALIASES.has(p)) alt = true
    else if (SHIFT_ALIASES.has(p)) shift = true
    else key = p
  }

  if (!key) return null

  // 把 mod 落地到对应平台：Mac → meta，其它 → ctrl
  // 但若用户已经显式 ctrl / meta，保留显式
  if (!ctrl && !meta) {
    if (mod && isMacPlatform()) meta = true
    else if (mod) ctrl = true
  }

  return { mod: false, ctrl, meta, alt, shift, key }
}

/** 判断 KeyboardEvent 是否匹配 binding 字符串 */
export function matchShortcut(e: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding)
  if (!parsed) return false

  // 主按键：字母 / 数字 / 单字符
  const keyLower = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (keyLower !== parsed.key) return false

  const modPressed = isMacPlatform() ? e.metaKey : e.ctrlKey
  // 用户显式指定 ctrl 时只看 ctrl；显式 meta 时只看 meta
  if (parsed.ctrl) {
    if (!e.ctrlKey) return false
  } else if (parsed.meta) {
    if (!e.metaKey) return false
  } else {
    if (!modPressed) return false
  }
  if (parsed.alt !== e.altKey) return false
  if (parsed.shift !== e.shiftKey) return false
  return true
}

/* ============================================================== */
/* 渲染展示                                                        */
/* ============================================================== */

/**
 * 把 binding 渲染成当前平台的友好显示字符串。
 * - Mac: ⌘⇧⌥ + Key
 * - Win/Linux: Ctrl + Shift + Alt + Key
 *
 * 单字母快捷键（如 "n" / "/"）统一首字母大写。
 */
export function formatShortcutForOS(binding: string, isMac?: boolean): string {
  const parsed = parseBinding(binding)
  if (!parsed) return binding || ''
  const mac = isMac ?? isMacPlatform()

  // 主按键字母大写，其它（数字 / 符号）保持原样
  const keyDisplay =
    parsed.key.length === 1 && /[a-z]/i.test(parsed.key)
      ? parsed.key.toUpperCase()
      : parsed.key

  if (mac) {
    const parts: string[] = []
    if (parsed.ctrl) parts.push('⌃')
    if (parsed.alt) parts.push('⌥')
    if (parsed.shift) parts.push('⇧')
    if (parsed.meta || (!parsed.ctrl && !parsed.meta && parsed.mod)) parts.push('⌘')
    parts.push(keyDisplay)
    return parts.join('')
  }

  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  else if (!parsed.meta) parts.push('Ctrl') // 默认 mod 在 Win/Linux 就是 Ctrl
  if (parsed.meta) parts.push('Meta')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(keyDisplay)
  return parts.join('+')
}

/** 拍平 binding 字符串便于存储（如 "Shift+Ctrl+K" → "mod+shift+k"）。用于 normalize 用户输入。 */
export function normalizeBindingFromEvent(e: KeyboardEvent): string | null {
  // 必须有主键
  if (!e.key || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta'
      || e.key === 'Alt' || e.key === 'Dead' || e.key === 'Unidentified') {
    return null
  }
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.metaKey) parts.push('meta')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

/** 从 SHORTCUT_DEFS 查 def */
export function findShortcutDef(id: string): ShortcutDef | undefined {
  return SHORTCUT_DEFS.find((d) => d.id === id)
}