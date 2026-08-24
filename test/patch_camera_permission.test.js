const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const patchCameraPermission = require('../hooks/before_compile/patch_camera_permission');

test('patches file capture without replacing Cordova 15.1 getUserMedia permission handling', (t) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'print-log-camera-hook-'));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const javaPath = path.join(
        projectRoot,
        'platforms', 'android', 'CordovaLib', 'src',
        'org', 'apache', 'cordova', 'engine',
        'SystemWebChromeClient.java'
    );
    fs.mkdirSync(path.dirname(javaPath), { recursive: true });
    fs.writeFileSync(javaPath, [
        'import androidx.core.content.FileProvider;',
        '',
        'public class SystemWebChromeClient {',
        '    @Override',
        '    public boolean onShowFileChooser(WebView webView, final ValueCallback<Uri[]> filePathsCallback,',
        '            final WebChromeClient.FileChooserParams fileChooserParams) {',
        '        if (fileChooserParams.isCaptureEnabled()) {',
        '            captureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);',
        '        }',
        '        return true;',
        '    }',
        '',
        '    @Override',
        '    public void onPermissionRequest(final PermissionRequest request) {',
        '        List<String> permissionList = new ArrayList<>();',
        '        String[] permissions = permissionList.toArray(new String[0]);',
        '        permissionLauncher.launch(permissions);',
        '    }',
        '}'
    ].join('\n'), 'utf8');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    t.after(() => { console.warn = originalWarn; });

    patchCameraPermission({
        opts: {
            platforms: ['android'],
            projectRoot
        }
    });

    const patched = fs.readFileSync(javaPath, 'utf8');
    assert.deepEqual(warnings, []);
    assert.match(patched, /private boolean showFileChooserImpl/);
    assert.match(patched, /allowCapture && fileChooserParams\.isCaptureEnabled\(\)/);
    assert.match(patched, /ContextCompat\.checkSelfPermission\(parentEngine\.getView\(\)\.getContext\(\),/);
    assert.doesNotMatch(patched, /\bappContext\b/);
    assert.match(patched, /permissionLauncher\.launch\(permissions\)/);
});
