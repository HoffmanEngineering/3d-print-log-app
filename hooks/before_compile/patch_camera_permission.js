#!/usr/bin/env node

/**
 * Cordova before_compile hook
 * Patches SystemWebChromeClient.java to request the CAMERA runtime permission
 * on demand when a web page requests camera access via getUserMedia().
 *
 * Without this patch, the WebView auto-grants the web permission but the
 * Android runtime permission is never requested, causing camera access to fail.
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

    // Skip if already patched
    if (content.includes('ContextCompat.checkSelfPermission')) {
        return;
    }

    // Add ContextCompat import
    content = content.replace(
        'import androidx.core.content.FileProvider;',
        'import androidx.core.content.ContextCompat;\nimport androidx.core.content.FileProvider;'
    );

    // Replace onPermissionRequest to check runtime permission before granting
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

    if (!content.includes(original)) {
        console.warn('WARN: Could not find expected onPermissionRequest in SystemWebChromeClient.java - skipping patch');
        return;
    }

    content = content.replace(original, patched);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Patched SystemWebChromeClient.java with camera runtime permission request');
};
