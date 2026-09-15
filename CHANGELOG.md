# Changelog

All notable changes to TaskPilot are documented here. Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — 200-round Quality Loop Pass

**Date**: 2026-09-10 → 2026-09-15
**Scope**: Code quality, correctness, performance, structure, security, accessibility, i18n, test coverage, error handling, documentation.

### Summary

A 200-round automated review→verify→fix→typecheck loop was run against the full `src/` tree, cycling through 10 review lenses (correctness, perf, structure, security, ai-quality, accessibility, i18n, test-coverage, error-handling, documentation). Each candidate finding was passed through an adversarial refuter (refute-by-default) before any fix was applied.

| Metric | Value |
| --- | --- |
| Rounds completed | 200 |
| Confirmed real issues fixed | **382** |
| Candidate findings surfaced | 2541 |
| False-positive refutations | ~2159 (~85% refuted) |
| Independent issue fingerprints | 400 |
| Completeness critics | 2 |
| Agent invocations | 1408 |
| Agent errors | 0 |
| Total elapsed | ~28h |
| Total tokens | ~87M |

### Verification

- `npm run typecheck` (web + node): **PASS** (0 errors)
- `npm run build`: **PASS**
- `npm run lint`: **0 errors**, 30 warnings (all `react-hooks/exhaustive-deps` and unused `err` in catch blocks — pre-existing, low priority)
- `npm test`: **533 / 535 pass**, 2 skipped pending mock refactor (`test-tools-execute.mts` happy-path tools)

### Major areas touched

#### 1. UI foundation
- New shared primitives: `components/ui/{Button,Modal,Page}.tsx` (CVA + Radix Slot/Dialog)
- CSS tokens `--page-padding-x/y`, `--page-max-width`, `--button-height-*` unify dashboard / today / settings / sticky-notes layout
- Sticky color-vs-priority visual conflict resolved (color classes now win over priority classes via cascade order; p0/p1 get a left-edge accent strip)

#### 2. Sticky-note reminder + global shortcut
- New `main/sticky-notes/notifier.ts` — 30s `setInterval` scanner, partial index on `due_at WHERE notified_at IS NULL`
- DB migration `014-sticky-notes-notified-at.sql`
- `QuickCaptureOverlay` portal-mounted global `n`-trigger floating capture, default priority p2, optional dueAt

#### 3. Pomodoro completion
- New `main/pomodoro/audio.ts` orchestrator + `renderer/audio/noise.ts` extended with brown/pink/rain/ocean synthesis (zero audio files)
- `phaseSounds.ts` adds `playCompletionPing()` (800Hz sine + 50ms exponential decay)
- `FocusModeOverlay.tsx` full-screen backdrop-blur overlay with tabular-nums clock
- `pomodoroService.handlePhaseComplete` auto-marks bound sticky as `done` on natural focus completion (try/catch guards against deleted/archived stickies)
- `autoEnterFocusMode` config field added

#### 4. AI toolset expansion
- 8 new tools in `main/ai/tools.ts` (now 22 total):
  - `startPomodoro` / `stopPomodoro` / `pausePomodoro` / `getPomodoroState`
  - `navigate` (whitelist + date validation + only-sender receives)
  - `applyTagToNote` / `applyTagToSticky` (refuse to auto-create tags)
  - `batchUpdateStickies` (capped at 100, per-id error collection)
  - `getPomodoroStats` (local-day bucketing, streak, bestHour)
- 4 bridge files isolating side effects: `pomodoroBridge.ts`, `navigateBridge.ts`, `tagBridge.ts`, `statsBridge.ts`

#### 5. Inline AI
- New `InlineAIButton` + `InlineAIPicker` components (Radix Popover, keyboard nav)
- Mounted on StickyNoteCard, NoteEditor, PomodoroTimerPanel
- AI context sync: `useAiStore` tracks current sticky/note/pomodoro state; pushed to main via new IPC channels `AI_SET_CURRENT_STICKY_ID` / `AI_SET_CURRENT_POMODORO_CONTEXT`
- New dashboard widget `AIInsightCard` with 3 contextual suggestions

#### 6. IPC trust boundary hardening
- `ipcLimits.ts`, `ipcSanitizers.ts` centralize input clamping
- `emit.ts` safe-emit helper that no-ops on destroyed webContents
- Bridge modules all validate enum ranges, string bounds, batch sizes

#### 7. DB layer refactor
- `cachedStmt.ts` + `withPrepared.ts` helpers to enforce `prepare → run → finalize` try/finally pattern (closes the prepared-statement-leak class of bugs)
- DB migration `015-ai-conv-title-is-auto.sql`

#### 8. Test suite
- 23 new Node-native test scripts (`scripts/test-*.mts`) wired into `npm test`
- Covers: pomodoro generation guard (H9), bridge sanitization, IPC validator paths, sticky optimistic-update rollback, notifier scan logic, AI tool validators, migration ordering, prepared-statement cleanup
- Total: 535 tests, 533 pass, 2 skipped (`test-tools-execute.mts` happy-path tools pending mock refactor)

#### 9. Tooling
- `eslint.config.mjs` covers `scripts/**/*.mts` and root `index.cjs`
- `verify-lunar.mjs` lunar calendar verifier tightened

### Known minor issues (non-blocking)

- 30 lint warnings remain — all `react-hooks/exhaustive-deps` or unused `err` in catch blocks across the codebase (pre-existing pattern, refactoring out of scope for this pass)
- 2 happy-path AI tool tests are `skip: true` pending test-loader ALS-context refactor (see TODO at `scripts/test-tools-execute.mts:1196`)
- `module type` Node ESM warning at test-time due to `withPrepared.ts` (a `"type": "module"` toggle in `package.json` would silence it; intentionally not added to keep CJS bundling stable)

### Files added (highlights)

- `src/renderer/src/components/ui/{Button,Modal,Page}.tsx`
- `src/renderer/src/components/ai/{InlineAIButton,InlineAIPicker}.tsx`
- `src/renderer/src/components/dashboard/AIInsightCard.tsx`
- `src/renderer/src/components/pomodoro/FocusModeOverlay.tsx`
- `src/renderer/src/components/sticky-notes/QuickCaptureOverlay.tsx`
- `src/main/ai/{pomodoro,navigate,tag,stats}Bridge.ts`
- `src/main/pomodoro/audio.ts`
- `src/main/sticky-notes/{notifier,index}.ts`
- `src/main/db/{cachedStmt,withPrepared}.ts`
- `src/main/db/migrations/{014-sticky-notes-notified-at,015-ai-conv-title-is-auto}.sql`
- `src/main/ipc/{emit,ipcLimits,ipcSanitizers}.ts`
- `src/shared/{i18n,lib}/` initial scaffolding
- `src/renderer/src/lib/{navigateBridge,stickyAggregates,useImeGuard}.ts`
- `src/renderer/src/audio/context.ts`
- `scripts/test-*.{mts,mjs}` (23 files)

### Files removed

- `src/main/lib/localDayKey.ts` (moved to `src/shared/lib/`)

### Compatibility notes

- Existing AI tools (14 prior) unchanged in behavior — only doc-comments tightened
- `pomodoroService` public API unchanged
- Sticky note IPC contracts unchanged
- Note file format on disk unchanged
- No new npm dependencies; no version bumps

---

## Previous releases

See `git log` for the full history of `bug fixed` / `chore` / `fix(deps)` commits leading up to this pass.
