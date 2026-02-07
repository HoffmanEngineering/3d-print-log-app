#!/usr/bin/env node

/**
 * Cordova before_compile hook
 * Patches SystemWebChromeClient.java to request the CAMERA runtime permission
 * on demand in two scenarios:
 *
 * 1. onPermissionRequest (WebRTC path) — when a web page requests camera
 *    access via getUserMedia() (e.g. QR scanning).
 *
 * 2. onShowFileChooser (file input path) — when a <input type="file" capture>
 *    triggers the Android file chooser with camera capture enabled.
 *
 * Without these patches the WebView auto-grants the web permission but never
 * triggers the Android runtime prompt, causing camera access to silently fail.
 */

const fs = require('fs');
const path = require('path');

module.exports = function (context) {
    const filePath = path.join(
        context.opts.projectRoot,
        'platforms', 'android', 'CordovaLib', 'src',
        'org', 'apache', 'cordova', 'engine',
        'SystemWebChromeClient.java'
    );

    if (!fs.existsSync(filePath)) {
        return;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // ── Import ContextCompat (needed by both patches) ──────────────────
    if (!content.includes('import androidx.core.content.ContextCompat;')) {
        content = content.replace(
            'import androidx.core.content.FileProvider;',
            'import androidx.core.content.ContextCompat;\nimport androidx.core.content.FileProvider;'
        );
        modified = true;
    }

    // ── Patch 1: onPermissionRequest (WebRTC / getUserMedia) ───────────
    if (!content.includes('needsCamera')) {
        const original = [
            '    @Override',
            '    public void onPermissionRequest(final PermissionRequest request) {',
            '        LOG.d(LOG_TAG, "onPermissionRequest: " + Arrays.toString(request.getResources()));',
            '        request.grant(request.getResources());',
            '    }'
        ].join('\n');

        const patched = [
            '    @Override',
            '    public void onPermissionRequest(final PermissionRequest request) {',
            '        LOG.d(LOG_TAG, "onPermissionRequest: " + Arrays.toString(request.getResources()));',
            '',
            '        boolean needsCamera = false;',
            '        for (String resource : request.getResources()) {',
            '            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {',
            '                needsCamera = true;',
            '                break;',
            '            }',
            '        }',
            '',
            '        if (needsCamera && ContextCompat.checkSelfPermission(appContext, android.Manifest.permission.CAMERA)',
            '                != PackageManager.PERMISSION_GRANTED) {',
            '            parentEngine.cordova.requestPermission(new CordovaPlugin() {',
            '                @Override',
            '                public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) {',
            '                    if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {',
            '                        request.grant(request.getResources());',
            '                    } else {',
            '                        request.deny();',
            '                    }',
            '                }',
            '            }, 0, android.Manifest.permission.CAMERA);',
            '        } else {',
            '            request.grant(request.getResources());',
            '        }',
            '    }'
        ].join('\n');

        if (content.includes(original)) {
            content = content.replace(original, patched);
            modified = true;
        } else {
            console.warn('WARN: Could not find expected onPermissionRequest — skipping that patch');
        }
    }

    // ── Patch 2: onShowFileChooser (file input with capture) ───────────
    // Wraps onShowFileChooser so that when capture is requested and CAMERA
    // permission is missing, the runtime prompt is shown first.  The original
    // method body is extracted into showFileChooserImpl(callback, params,
    // allowCapture).  If the user denies the permission the chooser still
    // opens but without the camera option (allowCapture = false).
    if (!content.includes('showFileChooserImpl')) {
        // Step 1 — guard the isCaptureEnabled() block with allowCapture
        const captureCheck = '        if (fileChooserParams.isCaptureEnabled()) {';
        const guardedCheck = '        if (allowCapture && fileChooserParams.isCaptureEnabled()) {';

        if (content.includes(captureCheck)) {
            content = content.replace(captureCheck, guardedCheck);
        } else {
            console.warn('WARN: Could not find isCaptureEnabled() check — skipping onShowFileChooser patch');
        }

        // Step 2 — replace method signature with wrapper + extracted helper
        const originalSig = [
            '    @Override',
            '    public boolean onShowFileChooser(WebView webView, final ValueCallback<Uri[]> filePathsCallback,',
            '            final WebChromeClient.FileChooserParams fileChooserParams) {'
        ].join('\n');

        const patchedSig = [
            '    @Override',
            '    public boolean onShowFileChooser(WebView webView, final ValueCallback<Uri[]> filePathsCallback,',
            '            final WebChromeClient.FileChooserParams fileChooserParams) {',
            '        if (fileChooserParams.isCaptureEnabled()',
            '                && ContextCompat.checkSelfPermission(appContext, android.Manifest.permission.CAMERA)',
            '                    != PackageManager.PERMISSION_GRANTED) {',
            '            parentEngine.cordova.requestPermission(new CordovaPlugin() {',
            '                @Override',
            '                public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) {',
            '                    boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;',
            '                    showFileChooserImpl(filePathsCallback, fileChooserParams, granted);',
            '                }',
            '            }, 0, android.Manifest.permission.CAMERA);',
            '            return true;',
            '        }',
            '        return showFileChooserImpl(filePathsCallback, fileChooserParams, true);',
            '    }',
            '',
            '    private boolean showFileChooserImpl(final ValueCallback<Uri[]> filePathsCallback,',
            '            final WebChromeClient.FileChooserParams fileChooserParams, boolean allowCapture) {'
        ].join('\n');

        if (content.includes(originalSig)) {
            content = content.replace(originalSig, patchedSig);
            modified = true;
        } else {
            console.warn('WARN: Could not find expected onShowFileChooser signature — skipping that patch');
        }
    }

    // ── Write back ─────────────────────────────────────────────────────
    if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('Patched SystemWebChromeClient.java with camera runtime permission requests');
    }
};
