# Design: Migrate print-log-app from Azure DevOps to public GitHub

Date: 2026-08-23
Status: Approved (revised after adversarial review)

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
| iOS | Never implemented. `azure-pipelines-ios.yml` and `ios-build-guide.md` are unimplemented design artifacts, retained as-is. No iOS CI existed to lose. |
| License | AGPL-3.0-only, matching `3d-print-log-ui`. |
| CI scope | Android CI on push/PR; signed Android AAB on tag. No iOS workflow. |
| Tag `v1.1.6` | Rewritten and pushed. Preserves release history; cannot trigger the release workflow (see Section 1). |
| Branch `UpdateAndroid13` | Deleted. Superseded — see Section 1 evidence. |

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
hygiene, not incident response. As cheap corroboration, the implementation
records the SHA-256 certificate fingerprint of the current
`3DPrintLogKeyStore.jks` via `keytool -list -v` and confirms it is the key
associated with current Play Store uploads.

### The credential hides where a ref-walk does not look

Measured on the pre-rewrite repository by enumerating blobs rather than counting
matched lines:

```
blobs containing the credential                      ->  8
of those, reachable only via refs/stash              ->  1
```

A `git log -p --all | grep` check does not surface that stash-only blob, so it
reports the repository clean while the credential is still in the object
database.

The mechanism is worth stating precisely, because the obvious explanation is
wrong. It is *not* that `--all` fails to traverse `refs/stash`; `git rev-list
--all` does reach it. It is that **stash entries are merge commits** — `git log
-1 --format=%p refs/stash` shows two parents — and `git log -p` suppresses diffs
for merge commits unless given `-m`, `-c`, or `--cc`. The blob is reachable; its
content is simply never printed.

Counting matched *lines* is also not comparable between the two methods: `git
log -p` re-prints the same blob once per diff it appears in, so its line count
can legitimately exceed the number of distinct blobs. Blob identity is the only
stable unit of measurement here.

Consequence: verification MUST enumerate objects, not walk refs. See Section 1
and Verification.

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
- The live keystore at `D:/Development/3d-print-log/AndroidKeyStore/` — a
  *sibling* of the repository, therefore already outside the working tree and not
  reachable by any `.gitignore` rule in this repo.

## Section 1: History scrub

### Ref inventory and disposition

Every ref is inventoried and given an explicit decision before rewriting.

| Ref | Disposition | Rationale |
|---|---|---|
| `refs/heads/main` | Rewrite, push | The trunk. 20 commits. |
| `refs/tags/v1.1.6` | Rewrite, push | Preserves release history. Safe — see below. |
| `refs/heads/chore/rename-app-id` | Delete | Merged into `main` (commit `1f881be`). |
| `refs/heads/feature/ios-platform-support` | Delete | Merged into `main`. |
| `refs/heads/UpdateAndroid13` | Delete | Unmerged, but superseded. See evidence below. |
| `refs/remotes/origin/*` | Delete | Azure remote is being dropped. |
| `refs/stash` (2 entries) | Delete before rewrite | Carry the leaked secret; WIP from 2022 with no ongoing value. |

**`UpdateAndroid13` supersession evidence.** The branch holds one unique commit,
`1cae47d "feat: update to android 13 (api 34)"`. Its entire diff against `main`
is `package.json` and `package-lock.json` — a bump to cordova-android for API 34.
`main` is already on cordova-android 14.0.1 targeting SDK 35. The branch is
strictly behind; nothing is lost by deleting it.

**Why pushing rewritten `v1.1.6` is safe.** For a tag `push` event, GitHub
resolves the workflow definition from the pushed ref itself. Rewritten `v1.1.6`
points at a commit that predates `.github/workflows/release.yml`, so the ref
contains no release workflow and no run is triggered. The tag is pushed *before*
the workflows are added regardless, as belt and braces.

### Procedure

1. Full mirror backup: `git clone --mirror . <scratchpad>/print-log-app-backup.git`
2. Validate the backup before touching the original: `git -C <backup> fsck` and
   confirm `git -C <backup> rev-list --count main` equals 20.
3. Drop the stashes: `git stash clear`
4. Delete the three obsolete branches and the `origin` remote-tracking refs.
5. Write `<scratchpad>/secrets.txt` containing `<leaked-string>==>***REMOVED***`
6. `git filter-repo --replace-text <scratchpad>/secrets.txt --force`
7. `git reflog expire --expire=now --all && git gc --prune=now --aggressive`
8. Object-level verification (see Verification section).

`filter-repo` removes the `origin` remote as a safety measure. This is desirable
here since the Azure remote is being dropped regardless.

All commit SHAs change. Any existing clone of the Azure repo becomes
incompatible; since the Azure repo is being retired, this is acceptable.

**Abort criterion.** If step 8 finds any occurrence of the leaked string, stop.
Do not create the GitHub repository and do not push. Restore from the mirror
backup and re-diagnose.

### Backup handling

The mirror backup deliberately retains the leaked credential, so it is a
secret-bearing artifact. It lives in the session scratchpad on local disk only,
is never uploaded anywhere, and is deleted once the migration is verified
complete. The credential is retired, which bounds the severity, but the backup is
not left lying around indefinitely.

## Section 2: Pre-push repo hygiene

`.gitignore` additions:

```
old-app-backup/
```

Note: an `AndroidKeyStore/` entry was considered and rejected as misleading. The
keystore lives at `D:/Development/3d-print-log/AndroidKeyStore/`, a sibling of
the repo root, so no in-repo ignore rule affects it. Adding the entry would imply
protection that does not exist.

`package.json` corrections (all currently hold Cordova scaffold defaults):

| Field | From | To |
|---|---|---|
| `version` | `1.0.0` | `1.1.6` (matches `config.xml`) |
| `description` | "A sample Apache Cordova application..." | The real app description from `config.xml` |
| `author` | `Apache Cordova Team` | `Hoffman Engineering` |
| `license` | `Apache-2.0` | `AGPL-3.0-only` |

`package.json` also gains the Cordova CLI as a pinned devDependency (see
Section 4, reproducibility).

`README.md` is currently four lines of scratch notes. It is rewritten as a public
README covering: what the app is and its relationship to the web UI, prerequisites
(Node 20, Android SDK 35, build-tools 35.0.0, JDK 17), build and run commands,
how release signing works and that `build.json` is intentionally absent, a note
that iOS is designed but unimplemented, a link to `3d-print-log-ui`, and a
license badge.

Node 20 is the single authoritative version: README, `ci.yml`, and `release.yml`
all state it. `azure-pipelines-ios.yml` says Node 18, but that pipeline was never
run and is retained only as a design artifact, so it is not a competing source of
truth.

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

### Licensing provenance

The project is relicensed AGPL-3.0-only to match `3d-print-log-ui`. The scaffold
files generated by `cordova create` (`www/js/index.js`, `www/css/index.css`,
`www/index.html`) carry upstream Apache-2.0 headers; those headers are left
intact and the `LICENSE` file notes that Cordova scaffold components remain under
Apache-2.0. All other source and the `www/img/` assets are Hoffman Engineering's
own work.

## Section 4: GitHub Actions

### Reproducible toolchain

The repo currently has no Cordova CLI in `devDependencies` — only
`cordova-android` and `cordova-ios` platform packages. A bare `npx cordova` in CI
would silently download whatever CLI version is current at build time. The CLI is
therefore added as a pinned devDependency and invoked via an npm script, so
`npm ci` resolves it from the lockfile.

### `.github/workflows/ci.yml`

Triggers on push and pull_request against `main`. Runs on `ubuntu-latest`.

```yaml
permissions:
  contents: read
```

Steps: checkout, setup-node 20 with npm cache, `npm ci`, add the Android
platform, build unsigned debug, then `actions/upload-artifact` with
`retention-days: 14` so PR builds can be sideloaded for review without
accumulating indefinitely.

The workflow uses no secrets, so the standard fork-PR secret restriction costs
nothing and fork PRs build normally.

No lint or test step: the repo has no test suite and `npm test` is the Cordova
scaffold's `exit 1` placeholder.

### `.github/workflows/release.yml`

Triggers on tags matching `v*`. Runs on `ubuntu-latest` with
`environment: production`.

```yaml
permissions:
  contents: write   # required for the release upload
```

Without an explicit `contents: write`, an org or repo default of a read-only
`GITHUB_TOKEN` breaks every tagged release.

Secrets are passed through step-level `env:` and referenced as quoted shell
variables. They are never interpolated into shell source: `${{ }}` substitution
happens before the shell parses the script, so a password containing
shell-significant characters would otherwise corrupt the command or be executed.

```yaml
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

- run: npm run release:android

- uses: softprops/action-gh-release@<full-40-char-sha>  # v2.x, SHA-pinned
  with:
    files: platforms/android/app/build/outputs/bundle/release/*.aab
```

The third-party release action is pinned to a full commit SHA rather than the
moving `v2` tag, because this job handles signing material and holds
`contents: write`. First-party `actions/*` steps stay on major tags.

A final `if: always()` step removes `keystore.jks` and `build.json`. On an
ephemeral runner this is hygiene rather than a security control — the real
controls are the least-privilege `permissions` block, `env:` secret transport,
and uploading only the `.aab` rather than any workspace directory.

Secrets the user must create (cannot be automated — requires the `.jks` in hand):
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. These are scoped to the `production` environment, not the
repository, so a workflow on an untrusted branch cannot reach them.

The existing `release:android` npm script already passes
`--buildConfig=build.json` and needs no modification: the local `build.json`
points at `../AndroidKeyStore/3DPrintLogKeyStore.jks` and the CI-generated one
points at `keystore.jks` in the workspace root. Both are valid for their context.

## Section 5: Repo creation and configuration

1. `gh repo create HoffmanEngineering/3d-print-log-app --public`
2. Push the rewritten `main`, then the rewritten `v1.1.6` tag.
3. Read `3d-print-log-ui`'s actual settings via `gh api` and match rather than
   assume. Expected: description set, topics
   (`cordova`, `android`, `3d-printing`, `hybrid-app`, `mobile`), issues enabled,
   wiki and projects disabled, squash-merge only, auto-delete merged branches.
4. Create the `production` environment and add the four signing secrets to it.
5. Branch protection on `main` — applied **after** CI has run at least once, so
   the required check exists by name. Requiring a status check that has never
   reported blocks all merges indefinitely. The required check is the job name
   `build` from `ci.yml`. Protection covers: require the check to pass, require a
   PR before merging, block force pushes, block deletion.

### Accepted losses

Azure DevOps pull request discussions, approvals, and work-item links are not
migrated. Only commit history and authorship carry over. This is accepted
deliberately rather than overlooked; the Azure repository remains readable until
the user archives it, which is the window to retrieve anything wanted.

## Verification

Before any push:

- **Object-level secret scan** — the gate that matters: enumerate every blob in
  the object database and confirm none contains the credential. A `git log -p
  --all` grep is NOT sufficient — it misses at least one stash-only blob (see
  Findings).
- `git stash list` is empty and `git for-each-ref` lists only `refs/heads/main`
  and `refs/tags/v1.1.6`.
- `git ls-files` matches no `build.json`, `.jks`, or `.p12`.
- `git status --porcelain` is clean, and `old-app-backup/` is confirmed absent
  from `git ls-files` (not merely hidden by the ignore rule).
- `npm run build:android` succeeds locally after the `package.json` edits.

After push:

- `ci.yml` goes green on `main`.
- GitHub's own secret scanning (enabled by default on public repos) reports
  nothing.
- The repo's public file listing contains no keystore or signing config.
- **Release path proven, not assumed:** tag a throwaway `v1.1.7-rc1`, confirm
  `release.yml` produces a signed `.aab` attached to a GitHub Release, and verify
  its signing certificate fingerprint matches the Play Store upload key via
  `keytool`/`apksigner`. Delete the test release and tag afterward. The migration
  is not complete until this passes — otherwise it can be declared successful
  with a release pipeline that has never run.
- Delete the scratchpad mirror backup.

## Out of scope

- Implementing iOS support, or porting the unimplemented iOS pipeline design to
  GitHub Actions
- Archiving or deleting the Azure DevOps repository (user action)
- Creating the four GitHub Actions secrets (user action)
- Migrating Azure PR/work-item history (explicitly accepted as lost, above)
- Any change to app functionality
