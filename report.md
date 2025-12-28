# Open Queue Report

## Summary
- Refactored queue flow to stay stable under high volumes and during drain, with per-plugin state and internal send markers.
- Added explicit guard to prevent automatic `/queue immediate` calls from flipping modes without a user command.
- Updated toast lifecycle to always refresh on send and show a short-lived "Queue empty" toast when cleared.
- Added bun-based tests that simulate real session event flow and queue draining behavior.
- Bumped package version to 1.0.11 for publish.

## Changes
- `src/index.ts`
  - Moved queue state into plugin instance, added internal part marker to prevent re-queue loops.
  - Drain loop now processes newly queued items while draining and updates toasts per send.
  - Added queue command execution tracking to block unsolicited `immediate` switches.
  - Added short-duration empty-queue toast (default 4s) with env override.
- `command/queue.md`
  - Clarified command usage: only switch modes on explicit user request.
- `package.json`
  - Added `test` script using bun to run queue behavior tests.
- `test/queue.test.mjs`
  - Added tests for busy queuing, draining order, queueing during drain, and immediate guard.

## Environment Variables
- `OPENCODE_MESSAGE_QUEUE_MODE` (existing): default mode (`hold` / `immediate`).
- `OPENCODE_MESSAGE_QUEUE_TOAST_DURATION_MS` (existing): duration for active queue toast.
- `OPENCODE_MESSAGE_QUEUE_EMPTY_TOAST_DURATION_MS` (new): duration for empty-queue toast (default 4000ms).

## Tests
- `npm test`
  - Runs `tsc` then `bun test test/queue.test.mjs`.
  - All tests passing.

## Notes
- Internal queue sends are marked via text part metadata to avoid re-queueing while still allowing user messages to queue during drain.
- Empty toast now replaces the queue toast when pending hits zero, lasting 3–5 seconds by default.
