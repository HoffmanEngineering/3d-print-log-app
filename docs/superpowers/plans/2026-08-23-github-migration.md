# GitHub Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `print-log-app` from Azure DevOps to a public, open-source GitHub repository at `HoffmanEngineering/3d-print-log-app`, with the leaked keystore credential scrubbed from git history and GitHub Actions producing Android CI builds and signed release artifacts.

**Architecture:** Three sequential phases that must not be reordered. Phase A (Tasks 1–3) rewrites git history and proves the secret is gone at the object level — nothing else may begin until its gate passes. Phase B (Tasks 4–10) adds hygiene fixes, OSS scaffolding, and workflows as fresh commits on top of the scrubbed history, all still local. Phase C (Tasks 11–13) creates the GitHub repository, pushes, configures it, and proves the signed-release path actually works.

**Tech Stack:** git 2.x + `git-filter-repo`, Apache Cordova 13 CLI, cordova-android 14.0.1 (SDK 35), Node 20, GitHub Actions on `ubuntu-latest`, `gh` CLI 2.92.

**Spec:** `docs/superpowers/specs/2026-08-23-github-migration-design.md`

## Global Constraints

- Repository root for all commands: `D:/Development/3d-print-log/print-log-app`
- Scratchpad root (referred to below as `$SCRATCH`): `C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad`
- The leaked string is **never** written into any committed file. It exists only in `$SCRATCH/secrets.txt`.
- **Verification is object-level, never ref-traversal.** `git log -p --all | grep` is forbidden as a completion check: it misses `refs/stash`, which carries 2 of the 6 occurrences. Always use `git cat-file --batch-all-objects --batch`.
- Node version is **20** everywhere it is stated (README, `ci.yml`, `release.yml`). `azure-pipelines-ios.yml` says 18; it is an unimplemented artifact and is not a source of truth.
- Android toolchain: SDK 35, build-tools 35.0.0, JDK 17.
- App version is **1.1.6**, matching `config.xml`.
- License is **AGPL-3.0-only**. Cordova scaffold files keep their upstream Apache-2.0 headers.
- GitHub org/repo: `HoffmanEngineering/3d-print-log-app`. Owner handle: `@ChristopherHoffman`.
- Contact email for security/conduct: `hello@3dprintlog.com`
- Nothing is pushed to any remote until Task 11. Tasks 1–10 are entirely local and reversible.

### Deviations from the spec, resolved during planning

Three spec statements were checked against reality and corrected here. The spec instructed matching the sibling repos "rather than assume"; these are the results of that check.

| Spec said | Reality (`gh api`) | Plan does |
|---|---|---|
| Match siblings: "squash-merge only, auto-delete merged branches" | `3d-print-log-ui` and `-api` both allow squash + merge + rebase, `delete_branch_on_merge: false` | Match the siblings exactly — all three merge methods, no auto-delete |
| Match siblings: "projects disabled" | Both siblings have `has_projects: true` | Leave projects enabled |
| `softprops/action-gh-release@v2`, SHA-pinned | Current release line is **v3.0.2** | Pin `v3.0.2` = `3d0d9888cb7fd7b750713d6e236d1fcb99157228` |

A fourth spec assumption was corrected after the user challenged it. The spec's "match the siblings" instruction was initially applied by querying `gh api .../branches/main/protection`, which returns **404** on both siblings — but that is the *legacy* endpoint, and both repos are protected by **rulesets** instead. A 404 there is not evidence of an unprotected repository.

The real sibling pattern, replicated in Task 12:

| Layer | Configuration |
|---|---|
| Branch ruleset `main`, targeting `~DEFAULT_BRANCH` | `deletion`, `non_fast_forward`, and `pull_request` with 1 required approving review, `dismiss_stale_reviews_on_push: true`, `require_extra_approval_for_unattributed_changes: true`, all three merge methods allowed |
| Tag ruleset `All Tags`, targeting `~ALL` | `deletion`, `non_fast_forward`, `creation`, `update` |
| Both rulesets | `bypass_actors: [{actor_id: 5, actor_type: RepositoryRole, bypass_mode: always}]` — admins bypass |
| `production` environment | `required_reviewers: ChristopherHoffman` (`prevent_self_review: false`), deployment branch policies `main` (branch) and `v*` (tag) |

Neither sibling configures a required status check, so this plan does not either — `ci.yml` reports on PRs without being a hard merge gate. Two consequences flow from this pattern and are handled where they land: the tag ruleset blocks tag *creation* (Task 13's test tag depends on the admin bypass), and the environment's required reviewer *pauses* every release run for manual approval before the signing steps execute.

---

## File Structure

**Rewritten by Phase A (no new files):** all of git history.

**Created in Phase B:**

| File | Responsibility |
|---|---|
| `LICENSE` | AGPL-3.0 text + Cordova scaffold Apache-2.0 note |
| `CONTRIBUTING.md` | Android toolchain setup, build/run, PR expectations |
| `CODE_OF_CONDUCT.md` | Contributor Covenant, contact `hello@3dprintlog.com` |
| `SECURITY.md` | Private vulnerability disclosure |
| `.github/CODEOWNERS` | Review gate on CI, agent config, and native-patch hooks |
| `.github/FUNDING.yml` | Sponsor links (verbatim from UI repo) |
| `.github/pull_request_template.md` | PR checklist, mobile-flavoured |
| `.github/ISSUE_TEMPLATE/bug-report.yml` | Device/Android-version/install-source fields |
| `.github/ISSUE_TEMPLATE/feature-request.yml` | Same shape as UI repo |
| `.github/workflows/ci.yml` | Unsigned debug APK on push/PR to `main` |
| `.github/workflows/release.yml` | Signed AAB attached to a GitHub Release on `v*` |

**Modified in Phase B:** `.gitignore`, `package.json`, `package-lock.json`, `README.md`.

**Untouched throughout:** `config.xml`, `www/`, `hooks/`, `azure-pipelines-ios.yml`, `ios-build-guide.md`, `CLAUDE.md`. No app functionality changes in this plan.

---

# Phase A — History scrub

## Task 1: Inventory and validated backup

Establishes the pre-rewrite baseline and a restore point. Every later claim about what was removed is measured against the numbers captured here.

**Files:**
- Create: `$SCRATCH/pre-migration-inventory.txt`
- Create: `$SCRATCH/print-log-app-backup.git/` (mirror clone)

**Interfaces:**
- Consumes: nothing
- Produces: `$SCRATCH/print-log-app-backup.git` (restore source for the Task 3 abort path); the baseline counts `TOTAL_OBJECTS_WITH_SECRET=6` and `MAIN_COMMITS=20`

- [ ] **Step 1: Confirm the working tree is clean**

```bash
cd D:/Development/3d-print-log/print-log-app
git status --porcelain
```

Expected: only `?? old-app-backup/`. If anything else appears, stop and resolve it — `filter-repo` refuses to run on a dirty tree, and uncommitted work would be lost.

- [ ] **Step 2: Capture the full ref and object inventory**

```bash
cd D:/Development/3d-print-log/print-log-app
SCRATCH="C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad"
SECRET='***REMOVED***'

{
  echo "=== date ==="; date
  echo "=== refs ==="; git for-each-ref --format='%(refname) %(objectname)'
  echo "=== stashes ==="; git stash list
  echo "=== main commit count ==="; git rev-list --count main
  echo "=== occurrences via log --all (KNOWN INCOMPLETE) ==="
  git log -p --all | grep -c "$SECRET"
  echo "=== occurrences via all objects (AUTHORITATIVE) ==="
  git cat-file --batch-all-objects --batch | grep -c "$SECRET"
} > "$SCRATCH/pre-migration-inventory.txt"

cat "$SCRATCH/pre-migration-inventory.txt"
```

Expected: `main` commit count `20`; log-based count `4`; object-based count `6`. The gap between 4 and 6 is the whole reason this plan exists — if the object count is not greater than the log count, re-read the spec's Findings section before continuing, because the repository state has changed since it was written.

- [ ] **Step 3: Create the mirror backup**

```bash
SCRATCH="C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad"
rm -rf "$SCRATCH/print-log-app-backup.git"
git clone --mirror D:/Development/3d-print-log/print-log-app "$SCRATCH/print-log-app-backup.git"
```

- [ ] **Step 4: Validate the backup before trusting it**

A backup that has not been verified is not a backup.

```bash
SCRATCH="C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad"
git -C "$SCRATCH/print-log-app-backup.git" fsck --no-progress
git -C "$SCRATCH/print-log-app-backup.git" rev-list --count main
```

Expected: `fsck` reports no errors (dangling-object notices are fine), and the count is `20`.

Note: a `--mirror` clone does **not** copy `refs/stash`. That is acceptable — the stashes are 2022 WIP being deliberately discarded, and their content is a superset of what is already in history. If they must be recoverable, run `git stash show -p stash@{0} > $SCRATCH/stash0.patch` (and `stash@{1}`) first, and treat those patch files as secret-bearing.

- [ ] **Step 5: Commit the inventory record**

Nothing to commit in the repo — the inventory lives in the scratchpad by design, because it names the secret. Confirm no scratchpad file leaked into the repo:

```bash
cd D:/Development/3d-print-log/print-log-app
git status --porcelain
```

Expected: unchanged from Step 1.

---

## Task 2: Ref cleanup

Removes the refs that will not be carried to GitHub, **before** rewriting. Deleting them first means `filter-repo` has less to rewrite and the post-rewrite ref list is trivially checkable.

**Files:** none — this task operates on git refs only.

**Interfaces:**
- Consumes: validated backup from Task 1
- Produces: a repository whose only refs are `refs/heads/main` and `refs/tags/v1.1.6`

- [ ] **Step 1: Record the supersession evidence for `UpdateAndroid13`**

This branch is unmerged, so deleting it needs a reason on the record, not an assertion.

```bash
cd D:/Development/3d-print-log/print-log-app
git log --oneline main..UpdateAndroid13
git diff --stat main...UpdateAndroid13
grep -n '"cordova-android"' package.json
```

Expected: exactly one unique commit `1cae47d feat: update to android 13 (api 34)`; a diff touching only `package.json` and `package-lock.json`; and current `package.json` showing `cordova-android: ^14.0.1`. That combination is the proof the branch is superseded — it proposes API 34 tooling that `main` has already moved past. If the diff touches any file beyond those two, **stop** and escalate: the branch contains unique work.

- [ ] **Step 2: Drop the stashes**

```bash
cd D:/Development/3d-print-log/print-log-app
git stash list
git stash clear
git stash list
```

Expected: two entries before, no output after. These carry 2 of the 6 secret occurrences.

- [ ] **Step 3: Delete the obsolete branches and the Azure remote**

```bash
cd D:/Development/3d-print-log/print-log-app
git branch -D UpdateAndroid13 chore/rename-app-id feature/ios-platform-support
git remote remove origin
```

Removing the remote also removes its `refs/remotes/origin/*` tracking refs, and guarantees no accidental push to Azure for the rest of the migration.

- [ ] **Step 4: Verify the ref list**

```bash
cd D:/Development/3d-print-log/print-log-app
git for-each-ref --format='%(refname)'
```

Expected exactly:

```
refs/heads/main
refs/tags/v1.1.6
```

If anything else is listed, remove it before continuing — `filter-repo` rewrites every ref it finds, and an unnoticed ref is an unnoticed leak.

---

## Task 3: Scrub and prove

The gate. Nothing in Phase B or C may start until Step 5 passes.

**Files:**
- Create: `$SCRATCH/secrets.txt` (never committed)

**Interfaces:**
- Consumes: cleaned refs from Task 2
- Produces: a rewritten history with zero secret occurrences at object level; all commit SHAs changed

- [ ] **Step 1: Write the replacement file**

```bash
SCRATCH="C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad"
printf '%s==>%s\n' '***REMOVED***' '***REMOVED***' > "$SCRATCH/secrets.txt"
cat "$SCRATCH/secrets.txt"
```

- [ ] **Step 2: Confirm the scrub is currently needed (the failing check)**

Run the authoritative scan before the rewrite so its post-rewrite counterpart is meaningful:

```bash
cd D:/Development/3d-print-log/print-log-app
git cat-file --batch-all-objects --batch | grep -c '***REMOVED***'
```

Expected: still `6`, unchanged from Task 1. Clearing the stashes in Task 2 made those two blobs *unreachable*, but `--batch-all-objects` walks the whole object database including unreachable objects, so they are still counted. This is exactly why the ref-based check is inadequate and why Step 4's gc is a required step rather than tidying. Any non-zero value confirms the scrub is still needed.

- [ ] **Step 3: Run the rewrite**

```bash
cd D:/Development/3d-print-log/print-log-app
SCRATCH="C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad"
git filter-repo --replace-text "$SCRATCH/secrets.txt" --force
```

`--force` is required because this is not a fresh clone. `filter-repo` removes any remaining remote itself.

- [ ] **Step 4: Expire reflogs and garbage-collect**

The rewrite leaves the old objects reachable via reflog. Until they are pruned, the secret is still in `.git`.

```bash
cd D:/Development/3d-print-log/print-log-app
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

- [ ] **Step 5: THE GATE — object-level verification**

```bash
cd D:/Development/3d-print-log/print-log-app
git cat-file --batch-all-objects --batch | grep -c '***REMOVED***'
```

Expected: `0`. (`grep -c` exits non-zero on zero matches; that is success here.)

Then confirm the replacement landed and the history is intact:

```bash
git log --all -p | grep -c 'REMOVED'          # expect >= 1
git rev-list --count main                      # expect 20
git for-each-ref --format='%(refname)'         # expect only main + v1.1.6
git log --oneline -3
```

**ABORT CRITERION.** If the object scan returns anything other than 0, stop immediately. Do not create the GitHub repository. Do not push. Restore and re-diagnose:

```bash
SCRATCH="C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad"
cd D:/Development/3d-print-log
mv print-log-app print-log-app-FAILED
git clone "$SCRATCH/print-log-app-backup.git" print-log-app
```

- [ ] **Step 6: Confirm the tag survived and still predates the workflows**

```bash
cd D:/Development/3d-print-log/print-log-app
git tag -l
git ls-tree -r --name-only v1.1.6 | grep -c '.github/workflows' || echo "no workflows at tag - correct"
```

Expected: `v1.1.6` present; no workflow files at that tag. This is what makes pushing the tag safe — a tag push resolves its workflow from the pushed ref, and this ref has none.

No commit step: `filter-repo` has already rewritten the commits.

---

# Phase B — Local content (nothing pushed)

## Task 4: Repo hygiene and a reproducible Cordova CLI

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json` (via `npm install`)

**Interfaces:**
- Consumes: scrubbed history from Task 3
- Produces: npm scripts `build:android` / `release:android` resolving a **pinned** Cordova CLI from the lockfile, so `ci.yml` and `release.yml` (Tasks 8–9) need no `npx` download

- [ ] **Step 1: Show the problem**

```bash
cd D:/Development/3d-print-log/print-log-app
ls node_modules/cordova 2>/dev/null || echo "CORDOVA CLI ABSENT"
ls node_modules/.bin/ | grep -i cordova || echo "NO cordova BINARY"
```

Expected: both report absent. `package.json` carries `cordova-android` and `cordova-ios` (platform packages) but not the CLI, so a bare `npx cordova` in CI would download an unpinned current version at build time.

- [ ] **Step 2: Add `old-app-backup/` to `.gitignore`**

Append to `.gitignore`:

```
# Local APK backups (never publish)
old-app-backup/
```

Do **not** add an `AndroidKeyStore/` entry. That directory is at `D:/Development/3d-print-log/AndroidKeyStore/`, a sibling of the repo root, so no in-repo ignore rule can affect it. Adding one would imply protection that does not exist.

- [ ] **Step 3: Fix the `package.json` metadata and pin the CLI**

Apply these edits to `package.json`:

```json
{
  "name": "com.hoffmanengineering.printlog",
  "displayName": "3D Print Log",
  "version": "1.1.6",
  "description": "Cordova hybrid mobile app for 3D Print Log — log and track your 3D prints, print times, filament usage, and settings.",
  "author": "Hoffman Engineering",
  "license": "AGPL-3.0-only",
  "repository": {
    "type": "git",
    "url": "https://github.com/HoffmanEngineering/3d-print-log-app.git"
  }
}
```

Leave `main`, `keywords`, `scripts`, and the `cordova` block as they are. Then add the CLI to `devDependencies`, alongside the existing entries:

```json
"cordova": "13.0.0"
```

Pin it exactly — no `^`. The point is that CI resolves the same CLI every run.

- [ ] **Step 4: Install and confirm the CLI now resolves locally**

```bash
cd D:/Development/3d-print-log/print-log-app
npm install
ls node_modules/.bin/ | grep -i cordova
node_modules/.bin/cordova --version
```

Expected: a `cordova` binary exists and reports `13.0.0`. `package-lock.json` is modified.

- [ ] **Step 5: Confirm the ignore rule works**

```bash
cd D:/Development/3d-print-log/print-log-app
git status --porcelain | grep old-app-backup || echo "IGNORED - correct"
git check-ignore -v old-app-backup/
```

Expected: no longer listed as untracked; `check-ignore` names the `.gitignore` line.

- [ ] **Step 6: Commit**

```bash
cd D:/Development/3d-print-log/print-log-app
git add .gitignore package.json package-lock.json
git commit -m "chore: correct package metadata, pin cordova CLI, ignore APK backups

Replaces the Cordova scaffold defaults (author, description, Apache-2.0,
version 1.0.0) with the real values and AGPL-3.0-only. Pins the Cordova
CLI at 13.0.0 so CI resolves it from the lockfile rather than
downloading an unpinned version via npx."
```

---

## Task 5: Public README

**Files:**
- Modify: `README.md` (currently four lines of scratch notes)

**Interfaces:**
- Consumes: the pinned npm scripts from Task 4
- Produces: the documented toolchain contract (Node 20, SDK 35, build-tools 35.0.0, JDK 17) that Tasks 8–9 must match

- [ ] **Step 1: Replace `README.md` entirely**

```markdown
# 3D Print Log — Mobile App

[![CI](https://github.com/HoffmanEngineering/3d-print-log-app/actions/workflows/ci.yml/badge.svg)](https://github.com/HoffmanEngineering/3d-print-log-app/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

The Android app for [3D Print Log](https://www.3dprintlog.com) — a tool for logging and tracking 3D prints, print times, filament usage, and printer settings.

This is an [Apache Cordova](https://cordova.apache.org/) hybrid app: a native shell wrapping the web application. The shell handles device initialization, network-connectivity checks, OAuth callbacks (Auth0 and Google), and native camera permissions, then hands off to the web UI. The interface itself lives in [3d-print-log-ui](https://github.com/HoffmanEngineering/3d-print-log-ui).

## Status

**Android** is shipping — see the app on Google Play.

**iOS** is designed but **not implemented**. `azure-pipelines-ios.yml` and `ios-build-guide.md` describe an intended iOS build; neither has ever run. Treat them as design notes, not working configuration.

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- JDK 17
- Android SDK **35** with build-tools **35.0.0** (cordova-android 14 targets SDK 35)
- `ANDROID_HOME` set to your SDK location

## Getting started

```bash
git clone https://github.com/HoffmanEngineering/3d-print-log-app.git
cd 3d-print-log-app
npm install
npm run build:android
```

To run on a connected device or a running emulator:

```bash
npx cordova run android
```

## Project layout

| Path | Purpose |
|---|---|
| `config.xml` | Cordova configuration — app ID, permissions, allowed domains, plugins |
| `www/` | The native shell's entry point and bootstrap logic |
| `www/js/index.js` | `deviceready` handler, connectivity check, redirect to the web app |
| `hooks/before_compile/` | Build hooks that patch the generated Android WebView sources |
| `platforms/` | Generated by Cordova — **not** checked in, and edits here are lost |

### Build hooks

`platforms/android/` is regenerated on every `cordova platform add`, so persistent native changes are applied by hooks instead:

- `patch_camera_permission.js` — makes the WebView request the Android runtime CAMERA permission. The WebView auto-grants the *web* permission but never triggers the OS prompt, so QR scanning and `<input type="file" capture="environment">` would silently fail without this.
- `patch_auth_custom_tab.js` — routes Auth0 `/authorize` URLs to a Chrome Custom Tab so Google sign-in works.

Both are idempotent and skip when the build target is not Android.

## Release signing

Release builds are signed with a keystore that is **not** in this repository. `build.json` holds the signing configuration and is gitignored.

Maintainers building a release locally create `build.json` at the repo root:

```json
{
  "android": {
    "release": {
      "keystore": "/path/to/your.jks",
      "storePassword": "...",
      "alias": "...",
      "password": "...",
      "packageType": "bundle"
    }
  }
}
```

Then `npm run release:android` produces `platforms/android/app/build/outputs/bundle/release/app-release.aab`.

In CI, the tagged-release workflow reconstructs `build.json` from repository secrets. Contributors do not need any of this — `npm run build:android` produces an unsigned debug build.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests are welcome via [issues](https://github.com/HoffmanEngineering/3d-print-log-app/issues).

## Related repositories

- [3d-print-log-ui](https://github.com/HoffmanEngineering/3d-print-log-ui) — Angular web app
- [3d-print-log-api](https://github.com/HoffmanEngineering/3d-print-log-api) — ASP.NET Core API

## License

[AGPL-3.0-only](LICENSE). Files generated by `cordova create` retain their upstream Apache-2.0 headers.
```

- [ ] **Step 2: Verify no stale content survives**

```bash
cd D:/Development/3d-print-log/print-log-app
grep -c 'Add readme' README.md || echo "scratch notes gone - correct"
grep -n 'Node.js 20' README.md
grep -n 'not implemented' README.md
```

Expected: the old `Add readme!` line is gone; Node 20 and the iOS status are both stated.

- [ ] **Step 3: Commit**

```bash
cd D:/Development/3d-print-log/print-log-app
git add README.md
git commit -m "docs: write public README

Replaces four lines of scratch notes. Documents the toolchain (Node 20,
SDK 35, build-tools 35.0.0, JDK 17), the hook-based native patching,
the signing story, and that iOS is designed but unimplemented."
```

---

## Task 6: Root OSS files

**Files:**
- Create: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`

**Interfaces:**
- Consumes: the toolchain contract from Task 5
- Produces: the files GitHub's community-standards checks look for

- [ ] **Step 1: Copy the AGPL text and Code of Conduct from the sibling repo**

Copying guarantees the licence text is byte-identical across the three repos.

```bash
cd D:/Development/3d-print-log/print-log-app
cp ../print-log-ui/LICENSE LICENSE
cp ../print-log-ui/CODE_OF_CONDUCT.md CODE_OF_CONDUCT.md
head -3 LICENSE
grep -n '3D Print Log UI' CODE_OF_CONDUCT.md || echo "no UI-specific naming"
```

Expected: `LICENSE` begins with the GNU AFFERO GENERAL PUBLIC LICENSE header. If `CODE_OF_CONDUCT.md` names the UI project anywhere, change those references to `3D Print Log`. Confirm the enforcement-contact address is `hello@3dprintlog.com`; set it if absent.

- [ ] **Step 2: Append the Cordova provenance note to `LICENSE`**

Add at the very end of `LICENSE`:

```
---

ADDITIONAL NOTICE

Files generated by `cordova create` — including www/index.html,
www/js/index.js, and www/css/index.css — originate from the Apache
Cordova project and remain licensed under the Apache License 2.0. Their
original license headers are retained in those files.

All other source code and assets in this repository are copyright
Hoffman Engineering and licensed under the AGPL-3.0-only terms above.
```

- [ ] **Step 3: Create `SECURITY.md`**

```markdown
# Security Policy

If you discover a security vulnerability, please **do not** open a public GitHub issue.

Instead, email **hello@3dprintlog.com** with a description of the issue and steps to reproduce it. We'll respond as quickly as possible and coordinate a fix before any public disclosure.

## Scope

This repository is the Cordova shell for the Android app. Issues in the web application or the backend belong in [3d-print-log-ui](https://github.com/HoffmanEngineering/3d-print-log-ui) and [3d-print-log-api](https://github.com/HoffmanEngineering/3d-print-log-api) respectively — but if you are unsure, email us and we will route it.

Of particular interest here: the WebView configuration in `config.xml`, the allowed-navigation domain list, the OAuth custom-URL-scheme handling, and the native permission patches in `hooks/before_compile/`.
```

- [ ] **Step 4: Create `CONTRIBUTING.md`**

```markdown
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
```

- [ ] **Step 5: Verify all four files exist and are non-trivial**

```bash
cd D:/Development/3d-print-log/print-log-app
wc -l LICENSE CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md
grep -c 'AGPL\|Affero' LICENSE
grep -n 'hello@3dprintlog.com' SECURITY.md CODE_OF_CONDUCT.md
tail -5 LICENSE
```

Expected: `LICENSE` is several hundred lines and ends with the ADDITIONAL NOTICE block; the contact email appears in both `SECURITY.md` and the Code of Conduct.

- [ ] **Step 6: Commit**

```bash
cd D:/Development/3d-print-log/print-log-app
git add LICENSE CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md
git commit -m "docs: add OSS scaffolding (license, contributing, conduct, security)

AGPL-3.0-only matching 3d-print-log-ui, with an added notice that
Cordova scaffold files remain Apache-2.0. CONTRIBUTING documents the
hook-patching constraints that are easy to get wrong."
```

---

## Task 7: GitHub metadata templates

**Files:**
- Create: `.github/CODEOWNERS`, `.github/FUNDING.yml`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug-report.yml`, `.github/ISSUE_TEMPLATE/feature-request.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `.github/` directory that Tasks 8–9 add workflow files into

- [ ] **Step 1: Create the directories and copy `FUNDING.yml` verbatim**

```bash
cd D:/Development/3d-print-log/print-log-app
mkdir -p .github/ISSUE_TEMPLATE
cp ../print-log-ui/.github/FUNDING.yml .github/FUNDING.yml
cat .github/FUNDING.yml
```

Expected: `patreon: HoffmanEngineering` and the PayPal custom link.

- [ ] **Step 2: Create `.github/CODEOWNERS`**

```
* @ChristopherHoffman

# Maintainer review required for CI/CD, signing, native patches, and AI agent config
.github/workflows/          @ChristopherHoffman
.github/CODEOWNERS          @ChristopherHoffman
CLAUDE.md                   @ChristopherHoffman
.claude/                    @ChristopherHoffman
config.xml                  @ChristopherHoffman
hooks/                      @ChristopherHoffman
```

`config.xml` and `hooks/` are listed because they control app permissions, allowed navigation domains, and patches to generated native code — the places where a subtle change has security consequences.

- [ ] **Step 3: Create `.github/pull_request_template.md`**

```markdown
## What does this PR do?

<!-- Brief description of the change -->

## How to test

<!-- Steps to verify on a device or emulator -->

## Tested on

<!-- e.g. Pixel 7, Android 14 — or "emulator, API 35" -->

## Checklist

- [ ] `npm run build:android` succeeds
- [ ] Deployed and launched on a device or emulator
- [ ] Permission / OAuth / camera paths exercised by hand if touched
- [ ] Build hook changes dry-run against the real generated Java file
- [ ] No secrets committed (`build.json`, `.jks`, keystore passwords)
```

- [ ] **Step 4: Create `.github/ISSUE_TEMPLATE/bug-report.yml`**

```yaml
name: Bug Report
description: Something isn't working correctly
labels: ['bug']
body:
  - type: textarea
    id: description
    attributes:
      label: What happened?
      description: A clear description of the bug
    validations:
      required: true
  - type: textarea
    id: reproduction
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. Open the app and ...
        2. Tap ...
        3. See error ...
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: Expected behavior
    validations:
      required: true
  - type: input
    id: device
    attributes:
      label: Device
      placeholder: e.g. Pixel 7, Samsung Galaxy S23
    validations:
      required: true
  - type: input
    id: android_version
    attributes:
      label: Android version
      placeholder: e.g. Android 14
    validations:
      required: true
  - type: input
    id: app_version
    attributes:
      label: App version
      description: Found in the Play Store listing, or the version in config.xml if you built it yourself
      placeholder: e.g. 1.1.6
  - type: dropdown
    id: install_source
    attributes:
      label: How did you install the app?
      options:
        - Google Play Store
        - Sideloaded a build myself
        - Built from source
    validations:
      required: true
  - type: textarea
    id: web_or_native
    attributes:
      label: Does it also happen at www.3dprintlog.com in a mobile browser?
      description: This app wraps the web UI, so this tells us which repo the bug belongs in. "Didn't check" is a fine answer.
```

- [ ] **Step 5: Create `.github/ISSUE_TEMPLATE/feature-request.yml`**

```yaml
name: Feature Request
description: Suggest a new feature or improvement
labels: ['enhancement']
body:
  - type: markdown
    attributes:
      value: |
        This repo is the native Android shell. If your request is about the app's screens or features, it likely belongs in [3d-print-log-ui](https://github.com/HoffmanEngineering/3d-print-log-ui). Requests about permissions, sign-in, notifications, offline behaviour, or packaging belong here.
  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve?
      description: Describe the use case or problem you're trying to address
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: Proposed solution
      description: Describe what you'd like to see
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives considered
      description: Any other approaches you've thought of
```

- [ ] **Step 6: Validate the YAML parses**

Malformed issue-template YAML fails silently on GitHub — the template just never appears.

```bash
cd D:/Development/3d-print-log/print-log-app
node -e "const y=require('fs').readFileSync('.github/ISSUE_TEMPLATE/bug-report.yml','utf8'); console.log('bug-report lines:', y.split('\n').length)"
node -e "const y=require('fs').readFileSync('.github/ISSUE_TEMPLATE/feature-request.yml','utf8'); console.log('feature-request lines:', y.split('\n').length)"
ls -R .github
```

Expected: both files read cleanly and `.github` contains `CODEOWNERS`, `FUNDING.yml`, `pull_request_template.md`, and the two templates. (Full schema validation happens on GitHub in Task 12.)

- [ ] **Step 7: Commit**

```bash
cd D:/Development/3d-print-log/print-log-app
git add .github
git commit -m "chore: add GitHub issue templates, PR template, CODEOWNERS, funding

Issue templates adapted for mobile: device, Android version, and install
source replace the UI repo's browser field, plus a question routing
web-UI bugs to the right repository."
```

---

## Task 8: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the pinned `cordova` devDependency from Task 4
- Produces: a job named **`build`** — the name a `required_status_checks` rule would reference if CI is ever made a hard merge gate (Task 12 Step 6). Keep it stable.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Setup JDK
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Install dependencies
        run: npm ci

      - name: Add Android platform
        run: npx cordova platform add android@14.0.1

      - name: Build debug APK
        run: npm run build:android

      - name: Upload debug APK
        uses: actions/upload-artifact@v4
        with:
          name: debug-apk
          path: platforms/android/app/build/outputs/apk/debug/*.apk
          retention-days: 14
          if-no-files-found: error
```

Notes for the implementer:

- `permissions: contents: read` is the least privilege this job needs. It uses no secrets, so pull requests from forks build normally.
- `npx cordova` here resolves the CLI pinned in the lockfile by Task 4 — it does not download anything, because `npm ci` already placed it in `node_modules/.bin`.
- The Android SDK is preinstalled on `ubuntu-latest` runners; `cordova platform add` accepts it via `ANDROID_HOME`. No SDK setup action is needed.
- `if-no-files-found: error` matters: without it, a build that produces no APK still reports success.

- [ ] **Step 2: Validate the workflow syntax locally**

```bash
cd D:/Development/3d-print-log/print-log-app
node -e "
const s=require('fs').readFileSync('.github/workflows/ci.yml','utf8');
if(!/^\s{2}build:/m.test(s)) throw new Error('job must be named build - the optional required-check rule references this name');
if(!/permissions:/.test(s)) throw new Error('missing permissions block');
console.log('ci.yml structure OK');
"
```

Expected: `ci.yml structure OK`.

- [ ] **Step 3: Commit**

```bash
cd D:/Development/3d-print-log/print-log-app
git add .github/workflows/ci.yml
git commit -m "ci: add Android build workflow

Builds an unsigned debug APK on push and PR to main and uploads it for
sideloading. Least-privilege read-only token; uses no secrets, so fork
PRs build normally."
```

---

## Task 9: Release workflow

The highest-risk file in this plan: it handles signing material and holds `contents: write`.

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the pinned `cordova` devDependency (Task 4); the `release:android` npm script's existing `--buildConfig=build.json` flag
- Produces: a GitHub Release with `app-release.aab` attached; requires the `production` environment and 4 secrets created in Task 12

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    environment: production

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Setup JDK
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Install dependencies
        run: npm ci

      - name: Add Android platform
        run: npx cordova platform add android@14.0.1

      - name: Decode keystore
        env:
          KEYSTORE_B64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
        run: printf '%s' "$KEYSTORE_B64" | base64 -d > keystore.jks

      - name: Write build.json
        env:
          STORE_PW: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          KEY_PW: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          jq -n \
            --arg pw  "$STORE_PW" \
            --arg al  "$KEY_ALIAS" \
            --arg kpw "$KEY_PW" \
            '{android:{release:{keystore:"keystore.jks",storePassword:$pw,alias:$al,password:$kpw,packageType:"bundle"}}}' \
            > build.json

      - name: Build signed bundle
        run: npm run release:android

      - name: Verify the bundle was signed
        run: |
          AAB=$(ls platforms/android/app/build/outputs/bundle/release/*.aab)
          echo "Built: $AAB"
          unzip -l "$AAB" | grep -q 'META-INF/.*\.RSA\|META-INF/.*\.EC' \
            && echo "signature block present" \
            || (echo "ERROR: bundle is not signed" && exit 1)

      - name: Create GitHub Release
        uses: softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228 # v3.0.2
        with:
          files: platforms/android/app/build/outputs/bundle/release/*.aab
          generate_release_notes: true

      - name: Clean up signing material
        if: always()
        run: rm -f keystore.jks build.json
```

Notes for the implementer — each of these is deliberate, do not "simplify" them:

- **`permissions: contents: write` is required.** Without it, an org or repo default of a read-only `GITHUB_TOKEN` makes every release fail at the upload step.
- **Secrets go through `env:`, never inline `${{ }}` in a `run:` body.** GitHub substitutes `${{ }}` into the script text *before* the shell parses it, so a password containing a quote, backtick, or `$` would corrupt the command or execute. Masking in logs does not fix this. The `env:` form passes the value through the environment, where the quoted `"$VAR"` expansion is safe.
- **`printf '%s'` rather than `echo`** for the base64 payload: `echo` may append a newline or interpret escapes depending on the shell builtin, corrupting the decode.
- **The third-party action is SHA-pinned**, because this job holds write access and touches the signing key. First-party `actions/*` steps stay on major tags. When bumping it, resolve the new tag to a SHA and update the trailing comment.
- **`environment: production`** scopes the four secrets to that environment rather than the whole repository, so a workflow on an untrusted branch cannot read them. Task 12 creates it.
- **The signature check is not decoration.** Cordova will happily emit an unsigned bundle if `build.json` is malformed, and an unsigned `.aab` attached to a release looks identical to a signed one until Play rejects it.
- `rm` on an ephemeral runner is hygiene, not a security control — the real controls are the permissions block, `env:` transport, and uploading only the `.aab` rather than any directory.

- [ ] **Step 2: Validate the workflow's security properties**

```bash
cd D:/Development/3d-print-log/print-log-app
node -e "
const s=require('fs').readFileSync('.github/workflows/release.yml','utf8');
const runs=[...s.matchAll(/run: *\|?([\s\S]*?)(?=\n      - |\n\njobs|$)/g)].map(m=>m[1]);
if(runs.some(r=>/\\\$\{\{ *secrets\./.test(r)))
  throw new Error('SECURITY: a secret is interpolated inside a run: body');
if(!/permissions:\s*\n\s*contents: write/.test(s))
  throw new Error('missing contents: write - releases will fail');
if(!/softprops\/action-gh-release@[0-9a-f]{40}/.test(s))
  throw new Error('third-party action is not SHA-pinned');
if(!/environment: production/.test(s))
  throw new Error('missing production environment');
console.log('release.yml security checks OK');
"
```

Expected: `release.yml security checks OK`. Each failure message names a real defect from the design review — do not weaken the check to make it pass.

- [ ] **Step 3: Commit**

```bash
cd D:/Development/3d-print-log/print-log-app
git add .github/workflows/release.yml
git commit -m "ci: add signed Android release workflow

Builds a signed AAB on v* tags and attaches it to a GitHub Release.
Secrets are passed via step-level env rather than interpolated into
shell source; contents: write is explicit; the third-party release
action is SHA-pinned; the bundle's signature is verified before upload."
```

---

## Task 10: Local build verification

The last gate before anything becomes public. Proves the Task 4 metadata edits did not break the build.

**Files:** none created or modified.

**Interfaces:**
- Consumes: everything from Tasks 4–9
- Produces: a green light for Phase C

- [ ] **Step 1: Build**

```bash
cd D:/Development/3d-print-log/print-log-app
npm run build:android
```

Expected: `BUILD SUCCESSFUL`. If it fails on SDK or build-tools, confirm build-tools 35.0.0 is installed and `ANDROID_HOME` is set — that is an environment problem, not a plan problem.

- [ ] **Step 2: Re-run the full pre-push checklist**

```bash
cd D:/Development/3d-print-log/print-log-app

echo "--- object-level secret scan (must be 0) ---"
git cat-file --batch-all-objects --batch | grep -c '***REMOVED***'

echo "--- refs (expect main + v1.1.6 only) ---"
git for-each-ref --format='%(refname)'

echo "--- stashes (expect empty) ---"
git stash list

echo "--- no signing material tracked (expect no output) ---"
git ls-files | grep -E 'build\.json|\.jks$|\.p12$|\.keystore$'

echo "--- APK backup not tracked (expect no output) ---"
git ls-files | grep old-app-backup

echo "--- working tree clean ---"
git status --porcelain
```

Every line must match its stated expectation. **If the secret scan is not 0, stop** and follow the abort path in Task 3 Step 5.

- [ ] **Step 3: Record the current keystore fingerprint**

Corroborates that the live signing key is a different key from the leaked one.

```bash
keytool -list -v \
  -keystore D:/Development/3d-print-log/AndroidKeyStore/3DPrintLogKeyStore.jks \
  -alias HoffmanUpload | grep -A2 'SHA256:'
```

Save the SHA-256 fingerprint — Task 13 compares the CI-signed artifact against it. `keytool` will prompt for the store password interactively; that is fine and keeps it out of shell history.

- [ ] **Step 4: No commit**

This task changes nothing. Confirm with `git status --porcelain` (already done in Step 2).

---

# Phase C — GitHub

## Task 11: Create the repository and push

**Files:** none — remote operations only.

**Interfaces:**
- Consumes: the verified local repository from Task 10
- Produces: `https://github.com/HoffmanEngineering/3d-print-log-app` with `main` and `v1.1.6`

- [ ] **Step 1: Confirm the gate one final time**

```bash
cd D:/Development/3d-print-log/print-log-app
git cat-file --batch-all-objects --batch | grep -c '***REMOVED***'
```

Expected: `0`. This is the point of no return — after the push, the history is public and cannot be recalled.

- [ ] **Step 2: Confirm `gh` is authenticated with the right account and scopes**

```bash
gh auth status
```

Expected: logged in as `ChristopherHoffman` with at least `repo` and `workflow` scopes. `workflow` is required to push `.github/workflows/` files.

- [ ] **Step 3: Create the repository**

```bash
cd D:/Development/3d-print-log/print-log-app
gh repo create HoffmanEngineering/3d-print-log-app \
  --public \
  --description "Apache Cordova Android app for 3D Print Log — a mobile shell for logging and tracking 3D prints, print times, filament usage, and printer settings." \
  --source . \
  --remote origin \
  --push
```

`--source . --remote origin --push` creates the repo, wires `origin`, and pushes the current branch in one step.

- [ ] **Step 4: Push the tag**

Deliberately after the branch push. The tag predates the workflow files, so it cannot trigger a release run.

```bash
cd D:/Development/3d-print-log/print-log-app
git push origin v1.1.6
```

- [ ] **Step 5: Verify what actually landed**

```bash
gh repo view HoffmanEngineering/3d-print-log-app --json name,visibility,url
gh api repos/HoffmanEngineering/3d-print-log-app/branches --jq '.[].name'
gh api repos/HoffmanEngineering/3d-print-log-app/tags --jq '.[].name'
gh run list --repo HoffmanEngineering/3d-print-log-app --limit 5
```

Expected: public repo; only `main`; tag `v1.1.6`; and in the run list, a `CI` run from the branch push but **no `Release` run** from the tag. A Release run appearing here means the tag was not rewritten as expected — cancel it immediately with `gh run cancel` and investigate.

- [ ] **Step 6: Confirm GitHub's own secret scanning is clean**

```bash
gh api repos/HoffmanEngineering/3d-print-log-app/secret-scanning/alerts --jq 'length'
```

Expected: `0`. A non-empty result means something was missed — treat as an incident, make the repo private with `gh repo edit --visibility private`, and re-diagnose.

---

## Task 12: Configure repository settings

**Files:** none — remote configuration only.

**Interfaces:**
- Consumes: the pushed repository from Task 11
- Produces: the `production` environment holding the 4 signing secrets that Task 13's release run needs

- [ ] **Step 1: Apply settings matching the sibling repos**

Values verified against `3d-print-log-ui` and `3d-print-log-api` during planning — all three merge methods, no auto-delete, projects on, wiki off.

```bash
gh api -X PATCH repos/HoffmanEngineering/3d-print-log-app \
  -f has_issues=true \
  -F has_wiki=false \
  -F has_projects=true \
  -F allow_squash_merge=true \
  -F allow_merge_commit=true \
  -F allow_rebase_merge=true \
  -F delete_branch_on_merge=false
```

- [ ] **Step 2: Set topics**

```bash
gh api -X PUT repos/HoffmanEngineering/3d-print-log-app/topics \
  -f "names[]=3d-printing" \
  -f "names[]=3d-printer" \
  -f "names[]=cordova" \
  -f "names[]=android" \
  -f "names[]=hybrid-app" \
  -f "names[]=mobile" \
  -f "names[]=auth0" \
  -f "names[]=print-tracker" \
  -f "names[]=maker" \
  -f "names[]=open-source"
```

- [ ] **Step 3: Create the `production` environment with reviewer and branch policies**

Both siblings gate `production` behind a required reviewer and restrict it to `main` plus `v*` tags. Replicate that exactly. `ChristopherHoffman` is user id `19898400`.

```bash
gh api -X PUT repos/HoffmanEngineering/3d-print-log-app/environments/production \
  --input - <<'JSON'
{
  "prevent_self_review": false,
  "reviewers": [
    { "type": "User", "id": 19898400 }
  ],
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
JSON
```

Then add the two allowed refs. Without the `v*` tag policy, the release workflow refuses to start on a tag — the environment would reject the deployment ref.

```bash
gh api -X POST repos/HoffmanEngineering/3d-print-log-app/environments/production/deployment-branch-policies \
  -f name='main' -f type='branch'
gh api -X POST repos/HoffmanEngineering/3d-print-log-app/environments/production/deployment-branch-policies \
  -f name='v*' -f type='tag'
```

Verify:

```bash
gh api repos/HoffmanEngineering/3d-print-log-app/environments \
  --jq '.environments[] | {name, rules:[.protection_rules[].type]}'
gh api repos/HoffmanEngineering/3d-print-log-app/environments/production/deployment-branch-policies \
  --jq '.branch_policies[] | "\(.type) \(.name)"'
```

Expected: `production` with `branch_policy` and `required_reviewers`; policies `branch main` and `tag v*`.

**Consequence to expect in Task 13:** `required_reviewers` means every tagged release *pauses* and waits for manual approval before the signing steps run. This is deliberate — it is a human gate in front of the signing key — but it means the release run will sit at "Waiting" until approved. `prevent_self_review: false` matches the siblings and lets the maintainer approve their own release.

- [ ] **Step 4: USER ACTION — add the four signing secrets**

This step cannot be automated: it requires the keystore file and its passwords, which are deliberately not available to any agent. Hand these commands to the user:

```bash
# From a directory containing the keystore. Base64 with no line wrapping:
base64 -w0 D:/Development/3d-print-log/AndroidKeyStore/3DPrintLogKeyStore.jks > keystore.b64

gh secret set ANDROID_KEYSTORE_BASE64 --env production \
  --repo HoffmanEngineering/3d-print-log-app < keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --env production --repo HoffmanEngineering/3d-print-log-app
gh secret set ANDROID_KEY_ALIAS        --env production --repo HoffmanEngineering/3d-print-log-app
gh secret set ANDROID_KEY_PASSWORD     --env production --repo HoffmanEngineering/3d-print-log-app

rm keystore.b64   # do not leave this lying around
```

The alias is `HoffmanUpload`; the two passwords are the `storePassword` and `password` values from the local `build.json`. `base64 -w0` matters — wrapped base64 fails to decode in the workflow.

Verify the names landed (values are never readable back):

```bash
gh secret list --env production --repo HoffmanEngineering/3d-print-log-app
```

Expected: all four names present.

- [ ] **Step 5: Confirm CI has run at least once**

```bash
gh run list --repo HoffmanEngineering/3d-print-log-app --workflow=ci.yml --limit 3
```

Expected: at least one completed run, ideally `success`.

Step 6 configures no required status check (matching the siblings), so a red CI does not strictly block it. Fix it anyway before continuing: the rulesets in Step 6 require a PR with an approving review for all non-admin changes, which makes fixing a broken workflow measurably more tedious afterwards. If CI failed for an environment reason — a missing Android SDK component on the runner — fix `ci.yml` and push a follow-up commit now.

- [ ] **Step 6: Apply the branch and tag rulesets**

The siblings use **rulesets**, not classic branch protection. Querying `/branches/main/protection` on them returns 404, which is an artifact of the legacy endpoint and not an absence of protection — do not conclude from a 404 that a repo is unprotected.

Replicate both sibling rulesets verbatim, including the bypass actor. `actor_id: 5` with `actor_type: RepositoryRole` is the admin role; `bypass_mode: always` is what lets the maintainer push and merge without self-approval ceremony while the rules still bind contributors.

Branch ruleset, targeting the default branch:

```bash
gh api -X POST repos/HoffmanEngineering/3d-print-log-app/rulesets \
  --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    }
  ]
}
JSON
```

Tag ruleset, targeting all tags:

```bash
gh api -X POST repos/HoffmanEngineering/3d-print-log-app/rulesets \
  --input - <<'JSON'
{
  "name": "All Tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "conditions": {
    "ref_name": { "include": ["~ALL"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "creation" },
    { "type": "update" }
  ]
}
JSON
```

Two ordering notes:

- The tag ruleset blocks tag **creation**. `v1.1.6` was already pushed in Task 11, before this ruleset existed, so it is unaffected. The `v1.1.7-rc1` test tag in Task 13 is created *after* this ruleset — that works only via the admin bypass. If tag creation is ever rejected, the bypass actor is missing or wrong, not the tag.
- No required status check is configured, matching both siblings. `ci.yml` still runs on every PR and its result is visible; it simply is not a hard merge gate. This is a deliberate parity decision — if you want CI to block merges here, add a `required_status_checks` rule with `{"context": "build"}` to the branch ruleset, but only after CI has reported at least once, since a check that has never run blocks every merge including the fix.

- [ ] **Step 7: Verify the configuration**

```bash
gh api repos/HoffmanEngineering/3d-print-log-app --jq '{description,topics,has_issues,has_wiki,has_projects,delete_branch_on_merge}'
gh api repos/HoffmanEngineering/3d-print-log-app/rulesets --jq '.[] | "\(.target) \(.name) \(.enforcement)"'
gh api repos/HoffmanEngineering/3d-print-log-app/rules/branches/main --jq '[.[].type]'
gh secret list --env production --repo HoffmanEngineering/3d-print-log-app
```

Expected: two active rulesets (`branch main`, `tag All Tags`); the branch rules listing `deletion`, `non_fast_forward`, `pull_request`; four secrets listed.

Compare against the sibling to confirm parity:

```bash
diff <(gh api repos/HoffmanEngineering/3d-print-log-ui/rules/branches/main --jq '[.[].type]|sort') \
     <(gh api repos/HoffmanEngineering/3d-print-log-app/rules/branches/main --jq '[.[].type]|sort') \
  && echo "branch rules match the UI repo"
```

Also open the repo's Insights → Community Standards page and confirm every item is checked (README, Code of Conduct, Contributing, License, Security policy, issue and PR templates).

---

## Task 13: Prove the release path, then clean up

Without this task the migration can be declared complete while the release pipeline has never run once. Everything before this is unproven.

**Files:** none — remote operations only.

**Interfaces:**
- Consumes: the `production` environment and secrets from Task 12; the fingerprint recorded in Task 10 Step 3
- Produces: a verified signed-release path, and a clean scratchpad

- [ ] **Step 1: Tag a release candidate**

```bash
cd D:/Development/3d-print-log/print-log-app
git tag v1.1.7-rc1
git push origin v1.1.7-rc1
```

- [ ] **Step 2: Approve the pending deployment**

The `production` environment has a required reviewer (Task 12 Step 3), so the run does **not** start executing — it sits at "Waiting" until approved. This is expected, not a hang.

```bash
RUN_ID=$(gh run list --repo HoffmanEngineering/3d-print-log-app --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Run: $RUN_ID"
gh api repos/HoffmanEngineering/3d-print-log-app/actions/runs/$RUN_ID/pending_deployments \
  --jq '.[] | {env:.environment.name, waiting:.current_user_can_approve}'
```

Expected: `production` with `waiting: true`. Approve it — either in the browser via the run's "Review deployments" button, or:

```bash
ENV_ID=$(gh api repos/HoffmanEngineering/3d-print-log-app/environments/production --jq '.id')
gh api -X POST repos/HoffmanEngineering/3d-print-log-app/actions/runs/$RUN_ID/pending_deployments \
  -F "environment_ids[]=$ENV_ID" -f state=approved -f comment='release path verification'
```

- [ ] **Step 3: Watch the release run**

```bash
gh run watch --repo HoffmanEngineering/3d-print-log-app "$RUN_ID"
```

Expected: all steps succeed, including `Verify the bundle was signed`.

Common first-run failures and their causes:

| Failure | Cause |
|---|---|
| Run never leaves "Waiting" | Pending deployment not approved — see Step 2 |
| Run rejected before starting, ref not permitted | The `v*` **tag** deployment-branch-policy is missing from `production` (Task 12 Step 3) |
| Tag push itself rejected | The `All Tags` ruleset blocks creation and the admin bypass actor is missing (Task 12 Step 6) |
| `Resource not accessible by integration` at the release step | `permissions: contents: write` missing or overridden by an org default |
| `base64: invalid input` | Secret created without `-w0` (wrapped base64) |
| `Environment 'production' not found` | Task 12 Step 3 skipped |
| Signature verification step fails | Wrong alias or password — `build.json` was written but Cordova fell back to unsigned |

- [ ] **Step 4: Verify the published artifact is signed with the expected key**

```bash
gh release download v1.1.7-rc1 --repo HoffmanEngineering/3d-print-log-app --pattern '*.aab' --dir /tmp/relcheck
ls -la /tmp/relcheck
keytool -printcert -jarfile /tmp/relcheck/*.aab | grep -A2 'SHA256:'
```

Expected: the SHA-256 fingerprint matches the one recorded in Task 10 Step 3. **A mismatch means the CI-signed artifact would be rejected by Play Store** — investigate before shipping any real release.

- [ ] **Step 5: Delete the test release and tag**

```bash
gh release delete v1.1.7-rc1 --repo HoffmanEngineering/3d-print-log-app --yes --cleanup-tag
git tag -d v1.1.7-rc1
rm -rf /tmp/relcheck
gh release list --repo HoffmanEngineering/3d-print-log-app
```

Expected: no `v1.1.7-rc1` release or tag remaining.

- [ ] **Step 6: Delete the secret-bearing backup**

The mirror backup deliberately retains the leaked credential and must not outlive the migration.

```bash
SCRATCH="C:/Users/CHRIST~1/AppData/Local/Temp/claude/D--Development-3d-print-log-print-log-app/c737cb7f-e6a5-40c7-a46f-855a356db7b2/scratchpad"
rm -rf "$SCRATCH/print-log-app-backup.git"
rm -f "$SCRATCH/secrets.txt" "$SCRATCH/pre-migration-inventory.txt"
rm -f "$SCRATCH"/stash*.patch
ls "$SCRATCH"
```

Only do this once Steps 1–5 have passed. Until then, the backup is the restore path.

- [ ] **Step 7: Update `CLAUDE.md`**

The project instructions still describe an Azure-hosted repo. Update the Build Notes and iOS sections to say: the repository is at `github.com/HoffmanEngineering/3d-print-log-app`; CI is GitHub Actions (`ci.yml`, `release.yml`); releases are cut by pushing a `v*` tag; and `azure-pipelines-ios.yml` plus `ios-build-guide.md` are unimplemented design artifacts.

```bash
cd D:/Development/3d-print-log/print-log-app
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for GitHub migration"
git push origin main
```

- [ ] **Step 8: USER ACTION — archive the Azure DevOps repository**

Left to the user by design. Until it is archived it remains the only record of the Azure PR discussions and work-item links, which this migration explicitly does not carry over. Retrieve anything wanted from there first, then archive rather than delete.

---

## Post-migration state

- `github.com/HoffmanEngineering/3d-print-log-app` public, with `main` (20 commits, scrubbed) and tag `v1.1.6`
- Zero occurrences of the leaked credential at object level; GitHub secret scanning clean
- CI green on every push and PR, producing a sideloadable debug APK
- A signed-AAB release path proven end-to-end against the real Play Store upload key
- No remote pointing at Azure DevOps; no secret-bearing backup on disk
- iOS artifacts retained, clearly labelled unimplemented
