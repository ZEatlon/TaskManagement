/**
 * i18n locale registry（shared layer）。
 *
 * 单一来源：所有受支持语言的 value/label 都列在这里，TS 用 `as const` 推导
 * union type。新增 locale 只改本文件一处；下拉框 / 设置 store 类型 / i18n 加载
 * 器都从 LOCALE_VALUES / LocaleValue 派生，不再各自硬编码 'zh-CN'。
 *
 * 注意：当前 UI 仅硬编码中文文案，本模块只暴露「语言」选择器的元数据；真正
 * 多语言翻译是更大范围的工作，留待未来扩展。这里先消除「死 UI / cast 任何
 * 字符串回 zh-CN」的反模式，把扩展路径铺好。
 *
 * R-fix-i18n-notification-toast（high）：见底部 NOTIFICATION_MESSAGES 表 +
 * getNotificationMessages() —— 把「便签到期 / 提醒 / [TaskPilot] 前缀」这三
 * 条出现在系统通知中心的硬编码文案接上 locale registry，未来加 en-US 时不
 * 会立即变成 first bug。当前 locale registry 仍只一项（zh-CN），但底层已
 * 铺好，加新 locale 时本表增加一行即可，调用方零改动。
 *
 * R-fix-i18n-tray-menu（high）：见底部 TRAY_MESSAGES 表 + getTrayMessages()
 * —— 把 tray.ts:81-95 buildContextMenu() 里「显示窗口 / 隐藏窗口 / 退出」
 * 这三处 OS 级右键菜单的中文文案接上 locale registry，与 NotificationMessages
 * 同结构（短语 → 字符串）。
 */
export const LOCALE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
] as const

/** 从 LOCALE_OPTIONS 派生联合类型 —— 加新 locale 不用改 type 声明 */
export type LocaleValue = (typeof LOCALE_OPTIONS)[number]['value']

/** 下拉框选中值校验：未识别 locale 一律回退到默认值（首个 locale） */
export const DEFAULT_LOCALE: LocaleValue = LOCALE_OPTIONS[0].value

/**
 * Narrow unknown string to LocaleValue。
 * IPC / DB 读出来的字符串可能不在 union 内（老数据、用户手改 settings 文件），
 * 直接强转 'zh-CN' 会吞错；用本函数给出明确的回退语义。
 */
export function toLocaleValue(raw: unknown): LocaleValue {
  for (const opt of LOCALE_OPTIONS) {
    if (opt.value === raw) return opt.value
  }
  return DEFAULT_LOCALE
}

/**
 * 系统通知使用的固定文案 —— title / body 模板以 locale 维度维护。
 *
 * 历史动机（high i18n）：
 *   notify.ts:319 `title: '便签到期'` / notify.ts:343 `title: '提醒'` /
 *   notify.ts:381 `[TaskPilot] ${cleanTitle}` 这三处是直送系统 toast 通知
 *   中心的硬编码中文文案。即使当前 LOCALE_OPTIONS 仅 zh-CN 一项，未来加
 *   en-US 选项时这些会立即成为 first bug —— 把它们集中到本表 + 通过
 *   getNotificationMessages(locale) 查询，调用方零改动即可跟随 locale 切换。
 *
 * 设计取舍：
 *   - 文案是「短语」而非「带插值的句子」，所以直接放字符串而非模板函数。
 *     真要支持插值（"5 分钟后到期"）时改为 (args) => string 即可，本表
 *     仍是单一来源。
 *   - 不导出 raw strings（避免又出现 "import { STICKY_DUE_TITLE }" 然后被
 *     串改），只通过 getNotificationMessages() 暴露，调用方拿到的是冻结
 *     引用，不会无意修改污染后续 toast。
 */
export interface NotificationMessages {
  /** 系统通知中心 title —— sticky due */
  stickyDueTitle: string
  /** sticky due 通知 body 兜底文案 —— sticky 没有 title 时使用 */
  stickyDueBodyEmpty: string
  /** 系统通知中心 title —— 自定义 reminder */
  reminderTitle: string
  /** 系统通知中心 title 前缀 —— 渲染端发起的通知（防 XSS 仍走 [TaskPilot]） */
  rendererTitlePrefix: string
  /** 测试通知 title —— notify:test IPC handler 使用 */
  testTitle: string
  /**
   * 测试通知 body 模板 —— 接收已按 locale 格式化的时间字符串（HH:mm:ss），
   * 返回完整 body 文案。
   * 用函数而非字符串模板是因为 body 必然带时间插值；这里与设计上
   * "短语 → 字符串 / 插值 → (args) => string" 的取舍保持一致。
   */
  testBody: (time: string) => string
  /** 番茄钟 —— 专注阶段完成通知 title */
  pomodoroFocusCompleteTitle: string
  /** 番茄钟 —— 专注阶段完成通知 body 模板（含 sticky 标题、专注/休息分钟数） */
  pomodoroFocusCompleteBody: (args: {
    stickyTitle: string | null
    completedMin: number
    restMin: number
    restKind: 'shortBreak' | 'longBreak'
  }) => string
  /** 番茄钟 —— 休息阶段完成通知 title */
  pomodoroBreakCompleteTitle: string
  /** 番茄钟 —— 休息阶段完成通知 body */
  pomodoroBreakCompleteBody: string
  /** 番茄钟 —— 长休开始通知 title */
  pomodoroLongBreakStartTitle: string
  /** 番茄钟 —— 长休开始通知 body 模板（含休息分钟数） */
  pomodoroLongBreakStartBody: (min: number) => string
  /** 番茄钟 —— 短休开始通知 title */
  pomodoroShortBreakStartTitle: string
  /** 番茄钟 —— 短休开始通知 body 模板（含休息分钟数） */
  pomodoroShortBreakStartBody: (min: number) => string
}

/**
 * 各 locale 的通知文案。增加新 locale 时：
 *   1) 在 LOCALE_OPTIONS 加 value
 *   2) 在本表加同 key 的翻译条目（缺字段会触发 TS 编译错，强制补齐）
 */
const NOTIFICATION_MESSAGES: Record<LocaleValue, NotificationMessages> = {
  'zh-CN': {
    stickyDueTitle: '便签到期',
    stickyDueBodyEmpty: '(无标题便签)',
    reminderTitle: '提醒',
    rendererTitlePrefix: '[TaskPilot]',
    testTitle: 'TaskPilot 测试通知',
    testBody: (time) => `当前时间 ${time}`,
    pomodoroFocusCompleteTitle: '🍅 专注完成',
    pomodoroFocusCompleteBody: ({ stickyTitle, completedMin, restMin, restKind }) => {
      const rest = restKind === 'longBreak' ? '长休' : '短休'
      if (stickyTitle) {
        return `已专注 ${completedMin} 分钟：${stickyTitle}\n${rest} ${restMin} 分钟`
      }
      return `已专注 ${completedMin} 分钟，进入${rest} ${restMin} 分钟`
    },
    pomodoroBreakCompleteTitle: '⏰ 休息结束',
    pomodoroBreakCompleteBody: '该开始下一轮专注了',
    pomodoroLongBreakStartTitle: '☕ 长休开始',
    pomodoroLongBreakStartBody: (min) => `好好休息 ${min} 分钟`,
    pomodoroShortBreakStartTitle: '☕ 短休开始',
    pomodoroShortBreakStartBody: (min) => `稍作休息 ${min} 分钟`,
  },
}

/**
 * 查指定 locale 的通知文案字典；未识别 locale 一律回退到默认 locale，
 * 与 toLocaleValue() 的回退策略保持一致。
 *
 * 返回的是冻结的对象引用（as const），调用方安全地当作只读字典使用。
 */
export function getNotificationMessages(rawLocale: unknown): NotificationMessages {
  const locale = toLocaleValue(rawLocale)
  return NOTIFICATION_MESSAGES[locale]
}

/* ------------------------------------------------------------------ *
 * 系统托盘（tray）右键菜单文案
 *
 * 历史动机（high i18n）：
 *   tray.ts:81-95 buildContextMenu() 在 Menu.buildFromTemplate 里 inline
 *   写死「显示窗口 / 隐藏窗口 / 退出」三处硬编码中文。同项目其它用户可见
 *   文案（通知 / 日历 / 热力图 / 相对时间）已统一收口到本文件前 4 张字典；
 *   唯独 tray 在 new Menu 时直接写中文字面量。Menu 是 OS 级控件，
 *   linux / macOS / Windows 都通过系统菜单栏渲染，文案暴露给所有用户。
 *
 *   集中到本表 + 通过 getTrayMessages(locale) 查询，调用方零改动即可跟随
 *   locale 切换；与其它 registry 一样，未来加 en-US 时只在本表加同 key
 *   翻译条目（缺字段会触发 TS 编译错，强制补齐）。
 *
 * 设计取舍：
 *   - 三项都是「短语」而非「带插值的句子」，直接放字符串而非模板函数。
 *     真要支持插值时改为 (args) => string 即可，本表仍是单一来源。
 *   - tray 初始化时一次解析 settings.language 并把字典缓存到模块作用域，
 *     避免每次右键点击都 await settingsRepo.get —— 与 tray 模块的
 *     「OS 级全局菜单」语义匹配（语言变化频率远低于菜单点击频率）。
 *     settings.language 变化时调用方主动 refreshTrayMessages() 重建。
 * ------------------------------------------------------------------ */
export interface TrayMessages {
  /** 右键菜单「显示窗口」 */
  showWindow: string
  /** 右键菜单「隐藏窗口」 */
  hideWindow: string
  /** 右键菜单「退出」 */
  quit: string
}

const TRAY_MESSAGES: Record<LocaleValue, TrayMessages> = {
  'zh-CN': {
    showWindow: '显示窗口',
    hideWindow: '隐藏窗口',
    quit: '退出',
  },
}

export function getTrayMessages(rawLocale: unknown): TrayMessages {
  const locale = toLocaleValue(rawLocale)
  return TRAY_MESSAGES[locale]
}

/* ------------------------------------------------------------------ *
 * 月历组件（FocusCalendar）使用的固定文案
 *
 * 与 NOTIFICATION_MESSAGES 同样的「单一来源」原则：所有用户可见中文文案
 * （包括 WEEKDAY_HEADERS 的硬编码、monthLabel、tooltip、aria-label、按钮
 * 文字）都集中在这里。组件拿到的是函数引用 / 字符串 —— 真正的 i18n
 * 翻译在加新 locale 时只改本表 + 派生格式（Intl.DateTimeFormat 跟 locale
 * 自动走），调用方零改动。
 * ------------------------------------------------------------------ */

/** 月历 cell 的 aria-label 拼装参数（包含公历年月日 + 农历月日 + 节气） */
export interface CalendarCellAriaArgs {
  year: number
  month: number // 1-based (1 = 一月)
  day: number
  lunarMonthName: string
  lunarDayName: string
  /** 节气（如「立春」），没有则 null */
  term: string | null
  /** 当日便签数；> 0 时拼到末尾 */
  dueCount: number
}

/** 月历 tooltip 标题拼装参数 */
export interface CalendarTooltipTitleArgs {
  month: number // 1-based
  day: number
  lunarMonthName: string
  lunarDayName: string
  /** 节气，没有则 null */
  term: string | null
}

export interface CalendarMessages {
  /** role="grid" 容器 aria-label */
  gridAriaLabel: string
  /** 上个月按钮 aria-label */
  prevMonth: string
  /** 下个月按钮 aria-label */
  nextMonth: string
  /** 「回到今天」按钮文字 */
  backToToday: string
  /** monthStat 标签的 title（hover 提示） */
  monthStatTitle: string
  /**
   * monthStat 标签文字（拆成 before/after 两段，中间用 <strong> 包裹数字，
   * 这样 count 可以保持加粗视觉又不依赖 dangerouslySetInnerHTML）。
   * zh-CN: { before: '本月 ', after: ' 张待办便签' }
   * en-US: { before: 'This month: ', after: ' due notes' }
   */
  monthStatText: { before: string; after: string }
  /** 月历标题（年/月） */
  monthLabel: (year: number, month: number) => string
  /**
   * R-fix-i18n-lunar-shortdate (medium)：原 lunar.ts.shortDate(date) 返回
   * `${month}月${day}日` 形态的硬编码中文字符串，FocusDateHeader 的「8月31日」
   * 大字显示就是这条模板。集中到本表，加新 locale 时只改本表 + 派生
   * Intl.DateTimeFormat 跟 locale 自动走，调用方零改动。
   *   zh-CN: `${month}月${day}日`
   *   en-US: `Aug 31`（由 caller 决定走 monthShort 还是 Intl）
   */
  dayLabel: (month: number, day: number) => string
  /** 每个日期格子的 aria-label（公历 + 农历 + 节气 + 便签数） */
  cellAriaLabel: (args: CalendarCellAriaArgs) => string
  /** 悬停 tooltip 标题行（M月D日 · 农历月日 · 节气） */
  tooltipTitle: (args: CalendarTooltipTitleArgs) => string
  /** tooltip 「📌 N 张便签截止」—— 拆 before/after 让数字在 JSX 里独立加粗 */
  tooltipCount: { before: string; after: string }
  /** tooltip 空态文字 */
  tooltipEmpty: string
  /** tooltip 列表截断行（+N 更多…） */
  tooltipMore: (overflow: number) => string
  /**
   * 周内每天的短标签（按 Sunday=0 → Saturday=6 顺序固定 7 项）。
   * 用于月历 / 热力图左侧的 weekday 表头。
   * zh-CN: ['日','一','二','三','四','五','六']
   * en-US: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
   */
  weekdayShort: string[]
  /**
   * 月份短标签（按 January=0 → December=11 顺序固定 12 项）。
   * 用于热力图顶部「1月 / 2月 / …」月份标签条。
   * zh-CN: ['1月','2月',…,'12月']
   * en-US: ['Jan','Feb',…,'Dec']
   *
   * R-fix-i18n-heatmap-month-label (high)：原 heatmapData.ts:79 模块级
   * 常量 MONTH_LABELS_ZH 是硬编码中文，与本表 CalendarMessages 已有的
   * weekdayShort 走同一套 i18n 注册表的结构不一致 —— 任何未来非 zh-CN
   * locale 会让 weekday 头跟着 locale 走、月份标签却始终中文。增加本字段，
   * 由 buildHeatmap 调用方传入，热力图组件从 getCalendarMessages(language)
   * 取出。
   */
  monthShort: string[]
}

const CALENDAR_MESSAGES: Record<LocaleValue, CalendarMessages> = {
  'zh-CN': {
    gridAriaLabel: '月历',
    prevMonth: '上个月',
    nextMonth: '下个月',
    backToToday: '回到今天',
    monthStatTitle: '本月截止的便签数',
    monthStatText: { before: '本月 ', after: ' 张待办便签' },
    monthLabel: (year, month) => `${year}年${month}月`,
    dayLabel: (month, day) => `${month}月${day}日`,
    cellAriaLabel: ({ year, month, day, lunarMonthName, lunarDayName, term, dueCount }) => {
      const base = `${year}年${month}月${day}日，农历${lunarMonthName}${lunarDayName}`
        + (term ? `，节气${term}` : '')
      return dueCount > 0 ? `${base}，${dueCount} 张便签截止` : base
    },
    tooltipTitle: ({ month, day, lunarMonthName, lunarDayName, term }) =>
      `${month}月${day}日 · ${lunarMonthName}${lunarDayName}`
        + (term ? ` · ${term}` : ''),
    tooltipCount: { before: '📌 ', after: ' 张便签截止' },
    tooltipEmpty: '当日无待办便签',
    tooltipMore: (overflow) => `+${overflow} 更多…`,
    weekdayShort: ['日', '一', '二', '三', '四', '五', '六'],
    monthShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  },
}

export function getCalendarMessages(rawLocale: unknown): CalendarMessages {
  const locale = toLocaleValue(rawLocale)
  return CALENDAR_MESSAGES[locale]
}

/* ------------------------------------------------------------------ *
 * 热力图（Heatmap / HeatmapWidget）使用的固定文案
 *
 * 历史动机（high i18n-architecture）：
 *   原 Heatmap.tsx 已 import getCalendarMessages 取 weekdayShort，但其它
 *   13 处用户可见字符串（标题「贡献热力图」、loading 「加载中...」、3 张
 *   summary 卡「年总完成 / 活跃天数 / 当前连胜」、aria-label 「年度统计」/
 *   「热力图统计」、caption「N 天 · 总计 X 次 · 活跃 Y 天」、侧栏「最长连胜
 *   / 日均 / 峰值」、sr-only 完整摘要）全是硬编码中文。未来加任何 locale 时
 *   weekday 列会跟着切，其它文本全冻在中文，比完全硬编码更糟（用户视觉上
 *   是「半中半英」的混合 UI）。把它们集中到本表 + 通过
 *   getHeatmapMessages(locale) 查询，调用方零改动即可跟随 locale 切换。
 *
 * 设计取舍（与 CalendarMessages 保持一致）：
 *   - caption 是带插值的句子，数字不加粗，所以直接用 (args) => string
 *     模板函数（zh-CN: `${days} 天 · 总计 ${total} 次 · 活跃 ${active} 天`）。
 *     之前 monthStatText 用 before/after 拆段是因为数字要在 JSX 内独立
 *     加粗；caption 数字都是同一行同一字号，无需拆。
 *   - sr 完整摘要也是带插值句子，用 (args) => string 而不是裸字符串；
 *     这样加 en-US 时只需换翻译模板、不必为了复用改 React 端 JSX 结构。
 *   - 与 monthShort 的关系：月份短标签由 CALENDAR_MESSAGES 提供（与
 *     monthLabel / weekdayShort 共用「calendar」维度），不再在本表重复
 *     声明，避免双源。
 * ------------------------------------------------------------------ */

export interface HeatmapMessages {
  /** 卡片头部副标题（year 旁边的「贡献热力图」） */
  title: string
  /** loading 占位文案 */
  loading: string
  /** 3 张 summary 卡容器 aria-label */
  summaryAriaLabel: string
  /** summary 卡 1 — 年总完成 */
  summaryTotalLabel: string
  /** summary 卡 2 — 活跃天数 */
  summaryActiveLabel: string
  /** summary 卡 3 — 当前连胜 */
  summaryStreakLabel: string
  /**
   * footer caption 模板 —— 数字直接用 ES 模板字符串拼，不再拆 before/after：
   *   zh-CN: `${days} 天 · 总计 ${total} 次 · 活跃 ${active} 天`
   * 之前设计 before/after 拆段是因为数字要 JSX 内独立加粗；caption 数字不加粗，
   * 直接用模板函数最简洁。
   */
  caption: (args: { days: number; total: number; active: number }) => string
  /** 信息栏 aria-label */
  sidebarAriaLabel: string
  /** 信息栏 — 最长连胜 */
  sidebarLongestStreak: string
  /** 信息栏 — 日均 */
  sidebarAvg: string
  /** 信息栏 — 峰值 */
  sidebarPeak: string
  /**
   * sr-only 完整摘要（年度统计 + 当前连胜 + 最长连胜 + 单日峰值）模板。
   * 含 5 个数字插值（年总/活跃天数/当前连胜/最长连胜/单日峰值）+ 1 个 year。
   */
  srSummary: (args: {
    year: number
    total: number
    active: number
    currentStreak: number
    longestStreak: number
    maxCount: number
  }) => string
  /**
   * R-fix-i18n-heatmap-widget-strings (medium)：Dashboard 内嵌热力图专用。
   * 与全年版 Heatmap.tsx 共享同一份 HeatmapMessages（命名空间统一），但
   * 仪表盘 widget 还多出 5 块用户可见字符串未覆盖：图例 5 档量化描述 /
   * 「近三月 · X月 - Y月」period 标题 / 长 summary「N 次 · 活跃 M 天 · ...」/
   * 图例两端「少」「多」。这里集中暴露给 widget 调用方。
   */
  /**
   * 图例 5 档量化描述（按 level-0..4）。与 HeatmapWidget.LEGEND_LABELS
   * 形态完全一致 —— SR 用户听到「活动 1 至 3 次」即可判断色阶。
   */
  legendLabels: Record<0 | 1 | 2 | 3 | 4, string>
  /**
   * Dashboard widget 「近三月 · X月 - Y月」period 标题模板。
   * args.startMonth / args.endMonth 均为已格式化的月份短标签（取自
   * CalendarMessages.monthShort），caller 自己负责 startMonth === endMonth
   * 时只传一个 —— 因此本模板始终接收两段区间拼接。
   * zh-CN: `近三月 · ${start}月 - ${end}月`
   */
  periodLabelTemplate: (args: { startMonth: number; endMonth: number }) => string
  /**
   * Dashboard widget 长 summary 「近三月完成 N 次 · 活跃 M 天 · ...」。
   * 数字不加粗（与全年版 caption 设计一致），整段直接走模板函数最简洁。
   */
  subTemplate: (args: {
    total: number
    activeDays: number
    streak: number
    avgPerDay: string
  }) => string
  /** 图例左端「少」 */
  lessLabel: string
  /** 图例右端「多」 */
  moreLabel: string
}

const HEATMAP_MESSAGES: Record<LocaleValue, HeatmapMessages> = {
  'zh-CN': {
    title: '贡献热力图',
    loading: '加载中...',
    summaryAriaLabel: '年度统计',
    summaryTotalLabel: '年总完成',
    summaryActiveLabel: '活跃天数',
    summaryStreakLabel: '当前连胜',
    caption: ({ days, total, active }) => `${days} 天 · 总计 ${total} 次 · 活跃 ${active} 天`,
    sidebarAriaLabel: '热力图统计',
    sidebarLongestStreak: '最长连胜',
    sidebarAvg: '日均',
    sidebarPeak: '峰值',
    srSummary: ({ year, total, active, currentStreak, longestStreak, maxCount }) =>
      `${year} 年共完成 ${total} 次，活跃 ${active} 天，当前连胜 ${currentStreak} 天，`
      + `最长连胜 ${longestStreak} 天，单日峰值 ${maxCount}。详细分布见下方图例与网格。`,
    legendLabels: {
      0: '活动 0 次',
      1: '活动 1 至 3 次',
      2: '活动 4 至 6 次',
      3: '活动 7 至 9 次',
      4: '活动 10 次及以上',
    },
    periodLabelTemplate: ({ startMonth, endMonth }) =>
      `近三月 · ${startMonth}月 - ${endMonth}月`,
    subTemplate: ({ total, activeDays, streak, avgPerDay }) =>
      `近三月完成 ${total} 次 · 活跃 ${activeDays} 天 · 连续 ${streak} 天 · 日均 ${avgPerDay} 次`,
    lessLabel: '少',
    moreLabel: '多',
  },
}

export function getHeatmapMessages(rawLocale: unknown): HeatmapMessages {
  const locale = toLocaleValue(rawLocale)
  return HEATMAP_MESSAGES[locale]
}

/* ------------------------------------------------------------------ *
 * 相对日期 / 时间（formatDate.ts 使用的固定文案）
 *
 * 历史动机（high i18n）：
 *   formatDate.ts:25 硬编码中文 WEEKDAYS / '今天'/'明天'/'昨天'/'后天'/
 *   '前天'/`${diff} 天后`/`${-diff} 天前`/formatTimeAgo 同形态硬编码。
 *   CalendarMessages / HeatmapMessages / NotificationMessages 已走 locale
 *   registry，唯独这一块缺失 —— 当 settings.language 切换到非 zh-CN 时，
 *   便签 widget / 每日 sticky header 仍然渲染中文，与其它 i18n 路径「半
 *   中半英」体感更糟。集中到本表 + 通过 getRelativeTimeMessages(locale)
 *   查询，调用方零改动即可跟随 locale 切换。
 *
 * 设计取舍：
 *   - weekdayFull 用完整 7 项（Sunday=0 → Saturday=6）。与 CalendarMessages
 *     的 weekdayShort（短标签）共存：本表是「formatDate sticky header 用
 *     的全称」独立维护，因为 zh-CN 用「周一/周二/...」全称、en-US 用
 *     「Monday/Tuesday/...」全称，与短标签是两套词。
 *   - 跨周回落 `MM-DD` 用 mmDd(m, d) 模板函数：与 CalendarMessages 的
 *     monthLabel 同样的设计 —— 月份/日期段都是单独模板便于翻译。
 *   - dayHeaderTemplate(dateKey, weekday, relative) 把整个粘性 header 拼
 *     装逻辑交给 i18n 表，避免 `·` 分隔符被中英硬编码。
 * ------------------------------------------------------------------ */

export interface RelativeTimeMessages {
  /**
   * 一周七天的全称（Sunday=0 → Saturday=6）。
   * zh-CN: ['周日','周一','周二','周三','周四','周五','周六']
   * en-US: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
   */
  weekdayFull: string[]
  /** 「今天」 */
  today: string
  /** 「明天」 */
  tomorrow: string
  /** 「昨天」 */
  yesterday: string
  /** 「后天」 */
  dayAfterTomorrow: string
  /** 「前天」 */
  dayBeforeYesterday: string
  /** 「N 天后」 —— N 由 caller 计算好传进来 */
  inNDays: (n: number) => string
  /** 「N 天前」 —— N 由 caller 计算好传进来 */
  nDaysAgo: (n: number) => string
  /** 跨周回落 `MM-DD` —— caller 拆好 month/day 传进来 */
  mmDd: (month: number, day: number) => string
  /**
   * sticky day header 拼装模板：例如
   *   zh-CN: `${dateKey} ${weekday} · ${relative}`
   *   en-US: `${dateKey} ${weekday} · ${relative}`
   * 当前 zh-CN / en-US 形态相同，但分隔符/词序未来可能分化（例
   * 如改成 `Monday, 2026-08-31 (Today)`），因此暴露为模板函数而非
   * 在 caller 端 `·` 拼死。
   */
  dayHeaderTemplate: (dateKey: string, weekday: string, relative: string) => string
  /** 「—」 —— formatTimeAgo 空入参回退 */
  timeAgoEmpty: string
  /** 「刚刚」 */
  justNow: string
  /** 「N 秒前」 */
  secondsAgo: (n: number) => string
  /** 「N 分钟前」 */
  minutesAgo: (n: number) => string
  /** 「N 小时前」 */
  hoursAgo: (n: number) => string
  /** 「N 天前」 —— 7 天以内用，超过后回落到 mm-dd 形式 */
  daysAgo: (n: number) => string
  /**
   * 新建 AI 对话时的占位标题前缀（日期由 caller 用 `new Date().toLocaleString(locale)`
   * 拼到「prefix · datetime」形态）。
   *
   * 历史动机：原 stores/ai.ts:444 硬编码 `新对话 · ${new Date().toLocaleString('zh-CN')}`，
   * 把"系统占位"状态与中文字面量绑死。stores/ai.ts 的 title_updated handler 用
   * `c.title.startsWith('新对话')` 判定「这仍是占位，可以被 AI 自动覆盖」，切到
   * 非 zh-CN 后永远 false → 自动重写失效。
   *
   * 当前架构修复是双轨：
   *   1) DB schema 加 title_is_auto 列（见 migration 015），title_updated handler
   *      改用 `c.titleIsAuto === true` 判定（不再读字面量）。
   *   2) 占位前缀走本字段（保持调用方零字面量）。`·` 分隔符与日期格式仍由
   *      caller 拼，未来加 en-US 时只需在本表加同 key 翻译条目，分隔符如需变
   *      可改成 (args: {dateKey, time}) => string。
   *   zh-CN: '新对话'
   *   en-US: 'New conversation'
   */
  conversationTitlePlaceholder: string
}

const RELATIVE_TIME_MESSAGES: Record<LocaleValue, RelativeTimeMessages> = {
  'zh-CN': {
    weekdayFull: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    today: '今天',
    tomorrow: '明天',
    yesterday: '昨天',
    dayAfterTomorrow: '后天',
    dayBeforeYesterday: '前天',
    inNDays: (n) => `${n} 天后`,
    nDaysAgo: (n) => `${n} 天前`,
    mmDd: (m, d) => `${m}-${d}`,
    dayHeaderTemplate: (dateKey, weekday, relative) =>
      `${dateKey} ${weekday} · ${relative}`,
    timeAgoEmpty: '—',
    justNow: '刚刚',
    secondsAgo: (n) => `${n} 秒前`,
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    daysAgo: (n) => `${n} 天前`,
    conversationTitlePlaceholder: '新对话',
  },
}

export function getRelativeTimeMessages(rawLocale: unknown): RelativeTimeMessages {
  const locale = toLocaleValue(rawLocale)
  return RELATIVE_TIME_MESSAGES[locale]
}
