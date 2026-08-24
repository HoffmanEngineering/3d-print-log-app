#!/usr/bin/env node

/**
 * Cordova before_compile hook
 * Patches SystemWebChromeClient.java so that <input type="file" capture>
 * requests the CAMERA runtime permission before opening the file chooser.
 *
 * Cordova Android 15.1 handles getUserMedia camera and microphone
 * permissions upstream, so this hook intentionally leaves
 * onPermissionRequest unchanged.
 */

const fs = require('fs');
const path = require('path');

module.exports = function (context) {
    // Skip if not building for Android
    if (!context.opts.platforms.includes('android')) {
        return;
    }

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

    // ── Import ContextCompat (needed by the file chooser patch) ─────────
    if (!content.includes('import androidx.core.content.ContextCompat;')) {
        content = content.replace(
            'import androidx.core.content.FileProvider;',
            'import androidx.core.content.ContextCompat;\nimport androidx.core.content.FileProvider;'
        );
        modified = true;
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
            '                && ContextCompat.checkSelfPermission(parentEngine.getView().getContext(), android.Manifest.permission.CAMERA)',
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
