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

  // Listeners for taps that arrive while the page is already loaded. The page cannot use
  // Cordova's `resume` event for this: cordova.js is gone on the remote origin, so that
  // event never fires here. Native calls signalPendingTap instead.
  var tapListeners = [];

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
  function normaliseTap(tap) {
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
        return normaliseTap(reply.tap);
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
      for (var i = 0; i < tapListeners.length; i++) {
        try {
          tapListeners[i]();
        } catch (e) {
          // Deliberately swallowed; see above.
        }
      }
    }
  };

  global.PrintLogNative = bridge;
})(typeof window !== 'undefined' ? window : this);
