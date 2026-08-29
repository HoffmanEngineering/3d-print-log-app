const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'www', 'js', 'index.js'),
    'utf8'
);

/**
 * Executes the real bootstrap against a fake plugin global rather than grepping the
 * source, so calling the wrong plugin API fails the test instead of passing a regex.
 */
function runBootstrap({ withPlugin = true } = {}) {
    const channels = [];
    let onDeviceReady;
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
        window: { location: { replace() {} } },
        console
    };

    if (withPlugin) {
        // The plugin clobbers the bare global FirebasexMessaging (see its plugin.xml),
        // NOT cordova.plugins.firebase.messaging.
        sandbox.FirebasexMessaging = {
            createChannel(options) {
                channels.push(options);
                return Promise.resolve();
            }
        };
    }

    vm.runInNewContext(source, sandbox);
    onDeviceReady();
    return channels;
}

test('creates the print_status channel using the real plugin global', () => {
    const channels = runBootstrap();
    assert.equal(channels.length, 1);
    assert.equal(channels[0].id, 'print_status');
});

test('channel importance is high so print failures are not silenced', () => {
    const channels = runBootstrap();
    assert.equal(channels[0].importance, 4);
});

test('startup still completes when the plugin is unavailable', () => {
    // A debug build without the plugin, or a platform where it failed to load, must not
    // take the whole app down before it ever navigates.
    assert.doesNotThrow(() => runBootstrap({ withPlugin: false }));
});
