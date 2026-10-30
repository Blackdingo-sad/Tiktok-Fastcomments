# Android app plan: Live Comment Desk APK

Direction chosen with the operator on 2026-10-30. Read [`COMMENT-SEND-LATENCY.md`](COMMENT-SEND-LATENCY.md) first: this plan follows its rules.

## What Android can and cannot do

Cannot:

- Make Wi-Fi, mobile data or the ISP faster, or reduce TikTok's own processing, delivery and display time.
- Guarantee that a comment appears before someone else's.
- Beat a ready manual send for a single comment (see the decision note).

Can, and this is the whole point of the app:

- Remove the desktop app's own 2/3/5 second Enter delay. The Android app has no delay at all.
- Remove the PC hop. Desktop is renderer → IPC → HTTP → Node backend → CDP → page; Android is one process calling the accessibility API.
- Remove cold startup: the session is TikTok's own, already open and logged in.
- Let the operator type once, then send with one tap, so typing time is spent before the announcement instead of during it.

## Chosen design

An `AccessibilityService` inside the TikTok app that the operator already has open:

1. The operator pre-types the comment in the app, then taps **Gửi ngay** (or, from M1, a floating button over TikTok).
2. The service brings TikTok to the front and finds the editable LIVE chat box in the view tree.
3. It sets the text with `ACTION_SET_TEXT`, then submits through the send button, falling back to the keyboard Enter action (`ACTION_IME_ENTER`, API 30+).
4. It reports success only when the chat box is empty again. A still-filled box is `send_unconfirmed`.

One tap is one attempt. There is no retry loop, no bulk sending and no scheduled repeat.

Why not the other paths: a re-implemented Webcast call in Kotlin is the route that returned HTTP 403, and a WebView brings back a second browser stack without the operator's real session.

## Current limitation of M0: it cannot send

Tapping **Gửi ngay** switches away from the LIVE room, so by the time the service looks for the chat box, the room is usually gone. On a real phone M0 therefore ends at "đưa TikTok lên trước" and cannot place a comment anywhere. It is a shell that proves the service binds and the failure paths are honest, nothing more.

That is why the float button is M1 and not an optimisation: without a control that sits **on top of** the LIVE room, this design has no working send path at all.

Even with M1, the ceiling is unchanged: the app performs the same action a human performs (put text in the box, press send). It saves typing time, not TikTok's delivery time.

## Risks, stated plainly

- Automating TikTok's own UI is **not authorized by TikTok** and carries account risk for the operator. An enabled accessibility service is visible to other apps on the device.
- TikTok can change its view tree without notice. The app then reports `chat_input_not_found` or `submit_control_not_found` instead of sending the wrong text.
- Chat-box and send-button discovery depend on locale and build. The label list in `SendAccessibilityService` is a starting point, not a verified selector set.
- Bringing TikTok to the foreground is real overhead, measured as its own stage ("TikTok lên trước"). It is not network latency and must not be reported as such.
- Launching TikTok does not reliably return to the LIVE room (unverified). Milestone 1 below removes this step entirely.
- Do not use the app to exceed per-account posting limits, and stop on any HTTP 403/429 or account warning.

## Milestones

- **M0 — done, 2026-10-30.** Project, send flow, measurement and a debug APK (`android/apk/LiveCommentDesk-0.1.0-debug.apk`, git-ignored; rebuild from `android/`). The screen was redesigned with Hallmark (soft tone) around the composer, with a warm token palette and explicit enabled, focused and disabled states; the app runs light-only, there is no dark theme.
- **M1 — float button.** A small `SYSTEM_ALERT_WINDOW` bubble so the operator taps while the LIVE room stays in front. Removes the app-switch stage, which is the largest avoidable cost in M0.
- **M2 — on-device selector verification.** Dump the real TikTok view tree in a LIVE room on the target phone, then replace the guessed hints/labels with what the current build actually exposes. No comment needs to be sent for this step.
- **M3 — signed release APK.** Generate a keystore kept outside git, build `assembleRelease`, install and confirm the update path.
- **M4 — measurement.** Only with explicit approval of the target LIVE and the exact text; record each stage separately and never present a local confirmation as the moment viewers saw the comment.

## Build and verify

```bash
cd android
./gradlew assembleDebug            # wrapper: Gradle 9.6.0, AGP 9.5.0
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- `minSdk 26`, `targetSdk 37`, `compileSdk 37`, no third-party dependencies, Java only.
- `android/local.properties` holds `sdk.dir` and is git-ignored.
- After every `adb install -r` or force-stop, Android disables the service: re-enable it in Settings → Accessibility before sending again.
- The app is signed with the debug keystore; it is installable by sideload but is not a release build.

## Verified on 2026-10-30 (Windows, emulator `Medium_Phone_API_37.0`)

- Build succeeds; APK is debug-signed and declares `provides-component:'accessibility'`.
- Installs, launches, no crash. `dumpsys accessibility` shows the service bound with the expected event types.
- Typing a comment and tapping **Gửi ngay** reaches the service, which reports `tiktok_not_foreground` because TikTok is not installed on the emulator. No crash, and the timing line says no stage ran instead of printing a fake `0 ms`.
- A real bug was found and fixed by this test: the enabled-service check compared strings and missed Android's `pkg/.Service` shorthand, so it would have shown "Chưa bật" on a device where the service was running. It now parses `ComponentName`s.

## Not verified

- No real TikTok build was involved: chat-box discovery, `ACTION_SET_TEXT` acceptance, send-button labels, the IME Enter fallback, empty-box confirmation and every per-stage timing are unproven against the real UI.
- No comment has been sent to any LIVE from Android. That needs explicit approval of both the target and the exact text.
- Emulator numbers prove the plumbing only; they say nothing about real send latency.
