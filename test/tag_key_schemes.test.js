const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

/** Runs TagKeySchemes.main and returns its output lines. */
function derive(...args) {
    if (!classesDir) {
        classesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-key-schemes-'));
        const compiled = spawnSync(
            javac,
            ['-d', classesDir, path.join(javaDir, 'TagKeySchemes.java')],
            { encoding: 'utf8' }
        );
        assert.equal(compiled.status, 0, compiled.stderr);
    }
    const java = path.join(path.dirname(javac), process.platform === 'win32' ? 'java.exe' : 'java');
    const run = spawnSync(
        fs.existsSync(java) ? java : 'java',
        ['-cp', classesDir, 'com.hoffmanengineering.printlog.TagKeySchemes', ...args],
        { encoding: 'utf8' }
    );
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim().split(/\r?\n/);
}

const skip = javac ? false : 'no javac (CI installs a JDK with setup-java)';

// Dummy values for the tests only.
const UID_HEX = '805BEC3E';
const SALT_HEX = '00112233445566778899AABBCCDDEEFF';
const uid = Buffer.from(UID_HEX, 'hex');
const salt = Buffer.from(SALT_HEX, 'hex');

test('hmac-sha256-sector matches HKDF-SHA256 with info labelPrefix + n, six bytes', { skip }, () => {
    const keys = derive('hmac-sha256-sector', UID_HEX, SALT_HEX, 'key_a_', '16');
    assert.equal(keys.length, 16);
    keys.forEach((key, n) => {
        const expected = Buffer.from(crypto.hkdfSync('sha256', uid, salt, `key_a_${n}`, 6))
            .toString('hex')
            .toUpperCase();
        assert.equal(key, expected, `sector ${n}`);
    });
});

test('hkdf-sha256-sectors splits one 96-byte HKDF output into six-byte keys', { skip }, () => {
    const keys = derive('hkdf-sha256-sectors', UID_HEX, SALT_HEX, '52464944', '16');
    const okm = Buffer.from(crypto.hkdfSync('sha256', uid, salt, Buffer.from('52464944', 'hex'), 96));
    assert.equal(keys.length, 16);
    keys.forEach((key, n) => {
        assert.equal(key, okm.subarray(n * 6, n * 6 + 6).toString('hex').toUpperCase(), `sector ${n}`);
    });
});

test('the number of sectors sets the number of keys', { skip }, () => {
    assert.equal(derive('hmac-sha256-sector', UID_HEX, SALT_HEX, 'key_a_', '3').length, 3);
    assert.equal(derive('hkdf-sha256-sectors', UID_HEX, SALT_HEX, '52464944', '1').length, 1);
});
