const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginDir = path.join(__dirname, '..', 'plugins-local', 'cordova-plugin-printlog-native');
const javaDir = path.join(pluginDir, 'src', 'android');

/** javac from JAVA_HOME, else from PATH; null when neither has one. */
function findJavac() {
    const candidates = [];
    if (process.env.JAVA_HOME) {
        candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javac'));
    }
    candidates.push('javac');
    for (const javac of candidates) {
        const probe = spawnSync(javac, ['-version'], { encoding: 'utf8' });
        if (probe.status === 0) {
            return javac;
        }
    }
    return null;
}

const javac = findJavac();
let classesDir;

/** Runs ReaderConfig.main: one "ok <id>" or "drop" per input line. */
function validate(...lines) {
    if (!classesDir) {
        classesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-config-'));
        const compiled = spawnSync(
            javac,
            [
                '-d', classesDir,
                path.join(javaDir, 'TagKeySchemes.java'),
                path.join(javaDir, 'ReaderFormat.java'),
                path.join(javaDir, 'ReaderConfig.java'),
            ],
            { encoding: 'utf8' }
        );
        assert.equal(compiled.status, 0, compiled.stderr);
    }
    const java = path.join(path.dirname(javac), process.platform === 'win32' ? 'java.exe' : 'java');
    const run = spawnSync(
        fs.existsSync(java) ? java : 'java',
        ['-cp', classesDir, 'com.hoffmanengineering.printlog.ReaderConfig', ...lines],
        { encoding: 'utf8' }
    );
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim().split(/\r?\n/);
}

const skip = javac ? false : 'no javac (CI installs a JDK with setup-java)';

// Dummy values for the tests only.
const SALT = '00112233445566778899AABBCCDDEEFF';
const hmac = (id, extra = '') => `${id}|hmac-sha256-sector|saltHex=${SALT};labelPrefix=key_a_${extra}`;
const hkdf = (id, extra = '') => `${id}|hkdf-sha256-sectors|saltHex=${SALT};infoHex=52464944${extra}`;

test('a valid hmac-sha256-sector format is kept', { skip }, () => {
    assert.deepEqual(validate(hmac('brand-a')), ['ok brand-a']);
});

test('a valid hkdf-sha256-sectors format is kept', { skip }, () => {
    assert.deepEqual(validate(hkdf('brand-b')), ['ok brand-b']);
});

test('sectors is optional and accepts 1 through 16', { skip }, () => {
    assert.deepEqual(validate(hmac('a', ';sectors=1'), hmac('b', ';sectors=16')), ['ok a', 'ok b']);
});

test('an unknown scheme is dropped', { skip }, () => {
    assert.deepEqual(validate(`brand-a|rot13|saltHex=${SALT};labelPrefix=key_a_`), ['drop']);
});

test('a non-hex or odd-length saltHex is dropped', { skip }, () => {
    assert.deepEqual(
        validate(
            'a|hmac-sha256-sector|saltHex=0G;labelPrefix=key_a_',
            'b|hmac-sha256-sector|saltHex=001;labelPrefix=key_a_',
            'c|hkdf-sha256-sectors|saltHex=00;infoHex=5'
        ),
        ['drop', 'drop', 'drop']
    );
});

test('a missing required param is dropped', { skip }, () => {
    assert.deepEqual(
        validate(
            `a|hmac-sha256-sector|saltHex=${SALT}`,
            `b|hkdf-sha256-sectors|saltHex=${SALT}`,
            'c|hmac-sha256-sector|labelPrefix=key_a_'
        ),
        ['drop', 'drop', 'drop']
    );
});

test('a bad id is dropped', { skip }, () => {
    assert.deepEqual(validate(hmac('Snap Maker'), hmac('UPPER'), hmac('a'.repeat(51))), ['drop', 'drop', 'drop']);
});

test('sectors outside 1-16 or not a number is dropped', { skip }, () => {
    assert.deepEqual(
        validate(hmac('a', ';sectors=17'), hmac('b', ';sectors=0'), hmac('c', ';sectors=x')),
        ['drop', 'drop', 'drop']
    );
});

test('a value over 256 characters is dropped', { skip }, () => {
    const longPrefix = 'k'.repeat(257);
    assert.deepEqual(
        validate(
            `a|hmac-sha256-sector|saltHex=${SALT};labelPrefix=${longPrefix}`,
            `b|hkdf-sha256-sectors|saltHex=${'00'.repeat(129)};infoHex=52464944`
        ),
        ['drop', 'drop']
    );
});

test('nine valid formats keep eight', { skip }, () => {
    const lines = Array.from({ length: 9 }, (_, i) => hmac(`brand-${i}`));
    const out = validate(...lines);
    assert.equal(out.filter((line) => line.startsWith('ok')).length, 8);
    assert.equal(out[8], 'drop');
});

test('a repeated id is dropped and the first one wins', { skip }, () => {
    assert.deepEqual(validate(hmac('same'), hkdf('same')), ['ok same', 'drop']);
});
