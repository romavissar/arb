---
phase: 1
slug: api-connectivity-and-observability
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Manual CLI + grep verification (no test framework in project yet) |
| **Config file** | none — no test framework installed |
| **Quick run command** | `npx tsx src/index.ts 2>&1 | head -50` |
| **Full suite command** | `npx tsx src/index.ts 2>&1 | head -100` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command and verify expected output
- **After every plan wave:** Run full suite command and check all behaviors
- **Before `/gsd:verify-work`:** Full suite must show expected outputs
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | KAPI-06 | grep | `grep -q 'KALSHI_EXCLUDE_SPORTS' src/config.ts` | ✅ | ⬜ pending |
| 01-02-01 | 02 | 1 | KAPI-01 | run | `npx tsx src/index.ts 2>&1 \| grep -i 'kalshi'` | ✅ | ⬜ pending |
| 01-02-02 | 02 | 1 | KAPI-02 | grep | `grep -q '401' src/apis/kalshi.ts` | ✅ | ⬜ pending |
| 01-03-01 | 03 | 2 | KAPI-04 | run | `npx tsx src/index.ts 2>&1 \| grep -i 'health\|status'` | ✅ | ⬜ pending |
| 01-03-02 | 03 | 2 | KAPI-03 | grep | `grep -q 'kalshiCount\|kalshi.*count' src/display/renderer.ts src/web/server.ts` | ✅ | ⬜ pending |
| 01-03-03 | 03 | 2 | KAPI-05 | grep | `grep -q 'KALSHI_EXCLUDE_SPORTS\|excludeSports' src/apis/kalshi.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements — no test framework needed. All verifications are CLI run + grep based.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dashboard red count on zero | KAPI-03 | Visual CSS check in browser | Open web dashboard, verify Kalshi count styling when 0 |
| Terminal health check output | KAPI-04 | Visual terminal output | Run screener, verify health check prints before poll loop |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
