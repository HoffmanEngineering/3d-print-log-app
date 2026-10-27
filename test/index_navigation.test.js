const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('successful startup replaces the bootstrap page in browser history', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'www', 'js', 'index.js'),
        'utf8'
    );
    let onDeviceReady;
    const navigations = [];
    const sandbox = {
        Connection: { NONE: 'none' },
        document: {
            addEventListener(eventName, callback) {
                if (eventName === 'deviceready') {
                    onDeviceReady = callback;
                }
            }
        },
        navigator: {
            connection: { type: 'wifi' },
            notification: { alert() {} }
        },
        window: {
            location: {
                replace(url) {
                    navigations.push(url);
                }
            }
        }
    };

    vm.runInNewContext(source, sandbox);
    onDeviceReady();

    assert.deepEqual(navigations, ['https://www.3dprintlog.com']);
});

/**
 * Runs the real bootstrap with a fake DOM holding the offline screen, so the tests see what
 * the user sees: whether the screen is shown and where the WebView goes.
 */
function bootOffline() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'www', 'js', 'index.js'),
        'utf8'
    );
    const listeners = {};
    const offline = { hidden: true };
    const retry = {
        addEventListener(eventName, callback) {
            listeners['retry:' + eventName] = callback;
        }
    };
    const navigations = [];
    const connection = { type: 'none' };
    const sandbox = {
        Connection: { NONE: 'none' },
        document: {
            addEventListener(eventName, callback) {
                listeners[eventName] = callback;
            },
            getElementById(id) {
                return { offline, retry }[id] || null;
            }
        },
        navigator: { connection },
        window: {
            location: {
                replace(url) {
                    navigations.push(url);
                }
            }
        }
    };

    vm.runInNewContext(source, sandbox);
    listeners.deviceready();
    return { listeners, offline, navigations, connection };
}

test('offline at launch shows the offline screen and does not navigate', () => {
    const { offline, navigations } = bootOffline();

    assert.equal(offline.hidden, false);
    assert.deepEqual(navigations, []);
});

test('coming back online continues to the site without a tap', () => {
    const { listeners, navigations, connection } = bootOffline();

    connection.type = 'wifi';
    listeners.online();

    assert.deepEqual(navigations, ['https://www.3dprintlog.com']);
});

test('Try again while still offline stays on the offline screen', () => {
    const { listeners, offline, navigations } = bootOffline();

    listeners['retry:click']();

    assert.equal(offline.hidden, false);
    assert.deepEqual(navigations, []);
});

test('an online event and a tap together navigate only once', () => {
    const { listeners, navigations, connection } = bootOffline();

    connection.type = 'wifi';
    listeners.online();
    listeners['retry:click']();

    assert.deepEqual(navigations, ['https://www.3dprintlog.com']);
});
