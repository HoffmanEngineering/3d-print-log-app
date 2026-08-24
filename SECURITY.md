# Security Policy

If you discover a security vulnerability, please **do not** open a public GitHub issue.

Instead, email **hello@3dprintlog.com** with a description of the issue and steps to reproduce it. We'll respond as quickly as possible and coordinate a fix before any public disclosure.

## Scope

This repository is the Cordova shell for the Android app. Issues in the web application or the backend belong in [3d-print-log-ui](https://github.com/HoffmanEngineering/3d-print-log-ui) and [3d-print-log-api](https://github.com/HoffmanEngineering/3d-print-log-api) respectively — but if you are unsure, email us and we will route it.

Of particular interest here: the WebView configuration in `config.xml`, the allowed-navigation domain list, the OAuth custom-URL-scheme handling, and the native permission patches in `hooks/before_compile/`.
