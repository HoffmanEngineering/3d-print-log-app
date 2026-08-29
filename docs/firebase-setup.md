# Firebase setup for push notifications

One-time setup. Push notifications do not work at all until every step here is done, and
each step fails quietly rather than loudly — a missing credential degrades push and nothing
else, by design. That makes this checklist the only thing standing between "deployed" and
"actually works".

There are two halves and they use **different credentials**:

| Half | Credential | Lives in |
| --- | --- | --- |
| Client — the app receives pushes | `google-services.json` | this repo (gitignored) + CI secrets |
| Server — the API sends pushes | service account JSON | Azure App Service config |

Do not mix them up. `google-services.json` is client config and is safe on a device;
the service account key is a real secret that can send push to every one of your users.

---

## 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**.
2. Name it something recognisable (e.g. `3d-print-log`). Google Analytics is optional and
   not used by this integration.

If a project already exists for 3D Print Log, use it — do not create a second one. Tokens
are scoped to a project, so a second project silently invalidates every registration made
against the first.

## 2. Register the Android app

1. In the project, **Add app → Android**.
2. **Android package name:** `com.hoffmanengineering.printlog`

   This must match `id` in `config.xml` exactly. A mismatch produces a `google-services.json`
   the Gradle plugin rejects at build time, so at least this one fails loudly.
3. Nickname and debug signing SHA-1 can both be skipped. **SHA-1 is not required for FCM** —
   it is only needed for Google Sign-In, Dynamic Links, and App Check, none of which this
   integration uses.
4. Download **`google-services.json`**.

## 3. Client credential — `google-services.json`

### Local builds

Put the downloaded file at the repo root:

```
3d-print-log-app/google-services.json
```

It is gitignored (`.gitignore`, "Firebase Android config"). Without it the Android build
fails at `:app:processDebugGoogleServices` — this is the one part of the setup that does
fail loudly.

### CI and release builds

Both workflows reconstruct the file at run time from a base64 secret, exactly the way
`build.json` is handled.

```bash
# from the repo root, with google-services.json in place
base64 -w0 google-services.json          # Linux
base64 -i google-services.json           # macOS
certutil -encode google-services.json - | findstr /v CERTIFICATE   # Windows
```

Add the output as `GOOGLE_SERVICES_JSON_BASE64` in **two** places:

| Where | Used by | Path in GitHub |
| --- | --- | --- |
| Repository secret | `.github/workflows/ci.yml` | Settings → Secrets and variables → Actions → **Secrets** |
| `production` environment secret | `.github/workflows/release.yml` | Settings → Environments → `production` → **Environment secrets** |

The release job runs in the `production` environment, which does not inherit repository
secrets — it needs its own copy. Miss this and CI goes green while the release build fails.

> **Until this secret exists, CI on any branch carrying the push plugin fails at the
> Android build step.** That is expected, not a regression.

## 4. Server credential — the service account key

This is what lets the API call FCM.

1. Firebase console → **⚙ Project settings → Service accounts**.
2. **Generate new private key** → confirm. A JSON file downloads. **This is a secret.**
   Treat it like the keystore: never commit it, never paste it into an issue.
3. In the Azure portal, open the API's App Service → **Settings → Environment variables →
   App settings**, and add:

   | Name | Value |
   | --- | --- |
   | `Push__Enabled` | `true` |
   | `Push__ServiceAccountJson` | the entire contents of the JSON file, on one line |

   **Double underscore, not a colon.** The API runs on Linux App Service, where `:` is not
   valid in an environment variable name; `Push__ServiceAccountJson` is how .NET binds the
   nested `Push:ServiceAccountJson` configuration key there.

   The remaining `PushOptions` settings — `ChannelId`, `TimeToLiveHours`,
   `SendTimeoutSeconds` — have working defaults and only need setting to override them.

4. Save and let the app restart.

### Why the API will not crash if you get this wrong

`Startup` parses the credential at startup and, if it is malformed, logs to stderr, registers
`NoOpFcmClient`, and carries on. Push is an optional transport: a bad Firebase credential
must degrade push alone, never take printing, login and the website down with it.

The cost of that choice is that a typo here is **silent**, which is what step 5 is for.

## 5. Verify

**Server:**

```bash
curl -s https://api.3dprintlog.com/health/ready | jq
```

The `push` check reports `Healthy` once credentials parse, and `Degraded` while push is
disabled or misconfigured. Degraded still returns HTTP 200 — again, push must not make the
API look dead — so read the body, not the status code.

**Client:** build and install a debug APK, log in, and confirm a row appears in
`DeviceTokens` for your user. Then work through the manual delivery checklist (Task 18 of
the push notifications plan): CI cannot exercise FCM delivery, so a green CI is not evidence
this feature works.

## Rotating the service account key

Generating a new private key does not revoke the old one. Update
`Push__ServiceAccountJson`, confirm `/health/ready` still reports `push: Healthy`, and only
then delete the old key from **Google Cloud console → IAM & Admin → Service accounts →
`firebase-adminsdk-…` → Keys**.

## What is *not* needed

- **SHA-1 / SHA-256 fingerprints** — FCM does not use them.
- **A separate Firebase project per environment** — one project is fine; tokens are per
  installation, and a device only ever registers against the API it is pointed at.
- **Enabling the FCM v1 API by hand** — it is on by default for projects created since 2023.
  If sends fail with `SENDER_ID_MISMATCH` or a 403 mentioning the API, check
  **Google Cloud console → APIs & Services** for *Firebase Cloud Messaging API*.
- **APNs keys** — iOS has never been built or shipped in this repo.
