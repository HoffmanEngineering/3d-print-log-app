const assert = require('node:assert/strict');
const test = require('node:test');
const { findJavac, compile, runJava } = require('./helpers/javac');

const javac = findJavac();
let classesDir;

/** Runs ReaderConfig.main: one "ok <id>" or "drop" per input line. */
function validate(...args) {
    if (!classesDir) {
        classesDir = compile(['TagKeySchemes.java', 'ReaderFormat.java', 'ReaderConfig.java']);
    }
    return runJava(classesDir, 'ReaderConfig', args).split(/\r?\n/);
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

test('a huge or non-numeric sectors string is dropped', { skip }, () => {
    assert.deepEqual(
        validate(
            hmac('a', `;sectors=${'9'.repeat(300)}`),
            hmac('b', ';sectors=99999999999'),
            hmac('c', ';sectors=1.5'),
            hmac('d', ';sectors=-1'),
            hmac('e', ';sectors=')
        ),
        ['drop', 'drop', 'drop', 'drop', 'drop']
    );
});

test('a labelPrefix with non-ASCII or control characters is dropped', { skip }, () => {
    assert.deepEqual(
        validate(
            `a|hmac-sha256-sector|saltHex=${SALT};labelPrefix=key_é_`,
            `b|hmac-sha256-sector|saltHex=${SALT};labelPrefix=key_\u0001_`,
            `c|hmac-sha256-sector|saltHex=${SALT};labelPrefix=key_\u007f_`,
            `d|hmac-sha256-sector|saltHex=${SALT};labelPrefix=`
        ),
        ['drop', 'drop', 'drop', 'drop']
    );
});

test('any over-long param value drops the format, even an unknown param', { skip }, () => {
    assert.deepEqual(
        validate(hmac('a', `;extra=${'x'.repeat(257)}`), hmac('b', `;extra=${'x'.repeat(256)}`)),
        ['drop', 'ok b']
    );
});
