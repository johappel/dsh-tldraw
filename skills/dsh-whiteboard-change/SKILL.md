---
name: dsh-whiteboard-change
description: Diagnose, change, or accept the generic DSH Whiteboard host/client, session routing, events, snapshots, or tldraw rendering. Use for dsh-whiteboard and the PTS renderer seam; do not use for PTS domain design.
---

# DSH Whiteboard Change

Use this workflow when a change can affect the generic Whiteboard's browser behaviour. Its purpose is to replace repeated guess-and-retry loops with one evidence-backed hypothesis at a time.

## Before editing

1. Read `AGENTS.md`, `docs/WHITEBOARD-SPEC.md`, and `docs/TESTING.md`.
2. Capture the concrete symptom: browser request/event name, request payload, response or console error, session/workspace, and the responsible source location. Do not infer a transport, session fallback, tldraw API, or DSH sidebar capability from a previous spike or from source alone.
3. Identify whether the fault is host, client, session routing, persistence, or the PTS semantic seam. Keep PTS roles and domain logic out of this repo.
4. State one falsifiable hypothesis and the smallest observable acceptance criterion before changing code.

## Change discipline

- Make one bounded change for that hypothesis. Do not combine a transport replacement, UI redesign, and renderer/domain refactor in one attempt.
- Preserve session binding. A missing identity must fail closed; it must never select a browser-local or another workspace's board.
- Idle browser behaviour is part of the contract: do not introduce repeated empty request/response cycles. Use a session-bound event channel when the host must notify a connected client.
- Keep the Companion boundary semantic (`pts_whiteboard_render`). Generic host/client seams may transport validated presentation data but must not interpret PTS roles.
- If the observed result contradicts the hypothesis, stop the edit sequence, record the result, and re-inspect the runtime before proposing another fix.

## Required evidence

Run the static checks in `docs/TESTING.md`. For a host/client transport change, add or update a focused host contract test that proves the intended session routing and delivery; tests must check behaviour, not merely source text.

Then restart DSH and hard-reload the browser. Browser acceptance is required before reporting a runtime fix. Record the URL/context, session/workspace, the observed request/event traffic while idle, the triggering action, and the visible result. When browser access is unavailable, report **NOT TESTED**; do not substitute static tests for E2E evidence.

## Network acceptance

For an idle Board, inspect the Network panel for at least three seconds:

- no repeated empty command or open request/response cycle;
- only documented persistent event connections may remain open;
- a render request reaches only its matching session and produces one deterministic render batch;
- a second session receives neither the open nor command event.

Treat an unexpected request name, `open:false`, or empty `commands` loop as a failed acceptance, not as benign diagnostic traffic.

## References

- `docs/WHITEBOARD-SPEC.md` — generic contract and PTS boundary
- `docs/TESTING.md` — static, live-boot, and browser acceptance protocol
- `docs/vendor/tldraw/llms-full.txt` — upstream reference; verify it against the installed version before relying on an API
