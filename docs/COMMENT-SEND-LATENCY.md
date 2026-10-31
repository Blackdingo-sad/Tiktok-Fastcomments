# Comment send latency: Chrome and the app

## Decision

For one comment in an already-open, logged-in TikTok LIVE page, direct manual Chrome is the baseline. Do not promise that the app will make that single comment appear sooner. The desktop app provides a separate TikTok window and an optional, explicit delay before a manually entered comment is submitted.

This is a practical design rule, not a mathematical guarantee. Measure the actual paths before making absolute claims. A warm app or a different network route could change a particular result; typing time and network latency are also different measurements.

## Why the app has more latency to overcome

- Manual Chrome uses the page and TikTok session that are already open. The page handles its own request and sends it to TikTok.
- The desktop app's manual path uses a separate Playwright-controlled Chrome window. The operator types in TikTok's own chat box; the app intercepts Enter, waits for the selected 2, 3, or 5 seconds, then sends Enter to that page. This adds a chosen wait and does not make a ready manual browser faster.
- Euler adds a remote service hop between the backend and TikTok. It may help with provider compatibility, but it is not a speed optimization by default.
- The `browser` provider launches a separate Playwright-controlled Chrome context and injects the in-memory session; it does not reuse the user's already-open Chrome tab/profile. A cold send can include browser startup, navigation, and waiting for the chat input. A warm send avoids some startup cost, but still includes app/automation work.
- Once TikTok receives a request, TikTok's own processing and live-chat delivery affect when viewers see it. A backend response or local echo is not proof of when every viewer saw the comment.

Extra layers usually add overhead, but network placement and warm state can affect the result. Compare measured timestamps rather than asserting that every app send is always slower.

## Network limits and practical steps

- The app cannot increase Wi-Fi or ISP speed, remove its selected 2, 3, or 5 second Enter delay, or control TikTok's processing and display time. A faster connection can only reduce the network portion when the connection is the bottleneck; it cannot guarantee that a comment appears faster.
- For fewer network-side delays, use a stable connection with a strong signal, reduce competing traffic on the network, and use Ethernet on desktop when available. On Android, prefer stable Wi-Fi or a strong mobile-data signal. These are troubleshooting steps, not promises about TikTok delivery time.
- A VPN is not a speed option. It inserts a hop between the device and TikTok and adds encryption overhead, so it can only hold latency equal or make it worse; an exit IP that disagrees with the account's region can also trigger TikTok's own checks. It cannot reorder chat delivery.
- A comment is well under a kilobyte, so the path is latency-bound, not bandwidth-bound. "Network boost" apps that free memory, clear caches or toggle the radio do not change the time TikTok takes to receive, process and distribute a comment. No Android API raises radio throughput for one request.
- In the next Android-app session, carry this limitation and connection advice into the Android UI. Report only connection or timing measurements the app actually collects; do not imply that the app changes Wi-Fi speed or TikTok's processing time.

## Current repository and incident context

- `SEND_PROVIDER=webcast` is the default direct Webcast route. In the reported incident, manual posting worked while this app path received HTTP 403 from TikTok; the backend surfaced it as HTTP 502. Repeated attempts also produced HTTP 429. This points to a difference in the app's send path, but does not establish the exact cause of the 403.
- `SEND_PROVIDER=euler` is an existing relay path. It requires an Euler API key and may require a paid Premium Webcast add-on. No successful live send or published success-rate/latency figure has been established for this project.
- `SEND_PROVIDER=browser` launches a Playwright-driven Chrome context and injects the in-memory session. The desktop UI opens the LIVE page and delays Enter in recognized chat-input candidates before releasing it; the operator types the comment in TikTok. The backend's separate `/api/comments` path can still type supplied text into that page. The launcher also sets `--disable-blink-features=AutomationControlled`; do not call this equivalent to manual browsing or evidence of TikTok authorization. Its presence in the code is not proof of successful real-LIVE delivery or lower latency. The window and page stay warm between sends; see the measured section above.
- The Windows installer bundles and starts the local backend itself, selects `SEND_PROVIDER=browser`, and creates a per-run `APP_TOKEN` internally. The operator does not need to install Node.js or enter an API key/token. Standalone backend runs still use `server/.env`.
- The desktop UI exposes the LIVE channel and delay controls, with no comment composer. The operator enters the comment in the app-managed TikTok window. The selector keeps its illustrative labels; the selected option applies an actual 2, 3, or 5 second wait before Enter is released. The app intercepts Enter only in recognized chat-input candidates. It does not control TikTok's display time, external browser windows, or guarantee account safety.
- The desktop app's manual Enter delay is applied in the app-managed Chrome page. The backend also retains its separate comment API path with a 70 second response timeout: room lookup and the browser provider can each take up to 30 seconds. A client timeout on that API path still does not prove whether TikTok accepted a comment; it does not retry automatically.
- Euler receives session-related values and comment content when its provider is used. Prior authorization to send credentials to the local backend does not authorize sending them to Euler. Get explicit consent before enabling a third-party route, and disclose possible charges. Never put API keys or session cookies in chat, logs, or committed files.
- No real comment is authorized by a screenshot, draft text, or this design note. Before any live test, get explicit approval for the target LIVE and exact comment text.

## What was measured here (2026-10-29, one Windows machine)

These are the browser path's own startup numbers, not send latency, and not a comparison against a ready Chrome tab.

- Launching Chrome through Playwright with the session cookies applied took about 0.6 s. Loading `https://www.tiktok.com/` to `domcontentloaded` took about 0.5 s, and closing the window about 0.15 s.
- The sender reuses its window and page: a second `prepare` returned the same page, so only the first comment of a session pays launch and navigation. `POST /api/rooms/prewarm`, which the desktop app already calls while the handle is being typed, now opens that window and the LIVE page off the response path.
- A send counts as accepted only when the chat input is empty again shortly after Enter. A still-full input raises `browser_send_unconfirmed` instead of reporting success, so a click that missed the box or a closed chat no longer looks like a delivered comment. Newlines are collapsed first, because LIVE chat is a single line.
- Still unverified: that the candidate chat-input selectors match TikTok's current LIVE page, that Enter is reliably delayed on the current TikTok build, and the real Enter-to-appearance delay. Confirm the behavior without posting a comment first; any live send needs explicit approval for both the target and exact text.

## Two-client observer measurement (added 2026-10-31; not live-verified)

For a manual app send, the app records a local timestamp when the actual Enter `keydown` reaches the TikTok page (after the configured delay). A second, read-only `watch-live` connection observes the **same LIVE** and matches the public chat event by sender username and a hash of the exact comment text. The hash—not the comment text—is sent to the observer over loopback at `127.0.0.1:8787`.

Run the observer first:

```powershell
npm run watch -- @live-handle --sender @sender-account
```

Keep it running on the same machine as the desktop app, open the same LIVE in the app, and send only a specifically approved test comment. A `Δ ms` label appears next to the matching comment.

This is the elapsed time from the app page's Enter `keydown` to the observer connector receiving that event, using the same machine's wall clock at millisecond resolution and matching within 30 seconds. It is not a guaranteed measurement of TikTok's internal processing, a viewer's rendered frame, or when all viewers saw the comment. Repeated identical comments from the same account close together can be ambiguous. No `Δ` means no match was observed, not necessarily that sending failed. Do not send test messages or run a benchmark without approval for both the destination and exact content.

### Observed against a real LIVE (2026-10-31, TikTok LIVE Studio, not a latency measurement)

The observer was run read-only against a real LIVE from TikTok LIVE Studio (`@mehideslow`) on one Windows machine. It connected (`status: live`) and the host account's own comments, typed by the operator in LIVE Studio's chat box, appeared in the public chat feed the observer reads — five comments over roughly four minutes.

- Established: the observer receives the host's own comments, so it can serve as one read-only screen showing host and customer comments in arrival order.
- Not established: any send latency. LIVE Studio emits no Enter marker, so no `Δ` exists for a LIVE Studio comment; only the arrival timestamp is known. Nothing here measures TikTok's processing, a viewer's render, or a comparison against manual Chrome, and nothing here supports a speed claim for any path.
- To get a number for a LIVE Studio send, the only remaining option is frame-counted screen recording, accurate to about one frame; the marker path stays the only millisecond measurement and applies only to the app's manual Enter.

## Android APK (planned 2026-10-30, not live-verified)

The operator's desktop build was judged too slow, so an Android app is the next delivery path. Plan: [`ANDROID-APP-PLAN.md`](ANDROID-APP-PLAN.md).

- Chosen path: an `AccessibilityService` that sets the comment into TikTok's own LIVE chat box and taps send, treating an empty box as confirmation. TikTok's app signs the request itself, so there is no re-implemented Webcast route (the path that returned 403) and no PC hop.
- What it removes versus desktop: the app's own 2/3/5 second Enter delay (Android has none) and the renderer → IPC → HTTP → backend → CDP chain.
- What it adds: bringing TikTok to the foreground before each send, reported as its own measured stage, plus dependence on TikTok's view tree. Neither is network latency. That foreground switch is also why the first build cannot send at all: leaving the LIVE room usually removes the chat box before the service reaches it, so a control placed on top of TikTok is required before this path can submit anything.
- Even when it works, it performs the same action the operator performs by hand. It can save typing time; it cannot make TikTok deliver a comment sooner than a manual send of the same text.
- Android cannot raise Wi-Fi or ISP throughput, and does not change TikTok's processing or display time. An Android build is not evidence that a comment appears before someone else's.
- Unproven: chat-box and send-button discovery on the current TikTok build, locale coverage, whether launching TikTok returns to the LIVE room, and every per-stage timing. No comment has been sent from Android.
- Accessibility automation of TikTok's app is not authorized by TikTok and carries account risk for the operator. The app is operator-triggered only: one tap, one attempt, no retry loop, no bulk or scheduled sending.

## Guidance for future work

1. Do not optimize the app on the premise that it can beat a ready Chrome tab for a single comment. Optimize for the workflow above, and keep direct manual sending available.
2. Separate the measurements: send initiation, provider/backend response, and observed chat echo. Treat echo as best-effort; do not present it as a guaranteed global display timestamp.
3. Compare cold and warm paths under equivalent account, room, device, and network conditions. Use low-volume, explicitly authorized tests; stop on HTTP 403 or 429 and do not automatically retry.
4. Do not add private-signature or browser-fingerprint spoofing, proxy/IP rotation, CAPTCHA solving, or rate-limit evasion. Prefer user-controlled manual interaction or an integration TikTok explicitly authorizes.
5. Do not run a live benchmark or send a test message without explicit user approval of both the destination and exact message.
