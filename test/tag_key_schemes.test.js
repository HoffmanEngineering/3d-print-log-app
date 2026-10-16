const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { findJavac, compile, runJava } = require('./helpers/javac');

const javac = findJavac();
let classesDir;

/** Runs TagKeySchemes.main and returns its output lines. */
function derive(...args) {
    if (!classesDir) {
        classesDir = compile(['TagKeySchemes.java']);
    }
    return runJava(classesDir, 'TagKeySchemes', args).split(/\r?\n/);
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
