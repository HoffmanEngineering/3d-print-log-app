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

/** Runs TagMemory.main and returns its output lines. */
function run(...args) {
    if (!classesDir) {
        classesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-memory-'));
        const compiled = spawnSync(
            javac,
            [
                '-d', classesDir,
                path.join(javaDir, 'TagKeySchemes.java'),
                path.join(javaDir, 'ClassicDump.java'),
                path.join(javaDir, 'PageDump.java'),
                path.join(javaDir, 'TagMemory.java'),
            ],
            { encoding: 'utf8' }
        );
        assert.equal(compiled.status, 0, compiled.stderr);
    }
    const java = path.join(path.dirname(javac), process.platform === 'win32' ? 'java.exe' : 'java');
    const result = spawnSync(
        fs.existsSync(java) ? java : 'java',
        ['-cp', classesDir, 'com.hoffmanengineering.printlog.TagMemory', ...args],
        { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\r?\n/);
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
