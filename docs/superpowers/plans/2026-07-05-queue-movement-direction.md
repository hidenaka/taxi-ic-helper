# Queue Movement Direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split queue movement into replenishment and departure-like emptying while preserving the existing `actual` field as replenishment.

**Architecture:** Reuse front-density transitions for event timing, then classify each event with nearby slot occupancy. Existing callers of `binAdvanceCounts` and `recentActualCount` continue to receive replenishment counts only.

**Tech Stack:** Node.js ESM, `node:test`, existing taxi-ic-helper scripts.

---

### Task 1: Directional Transition Detector

**Files:**
- Modify: `scripts/lib/advance-counter.mjs`
- Test: `tests/advance-counter.test.mjs`

- [ ] Write failing tests for upward and downward persistent front-density transitions.
- [ ] Add `detectDirectionalTransitions(values, times, opts)` returning `{events:[{time, direction}]}` where direction is `rise` or `fall`.
- [ ] Run `node --test tests/advance-counter.test.mjs`.

### Task 2: Occupancy-Based Movement Classification

**Files:**
- Modify: `scripts/lib/advance-forecast.mjs`
- Test: `tests/advance-forecast.test.mjs`

- [ ] Write failing tests proving a front-density rise with occupancy drop is classified as `departure`, not replenishment.
- [ ] Add `binMovementCounts(rows, stalls, opts)` returning `{replenish, departure}`.
- [ ] Keep `binAdvanceCounts` returning only `replenish`.
- [ ] Add `recentActualBreakdown` and keep `recentActualCount` returning only replenishment.
- [ ] Run `node --test tests/advance-forecast.test.mjs`.

### Task 3: Publish Current Departure Count

**Files:**
- Modify: `scripts/publish-advance-forecast.mjs`

- [ ] Use `recentActualBreakdown` in `currentActuals`.
- [ ] Keep `actual` as replenishment and add `departure`.
- [ ] Run targeted tests and full `npm test`.
