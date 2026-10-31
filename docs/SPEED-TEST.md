# Speed Test – TikTok LIVE Studio comment delivery

Date: 2026-10-31 (runs recorded). Observer: `npm run watch -- @mehideslow --keywords "199k,gia,giá,chot"` on `http://127.0.0.1:8787/`.

## Test state
- LIVE: `@mehideslow` (TikTok LIVE Studio), WebSocket state `live` (fetchIsLive = true).
- Moment of observation: 2026-10-31 15:26–15:29.
- Observer process: restarted twice in the window (old PID killed, fresh started). Port 8787.

## Events received by the observer

| id | user | text | at (epoch ms) | received (clock) |
|----|------|------|---------------|------------------|
| 1 | mehideslow | `.` | 1793435125140 | 15:26:36 |
| 2 | mehideslow | host test | 1793435128436 | 15:26:38 |
| 3-5 | mehideslow | ., .., a (history replay on connect, id 3-5) | 1793434273791..1793434273792 | 15:11:13 (replay window) |
| 6 | mehideslow | host test (15:26) | 1793435128436 | 15:26:38 |

No event from any other account was ever observed in the window (15:13–15:29). Four comment attempts from the second account produced zero chat events.

## Results so far

- ✅ Observer connects to a real LIVE and receives the host's own comments (also plays back recent history on connect).
- ❌ No non-host comment ever arrived in the observer feed → comment from the second account is not reaching the public chat feed, or the second account's discussion path is blocked.
- ❌ No `Δ ms` measured: LIVE Studio emits no Enter marker, so no start timestamp exists.
- ❌ Unknown: is the loopback measurement accurate for LIVE Studio sends? Unverified (no marker).

## Conclusions / follow-ups

1. Do not claim a speed number until the second-account comment appears in the observer feed.
2. Check the second account's TikTok browser panel / Network tab for chat events; replicate the send from the app's own browser path to compare.
3. If needed, inspect the WebSocket message-decoding failure at `src/lib/client.ts:506` (`messageDecodingFailed` → handleError) and decide whether the connection degrades silently.

## Files changed in this repo (current state)

- `docs/COMMENT-SEND-LATENCY.md` — two-client measurement procedure; added "Observed against a real LIVE (2026-10-31, TikTok LIVE Studio, not a latency measurement)" section.
- `SECOND-BRAIN.md` — two-client measurement bullet updated with the LIVE Studio observation.
- `docs/SPEED-TEST.md` — this file (new).
- `server/measurement.ts` + `server/measurement.test.ts` — new.
- `server/browser-send.ts` — marker recording on delayed Enter (`__liveDeskMarkSend`).
- `server/live.ts` — automatic POST of marker to `127.0.0.1:8787/measurement/send`.
- `watch-live.ts` — observer with `--sender`, `POST /measurement/send`, correlation, `Δ ms` UI.
- `package.json` — `server:test` includes `server/measurement.test.ts`.

Verification: `npm run server:check` → exit 0, `npm run server:test` → 60/60 pass. Docs edited by hand (no build step).

## What is explicitly NOT established

- Any send latency, even for a LIVE Studio comment.
- That the app or LIVE Studio delivers a comment before anyone else.
- That the observer loopback is accurate.
- That a comment sent from a second account is unreliable — only that it never reached this observer during the window.

## Backend dry-run receipt (2026-10-31; user-reported, not a delivery test)

The operator reported three `POST /api/comments` requests for `@chimsedinang` with `SEND_DRY_RUN=1`. No comment was sent to TikTok. Reported `backendMs`: p50 ≈ 0 ms, p95 ≈ 1 ms, max ≈ 1 ms. The accompanying note separately estimates roughly 2 ms per request; raw per-request samples and a backend log were not retained, so these are approximate observations from only three requests, not a stable latency estimate.

The current code measures `backendMs` around the server's `sender.sendComment()` call. In dry-run mode, `sendComment()` returns before room lookup, provider work, or echo setup (`server/comments.ts`). Therefore this result is local server handling time; the report's room-cache attribution does not match the current code path. It does not measure network-to-TikTok time or comment appearance. `providerMs` is `null`; `appearedMs` and observer `Δ ms` are unavailable by design because no provider send or matching echo occurred.

The operator also reported that the backend/observer did not connect to a live TikTok room, so the two-client measurement was not made. In this checkout, `npm run watch` maps to `node --import tsx watch-live.ts` in `package.json`; the observer's local UI defaults to port 8787. That local listener is not itself a TikTok chat connection. The two-client command template is `npm run watch -- @live-handle --sender @sender-account`; replace those example handles with a real LIVE target and sender before expecting an observer match. The observer is separate from the dry-run backend and does not use the backend's sender session.

**Provenance:** user-provided execution summary; repository code was checked for the dry-run branch, `backendMs` timing scope, watch script, and observer port. This documentation update started no processes and repeated no live send.
