// Shared by the tests that compile the plugin's plain-Java classes and run them with java.
// Not a *.test.js file, so the npm test glob does not pick it up.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const javaDir = path.join(
    __dirname, '..', '..', 'plugins-local', 'cordova-plugin-printlog-native', 'src', 'android'
);

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

/** Compiles the named files of src/android into a new temp dir and returns it. */
function compile(files) {
    const javac = findJavac();
    const classesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printlog-java-'));
    const compiled = spawnSync(
        javac,
        ['-d', classesDir, ...files.map((file) => path.join(javaDir, file))],
        { encoding: 'utf8' }
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    return classesDir;
}

/** Runs com.hoffmanengineering.printlog.<className> with args; returns trimmed stdout. */
function runJava(classesDir, className, args) {
    const javac = findJavac();
    const java = path.join(path.dirname(javac), process.platform === 'win32' ? 'java.exe' : 'java');
    const run = spawnSync(
        fs.existsSync(java) ? java : 'java',
        ['-cp', classesDir, `com.hoffmanengineering.printlog.${className}`, ...args],
        { encoding: 'utf8' }
    );
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
}

module.exports = { findJavac, compile, runJava };
