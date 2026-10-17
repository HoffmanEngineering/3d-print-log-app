const assert = require('node:assert/strict');
const test = require('node:test');
const { findJavac, compile, runJava } = require('./helpers/javac');

const javac = findJavac();
let classesDir;

/** Runs TagMemory.main and returns its output lines. */
function run(...args) {
    if (!classesDir) {
        classesDir = compile(['TagKeySchemes.java', 'ClassicDump.java', 'PageDump.java', 'TagMemory.java']);
    }
    return runJava(classesDir, 'TagMemory', args).split(/\r?\n/);
}

const skip = javac ? false : 'no javac (CI installs a JDK with setup-java)';

test('a 16-sector Classic dump is 1024 bytes with unread sectors zeroed and listed', { skip }, () => {
    const unreadable = Array.from({ length: 13 }, (_, i) => i + 3).join(',');
    const out = run('classic', '16', '0,1,2', unreadable);
    assert.equal(out[0], 'length 1024');
    assert.equal(out[1], `unreadable ${unreadable}`);
    // Sector s was filled with s + 1; unread sectors are zero.
    assert.equal(out[2], 'first-bytes 01,02,03,00,00,00,00,00,00,00,00,00,00,00,00,00');
});

test('a Classic dump with every sector read has nothing unreadable', { skip }, () => {
    const all = Array.from({ length: 16 }, (_, i) => i).join(',');
    const out = run('classic', '16', all, '');
    assert.equal(out[0], 'length 1024');
    assert.equal(out[1].trim(), 'unreadable');
});

test('a Classic dump is always 64 bytes per sector', { skip }, () => {
    assert.equal(run('classic', '5', '', '')[0], 'length 320');
});

test('a page dump stops at its cap and add reports full', { skip }, () => {
    const out = run('page', '192', '16', '13');
    assert.equal(out[0], `${'true,'.repeat(12)}false`);
    assert.equal(out[1], 'length 192');
});

test('a page dump cuts a chunk that crosses the cap', { skip }, () => {
    const out = run('page', '20', '16', '2');
    assert.equal(out[0], 'true,false');
    assert.equal(out[1], 'length 20');
});

test('putSector after markUnreadable clears the mark', { skip }, () => {
    const out = run('classic', '4', '1', '1', 'again');
    assert.equal(out[1].trim(), 'unreadable');
    assert.equal(out[2], 'first-bytes 00,02,00,00');
});
