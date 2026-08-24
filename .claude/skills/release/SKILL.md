---
name: release
description: Cut a release of the 3D Print Log Android app - bump the version in all three files, commit, tag, and push so the release workflow builds a signed AAB. Use when the user says /release, "cut a release", "ship a new version", or "bump the version".
---

# Cut a release

Bumps the app version, tags it, and pushes so `.github/workflows/release.yml`
builds a signed `.aab` and attaches it to a GitHub Release.

**Argument:** `major`, `minor`, or `patch`. Defaults to `patch` if omitted.

## What you need to know first

**`config.xml` is authoritative.** Cordova derives the Android `versionCode`
from the `<widget version>` attribute as `major*10000 + minor*100 + patch`, and
writes it into `AndroidManifest.xml` at build time. `1.1.6` becomes `10106`.
There is no separate version code to maintain — but it also means **minor and
patch must each stay below 100**, or the arithmetic collides with the next
digit up. Refuse the bump rather than produce a colliding code.

Play rejects an upload whose `versionCode` is not greater than the last one, so
a version that goes backwards is a real failure, not a cosmetic one.

**Three files carry the version.** All three must move together:

| File | What to change |
|---|---|
| `config.xml` | the `version` attribute on `<widget>` — the one that matters |
| `package.json` | the top-level `"version"` field |
| `CLAUDE.md` | the `**Version:**` line in the Project Overview |

Do **not** touch the `e.g. 1.1.6` placeholder in
`.github/ISSUE_TEMPLATE/bug-report.yml` — it is an example, not a version.

## Steps

### 1. Refuse to run unless the repo is ready

```bash
set -euo pipefail
cd D:/Development/3d-print-log/print-log-app
[ "$(git branch --show-current)" = "main" ] || { echo "not on main"; exit 1; }
[ -z "$(git status --porcelain | grep -v '^?? ' || true)" ] || { echo "uncommitted changes"; exit 1; }
git fetch origin --quiet
[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] || { echo "main and origin/main differ - pull or push first"; exit 1; }
echo "ready"
```

Stop and report if any check fails. Do not offer to force past them.

### 2. Compute the new version and confirm it with the user

Read the current version from `config.xml`, apply the bump, and check the
guards. Show the user this before changing anything:

```
1.1.6 -> 1.1.7   (versionCode 10106 -> 10107)
```

Refuse if the resulting minor or patch would reach 100, and say why.

Also confirm the tag is free — a colliding tag means this version already
shipped:

```bash
git ls-remote --tags origin | grep -q "refs/tags/vNEW" && { echo "tag already exists"; exit 1; }
```

Wait for the user to confirm the numbers before proceeding.

### 3. Edit the three files

Change only the version in each — no reformatting. In `config.xml` target the
`version="..."` attribute on the `<widget>` element specifically; the file's
first line is an XML declaration that also contains `version=`, and a careless
replacement will corrupt it.

Then sync the lockfile:

```bash
npm install --package-lock-only
```

### 4. Verify before committing

```bash
grep -n 'version=' config.xml | head -2
grep -n '"version"' package.json
grep -n '\*\*Version:\*\*' CLAUDE.md
git diff --stat
```

All three must show the new version, and the diff should touch exactly
`config.xml`, `package.json`, `package-lock.json`, and `CLAUDE.md`. Anything
else in the diff means something went wrong — stop.

### 5. Commit, tag, push

```bash
git add config.xml package.json package-lock.json CLAUDE.md
git commit -m "chore: release vNEW"
git tag vNEW
git push origin main
git push origin vNEW
```

The branch ruleset requires a PR for non-admins; as the maintainer you bypass
it. Tag creation is likewise blocked for non-admins and allowed by bypass.

### 6. Tell the user to approve the deployment

**This is the step people forget.** The release job runs in the `production`
environment, which has a required reviewer, so it stops at "Waiting" and does
nothing until approved. It is not stuck.

```bash
gh run list --repo HoffmanEngineering/3d-print-log-app --workflow=release.yml --limit 1
```

Give them the run URL and say plainly that it is waiting for their approval.
Offer to approve it via the API if they would rather not click through:

```bash
RUN_ID=<from above>
ENV_ID=$(gh api repos/HoffmanEngineering/3d-print-log-app/environments/production --jq '.id')
gh api -X POST repos/HoffmanEngineering/3d-print-log-app/actions/runs/$RUN_ID/pending_deployments \
  -F "environment_ids[]=$ENV_ID" -f state=approved -f comment='release'
```

### 7. Report where to collect the artifact

Once the run is green, the signed `.aab` is attached to the GitHub Release for
the tag. Remind the user of the remaining manual step: download it and upload
to Play Console under Production or Internal testing.

## If the build fails

Check the failing step against these, in order of likelihood:

| Symptom | Cause |
|---|---|
| Run never leaves "Waiting" | Not approved — step 6 |
| `Resource not accessible by integration` | `permissions: contents: write` missing from the workflow |
| `base64: invalid input` | `ANDROID_KEYSTORE_BASE64` was set with wrapped base64; re-set it with `base64 -w0` |
| "bundle is not signed" | Wrong alias or password in the `production` secrets |
| Play rejects the upload | `versionCode` did not increase — check `config.xml` actually changed |

A failed release is recoverable: delete the tag and release
(`gh release delete vNEW --cleanup-tag`), fix, and re-run. Never reuse a
version number that already reached Play.
