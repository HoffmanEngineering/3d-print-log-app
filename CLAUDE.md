# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

3D Print Log is an Apache Cordova hybrid mobile application that serves as a WebView wrapper for https://www.3dprintlog.com. The app handles device initialization, network connectivity checks, and authentication flows (Auth0, Google OAuth) before redirecting to the main web application.

**App ID:** com.printlog.app
**Version:** 1.1.4
**Primary Platform:** Android

## Build Commands

```bash
# Build development APK
npm run build:android

# Build signed release bundle (uses keystore credentials from package.json)
npm run release:android

# Run on connected device/emulator
cordova run android
```

## Architecture

**Framework:** Apache Cordova 13.0.0 with cordova-android 14.0.1

**Entry Flow:**
1. `www/index.html` loads as entry point with splash screen
2. `www/js/index.js` handles Cordova `deviceready` event
3. Network connectivity check via cordova-plugin-network-information
4. On success, navigates to https://www.3dprintlog.com

**Key Plugins:**
- `cordova-plugin-network-information` - Network connectivity detection
- `cordova-plugin-customurlscheme` - Custom URL scheme (com.printlog.app://) for OAuth callbacks
- `cordova-plugin-dialogs` - Native alert dialogs
- `cordova-plugin-splashscreen` - Splash screen management
- `cordova-plugin-statusbar` - Status bar customization (indigo #3F50B5)

**Allowed Navigation Domains (config.xml):**
- https://www.3dprintlog.com/*
- https://*.auth0.com/*
- https://*.google.com/*

## Key Files

- `config.xml` - Cordova configuration (app settings, plugins, permissions, allowed domains)
- `www/index.html` - Entry point HTML
- `www/js/index.js` - Device ready handler and navigation logic
- `platforms/android/` - Android platform build files (generated — do not edit directly)
- `hooks/before_compile/patch_camera_permission.js` - Build hook that patches WebView camera permission handling

## Build Notes

- Android build uses Gradle with AndroidX enabled
- Release builds require signing with AndroidKeyStore/KeyStore.jks
- User agent is overridden to "Mozilla/5.0 Google" for Google login compatibility
- `platforms/android/` is generated — changes there are lost on `cordova platform remove/add`. Use `config.xml`, hooks, or plugins for persistent changes.
- A `before_compile` hook patches `SystemWebChromeClient.java` to request Android's runtime CAMERA permission on demand when the website requests camera access (e.g. QR scanning). Without this patch, the WebView auto-grants the web permission but never triggers the Android runtime prompt, causing camera access to silently fail.
- Android build tools 35.0.0 is required (cordova-android 14.0.1 targets SDK 35)
