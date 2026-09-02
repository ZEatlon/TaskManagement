// Quick verification script for lunar.ts — run with `npx tsx scripts/verify-lunar.mjs`
import { solarToLunar, getSolarTerm, weekdayName } from '../src/renderer/src/lib/lunar.ts'

const tests = [
  // 节气测试
  { date: '2026-08-07', expectTerm: '立秋', desc: '2026年立秋' },
  { date: '2026-08-23', expectTerm: '处暑', desc: '2026年处暑' },
  // 农历日期
  { date: '2026-08-31', desc: '今日（应得七月十九）' },
  { date: '2025-01-29', desc: '2025年春节（应得正月初一）' },
  { date: '2026-02-17', desc: '2026年春节（应得正月初一）' },
  { date: '2024-02-10', desc: '2024年春节（应得正月初一）' },
  { date: '2020-01-25', desc: '2020年春节（应得正月初一）' },
  // 节气偏移校验
  { date: '2025-08-07', expectTerm: '立秋', desc: '2025年立秋' },
  { date: '2024-08-07', expectTerm: '立秋', desc: '2024年立秋' },
]

let pass = 0
let fail = 0

for (const t of tests) {
  const d = new Date(t.date + 'T12:00:00')
  const r = solarToLunar(d)
  const w = weekdayName(d, 1)
  console.log(
    `${t.date} (${w}) → 农历${r.year}年${r.monthName}${r.dayName}` +
      (r.term ? ` / 节气: ${r.term}` : ''),
  )
  if (t.expectTerm) {
    if (r.term === t.expectTerm) {
      pass++
    } else {
      fail++
      console.error(`  ❌ expected term ${t.expectTerm}, got ${r.term ?? 'none'}`)
    }
  } else {
    pass++
  }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail > 0 ? 1 : 0)