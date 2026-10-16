/**
 * window.PrintLogNative — the page-side half of the native bridge.
 *
 * This file is NOT a Cordova js-module. The WebView navigates to https://www.3dprintlog.com
 * and cordova.js is gone from that point on, so nothing Cordova injects reaches the running
 * app. Native evaluates this script into the page itself, and only for the one allowed
 * origin.
 *
 * The FCM token is deliberately absent from everything below. The page hands native its
 * bearer token and native performs the /api/devices call, so page script — including the
 * third-party scripts this origin serves — has nothing it could use to hijack a device
 * registration.
 */
(function (global) {
  'use strict';

  var host = global.PrintLogNativeHost;
  if (!host) {
    return;
  }

  // Correlation, not a queue: replies can arrive out of order (a slow HTTP register
  // overtaken by a local permission read), and resolving by arrival order would hand one
  // caller another caller's result.
  var pending = Object.create(null);
  var nextId = 0;

  // Listener lists for the native-to-page signals. Taps that arrive while the page is
  // already loaded cannot use Cordova's `resume` event (cordova.js is gone on the remote
  // origin), so native calls signalPendingTap instead; tag reads and NFC on/off changes work
  // the same way.
  //
  // Reused when the shim runs a second time in the same page: building fresh, empty lists
  // would silently orphan every listener the page had already registered.
  var previous = global.PrintLogNative;
  var listeners = (previous && previous.__listeners) || { tap: [], tag: [], nfc: [] };
  // A shim from before tag reading signals had no reading list.
  listeners.reading = listeners.reading || [];
  var tapListeners = listeners.tap;
  var tagListeners = listeners.tag;
  var nfcListeners = listeners.nfc;
  var readingListeners = listeners.reading;

  var NFC_STATUSES = ['unsupported', 'off', 'ready'];
  var TAG_TECHS = ['nfca', 'nfcb', 'nfcf', 'nfcv'];
  var MEMORY_KINDS = ['classic', 'type2', 'nfcv'];
  var MAX_FORMATS = 8;
  var MAX_TECHS = 10;
  var MAX_TECH_LENGTH = 64;
  var MAX_MEMORY_DATA = 2800;
  var MAX_UNREADABLE = 16;

  host.addEventListener('message', function (event) {
    var reply;
    try {
      reply = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    var resolve = pending[reply.id];
    if (!resolve) {
      return;
    }
    delete pending[reply.id];
    resolve(reply);
  });

  function request(action, payload) {
    var id = 'r' + ++nextId;
    var message = { id: id, action: action };
    if (payload) {
      for (var key in payload) {
        message[key] = payload[key];
      }
    }

    return new Promise(function (resolve) {
      pending[id] = resolve;
      host.postMessage(JSON.stringify(message));
    });
  }

  /**
   * A tap payload is attacker-influenced: it arrives over FCM and is copied verbatim out of
   * the message data. Only a plain positive integer is accepted as a print id, so a payload
   * carrying a path or a URL cannot become a navigation target. Native never navigates; the
   * Angular router does, from this value.
   */
  function normalizeTap(tap) {
    if (!tap || typeof tap.notificationId !== 'string' || !tap.notificationId) {
      return null;
    }

    var raw = String(tap.printId);
    if (!/^[0-9]+$/.test(raw)) {
      return null;
    }

    var printId = Number(raw);
    if (!Number.isSafeInteger(printId) || printId <= 0) {
      return null;
    }

    return { notificationId: tap.notificationId, printId: printId };
  }

  /**
   * A tag UID comes from whatever the user held to the phone, so it is vetted like a tap
   * payload: uppercase hex, whole bytes, at most 64 digits (the API's TagUid.Normalize rule),
   * and a tech from the allowlist. Anything else is dropped rather than handed to the page.
   */
  function normalizeTag(tag) {
    if (!tag || typeof tag.uid !== 'string' || typeof tag.tech !== 'string') {
      return null;
    }

    var uid = tag.uid;
    if (!/^[0-9A-F]+$/.test(uid) || uid.length % 2 !== 0 || uid.length > 64) {
      return null;
    }

    if (TAG_TECHS.indexOf(tag.tech) < 0) {
      return null;
    }

    var result = { uid: uid, tech: tag.tech };

    // The rest is optional and each part stands alone: an invalid one is dropped, and the
    // UID is still delivered.
    var techs = normalizeTechs(tag.techs);
    if (techs) {
      result.techs = techs;
    }
    if (tag.classicUnsupported === true) {
      result.classicUnsupported = true;
    }
    var memory = normalizeMemory(tag.memory);
    if (memory) {
      result.memory = memory;
    }
    return result;
  }

  function normalizeTechs(techs) {
    if (!Array.isArray(techs) || techs.length > MAX_TECHS) {
      return null;
    }
    for (var i = 0; i < techs.length; i++) {
      if (typeof techs[i] !== 'string' || techs[i].length > MAX_TECH_LENGTH) {
        return null;
      }
    }
    return techs.slice();
  }

  /**
   * Raw tag memory is opaque here: the API parses it. The shim only checks the envelope, so
   * a malformed payload never reaches page code.
   */
  function normalizeMemory(memory) {
    if (!isPlainObject(memory) || MEMORY_KINDS.indexOf(memory.kind) < 0) {
      return null;
    }
    if (typeof memory.data !== 'string' || memory.data.length > MAX_MEMORY_DATA ||
        !/^[A-Za-z0-9+\/]+={0,2}$/.test(memory.data)) {
      return null;
    }

    var result = { kind: memory.kind, data: memory.data };

    if (memory.keyFormat !== undefined && memory.keyFormat !== null) {
      if (typeof memory.keyFormat !== 'string' || !/^[a-z0-9-]{1,50}$/.test(memory.keyFormat)) {
        return null;
      }
      result.keyFormat = memory.keyFormat;
    }

    if (memory.unreadable !== undefined && memory.unreadable !== null) {
      var list = memory.unreadable;
      if (!Array.isArray(list) || list.length > MAX_UNREADABLE) {
        return null;
      }
      for (var i = 0; i < list.length; i++) {
        if (typeof list[i] !== 'number' || list[i] % 1 !== 0 || list[i] < 0 || list[i] > 15) {
          return null;
        }
      }
      result.unreadable = list.slice();
    }
    return result;
  }

  // toString rather than instanceof: the page may hand over an object from another realm.
  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  /** The reader config goes to native only when it has the expected shape. */
  function validConfig(config) {
    if (!isPlainObject(config) || !Array.isArray(config.formats) ||
        config.formats.length > MAX_FORMATS) {
      return false;
    }
    for (var i = 0; i < config.formats.length; i++) {
      if (!isPlainObject(config.formats[i])) {
        return false;
      }
    }
    return true;
  }

  function nfcStatusOf(reply) {
    return NFC_STATUSES.indexOf(reply.nfc) >= 0 ? reply.nfc : 'unsupported';
  }

  /** Every listener runs even if an earlier one throws; see signalPendingTap. */
  function signal(list) {
    for (var i = 0; i < list.length; i++) {
      try {
        list[i]();
      } catch (e) {
        // Deliberately swallowed.
      }
    }
  }

  var bridge = {
    platform: 'android',
    appVersion: host.appVersion || '',
    pushPermission: host.pushPermission || 'default',

    requestPushPermission: function () {
      return request('requestPushPermission').then(function (reply) {
        bridge.pushPermission = reply.permission || 'default';
        return bridge.pushPermission;
      });
    },

    registerForPush: function (bearerToken) {
      return request('registerForPush', { bearerToken: bearerToken }).then(
        function (reply) {
          // Resolved, never rejected: registration failure is a degraded feature, not an
          // error the app should surface or a promise anyone should have to catch.
          return { ok: reply.ok === true };
        }
      );
    },

    unregisterForPush: function (bearerToken) {
      return request('unregisterForPush', { bearerToken: bearerToken }).then(
        function (reply) {
          return { ok: reply.ok === true };
        }
      );
    },

    consumePendingTap: function () {
      return request('consumePendingTap').then(function (reply) {
        return normalizeTap(reply.tap);
      });
    },

    /**
     * Register interest in taps that arrive after the page has loaded. The listener is a
     * signal, not a delivery: it calls consumePendingTap itself, so the tap keeps being
     * claimed exactly once through the one native path that clears it.
     */
    onPendingTap: function (listener) {
      if (typeof listener === 'function') {
        tapListeners.push(listener);
      }
    },

    /**
     * Called by native when a tap has been captured. Every listener runs even if an earlier
     * one throws: a bug in page script must not strand a tap native already holds.
     */
    signalPendingTap: function () {
      signal(tapListeners);
    },

    // ---- NFC tags ----
    //
    // Reading runs only while the page holds a session (startTagReading .. stopTagReading).
    // Delivery is signal-then-fetch, like taps: native calls signalTag() with no arguments
    // and the page claims the tag with consumeTag(), so native never builds script from tag
    // data.

    /** @returns 'unsupported' (no NFC hardware), 'off', or 'ready'. */
    nfcStatus: function () {
      return request('nfcStatus').then(nfcStatusOf);
    },

    /**
     * Starts a reading session. Succeeds even while NFC is off; reading starts when it is on.
     * The optional config ({ formats: [...] }) says how to read tag memory; without a valid
     * one native reads the UID only.
     */
    startTagReading: function (config) {
      return request('startTagReading', validConfig(config) ? { config: config } : null)
        .then(nfcStatusOf);
    },

    stopTagReading: function () {
      return request('stopTagReading').then(function () {});
    },

    /** The latest tag read, claimed once, or null. */
    consumeTag: function () {
      return request('consumeTag').then(function (reply) {
        return normalizeTag(reply.tag);
      });
    },

    openNfcSettings: function () {
      return request('openNfcSettings').then(function () {});
    },

    onTag: function (listener) {
      if (typeof listener === 'function') {
        tagListeners.push(listener);
      }
    },

    /** Fires when a tag has arrived and its memory is being read. */
    onTagReading: function (listener) {
      if (typeof listener === 'function') {
        readingListeners.push(listener);
      }
    },

    onNfcStatus: function (listener) {
      if (typeof listener === 'function') {
        nfcListeners.push(listener);
      }
    },

    /** Called by native as soon as a tag arrives, before the read finishes. */
    signalTagReading: function () {
      signal(readingListeners);
    },

    /** Called by native after storing a tag. */
    signalTag: function () {
      signal(tagListeners);
    },

    /** Called by native when NFC is turned on or off, or the app returns to the front. */
    signalNfcStatus: function () {
      signal(nfcListeners);
    }
  };

  // Not enumerable: page code has no business with it, and the contract tests enumerate keys.
  Object.defineProperty(bridge, '__listeners', { value: listeners });

  global.PrintLogNative = bridge;

  // The shim usually lands after the page's app has booted, so tell it the bridge is here.
  try {
    global.dispatchEvent(new global.Event('printlog-native-ready'));
  } catch (e) {
    // No event support; the page falls back to checking for the bridge itself.
  }
})(typeof window !== 'undefined' ? window : this);
