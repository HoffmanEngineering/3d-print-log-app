#!/usr/bin/env node

/**
 * Cordova before_compile hook
 * Patches SystemWebViewClient.java to intercept Auth0 /authorize URLs and
 * open them in a Chrome Custom Tab instead of loading in the WebView.
 *
 * This enables the native Android account picker for Google login, rather
 * than forcing email/password entry in the WebView.
 *
 * Only /authorize URLs are intercepted — logout and other Auth0 URLs
 * continue to load in the WebView as before.
 */

const fs = require('fs');
const path = require('path');

module.exports = function (context) {
    const javaFilePath = path.join(
        context.opts.projectRoot,
        'platforms', 'android', 'CordovaLib', 'src',
        'org', 'apache', 'cordova', 'engine',
        'SystemWebViewClient.java'
    );

    if (!fs.existsSync(javaFilePath)) {
        return;
    }

    let content = fs.readFileSync(javaFilePath, 'utf8');

    // Skip if already patched
    if (content.includes('CustomTabsIntent')) {
        return;
    }

    // --- Patch CordovaLib build.gradle to add androidx.browser dependency ---
    const gradlePath = path.join(
        context.opts.projectRoot,
        'platforms', 'android', 'CordovaLib', 'build.gradle'
    );

    if (fs.existsSync(gradlePath)) {
        let gradle = fs.readFileSync(gradlePath, 'utf8');
        if (!gradle.includes('androidx.browser:browser')) {
            gradle = gradle.replace(
                'implementation "androidx.webkit:webkit:',
                'implementation "androidx.browser:browser:1.7.0"\n    implementation "androidx.webkit:webkit:'
            );
            fs.writeFileSync(gradlePath, gradle, 'utf8');
            console.log('Added androidx.browser dependency to CordovaLib build.gradle');
        }
    }

    // --- Patch SystemWebViewClient.java ---

    // Add CustomTabsIntent import
    content = content.replace(
        'import android.net.Uri;',
        'import android.net.Uri;\nimport androidx.browser.customtabs.CustomTabsIntent;'
    );

    // Patch shouldOverrideUrlLoading to intercept Auth0 authorize URLs
    const original = [
        '    @Override',
        '    @SuppressWarnings("deprecation")',
        '    public boolean shouldOverrideUrlLoading(WebView view, String url) {',
        '        return parentEngine.client.onNavigationAttempt(url);',
        '    }'
    ].join('\n');

    const patched = [
        '    @Override',
        '    @SuppressWarnings("deprecation")',
        '    public boolean shouldOverrideUrlLoading(WebView view, String url) {',
        '        if (url != null && url.contains("auth0.com/authorize")) {',
        '            CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder().build();',
        '            customTabsIntent.launchUrl(view.getContext(), Uri.parse(url));',
        '            return true;',
        '        }',
        '        return parentEngine.client.onNavigationAttempt(url);',
        '    }'
    ].join('\n');

    if (!content.includes(original)) {
        console.warn('WARN: Could not find expected shouldOverrideUrlLoading in SystemWebViewClient.java - skipping patch');
        return;
    }

    content = content.replace(original, patched);
    fs.writeFileSync(javaFilePath, content, 'utf8');
    console.log('Patched SystemWebViewClient.java with Chrome Custom Tab auth interception');
};
