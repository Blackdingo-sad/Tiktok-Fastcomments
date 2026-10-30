# Android APK: Live Comment Desk

**Read this before you touch `android/`, and say what it is before you continue.**
Then read [`../docs/ANDROID-APP-PLAN.md`](../docs/ANDROID-APP-PLAN.md) for the milestones and
[`../docs/COMMENT-SEND-LATENCY.md`](../docs/COMMENT-SEND-LATENCY.md) for the rules that bind this path.

## What this file is

The debug APK of a small Android app that puts a pre-typed comment into TikTok's **own** LIVE chat box
using Android's `AccessibilityService`, then taps send. It exists because the desktop app's separate
Chrome window and its 2/3/5 second Enter delay made comment sending feel slow to the operator.

It has **no backend, no `INTERNET` permission, no cookies and no TikTok credentials**: the only thing
it does is operate the TikTok app the operator already has open and logged in. TikTok signs its own
requests, which is why this path cannot hit the HTTP 403 the re-implemented Webcast route hit.

Built and signed here: [`apk/LiveCommentDesk-0.1.0-debug.apk`](apk/LiveCommentDesk-0.1.0-debug.apk) (debug keystore, sideload only; the binary is git-ignored).
Gradle also writes `app/build/outputs/apk/debug/app-debug.apk`.

## What it can do, verified

- Builds with `./gradlew assembleDebug` (Gradle 9.6, AGP 9.5, `minSdk 26`, `targetSdk 37`, Java only, no dependencies).
- Installs and launches on an emulator without crashing; the accessibility service binds and
  `dumpsys accessibility` lists it with the expected event types.
- Reports a typed comment's send attempt honestly: with no TikTok installed it says
  `tiktok_not_foreground` and states that no stage ran, instead of printing a fake `0 ms`.
- The screen is designed (Hallmark, soft tone) around the composer, with distinct enabled, focused
  and disabled states, and labels that are not in tracked capitals.

## What it cannot do: read this twice

- **It cannot send a comment as shipped.** Tapping *Gửi ngay* switches away from the LIVE room, so by
  the time the service looks, the chat box is usually gone (`chat_input_not_found`). The fix is M1, a
  floating button drawn **over** TikTok: without a control that keeps the room open, this design has no
  working send path. Do not describe the current APK as able to send.
- It cannot make Wi-Fi, mobile data or TikTok faster. No VPN, no "network boost", no proxy or IP
  rotation, no rate-limit evasion; those are ruled out in `COMMENT-SEND-LATENCY.md`.
- Even working, it performs the same two actions a human performs. It saves typing time (1–3 s), not
  TikTok's delivery time, and it cannot guarantee a comment appears before someone else's.
- Nothing has been tested against a real TikTok build: chat-box discovery, `ACTION_SET_TEXT`, the send
  button labels, the IME Enter fallback, the empty-box confirmation and every timing are unproven.
  No comment has been sent to any LIVE from Android.

## Layout

| File | Role |
| --- | --- |
| `app/src/main/java/.../SendAccessibilityService.java` | Brings TikTok forward, finds the editable chat node, sets the text, submits by send button then IME Enter, confirms by an empty box. One tap is one attempt: no retry, no bulk. |
| `app/src/main/java/.../MainActivity.java` | Composer, send button, service status, the per-stage timing table. |
| `app/src/main/res/layout/activity_main.xml` | The screen. |
| `app/src/main/res/values/colors.xml`, `values/styles.xml` | Hallmark tokens, text roles, the button states. |
| `app/src/main/res/xml/accessibility_service_config.xml` | Service config: reads window content, no gestures. |

Result codes the UI can show: `tiktok_not_foreground`, `chat_input_not_found`, `set_text_refused`,
`submit_control_not_found`, `send_unconfirmed` (chat box still filled: never reported as sent),
`send_failed: <error>`.

## Build and run

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`android/local.properties` holds `sdk.dir` and is git ignored. After every `adb install -r` or
force-stop, Android disables the service, so it must be re-enabled in Settings → Accessibility.
The app is light-only: there is no dark theme yet.

## Next step

M1 in `../docs/ANDROID-APP-PLAN.md`: a `SYSTEM_ALERT_WINDOW` float button so the operator sends
without leaving the LIVE room. After that, M2 dumps the real TikTok view tree to replace the guessed
chat-box hints and send-button labels. Do not run a live send without explicit approval of both the
target LIVE and the exact text.
