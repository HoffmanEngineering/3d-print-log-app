const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const shim = fs.readFileSync(
    path.join(
        __dirname, '..', 'plugins-local', 'cordova-plugin-printlog-native',
        'www', 'printlog-native.js'
    ),
    'utf8'
);

/**
 * Installs the shim against a fake host object, exactly as the native side installs it on
 * the remote origin. Returns the bridge plus a handle on the wire, so tests can assert on
 * what actually crosses to native rather than on the shape of the source.
 */
function installShim(existing) {
    const posted = existing ? existing.posted : [];
    const events = existing ? existing.events : [];
    let listener;
    const sandbox = existing ? existing.sandbox : {
        console,
        Event: class {
            constructor(type) {
                this.type = type;
            }
        },
        dispatchEvent(event) {
            events.push(event.type);
            return true;
        }
    };
    sandbox.PrintLogNativeHost = {
        postMessage(msg) {
            posted.push(JSON.parse(msg));
        },
        addEventListener(name, callback) {
            if (name === 'message') {
                listener = callback;
            }
        }
    };
    sandbox.window = sandbox;
    if (!existing) {
        vm.createContext(sandbox);
    }
    vm.runInContext(shim, sandbox);

    /** Delivers a native reply for the Nth request. */
    const reply = (index, body) =>
        listener({ data: JSON.stringify({ id: posted[index].id, ...body }) });

    return { bridge: sandbox.window.PrintLogNative, posted, reply, events, sandbox };
}

test('exposes exactly the agreed contract', () => {
    const { bridge } = installShim();
    for (const member of [
        'platform', 'appVersion', 'pushPermission',
        'requestPushPermission', 'registerForPush',
        'unregisterForPush', 'consumePendingTap'
    ]) {
        assert.ok(member in bridge, `missing ${member}`);
    }
});

test('never exposes a token to page script', () => {
    const { bridge } = installShim();
    for (const key of Object.keys(bridge)) {
        assert.ok(
            !/token/i.test(key),
            `${key} must not be readable: the FCM token never reaches page script`
        );
    }
    assert.equal(bridge.pushToken, undefined);
});

test('registerForPush forwards the bearer to native with a correlation id', () => {
    const { bridge, posted } = installShim();
    bridge.registerForPush('bearer-abc');
    assert.equal(posted[0].action, 'registerForPush');
    assert.equal(posted[0].bearerToken, 'bearer-abc');
    assert.ok(posted[0].id, 'requests must carry a correlation id');
});

test('concurrent requests are correlated, not confused', async () => {
    const { bridge, posted, reply } = installShim();

    const first = bridge.registerForPush('bearer-one');
    const second = bridge.unregisterForPush('bearer-two');
    assert.notEqual(posted[0].id, posted[1].id);

    // Reply out of order: a bridge that assumed FIFO would resolve the wrong promise.
    reply(1, { ok: false });
    reply(0, { ok: true });

    // Field-level rather than deepEqual: objects built inside the vm context have a
    // different Object.prototype, which strict deep equality rejects.
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, false);
});

test('consumePendingTap normalizes a valid payload', async () => {
    const { bridge, reply } = installShim();
    const pending = bridge.consumePendingTap();

    reply(0, { ok: true, tap: { notificationId: 'abc', printId: '42' } });

    const tap = await pending;
    assert.equal(tap.notificationId, 'abc');
    assert.equal(tap.printId, 42);
});

test('consumePendingTap rejects a non-numeric printId', async () => {
    const { bridge, reply } = installShim();
    const pending = bridge.consumePendingTap();

    // A payload is attacker-influenced data. Anything that is not a plain positive integer
    // is dropped rather than handed to the router.
    reply(0, { ok: true, tap: { notificationId: 'abc', printId: '/evil' } });

    assert.equal(await pending, null);
});

test('consumePendingTap rejects a payload carrying a URL instead of an id', async () => {
    const { bridge, reply } = installShim();
    const pending = bridge.consumePendingTap();

    reply(0, {
        ok: true,
        tap: { notificationId: 'abc', printId: 'https://evil.example/prints/42' }
    });

    assert.equal(await pending, null);
});

test('consumePendingTap resolves null when there is no tap', async () => {
    const { bridge, reply } = installShim();
    const pending = bridge.consumePendingTap();

    reply(0, { ok: true, tap: null });

    assert.equal(await pending, null);
});

test('a native error resolves rather than rejecting into the app', async () => {
    const { bridge, reply } = installShim();
    const result = bridge.registerForPush('bearer-abc');

    reply(0, { ok: false, error: 'no token' });

    assert.equal((await result).ok, false);
});

/**
 * A tap that arrives while the page is already loaded has no Cordova `resume` event to ride
 * on — cordova.js is gone on the remote origin — so native signals the page directly and the
 * page drains the tap in response. See PrintLogNativePlugin.notifyPendingTap.
 */
test('onPendingTap fires when native signals a tap arrived', () => {
    const { bridge } = installShim();
    let fired = 0;

    bridge.onPendingTap(() => { fired += 1; });
    bridge.signalPendingTap();

    assert.equal(fired, 1);
});

test('onPendingTap notifies every registered listener', () => {
    const { bridge } = installShim();
    const fired = [];

    bridge.onPendingTap(() => fired.push('a'));
    bridge.onPendingTap(() => fired.push('b'));
    bridge.signalPendingTap();

    assert.deepEqual(fired, ['a', 'b']);
});

test('a signal with no listener registered does not throw', () => {
    const { bridge } = installShim();
    assert.doesNotThrow(() => bridge.signalPendingTap());
});

/**
 * One listener throwing must not stop the others: the page registers these, and a bug in
 * page script must not be able to strand a tap that native has already captured.
 */
test('a throwing listener does not stop the rest', () => {
    const { bridge } = installShim();
    const fired = [];

    bridge.onPendingTap(() => { throw new Error('page bug'); });
    bridge.onPendingTap(() => fired.push('b'));

    assert.doesNotThrow(() => bridge.signalPendingTap());
    assert.deepEqual(fired, ['b']);
});

// ---- NFC tags ----

test('exposes the NFC members', () => {
    const { bridge } = installShim();
    for (const member of [
        'nfcStatus', 'startTagReading', 'stopTagReading', 'consumeTag',
        'openNfcSettings', 'onTag', 'onNfcStatus', 'signalTag', 'signalNfcStatus'
    ]) {
        assert.equal(typeof bridge[member], 'function', `missing ${member}`);
    }
});

test('startTagReading posts the action and resolves the status', async () => {
    const { bridge, posted, reply } = installShim();
    const status = bridge.startTagReading();

    assert.equal(posted[0].action, 'startTagReading');
    reply(0, { ok: true, nfc: 'off' });

    assert.equal(await status, 'off');
});

test('an unknown NFC status reads as unsupported', async () => {
    const { bridge, reply } = installShim();
    const status = bridge.nfcStatus();

    reply(0, { ok: true, nfc: 'weird' });

    assert.equal(await status, 'unsupported');
});

test('stopTagReading and openNfcSettings post their actions', async () => {
    const { bridge, posted, reply } = installShim();
    const stopped = bridge.stopTagReading();
    const opened = bridge.openNfcSettings();

    assert.equal(posted[0].action, 'stopTagReading');
    assert.equal(posted[1].action, 'openNfcSettings');
    reply(0, { ok: true });
    reply(1, { ok: false });

    assert.equal(await stopped, undefined);
    assert.equal(await opened, undefined);
});

test('consumeTag accepts a valid tag', async () => {
    const { bridge, posted, reply } = installShim();
    const pending = bridge.consumeTag();

    assert.equal(posted[0].action, 'consumeTag');
    reply(0, { ok: true, tag: { uid: '04A23F11', tech: 'nfca' } });

    const tag = await pending;
    assert.equal(tag.uid, '04A23F11');
    assert.equal(tag.tech, 'nfca');
});

test('consumeTag rejects malformed UIDs and unknown techs', async () => {
    const bad = [
        { uid: '04A23F1', tech: 'nfca' },
        { uid: '04a23f11', tech: 'nfca' },
        { uid: 'ZZ', tech: 'nfca' },
        { uid: '', tech: 'nfca' },
        { uid: 'AB'.repeat(33), tech: 'nfca' },
        { uid: 42, tech: 'nfca' },
        { uid: '04A23F11', tech: 'iso-dep' },
        { uid: '04A23F11' },
        null
    ];

    for (const tag of bad) {
        const { bridge, reply } = installShim();
        const pending = bridge.consumeTag();
        reply(0, { ok: true, tag });
        assert.equal(await pending, null, `accepted ${JSON.stringify(tag)}`);
    }
});

test('consumeTag accepts a 64-digit UID', async () => {
    const { bridge, reply } = installShim();
    const pending = bridge.consumeTag();

    reply(0, { ok: true, tag: { uid: 'AB'.repeat(32), tech: 'nfcv' } });

    assert.equal((await pending).uid, 'AB'.repeat(32));
});

test('signalTag runs every listener even if one throws', () => {
    const { bridge } = installShim();
    const fired = [];

    bridge.onTag(() => { throw new Error('page bug'); });
    bridge.onTag(() => fired.push('b'));

    assert.doesNotThrow(() => bridge.signalTag());
    assert.deepEqual(fired, ['b']);
});

test('signalNfcStatus runs every listener even if one throws', () => {
    const { bridge } = installShim();
    const fired = [];

    bridge.onNfcStatus(() => { throw new Error('page bug'); });
    bridge.onNfcStatus(() => fired.push('b'));

    assert.doesNotThrow(() => bridge.signalNfcStatus());
    assert.deepEqual(fired, ['b']);
});

/**
 * Native injects the shim after the page has loaded, often after Angular has booted, so the
 * page needs an event rather than a one-time check at startup.
 */
test('dispatches printlog-native-ready after installing', () => {
    const { bridge, events, sandbox } = installShim();
    assert.deepEqual(events, ['printlog-native-ready']);
    assert.equal(sandbox.window.PrintLogNative, bridge);
});

test('a second injection keeps the listeners already registered', () => {
    const first = installShim();
    const fired = [];
    first.bridge.onTag(() => fired.push('tag'));
    first.bridge.onNfcStatus(() => fired.push('nfc'));
    first.bridge.onPendingTap(() => fired.push('tap'));

    const second = installShim(first);
    second.bridge.signalTag();
    second.bridge.signalNfcStatus();
    second.bridge.signalPendingTap();

    assert.deepEqual(fired, ['tag', 'nfc', 'tap']);
});
