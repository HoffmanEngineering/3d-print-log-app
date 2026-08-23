# Design: Migrate print-log-app from Azure DevOps to public GitHub

Date: 2026-08-23
Status: Approved

## Goal

Move the 3D Print Log Cordova app repository from Azure DevOps to a public
open-source repository at `https://github.com/HoffmanEngineering/3d-print-log-app`,
scrubbing a leaked credential from git history, matching the OSS configuration of
the sibling `3d-print-log-ui` and `3d-print-log-api` repositories, and replacing
Azure Pipelines with GitHub Actions for Android build and release artifacts.

## Decisions

| Question | Decision |
|---|---|
| Leaked keystore status | Retired; `3DPrintLogKeyStore.jks` replaced it. No rotation needed. |
| History handling | `git filter-repo --replace-text` scrub. Authorship history preserved. |
| Repo name | `3d-print-log-app` |
| Azure DevOps remote | Dropped entirely. GitHub becomes the only remote. |
| `azure-pipelines-ios.yml` | Left in place; iOS builds stay on Azure DevOps for now. |
| License | AGPL-3.0-only, matching `3d-print-log-ui`. |
| CI scope | Android CI on push/PR; signed Android AAB on tag. No iOS workflow. |

## Findings

### The leak

`package.json` carried an Android keystore password in plaintext in the
`release:android` npm script across the early history, removed in a later commit
but still present in every intervening commit object. The same string served as
both `--storePassword` and `--password`, alongside `--alias=ChrisUpload` and
`--keystore=../AndroidKeyStore/KeyStore.jks`.

The exact string is NOT reproduced in this document. It lives only in the
`secrets.txt` replacement file, which is created in the scratchpad and never
committed.

The user has confirmed this keystore is retired and no longer signs Play Store
releases, so no upload-key rotation with Google Play is required. The scrub is
hygiene, not incident response.

### What is clean

- `build.json`, which holds the current live keystore passwords, is gitignored and
  was never committed. Verified against `git log --diff-filter=A --name-only`.
- No API keys, tokens, private keys, or `.p12`/`.jks` blobs appear anywhere in
  history. The `azure-pipelines-ios.yml` signing steps reference Azure secret
  variables by name only.
- `hello@3dprintlog.com`, the Auth0 wildcard domain, and the app ID are all
  already public-facing.

### What must not be pushed

- `old-app-backup/` — untracked directory containing built APKs. Currently only
  protected by being untracked.
- `AndroidKeyStore/` — sibling directory holding the live `.jks`.

## Section 1: History scrub

Procedure:

1. Full mirror backup: `git clone --mirror . <scratchpad>/print-log-app-backup.git`
2. Write `<scratchpad>/secrets.txt` containing `<leaked-string>==>***REMOVED***`
3. `git filter-repo --replace-text <scratchpad>/secrets.txt --force`
4. Verify: `git log -p --all` contains no occurrence of the leaked string

`filter-repo` removes the `origin` remote as a safety measure. This is desirable
here since the Azure remote is being dropped regardless.

All 19 commit SHAs change. Any existing clone of the Azure repo becomes
incompatible; since the Azure repo is being retired, this is acceptable.

Branches: only `main` is carried to GitHub. The local branches `UpdateAndroid13`,
`chore/rename-app-id`, and `feature/ios-platform-support` are merged or dead and
are deleted locally before the rewrite.

## Section 2: Pre-push repo hygiene

`.gitignore` additions:

```
old-app-backup/
AndroidKeyStore/
```

`package.json` corrections (all currently hold Cordova scaffold defaults):

| Field | From | To |
|---|---|---|
| `version` | `1.0.0` | `1.1.6` (matches `config.xml`) |
| `description` | "A sample Apache Cordova application..." | The real app description from `config.xml` |
| `author` | `Apache Cordova Team` | `Hoffman Engineering` |
| `license` | `Apache-2.0` | `AGPL-3.0-only` |

`README.md` is currently four lines of scratch notes. It is rewritten as a public
README covering: what the app is and its relationship to the web UI, prerequisites
(Node 20, Android SDK 35, build-tools 35.0.0, JDK 17), build and run commands,
how release signing works and that `build.json` is intentionally absent, a link to
`3d-print-log-ui`, and a license badge.

## Section 3: OSS scaffolding

Mirrors `3d-print-log-ui`. Root files:

- `LICENSE` — AGPL-3.0
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md` — same private-disclosure text pointing at `hello@3dprintlog.com`

`.github/`:

- `CODEOWNERS` — `* @ChristopherHoffman`, with explicit entries for
  `.github/workflows/`, `CODEOWNERS`, `CLAUDE.md`, `.claude/`, `config.xml`,
  and `hooks/`
- `FUNDING.yml` — copied verbatim from the UI repo
- `pull_request_template.md`
- `ISSUE_TEMPLATE/bug-report.yml` — adapted for mobile: device model, Android
  version, app version, install source (Play Store / sideload) replace the UI
  repo's browser fields
- `ISSUE_TEMPLATE/feature-request.yml`

## Section 4: GitHub Actions

### `.github/workflows/ci.yml`

Triggers on push and pull_request against `main`. Runs on `ubuntu-latest`.

Steps: checkout, setup-node 20 with npm cache, `npm ci`,
`npx cordova platform add android`, `npx cordova build android` (unsigned debug),
upload the resulting debug APK via `actions/upload-artifact` so a PR build can be
sideloaded for review.

No lint or test step: the repo has no test suite and `npm test` is the Cordova
scaffold's `exit 1` placeholder.

### `.github/workflows/release.yml`

Triggers on tags matching `v*`. Runs on `ubuntu-latest` with
`environment: production`.

Steps: checkout, setup-node 20, `npm ci`, `npx cordova platform add android`,
then decode the keystore and synthesize `build.json` at runtime — the file is
gitignored, so CI must create its own:

```yaml
- run: echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > keystore.jks
- run: |
    jq -n \
      --arg pw  "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}" \
      --arg al  "${{ secrets.ANDROID_KEY_ALIAS }}" \
      --arg kpw "${{ secrets.ANDROID_KEY_PASSWORD }}" \
      '{android:{release:{keystore:"keystore.jks",storePassword:$pw,alias:$al,password:$kpw,packageType:"bundle"}}}' \
      > build.json
- run: npm run release:android
- uses: softprops/action-gh-release@v2
  with:
    files: platforms/android/app/build/outputs/bundle/release/*.aab
```

A final `if: always()` step removes `keystore.jks` and `build.json`.

The existing `release:android` npm script already passes
`--buildConfig=build.json` and needs no modification: the local `build.json`
points at `../AndroidKeyStore/3DPrintLogKeyStore.jks` and the CI-generated one
points at `keystore.jks` in the workspace root. Both are valid for their context.

Secrets the user must create (cannot be automated — requires the `.jks` in hand):
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`.

## Section 5: Repo creation and configuration

1. `gh repo create HoffmanEngineering/3d-print-log-app --public`
2. Push the rewritten `main`
3. Read `3d-print-log-ui`'s actual settings via `gh api` and match rather than
   assume. Expected: description set, topics
   (`cordova`, `android`, `3d-printing`, `hybrid-app`, `mobile`), issues enabled,
   wiki and projects disabled, squash-merge only, auto-delete merged branches.
4. Branch protection on `main` requiring the CI check to pass.

## Verification

Before any push:

- `git log -p --all` contains no occurrence of the leaked string
- `git status --porcelain` shows no `old-app-backup/`, no `build.json`
- `git ls-files` matches no `build.json`, `.jks`, or `.p12`
- `npm run build:android` succeeds locally after the `package.json` edits

After push:

- CI workflow goes green on `main`
- The repo's public file listing contains no keystore or signing config

## Out of scope

- Porting the iOS pipeline to GitHub Actions
- Archiving or deleting the Azure DevOps repository (user action)
- Creating the four GitHub Actions secrets (user action)
- Any change to app functionality
