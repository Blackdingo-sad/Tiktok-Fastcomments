# APK folder

`LiveCommentDesk-0.1.0-debug.apk` is the built debug APK of the Android app in `../`.

- Package `com.blackdingo.livecommentdesk`, `minSdk 26`, `targetSdk 37`, debug keystore (sideload only, cannot be published).
- Read [`../README.md`](../README.md) before using or changing it: the app **cannot send a comment
  yet** (it needs the M1 float button), and it never touches the network.
- Install with `adb install -r LiveCommentDesk-0.1.0-debug.apk`, or copy it to a phone and open it
  (allow install from unknown sources). After install, enable the accessibility service in Settings.

The binary is git-ignored (`*.apk`), so it is not in the repository. Rebuild it any time:

```bash
cd android
./gradlew assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk apk/LiveCommentDesk-0.1.0-debug.apk
```

If a downloadable link inside the repository is needed, the APK has to be committed on purpose
(change the ignore rule) or attached to a release; neither is done yet.
