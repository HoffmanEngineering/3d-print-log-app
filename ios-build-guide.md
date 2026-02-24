# iOS Platform Support — Implementation Guide

## Status

- **Phase 1: Configuration (Windows)** — Complete
- **Phase 2: macOS Setup** — Pending (requires Mac access + Apple Developer account)
- **Phase 3: CI/CD** — Pending
- **Phase 4: App Store Submission** — Pending

---

## Phase 2: macOS Setup (Requires Mac Access)

**Prerequisite**: Apple Developer Account enrolled ($99/year)

**Mac Access Options**:
- **Recommended**: Rent MacinCloud for 1 month (~$20) for initial setup
- **Alternative**: Borrow a friend's Mac for a few hours
- **Long-term**: Buy used Mac Mini ($200-400) if frequent iOS work expected

### Steps on macOS

1. **Install Xcode** (free from App Store, ~12GB)

2. **Add iOS Platform**:
   ```bash
   cd /path/to/print-log-app
   cordova platform add ios@7.1.1
   ```

3. **Get Apple Team ID**:
   - Visit developer.apple.com/account
   - Copy 10-character Team ID (e.g., A1B2C3D4E5)

4. **Create App ID**:
   - developer.apple.com → Identifiers → "+"
   - App ID: `com.printlog.app`
   - Capabilities: Associated Domains (for custom URL scheme)

5. **Generate Distribution Certificate**:
   - Xcode → Preferences → Accounts → Manage Certificates → "+"
   - Create "Apple Distribution" certificate
   - Export from Keychain Access as .p12 with password
   - Convert to base64:
     ```bash
     base64 -i distribution_cert.p12 | pbcopy
     ```

6. **Create Provisioning Profile**:
   - developer.apple.com → Profiles → "+"
   - Type: App Store, App ID: com.printlog.app
   - Download and convert to base64:
     ```bash
     base64 -i profile.mobileprovision | pbcopy
     ```

7. **Configure Azure Pipeline Variables**:
   - Azure DevOps → Pipelines → Edit Pipeline → Variables → Add:
     - `APPLE_TEAM_ID`: 10-char Team ID (mark as secret)
     - `IOS_DISTRIBUTION_CERT_P12_BASE64`: Base64 cert (mark as secret)
     - `IOS_DISTRIBUTION_CERT_PASSWORD`: P12 password (mark as secret)
     - `IOS_PROVISIONING_PROFILE_BASE64`: Base64 profile (mark as secret)

8. **Test Local Build**:
   ```bash
   npm run build:ios
   cordova run ios  # Test in Simulator
   ```

9. **Verify**:
   - App launches with splash screen
   - Redirects to https://www.3dprintlog.com
   - Status bar color is indigo (#3F50B5)

10. **Configure Auth0**:
    - Auth0 Dashboard → Application Settings
    - Add to Allowed Callback URLs: `com.printlog.app://`
    - Add to Allowed Logout URLs: `com.printlog.app://`

---

## Phase 3: CI/CD and Testing

1. **Setup Azure Pipeline**:
   - Azure DevOps → Pipelines → New Pipeline
   - Select Azure Repos Git → Your repo
   - Select "Existing Azure Pipelines YAML file"
   - Path: `/azure-pipelines-ios.yml`
   - Add variables (see Phase 2 step 7)

2. **Trigger Pipeline**:
   ```bash
   git push origin main
   ```

3. **Monitor Build**: Azure DevOps → Pipelines → Select pipeline → View run

4. **Download IPA**: Pipelines → Build run → Artifacts → ios-app

5. **Test IPA**: Upload to TestFlight for beta testing

---

## Phase 4: App Store Submission

1. **Create App in App Store Connect**:
   - appstoreconnect.apple.com → My Apps → "+"
   - Bundle ID: com.printlog.app
   - Add metadata: description, keywords, privacy policy URL

2. **Prepare Assets**:
   - Screenshots from iOS Simulator
   - 1024x1024 app icon (verify `www/img/logo.png` dimensions)

3. **Upload IPA**: Use Transporter app or Xcode Organizer

4. **Submit for Review**: Typical 24-48 hour review time

---

## Potential Issues and Solutions

### Auth0 Login Doesn't Work on iOS

**Symptom**: Auth0 opens in WKWebView instead of Safari, or Google login fails.

**Solution**:
- iOS WKWebView may work fine (test first)
- If needed, add `cordova-plugin-safariviewcontroller` for native OAuth flow
- Android uses Chrome Custom Tab hook; iOS equivalent is `SFSafariViewController` or `ASWebAuthenticationSession`

**Action**: Test in Phase 2 Simulator testing. Add plugin only if default behavior fails.

### Camera Permission Never Prompts

**Symptom**: QR scanning or file input with camera capture doesn't show permission dialog.

**Diagnosis**: Unlike Android, iOS WKWebView should auto-prompt when web page uses `getUserMedia()` or file input with `capture` attribute.

**Solution**:
- Verify `NSCameraUsageDescription` in config.xml (already configured)
- Test in Simulator with Safari Web Inspector
- Fallback: Add `cordova-plugin-camera` if needed

**Action**: Test in Phase 2. No preemptive changes needed.

### Azure Pipeline Build Fails with Signing Error

**Common Causes**:
- Wrong Team ID
- Certificate expired or wrong type
- Provisioning profile doesn't match App ID
- Base64 encoding/decoding issue

**Solution**:
- Verify Team ID is correct 10-character string
- Re-export certificate as .p12 from Keychain Access
- Ensure provisioning profile is "App Store" type for App ID `com.printlog.app`
- Test base64 encoding: `echo "$B64" | base64 --decode > test.p12` should create valid file

---

## Cost Breakdown

| Item | Cost | Frequency |
|------|------|-----------|
| Apple Developer Account | $99 | Annual |
| Cloud Mac (MacinCloud, 1 month) | ~$20 | One-time (optional) |
| Azure Pipelines (free tier) | $0 | 1800 min/mo (~120 builds) |
| **Total First Year** | **$99-119** | |
| **Ongoing Annual** | **$99** | |

---

## Verification Checklists

### Phase 2 (macOS)
- [ ] iOS platform added successfully (`cordova platform ls` shows ios)
- [ ] Local build succeeds: `npm run build:ios`
- [ ] App runs in iOS Simulator: `cordova run ios`
- [ ] Auth0 callback URLs configured
- [ ] All 4 Azure Pipeline secret variables created

### Phase 3 (CI/CD)
- [ ] Azure Pipeline created and configured with variables
- [ ] Pipeline runs without errors on push to main
- [ ] IPA artifact downloadable from pipeline artifacts
- [ ] IPA installable via TestFlight

### Phase 4 (App Store)
- [ ] App listing created in App Store Connect
- [ ] Metadata complete (description, screenshots, icon)
- [ ] IPA uploaded and processing complete
- [ ] Submitted for review
