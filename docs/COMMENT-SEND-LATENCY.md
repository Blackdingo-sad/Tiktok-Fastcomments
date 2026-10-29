# Comment send latency: Chrome and the app

## Decision

For one comment in an already-open, logged-in TikTok LIVE page, direct manual Chrome is the baseline. Do not promise that the app will make that single comment appear sooner. The app's value is workflow: prepared text, a deliberate queue, controlled pacing, reusable templates, and recording a best-effort chat echo.

This is a practical design rule, not a mathematical guarantee. Measure the actual paths before making absolute claims. A warm app or a different network route could change a particular result; typing time and network latency are also different measurements.

## Why the app has more latency to overcome

- Manual Chrome uses the page and TikTok session that are already open. The page handles its own request and sends it to TikTok.
- The normal desktop-app path crosses the Electron renderer, IPC, the local backend, and a send provider before reaching TikTok.
- Euler adds a remote service hop between the backend and TikTok. It may help with provider compatibility, but it is not a speed optimization by default.
- The `browser` provider launches a separate Playwright-controlled Chrome context and injects the in-memory session; it does not reuse the user's already-open Chrome tab/profile. A cold send can include browser startup, navigation, and waiting for the chat input. A warm send avoids some startup cost, but still includes app/automation work.
- Once TikTok receives a request, TikTok's own processing and live-chat delivery affect when viewers see it. A backend response or local echo is not proof of when every viewer saw the comment.

Extra layers usually add overhead, but network placement and warm state can affect the result. Compare measured timestamps rather than asserting that every app send is always slower.

## Current repository and incident context

- `SEND_PROVIDER=webcast` is the default direct Webcast route. In the reported incident, manual posting worked while this app path received HTTP 403 from TikTok; the backend surfaced it as HTTP 502. Repeated attempts also produced HTTP 429. This points to a difference in the app's send path, but does not establish the exact cause of the 403.
- `SEND_PROVIDER=euler` is an existing relay path. It requires an Euler API key and may require a paid Premium Webcast add-on. No successful live send or published success-rate/latency figure has been established for this project.
- `SEND_PROVIDER=browser` is an existing Playwright-driven Chrome path that injects the in-memory TikTok session and types into the LIVE chat. The current launcher also sets `--disable-blink-features=AutomationControlled`; do not call this equivalent to manual browsing or evidence of TikTok authorization. Its presence in the code is not proof of successful real-LIVE delivery or lower latency. Review its automation behavior and platform authorization before relying on it. The window and page stay warm between sends, and a send is reported only after the chat input clears; see the measured section above.
- Euler receives session-related values and comment content when its provider is used. Prior authorization to send credentials to the local backend does not authorize sending them to Euler. Get explicit consent before enabling a third-party route, and disclose possible charges. Never put API keys or session cookies in chat, logs, or committed files.
- No real comment is authorized by a screenshot, draft text, or this design note. Before any live test, get explicit approval for the target LIVE and exact comment text.

## What was measured here (2026-10-29, one Windows machine)

These are the browser path's own startup numbers, not send latency, and not a comparison against a ready Chrome tab.

- Launching Chrome through Playwright with the session cookies applied took about 0.6 s. Loading `https://www.tiktok.com/` to `domcontentloaded` took about 0.5 s, and closing the window about 0.15 s.
- The sender reuses its window and page: a second `prepare` returned the same page, so only the first comment of a session pays launch and navigation. `POST /api/rooms/prewarm`, which the desktop app already calls while the handle is being typed, now opens that window and the LIVE page off the response path.
- A send counts as accepted only when the chat input is empty again shortly after Enter. A still-full input raises `browser_send_unconfirmed` instead of reporting success, so a click that missed the box or a closed chat no longer looks like a delivered comment. Newlines are collapsed first, because LIVE chat is a single line.
- Still unverified: that the candidate chat-input selectors match TikTok's current LIVE page, and the real Enter-to-appearance delay. Both need the one explicitly authorized, low-volume test described below.

## Guidance for future work

1. Do not optimize the app on the premise that it can beat a ready Chrome tab for a single comment. Optimize for the workflow above, and keep direct manual sending available.
2. Separate the measurements: send initiation, provider/backend response, and observed chat echo. Treat echo as best-effort; do not present it as a guaranteed global display timestamp.
3. Compare cold and warm paths under equivalent account, room, device, and network conditions. Use low-volume, explicitly authorized tests; stop on HTTP 403 or 429 and do not automatically retry.
4. Do not add private-signature or browser-fingerprint spoofing, proxy/IP rotation, CAPTCHA solving, or rate-limit evasion. Prefer user-controlled manual interaction or an integration TikTok explicitly authorizes.
5. Do not run a live benchmark or send a test message without explicit user approval of both the destination and exact message.
