---
phase: 2
slug: short-term-discovery
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts or "none — Wave 0 installs" |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 1 | DISC-01 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 2-01-02 | 01 | 1 | DISC-02 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 2-01-03 | 01 | 1 | DISC-03 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 2-01-04 | 01 | 1 | DISC-04 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 2-01-05 | 01 | 1 | DISC-05 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 2-01-06 | 01 | 1 | DISC-06 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/` directory — test infrastructure setup
- [ ] vitest config — if no framework detected
- [ ] Test stubs for DISC-01 through DISC-06

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Kalshi `max_close_ts` filter works on public API | DISC-04 | Requires live API call | Run discovery once with filter, verify response contains only markets closing within 7 days |
| Polymarket `end_date_max` filter works | DISC-06 | Requires live API call | Run discovery once with filter, verify response contains only near-term markets |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
