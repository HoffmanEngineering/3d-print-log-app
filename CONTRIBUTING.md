# Contributing to 3D Print Log App

Thank you for your interest in contributing!

This repository is the Apache Cordova shell for the Android app. Most user-facing behaviour lives in the web app — if your change is to the interface, it probably belongs in [3d-print-log-ui](https://github.com/HoffmanEngineering/3d-print-log-ui) instead. Changes here are for the native shell: permissions, OAuth handling, splash and status bar, plugins, and build configuration.

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- JDK 17
- Android SDK 35 with build-tools 35.0.0, and `ANDROID_HOME` set
- An Android device with USB debugging, or an emulator running via Android Studio

## Local setup

```bash
git clone https://github.com/HoffmanEngineering/3d-print-log-app.git
cd 3d-print-log-app
npm install
npm run build:android
```

`npm install` also installs the pinned Cordova CLI into `node_modules/.bin`, so you do not need a global install. To deploy to a running device or emulator:

```bash
npx cordova run android
```

## Things worth knowing before you change anything

**`platforms/` is generated.** It is not checked in, and `cordova platform remove/add` wipes it. Never edit it directly — changes there will be silently lost. Persistent native changes go in `config.xml`, a plugin, or a build hook.

**The build hooks patch generated Java.** `hooks/before_compile/patch_camera_permission.js` and `patch_auth_custom_tab.js` do string replacement against `SystemWebChromeClient.java` and `SystemWebViewClient.java` after Cordova generates them. This means:

- Each patch must be independently idempotent, keyed on a unique marker string. Do not use one global "already patched?" check for multiple patches.
- The generated Java uses 4-space indentation. Match it exactly or the replacement will not find its anchor.
- Dry-run any hook change against the real file before building — `node -e` against `platforms/android/app/src/main/java/.../SystemWebChromeClient.java` — because a silently non-matching patch produces a build that compiles and then misbehaves on a device.

**Camera permissions need two code paths.** The WebView auto-grants web permissions but never triggers the Android runtime prompt. `onPermissionRequest` covers `getUserMedia()` (QR scanning); `onShowFileChooser` covers `<input type="file" capture="environment">`. Changing one without the other leaves a broken path.

## Testing your change

There is no automated test suite for the shell — it is configuration and native glue, and the meaningful signal is whether it works on a device.

Before opening a PR:

1. `npm run build:android` completes without error
2. Deploy to a real device or emulator and confirm the app launches and reaches the web app
3. If you touched permissions, hooks, or `config.xml`, exercise the affected path by hand — take a photo from a print entry, scan a QR code, sign in with Google, or whatever your change affects
4. Say in the PR description which device and Android version you tested on

CI builds an unsigned debug APK on every PR and attaches it as an artifact, so reviewers can sideload your build.

## Submitting a PR

- Fork and branch from `main`
- Keep the change focused on one thing
- Open the PR and fill in the template
- Never commit `build.json`, a `.jks` keystore, or any signing credential. These are gitignored; if you find yourself fighting the ignore rules, stop and ask.
