const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const pluginDir = path.join(__dirname, '..', 'plugins-local', 'cordova-plugin-printlog-native');
const hostSource = fs.readFileSync(path.join(pluginDir, 'www', 'printlog-native-ios-host.js'), 'utf8');
const shimSource = fs.readFileSync(path.join(pluginDir, 'www', 'printlog-native.js'), 'utf8');
const swiftSource = fs.readFileSync(
    path.join(pluginDir, 'src', 'ios', 'PrintLogNativePlugin.swift'), 'utf8');

/**
 * Runs the host and the real shim in one context, in the order PrintLogNativePlugin injects
 * them, against a fake WKScriptMessageHandler. Returns what the page would see plus a handle
 * on what crossed to native.
 */
function boot({ href = 'https://www.3dprintlog.com/prints', withHandler = true } = {}) {
    const url = new URL(href);
    const posted = [];
    const sandbox = {
        location: { protocol: url.protocol, host: url.host },
        Promise,
        JSON,
        Object,
        Number,
        Event: class {
            constructor(type) {
                this.type = type;
            }
        },
        dispatchEvent() {}
    };
    if (withHandler) {
        sandbox.webkit = {
            messageHandlers: {
                printlogNative: { postMessage: (data) => posted.push(JSON.parse(data)) }
            }
        };
    }
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    // What native injects: the version placeholder replaced with a JSON string, then the shim.
    const seeded = hostSource.replace('"__PRINTLOG_APP_VERSION__"', JSON.stringify('1.4.0'));
    vm.runInContext(seeded + '\n' + shimSource, sandbox);
    return { window: sandbox, posted };
}

test('builds a bridge that reports iOS and the injected version', () => {
    const { window } = boot();
    assert.equal(window.PrintLogNative.platform, 'ios');
    assert.equal(window.PrintLogNative.appVersion, '1.4.0');
    assert.equal(window.PrintLogNative.pushPermission, 'default');
});

test('a request crosses to native and its reply resolves the promise', async () => {
    const { window, posted } = boot();

    const result = window.PrintLogNative.registerForPush('bearer-abc');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].action, 'registerForPush');
    assert.equal(posted[0].bearerToken, 'bearer-abc');

    // Native answers through __deliver with the router's JSON, as Android's reply proxy does.
    window.PrintLogNativeHost.__deliver(JSON.stringify({ id: posted[0].id, ok: true }));
    // Through JSON: the object comes from the vm's realm, with that realm's prototype.
    assert.deepEqual(JSON.parse(JSON.stringify(await result)), { ok: true });
});

test('a throwing listener does not strand the reply for the shim', async () => {
    const { window, posted } = boot();
    window.PrintLogNativeHost.addEventListener('message', () => {
        throw new Error('page bug');
    });

    const tap = window.PrintLogNative.consumePendingTap();
    window.PrintLogNativeHost.__deliver(JSON.stringify({
        id: posted[0].id, ok: true, tap: { notificationId: 'n1', printId: '42' }
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(await tap)), { notificationId: 'n1', printId: 42 });
});

test('installs nothing on another origin, so Auth0 and Google pages get no bridge', () => {
    for (const href of [
        'https://example.auth0.com/authorize',
        'https://accounts.google.com/',
        'http://www.3dprintlog.com/',
        'https://3dprintlog.com/'
    ]) {
        const { window } = boot({ href });
        assert.equal(window.PrintLogNativeHost, undefined, href);
        assert.equal(window.PrintLogNative, undefined, href);
    }
});

test('installs nothing when the message handler is missing', () => {
    const { window } = boot({ withHandler: false });
    assert.equal(window.PrintLogNative, undefined);
});

test('__deliver is hidden from enumeration', () => {
    const { window } = boot();
    assert.ok(!Object.keys(window.PrintLogNativeHost).includes('__deliver'));
});

test('the version placeholder appears exactly once, quoted, as native replaces it', () => {
    assert.equal(hostSource.split('"__PRINTLOG_APP_VERSION__"').length - 1, 1);
    assert.match(swiftSource, /"\\"__PRINTLOG_APP_VERSION__\\""/);
});

test('the host and the Swift plugin agree on the origin and the handler name', () => {
    const host = /allowedHost = "([^"]+)"/.exec(swiftSource)[1];
    const handler = /handlerName = "([^"]+)"/.exec(swiftSource)[1];
    assert.ok(hostSource.includes(`location.host !== '${host}'`));
    assert.ok(hostSource.includes(`handlers.${handler}`));
});
