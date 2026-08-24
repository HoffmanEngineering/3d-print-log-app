const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let patchBackNavigation = () => {};
try {
    patchBackNavigation = require('../hooks/before_compile/patch_back_navigation');
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') {
        throw error;
    }
}

test('patches MainActivity to navigate WebView history before exiting', (t) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'print-log-back-hook-'));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const javaPath = path.join(
        projectRoot,
        'platforms', 'android', 'app', 'src', 'main', 'java',
        'com', 'hoffmanengineering', 'printlog', 'MainActivity.java'
    );
    fs.mkdirSync(path.dirname(javaPath), { recursive: true });
    fs.writeFileSync(javaPath, [
        'package com.hoffmanengineering.printlog;',
        '',
        'import android.os.Bundle;',
        '',
        'import org.apache.cordova.*;',
        '',
        'public class MainActivity extends CordovaActivity',
        '{',
        '    @Override',
        '    public void onCreate(Bundle savedInstanceState)',
        '    {',
        '        super.onCreate(savedInstanceState);',
        '',
        '        loadUrl(launchUrl);',
        '    }',
        '}'
    ].join('\n'), 'utf8');

    const context = {
        opts: {
            platforms: ['android'],
            projectRoot
        }
    };

    patchBackNavigation(context);
    const patchedOnce = fs.readFileSync(javaPath, 'utf8');
    patchBackNavigation(context);
    const patchedTwice = fs.readFileSync(javaPath, 'utf8');

    assert.match(patchedOnce, /import androidx\.activity\.OnBackPressedCallback;/);
    assert.match(patchedOnce, /if \(appView != null && appView\.canGoBack\(\)\)/);
    assert.match(patchedOnce, /appView\.backHistory\(\);/);
    assert.match(patchedOnce, /setEnabled\(false\);/);
    assert.match(patchedOnce, /getOnBackPressedDispatcher\(\)\.onBackPressed\(\);/);
    assert.equal(patchedTwice, patchedOnce);
});
