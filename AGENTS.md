# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

3D Print Log is an Apache Cordova hybrid mobile application that serves as a WebView wrapper for https://www.3dprintlog.com. The app handles device initialization, network connectivity checks, and authentication flows (Auth0, Google OAuth) before redirecting to the main web application.

**App ID:** com.hoffmanengineering.printlog
**Version:** 1.2.0
**Repository:** https://github.com/HoffmanEngineering/3d-print-log-app (public, AGPL-3.0-only)
**Platforms:** Android (shipping). iOS is **designed but never implemented** — see iOS Build Notes.

## Build Commands

```bash
# Build development APK
npm run build:android

# Build signed release bundle (reads keystore config from build.json, which is gitignored)
npm run release:android

# Run on connected device/emulator
npx cordova run android

# iOS scripts exist but have never been run - see iOS Build Notes
npm run build:ios
npm run release:ios
```

The Cordova CLI is pinned at 13.0.0 in `devDependencies`; `npm install` puts it in
`node_modules/.bin`. Use the npm scripts or `npx cordova`, not a global install.

## CI/CD

GitHub Actions. There is no Azure DevOps remote.

| Workflow                        | Trigger             | Produces                                                       |
| ------------------------------- | ------------------- | -------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | push / PR to `main` | Unsigned debug APK, uploaded as an artifact (14-day retention) |
| `.github/workflows/release.yml` | push of a `v*` tag  | Signed AAB attached to a GitHub Release                        |

**Cutting a release:** push a `v*` tag, then approve the pending deployment. The
release job runs in the `production` environment, which has a required reviewer,
so it waits at "Waiting" until approved — that is the human gate in front of the
signing key, not a hang.

Signing secrets live on the `production` environment, not the repository:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. `release.yml` reconstructs `build.json` from them at run
time. Never commit `build.json` or a `.jks`.

**Nobody can push to `main` — not even admins.** The branch ruleset uses
`bypass_mode: pull_request`, so the maintainer's bypass covers only the
approving-review requirement when merging a PR, never a direct push. A
`git push origin main` is rejected with "Changes must be made through a pull
request." Every change goes through a PR, including version bumps; use the
`/release` skill, which does this for you.

Tags are protected against creation, update, and deletion, with
`bypass_mode: always` for the maintainer — creating a tag is not a PR
operation, so it has no PR path to take instead. This is what lets a release
tag be pushed.

## Architecture

**Framework:** Apache Cordova 13.0.0 with cordova-android 15.1.0 and cordova-ios 7.1.1

**Entry Flow:**

1. `www/index.html` loads as entry point with splash screen
2. `www/js/index.js` handles Cordova `deviceready` event
3. Network connectivity check via cordova-plugin-network-information
4. On success, navigates to https://www.3dprintlog.com

**Key Plugins:**

- `cordova-plugin-network-information` - Network connectivity detection
- `cordova-plugin-customurlscheme` - Custom URL scheme (com.hoffmanengineering.printlog://) for OAuth callbacks
- `cordova-plugin-dialogs` - Native alert dialogs



**Allowed Navigation Domains (config.xml):**

- https://www.3dprintlog.com/*
- https://_.auth0.com/_
- https://_.google.com/_

## Key Files

- `config.xml` - Cordova configuration (app settings, plugins, permissions, allowed domains)
- `www/index.html` - Entry point HTML
- `www/js/index.js` - Device ready handler and navigation logic
- `.github/workflows/` - CI and release pipelines (see CI/CD above)
- `platforms/android/` - Android platform build files (generated — do not edit directly)
- `platforms/ios/` - iOS platform build files (generated — do not edit directly)
- `build.json` - Code signing config for Android (keystore) and iOS (Team ID, provisioning)
- `azure-pipelines-ios.yml` - Unimplemented iOS pipeline design; never ran (see iOS Build Notes)
- `hooks/before_compile/patch_camera_permission.js` - Build hook that patches WebView camera permission handling (see Build Notes)

## Build Notes

- Android build uses Gradle with AndroidX enabled
- Release builds require signing with AndroidKeyStore/KeyStore.jks
- User agent is overridden to "Mozilla/5.0 Google" for Google login compatibility
- `platforms/android/` is generated — changes there are lost on `cordova platform remove/add`. Use `config.xml`, hooks, or plugins for persistent changes.
- Cordova Android 15.1 handles native camera and microphone permission requests for `getUserMedia()` upstream.
- The `before_compile` hook (`hooks/before_compile/patch_camera_permission.js`) retains the file-input path: it wraps `onShowFileChooser` so `<input type="file" capture="environment">` requests CAMERA runtime permission before opening the chooser. The original body is extracted to `showFileChooserImpl(callback, params, allowCapture)`. If permission is denied, the chooser still opens without the camera option.
- Android build tools 36.0.0 is required (cordova-android 15.1.0 targets SDK 36)
- The `patch_back_navigation.js` hook makes API 36 predictive-back gestures navigate WebView history before exiting; `www/js/index.js` uses `location.replace()` so the local bootstrap page is not retained in that history.
- All Android-specific hooks (`patch_camera_permission.js`, `patch_auth_custom_tab.js`, `patch_back_navigation.js`) have platform guards that skip when not building for Android
- `OverrideUserAgent` in `config.xml` is load-bearing: the UI's `isCordova`
  (`src/app/core/utils/platform.ts`) compares `navigator.userAgent` for exact equality with
  it. Changing the version in that string without the matching UI change silently disables
  every Cordova-specific behavior in the shipped app, including push registration.
  `scripts/check-user-agent-contract.mjs` checks both repos in CI, and reads the UI's actual
  `CORDOVA_USER_AGENT` constant rather than a hardcoded copy. Run it locally with
  `PRINT_LOG_UI_PATH=../3d-print-log-ui npm run check:user-agent`.
- `google-services.json` is **required for the Android build** — without it Gradle fails at
  `:app:processDebugGoogleServices`. It is gitignored and injected in CI from the
  `GOOGLE_SERVICES_JSON_BASE64` secret (repository secret for `ci.yml`, `production`
  environment for `release.yml`), exactly the way `build.json` is. For a local build, put
  the real file from the Firebase console at the project root.
- `PrintLogApiUrl` in `config.xml` must be set to the production API base URL. While it says
  `SET_ME`, `cordova-plugin-printlog-native` logs a warning and every push registration
  returns `ok:false` — push is off rather than pointed somewhere wrong. It is read from
  config rather than supplied by the page on purpose: a page-supplied API base would let
  compromised page script send the user's bearer token to a server of its choosing.

## Push Notifications

`plugins-local/cordova-plugin-printlog-native` bridges the remotely-loaded Angular app to
native push. It exists because `cordova.js` is gone once the WebView navigates to
`https://www.3dprintlog.com`, so the page cannot call plugins the normal way.
`WebViewCompat.addWebMessageListener` restores a channel and — unlike
`addJavascriptInterface` — takes an explicit origin allowlist, which matters because
`config.xml` also permits Auth0 and Google.

Two things are counter-intuitive and were established by reading the firebasex source:

- **The plugin already posts foreground notifications for us.** Its `showNotification` test
  includes `!hasNotificationsCallback()`, and this app can never register that JS callback,
  so it posts every notification itself — on the `channel_id` the API sets. Posting one
  ourselves would double every notification.
- **`FirebasePluginMessageReceiver.sendMessage(Bundle)` never fires here**, for the same
  reason: its only caller returns early when there is no JS callback. Notification taps are
  therefore captured from the main activity's intent extras instead — `pluginInitialize()`
  for a cold start, `onNewIntent()` for a warm one.

The FCM token is never exposed to page script. The page hands native its bearer token and
native performs the `/api/devices` call.

## iOS Build Notes

**iOS has never been built or shipped.** `azure-pipelines-ios.yml` and
`ios-build-guide.md` are _design artifacts_ describing an intended build that was
never implemented, and the Azure pipeline they reference no longer has a remote to
run on. Do not treat either file as working configuration or as a source of truth —
notably not for the Node version, which is **20** everywhere that matters
(`ios-build-guide.md` and the Azure pipeline say 18).

Implementing iOS means porting to a GitHub Actions macOS runner, not reviving the
Azure pipeline. The design notes below are what was intended:

- iOS builds require macOS with Xcode
- `build.json` would carry iOS signing config with `TEAM_ID_PLACEHOLDER`, substituted at build time
- Minimum deployment target: iOS 13.0
- WKWebView only (UIWebView removed)
- Permission descriptions live in config.xml `<platform name="ios">` (required for App Store)
- Four signing secrets were envisaged: `APPLE_TEAM_ID`, `IOS_DISTRIBUTION_CERT_P12_BASE64`, `IOS_DISTRIBUTION_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`

## Companion UI Repository

The web UI lives in the `print-log-ui` repo (Angular). When both repos need coordinated changes:

- The UI worktree for in-progress feature work is at `../print-log-ui/.worktrees/<branch-name>/`
- The UI repo is on GitHub at `HoffmanEngineering/3d-print-log-ui` (it also retains an `azure` remote)
- The UI exposes `isCordova` (from `src/app/core/utils/platform`) on components that need Cordova-specific behavior
- Use `capture="environment"` on hidden file inputs to let Android's native chooser offer Camera/Files — no need for a custom mat-menu
