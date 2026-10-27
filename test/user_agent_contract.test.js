const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, '..', 'scripts', 'check-user-agent-contract.mjs');

const ANDROID = 'Mozilla/5.0 Google PrintLog/1.2';
const IOS = 'Mozilla/5.0 Google PrintLog-iOS/1.0';

/** Mirrors the real config.xml's layout: the iOS block sits above the global preference. */
function configXml({ ios = IOS, android = ANDROID, extra = '' } = {}) {
    return `<?xml version='1.0' encoding='utf-8'?>
<widget id="com.example" version="1.0.0" xmlns="http://www.w3.org/ns/widgets">
    <platform name="android">
        <preference name="AndroidXEnabled" value="true" />
    </platform>
    <platform name="ios">
        ${ios ? `<preference name="OverrideUserAgent" value="${ios}" />` : ''}
    </platform>
    ${extra}
    <preference name="OverrideUserAgent" value="${android}" />
</widget>
`;
}

function platformTs({ android = ANDROID, ios = IOS } = {}) {
    return `export const CORDOVA_USER_AGENT = '${android}';
export const CORDOVA_IOS_USER_AGENT = '${ios}';
`;
}

/** Runs the real script against fixture files, never the repo's own config or a UI checkout. */
function check({ config = configXml(), ui = platformTs() } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-contract-'));
    try {
        const configPath = path.join(dir, 'config.xml');
        fs.writeFileSync(configPath, config);
        const uiRoot = path.join(dir, 'ui');
        if (ui !== null) {
            const utils = path.join(uiRoot, 'src', 'app', 'core', 'utils');
            fs.mkdirSync(utils, { recursive: true });
            fs.writeFileSync(path.join(utils, 'platform.ts'), ui);
        }
        const result = spawnSync(process.execPath, [script], {
            env: {
                ...process.env,
                PRINT_LOG_CONFIG_XML: configPath,
                PRINT_LOG_UI_PATH: uiRoot
            },
            encoding: 'utf8'
        });
        return { status: result.status, output: result.stdout + result.stderr };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('passes when both platforms match their UI constants', () => {
    const { status, output } = check();
    assert.equal(status, 0, output);
});

test('reads the iOS value from its block even though that block comes first', () => {
    // A first-match parser would compare the iOS string against CORDOVA_USER_AGENT.
    const { status, output } = check();
    assert.equal(status, 0, output);
    assert.match(output, /Android pins "Mozilla\/5\.0 Google PrintLog\/1\.2"/);
    assert.match(output, /iOS pins "Mozilla\/5\.0 Google PrintLog-iOS\/1\.0"/);
});

test('fails when the iOS user agent drifts from the UI', () => {
    const { status, output } = check({ config: configXml({ ios: 'Mozilla/5.0 Google PrintLog-iOS/1.1' }) });
    assert.equal(status, 1);
    assert.match(output, /iOS:/);
    assert.match(output, /CORDOVA_IOS_USER_AGENT/);
});

test('fails when the Android user agent drifts from the UI', () => {
    const { status, output } = check({ ui: platformTs({ android: 'Mozilla/5.0 Google PrintLog/1.3' }) });
    assert.equal(status, 1);
    assert.match(output, /Android:/);
});

test('fails when iOS has no override and would inherit the Android string', () => {
    const { status, output } = check({ config: configXml({ ios: null }) });
    assert.equal(status, 1);
    assert.match(output, /cannot tell the shells apart/);
});

test('fails when the UI predates the iOS constant', () => {
    const { status, output } = check({ ui: `export const CORDOVA_USER_AGENT = '${ANDROID}';\n` });
    assert.equal(status, 1);
    assert.match(output, /no CORDOVA_IOS_USER_AGENT constant/);
});

test('ignores a preference quoted in an XML comment', () => {
    const extra = '<!-- was: <preference name="OverrideUserAgent" value="old" /> -->';
    const { status, output } = check({ config: configXml({ extra }) });
    assert.equal(status, 0, output);
});

test('skips without failing when the UI checkout is absent', () => {
    const { status, output } = check({ ui: null });
    assert.equal(status, 0, output);
    assert.match(output, /skipped/);
});

test('ignores a commented-out override inside the iOS block', () => {
    const config = configXml().replace(
        '<platform name="ios">',
        '<platform name="ios">\n        <!-- <preference name="OverrideUserAgent" value="old" /> -->'
    );
    const { status, output } = check({ config });
    assert.equal(status, 0, output);
});

test('fails on two overrides in the same scope', () => {
    const extra = `<preference name="OverrideUserAgent" value="${ANDROID}" />`;
    const { status, output } = check({ config: configXml({ extra }) });
    assert.equal(status, 1);
    assert.match(output, /more than one OverrideUserAgent in the same scope/);
});
