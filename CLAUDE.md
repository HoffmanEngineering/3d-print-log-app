# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

3D Print Log is an Apache Cordova hybrid mobile application that serves as a WebView wrapper for https://www.3dprintlog.com. The app handles device initialization, network connectivity checks, and authentication flows (Auth0, Google OAuth) before redirecting to the main web application.

**App ID:** com.hoffmanengineering.printlog
**Version:** 1.1.6
**Platforms:** Android, iOS (in progress)

## Build Commands

```bash
# Build development APK
npm run build:android

# Build signed release bundle (uses keystore credentials from package.json)
npm run release:android

# Run on connected device/emulator
cordova run android

# iOS (requires macOS with Xcode)
npm run build:ios
npm run release:ios
cordova run ios
```

## Architecture

**Framework:** Apache Cordova 13.0.0 with cordova-android 14.0.1 and cordova-ios 7.1.1

**Entry Flow:**

1. `www/index.html` loads as entry point with splash screen
2. `www/js/index.js` handles Cordova `deviceready` event
3. Network connectivity check via cordova-plugin-network-information
4. On success, navigates to https://www.3dprintlog.com

**Key Plugins:**

- `cordova-plugin-network-information` - Network connectivity detection
- `cordova-plugin-customurlscheme` - Custom URL scheme (com.hoffmanengineering.printlog://) for OAuth callbacks
- `cordova-plugin-dialogs` - Native alert dialogs
- `cordova-plugin-splashscreen` - Splash screen management
- `cordova-plugin-statusbar` - Status bar customization (indigo #3F50B5)

**Allowed Navigation Domains (config.xml):**

- https://www.3dprintlog.com/*
- https://_.auth0.com/_
- https://_.google.com/_

## Key Files

- `config.xml` - Cordova configuration (app settings, plugins, permissions, allowed domains)
- `www/index.html` - Entry point HTML
- `www/js/index.js` - Device ready handler and navigation logic
- `platforms/android/` - Android platform build files (generated — do not edit directly)
- `platforms/ios/` - iOS platform build files (generated — do not edit directly)
- `build.json` - Code signing config for Android (keystore) and iOS (Team ID, provisioning)
- `azure-pipelines-ios.yml` - Azure Pipelines CI/CD for iOS builds (macOS agent)
- `hooks/before_compile/patch_camera_permission.js` - Build hook that patches WebView camera permission handling (see Build Notes)

## Build Notes

- Android build uses Gradle with AndroidX enabled
- Release builds require signing with AndroidKeyStore/KeyStore.jks
- User agent is overridden to "Mozilla/5.0 Google" for Google login compatibility
- `platforms/android/` is generated — changes there are lost on `cordova platform remove/add`. Use `config.xml`, hooks, or plugins for persistent changes.
- The `before_compile` hook (`hooks/before_compile/patch_camera_permission.js`) patches `SystemWebChromeClient.java` in two places. Each patch is independently idempotent:
  1. **`onPermissionRequest`** (WebRTC path) — requests CAMERA runtime permission when a page calls `getUserMedia()` (e.g. QR scanning). Without this, the WebView auto-grants the web permission but never triggers the Android runtime prompt.
  2. **`onShowFileChooser`** (file input path) — wraps the method so that `<input type="file" capture="environment">` requests CAMERA runtime permission before opening the chooser. The original body is extracted to `showFileChooserImpl(callback, params, allowCapture)`. If permission is denied, the chooser still opens but without the camera option.
- Android build tools 35.0.0 is required (cordova-android 14.0.1 targets SDK 35)
- Both Android-specific hooks (`patch_camera_permission.js`, `patch_auth_custom_tab.js`) have platform guards that skip when not building for Android

## iOS Build Notes

- iOS builds require macOS with Xcode (use Azure Pipelines for CI/CD)
- `build.json` contains iOS code signing config with `TEAM_ID_PLACEHOLDER` — replaced at build time in CI
- Minimum deployment target: iOS 13.0
- WKWebView only (UIWebView removed)
- Permission descriptions in config.xml `<platform name="ios">` section (required for App Store)
- Azure Pipelines workflow (`azure-pipelines-ios.yml`) requires 4 secret variables: `APPLE_TEAM_ID`, `IOS_DISTRIBUTION_CERT_P12_BASE64`, `IOS_DISTRIBUTION_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`

## Companion UI Repository

The web UI lives in the `print-log-ui` repo (Angular). When both repos need coordinated changes:

- The UI worktree for in-progress feature work is at `../print-log-ui/.worktrees/<branch-name>/`
- The UI repo remote is on Azure DevOps (`dev.azure.com/HoffmanEngineering/3D Print Log/_git/3D Print Log UI`)
- The UI exposes `isCordova` (from `src/app/core/utils/platform`) on components that need Cordova-specific behavior
- Use `capture="environment"` on hidden file inputs to let Android's native chooser offer Camera/Files — no need for a custom mat-menu
