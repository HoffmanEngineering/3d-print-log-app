/**
 * window.PrintLogNativeHost for iOS: the object printlog-native.js talks to.
 *
 * On Android, WebViewCompat.addWebMessageListener supplies this object natively, with an
 * origin allowlist. WKWebView has no such thing, so this script builds the same shape over a
 * WKScriptMessageHandler: postMessage(string) goes to native, and native answers by calling
 * __deliver(reply), which reaches listeners as event.data, exactly as on Android.
 *
 * PrintLogNativePlugin.swift injects it at document start, main frame only, immediately ahead
 * of printlog-native.js. It refuses to install anywhere but the app's origin, and native
 * checks the origin of every message again regardless: page script on another origin could
 * still post to the handler directly.
 *
 * Native replaces the quoted version placeholder below, quotes included, with a JSON string.
 */
(function (global) {
  'use strict';

  var location = global.location;
  if (!location || location.protocol !== 'https:' || location.host !== 'www.3dprintlog.com') {
    return;
  }

  var handlers = global.webkit && global.webkit.messageHandlers;
  var handler = handlers && handlers.printlogNative;
  if (!handler) {
    return;
  }

  var listeners = [];

  var host = {
    platform: 'ios',
    appVersion: "__PRINTLOG_APP_VERSION__",
    // Native corrects this once the page has loaded; see PrintLogNativePlugin.pageDidLoad.
    pushPermission: 'default',

    postMessage: function (data) {
      handler.postMessage(String(data));
    },

    addEventListener: function (type, listener) {
      if (type === 'message' && typeof listener === 'function') {
        listeners.push(listener);
      }
    }
  };

  // Not enumerable: only native calls it.
  Object.defineProperty(host, '__deliver', {
    value: function (data) {
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i]({ data: data });
        } catch (e) {
          // A throwing listener must not strand the others' replies.
        }
      }
    }
  });

  global.PrintLogNativeHost = host;
})(typeof window !== 'undefined' ? window : this);
