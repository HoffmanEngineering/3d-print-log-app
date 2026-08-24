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
