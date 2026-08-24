#!/usr/bin/env node

/**
 * Cordova before_compile hook
 * Patches the generated MainActivity so Android predictive-back gestures
 * navigate WebView history before falling through to the system exit action.
 */

const fs = require('fs');
const path = require('path');

module.exports = function (context) {
    if (!context.opts.platforms.includes('android')) {
        return;
    }

    const filePath = path.join(
        context.opts.projectRoot,
        'platforms', 'android', 'app', 'src', 'main', 'java',
        'com', 'hoffmanengineering', 'printlog',
        'MainActivity.java'
    );

    if (!fs.existsSync(filePath)) {
        return;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    const marker = '// PrintLog predictive back navigation';

    if (content.includes(marker)) {
        return;
    }

    const importAnchor = 'import android.os.Bundle;';
    const onCreateAnchor = '        super.onCreate(savedInstanceState);';

    if (!content.includes(importAnchor) || !content.includes(onCreateAnchor)) {
        throw new Error('Could not patch MainActivity.java for predictive back navigation');
    }

    content = content.replace(
        importAnchor,
        `${importAnchor}\n\nimport androidx.activity.OnBackPressedCallback;`
    );

    const callback = [
        onCreateAnchor,
        '',
        `        ${marker}`,
        '        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {',
        '            @Override',
        '            public void handleOnBackPressed() {',
        '                if (appView != null && appView.canGoBack()) {',
        '                    appView.backHistory();',
        '                    return;',
        '                }',
        '',
        '                setEnabled(false);',
        '                try {',
        '                    getOnBackPressedDispatcher().onBackPressed();',
        '                } finally {',
        '                    setEnabled(true);',
        '                }',
        '            }',
        '        });'
    ].join('\n');

    content = content.replace(onCreateAnchor, callback);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Patched MainActivity.java with predictive back navigation');
};
