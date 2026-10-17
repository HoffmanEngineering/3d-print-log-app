const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { findJavac, compile, runJava } = require('./helpers/javac');

const pluginDir = path.join(__dirname, '..', 'plugins-local', 'cordova-plugin-printlog-native');
const javaDir = path.join(pluginDir, 'src', 'android');

const javac = findJavac();
let classesDir;

/** Compiles once, on first use. */
function ensureCompiled() {
    if (!classesDir) {
        classesDir = compile(['SpoolTagRules.java']);
    }
    return classesDir;
}

/** Runs SpoolTagRules.main: "<tech> <uid>" or "drop <reason>". */
function classify(hexId, ...techs) {
    return runJava(ensureCompiled(), 'SpoolTagRules', [hexId, ...techs]);
}

const NFCA = 'android.nfc.tech.NfcA';
const NFCV = 'android.nfc.tech.NfcV';
const ISO_DEP = 'android.nfc.tech.IsoDep';
const CLASSIC = 'android.nfc.tech.MifareClassic';

const skip = javac ? false : 'no javac (CI installs a JDK with setup-java)';

test('an ISO 15693 UID is reversed into the printed E0... order', { skip }, () => {
    // Android returns the UID least significant byte first.
    assert.equal(classify('8877665544332211', NFCV), 'nfcv 1122334455667788');
    assert.equal(classify('0DE7A1B2C3040AE0', NFCV), 'nfcv E00A04C3B2A1E70D');
});

test('an NFC-A UID keeps its byte order', { skip }, () => {
    assert.equal(classify('04A23F11223380', NFCA, CLASSIC), 'nfca 04A23F11223380');
});

test('NFC-V wins over NFC-A when a tag reports both', { skip }, () => {
    assert.equal(classify('0102030405060708', NFCA, NFCV), 'nfcv 0807060504030201');
});

test('ISO-DEP tags are dropped: cards and phones', { skip }, () => {
    assert.equal(classify('04A23F11223380', NFCA, ISO_DEP), 'drop iso-dep');
});

test('a 4-byte NFC-A UID starting 08 is a random ID and is dropped', { skip }, () => {
    assert.equal(classify('08AABBCC', NFCA), 'drop random id');
    assert.equal(classify('09AABBCC', NFCA), 'nfca 09AABBCC');
});

test('a tag with no ID or no spool tech is dropped', { skip }, () => {
    assert.equal(classify('', NFCA), 'drop no id');
    assert.equal(classify('04A23F11', 'android.nfc.tech.Ndef'), 'drop no spool tech');
});

/** Runs SpoolTagRules.main in its classic-unsupported mode: "<sak hex> <techs...>" gives true or false. */
function classicUnsupported(sakHex, ...techs) {
    return runJava(ensureCompiled(), 'SpoolTagRules', ['classic-unsupported', sakHex, ...techs]);
}

test('a Classic-looking chip without MifareClassic support is flagged', { skip }, () => {
    assert.equal(classicUnsupported('08', NFCA), 'true');
    assert.equal(classicUnsupported('18', NFCA), 'true');
    assert.equal(classicUnsupported('09', NFCA), 'true');
    assert.equal(classicUnsupported('88', NFCA), 'true');
    assert.equal(classicUnsupported('28', NFCA), 'true');
});

test('a Classic-looking chip with an empty tech list is flagged', { skip }, () => {
    assert.equal(classicUnsupported('08'), 'true');
});

test('a Classic chip the phone can read, or any other chip, is not flagged', { skip }, () => {
    assert.equal(classicUnsupported('08', NFCA, CLASSIC), 'false');
    assert.equal(classicUnsupported('09', NFCA, CLASSIC), 'false');
    assert.equal(classicUnsupported('88', NFCA, CLASSIC), 'false');
    assert.equal(classicUnsupported('00', NFCA), 'false');
    assert.equal(classicUnsupported('20', NFCA), 'false');
});

test('every NFC action the shim sends runs on the UI thread', () => {
    const shim = fs.readFileSync(path.join(pluginDir, 'www', 'printlog-native.js'), 'utf8');
    const router = fs.readFileSync(path.join(javaDir, 'PrintLogBridgeRouter.java'), 'utf8');

    const pushActions = new Set([
        'requestPushPermission', 'registerForPush', 'unregisterForPush', 'consumePendingTap',
    ]);
    const sent = [...shim.matchAll(/request\('(\w+)'/g)].map((m) => m[1]);
    const nfcActions = [...new Set(sent.filter((a) => !pushActions.has(a)))].sort();

    const literal = router.match(/UI_THREAD_ACTIONS[\s\S]*?Arrays\.asList\(([\s\S]*?)\)\)\)/);
    assert.ok(literal, 'UI_THREAD_ACTIONS literal not found');
    const uiThread = [...literal[1].matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();

    assert.deepEqual(uiThread, nfcActions);
    for (const action of nfcActions) {
        assert.ok(router.includes(`"${action}".equals(action)`), `router has no branch for ${action}`);
    }
});
