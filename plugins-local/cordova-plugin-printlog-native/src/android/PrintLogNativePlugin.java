package com.hoffmanengineering.printlog;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.google.android.gms.tasks.Tasks;
import com.google.firebase.messaging.FirebaseMessaging;

import org.apache.cordova.CordovaPlugin;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Bridges the remotely-loaded Angular app to native push APIs.
 *
 * The WebView navigates to https://www.3dprintlog.com, after which cordova.js is gone and
 * the page cannot call plugins the normal way. WebViewCompat.addWebMessageListener gives a
 * channel back, and unlike addJavascriptInterface it takes an explicit origin allowlist —
 * which matters because config.xml also permits navigation to Auth0 and Google, and
 * patch_auth_custom_tab.js deliberately leaves some Auth0 URLs in this WebView.
 *
 * Notification handling is deliberately absent. See
 * docs/superpowers/notes/2026-08-28-firebasex-receiver-contract.md: because this page never
 * registers a firebasex JS callback, hasNotificationsCallback() is permanently false, so the
 * plugin posts every notification itself — foreground included — on the channel_id the API
 * sets. Posting one here too would double every notification.
 */
public class PrintLogNativePlugin extends CordovaPlugin implements PrintLogBridgeRouter.Actions {

    private static final String TAG = "PrintLogNative";

    /**
     * Exactly one origin. Never Auth0, never Google: those pages must not be able to
     * register devices or read anything from this bridge.
     */
    private static final Set<String> ALLOWED_ORIGINS =
            Collections.singleton("https://www.3dprintlog.com");

    private static final String BRIDGE_OBJECT = "PrintLogNativeHost";

    /** FCM data keys, set by the API's PushDispatchService. */
    private static final String KEY_NOTIFICATION_ID = "notificationId";
    private static final String KEY_PRINT_ID = "printId";

    private static final int HTTP_TIMEOUT_MS = 15000;
    private static final long TOKEN_TIMEOUT_SECONDS = 10;

    private PrintLogBridgeRouter router;

    /**
     * The tap waiting to be claimed. Atomic because it is written from the Android main
     * thread (intent callbacks) and read from the Cordova thread pool (bridge requests).
     * A cold-start tap has to survive here until Angular has booted on the remote origin
     * and asks for it — seconds, not milliseconds.
     */
    private final AtomicReference<Bundle> pendingTap = new AtomicReference<>(null);

    private static final int PERMISSION_REQUEST_CODE = 0;

    /**
     * How long to hold a bridge request open while the system permission dialog is up. Long
     * enough for a user who reads it, short enough that a forgotten dialog cannot pin a
     * thread-pool thread for the life of the process.
     */
    private static final long PERMISSION_TIMEOUT_SECONDS = 120;

    /** The bridge request currently waiting on the permission dialog, if any. */
    private final AtomicReference<CountDownLatch> permissionAnswer = new AtomicReference<>(null);

    @Override
    protected void pluginInitialize() {
        router = new PrintLogBridgeRouter(this);

        // Cold start: the launch intent carries the tap payload, because
        // OnNotificationReceiverActivity copies it onto the launch intent before finishing.
        capturePendingTap(cordova.getActivity().getIntent());

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // No safe fallback exists. addJavascriptInterface has no origin allowlist, so it
            // would expose this bridge to Auth0 and Google pages too. Push stays unavailable
            // rather than opening a broader interface to a remote origin.
            Log.w(TAG, "WEB_MESSAGE_LISTENER unsupported; the native bridge stays off.");
            return;
        }

        final WebView view = (WebView) this.webView.getView();

        WebViewCompat.addWebMessageListener(
                view, BRIDGE_OBJECT, ALLOWED_ORIGINS,
                (v, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    // Sub-frames on the app origin (ads, embeds) must not reach native.
                    if (!isMainFrame) {
                        return;
                    }

                    final String data = message.getData();
                    // Off the UI thread: registerForPush makes a network call.
                    cordova.getThreadPool().execute(
                            () -> replyProxy.postMessage(router.handle(data)));
                });
    }

    /** Warm start: the app was already running and the tap re-launched it. */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        capturePendingTap(intent);
    }

    private void capturePendingTap(Intent intent) {
        if (intent == null) {
            return;
        }

        Bundle extras = intent.getExtras();
        if (extras == null) {
            return;
        }

        // notificationId, not the "tap" key, is what identifies a tap.
        //
        // A message carrying an FCM `notification` block is handled by the system tray
        // whenever the app is backgrounded or not running: onMessageReceived is never
        // called, the SDK posts the card, and the tap launches this activity with the `data`
        // map as raw extras. OnNotificationReceiverActivity — the only thing that adds
        // "tap" — never runs on that path, which is the common one for a print that
        // finishes while the phone is in a pocket. Keying off "tap" therefore dropped every
        // tray tap on the floor.
        //
        // Both paths carry notificationId, because the API puts it in `data` and both the
        // tray and the plugin copy `data` onto the launch intent verbatim. Nothing else that
        // reaches us — the launcher icon, an OAuth callback — carries it.
        if (extras.getString(KEY_NOTIFICATION_ID) == null) {
            return;
        }

        pendingTap.set(extras);

        // The page may already be loaded, in which case nothing is going to ask us for this
        // tap on its own: the app's `resume` event does not exist on the remote origin.
        notifyPendingTap();
    }

    /**
     * The page injects nothing itself; native evaluates the shim into the page once it has
     * finished loading the allowed origin. Cordova calls this for every page load.
     */
    @Override
    public Object onMessage(String id, Object data) {
        if ("onPageFinished".equals(id) && data instanceof String) {
            String url = (String) data;
            for (String origin : ALLOWED_ORIGINS) {
                if (url.startsWith(origin + "/") || url.equals(origin)) {
                    injectShim();
                    break;
                }
            }
        }
        return null;
    }

    /**
     * The shim is shipped as an asset rather than a generated Java string constant, so
     * plugins-local/.../www/printlog-native.js stays the single source of truth — the same
     * file test/bridge_contract.test.js executes.
     */
    private static final String SHIM_ASSET = "www/printlog-native.js";

    private String shimSource;

    private void injectShim() {
        final String source = shimSource();
        if (source == null) {
            return;
        }

        // The shim reads its starting values off the host object, but a WebMessageListener
        // host exposes only postMessage/addEventListener — nothing native can hang a property
        // on. Left to itself the page therefore always began at "default", so Settings
        // reported notifications as disabled even for a user who had granted them, until
        // something called requestPushPermission. Seed the real values at injection instead.
        final String script = source
                + ";(function (b) { if (!b) { return; }"
                + " b.pushPermission = " + JSONObject.quote(currentPermission()) + ";"
                + " b.appVersion = " + JSONObject.quote(appVersion()) + ";"
                + " })(window.PrintLogNative);";

        cordova.getActivity().runOnUiThread(() -> {
            WebView view = (WebView) webView.getView();
            view.evaluateJavascript(script, null);
        });
    }

    /**
     * Tell the page a tap is waiting. Safe to call before the shim is injected: the guard
     * makes it a no-op, and the cold-start path drains the tap when Angular boots instead.
     */
    private void notifyPendingTap() {
        cordova.getActivity().runOnUiThread(() -> {
            WebView view = (WebView) webView.getView();
            view.evaluateJavascript(
                    "window.PrintLogNative && window.PrintLogNative.signalPendingTap();",
                    null);
        });
    }

    private String shimSource() {
        if (shimSource != null) {
            return shimSource;
        }

        try (InputStream in = cordova.getActivity().getAssets().open(SHIM_ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            shimSource = out.toString(StandardCharsets.UTF_8.name());
            return shimSource;
        } catch (Exception e) {
            Log.e(TAG, "Could not read the bridge shim; the native bridge stays off.", e);
            return null;
        }
    }

    // ---- PrintLogBridgeRouter.Actions ----

    @Override
    public String requestPushPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // Before Android 13 notifications need no runtime permission.
            return "granted";
        }

        if (hasNotificationPermission()) {
            return "granted";
        }

        // Wait for Android's answer rather than returning "default" immediately. Returning
        // early made the first tap of "Enable Notifications" always report failure: the page
        // cached "default" while the user was still looking at the system dialog, so Settings
        // kept offering to enable something that had in fact just been granted, and only a
        // second tap — which re-read the now-granted state — appeared to work.
        //
        // Blocking is safe here: bridge requests run on cordova.getThreadPool(), never the UI
        // thread, and registerForPush already performs network I/O on it.
        final CountDownLatch answered = new CountDownLatch(1);
        permissionAnswer.set(answered);

        try {
            cordova.requestPermission(this, PERMISSION_REQUEST_CODE, Manifest.permission.POST_NOTIFICATIONS);

            if (!answered.await(PERMISSION_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                // The user walked away from the dialog. Report what is true right now rather
                // than inventing a denial; the next call re-reads it anyway.
                return hasNotificationPermission() ? "granted" : "default";
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return hasNotificationPermission() ? "granted" : "default";
        } finally {
            permissionAnswer.compareAndSet(answered, null);
        }

        return hasNotificationPermission() ? "granted" : "denied";
    }

    /**
     * Cordova delivers the permission dialog's outcome here. The grant state itself is read
     * back from the system rather than from grantResults, so there is one source of truth.
     */
    @Override
    public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == PERMISSION_REQUEST_CODE) {
            CountDownLatch waiting = permissionAnswer.getAndSet(null);
            if (waiting != null) {
                waiting.countDown();
            }
        }
    }

    /** The page-facing spelling of the current notification permission. */
    private String currentPermission() {
        return hasNotificationPermission() ? "granted" : "default";
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        return ContextCompat.checkSelfPermission(
                cordova.getActivity(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public boolean registerForPush(String bearerToken) {
        String apiUrl = apiBaseUrl();
        if (apiUrl == null) {
            return false;
        }

        String fcmToken = currentFcmToken();
        if (fcmToken == null) {
            return false;
        }

        JSONObject body = new JSONObject();
        try {
            body.put("token", fcmToken);
            body.put("platform", 1); // DevicePlatform.Android
            body.put("appVersion", appVersion());
        } catch (Exception e) {
            return false;
        }

        return send(apiUrl + "/api/devices", "POST", body.toString(), bearerToken);
    }

    @Override
    public boolean unregisterForPush(String bearerToken) {
        String apiUrl = apiBaseUrl();
        if (apiUrl == null) {
            return false;
        }

        String fcmToken = currentFcmToken();
        if (fcmToken == null) {
            return false;
        }

        String encoded;
        try {
            encoded = URLEncoder.encode(fcmToken, StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return false;
        }

        return send(apiUrl + "/api/devices/" + encoded, "DELETE", null, bearerToken);
    }

    @Override
    public JSONObject consumePendingTap() {
        // getAndSet, not get-then-clear: the tap is claimed exactly once, so a second call
        // (a resume racing the boot-time call) cannot route the user twice.
        Bundle tap = pendingTap.getAndSet(null);
        if (tap == null) {
            return null;
        }

        try {
            JSONObject json = new JSONObject();
            json.put(KEY_NOTIFICATION_ID, tap.getString(KEY_NOTIFICATION_ID));
            // Raw string. The shim validates it is a plain positive integer before anything
            // acts on it — see printlog-native.js normaliseTap.
            json.put(KEY_PRINT_ID, tap.getString(KEY_PRINT_ID));
            return json;
        } catch (Exception e) {
            return null;
        }
    }

    // ---- helpers ----

    /**
     * Read from config.xml rather than accepted from the page. A page-supplied API base
     * would let compromised page script point this bridge — and the user's bearer token —
     * at a server of its choosing.
     */
    private String apiBaseUrl() {
        String url = preferences.getString("PrintLogApiUrl", "");
        if (url == null || url.trim().isEmpty() || url.contains("SET_ME")) {
            Log.w(TAG, "PrintLogApiUrl is not configured; push registration is disabled.");
            return null;
        }
        return url.trim().replaceAll("/+$", "");
    }

    private String appVersion() {
        try {
            return cordova.getActivity().getPackageManager()
                    .getPackageInfo(cordova.getActivity().getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Re-read on every call rather than cached. The plugin's token-refresh callback only
     * forwards to a JS callback this app cannot register (see the contract note), so
     * re-reading is how token rotation is picked up — the app registers on every
     * authenticated launch.
     */
    private String currentFcmToken() {
        try {
            return Tasks.await(
                    FirebaseMessaging.getInstance().getToken(),
                    TOKEN_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception e) {
            Log.w(TAG, "Could not read the FCM token: " + e.getMessage());
            return null;
        }
    }

    /** @return true only on a 2xx. Runs on the Cordova thread pool, never the UI thread. */
    private boolean send(String url, String method, String body, String bearerToken) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(HTTP_TIMEOUT_MS);
            connection.setReadTimeout(HTTP_TIMEOUT_MS);
            connection.setRequestProperty("Authorization", "Bearer " + bearerToken);

            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }

            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                Log.w(TAG, method + " " + url + " returned " + status);
                return false;
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, method + " " + url + " failed: " + e.getMessage());
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }
}
