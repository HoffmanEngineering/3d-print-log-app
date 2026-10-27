package com.hoffmanengineering.printlog;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * The request/response protocol spoken over the web message channel.
 *
 * Deliberately free of Android imports: everything here is string and JSON handling, so it
 * can be reasoned about — and, if a JVM test harness is ever added to this repo, tested —
 * without an emulator. All Android APIs live in {@link PrintLogNativePlugin}, which supplies
 * this class with an {@link Actions} implementation.
 *
 * Responses never carry the FCM token. The page hands us its bearer, we make the API call;
 * nothing that could hijack a device registration travels back out to page script.
 */
public class PrintLogBridgeRouter {

    /** What the plugin can actually do. Injected so the protocol stays testable in isolation. */
    public interface Actions {
        /** @return the current push permission state: granted, denied, or default. */
        String requestPushPermission();

        /** @return true if the device was registered with the API. */
        boolean registerForPush(String bearerToken);

        /** @return true if the registration was deleted. */
        boolean unregisterForPush(String bearerToken);

        /**
         * @return the pending tap as {@code {notificationId, printId}} with both values as
         *         raw strings, or null. Validation is the shim's job: it is the layer that
         *         acts on the value, and doing it there keeps it under test.
         */
        JSONObject consumePendingTap();

        /** @return {@code unsupported}, {@code off} or {@code ready}. */
        String nfcStatus();

        /**
         * Starts a tag-reading session: clears any stored tag and sets the reading flag. Reader
         * mode itself turns on only while NFC is on and the activity is in front.
         *
         * @param config the page's reader config ({@code {formats: [...]}}), or null when it sent
         *               none: then only the UID is read. Untrusted; the implementation vets it.
         * @return the NFC status, as {@link #nfcStatus()}.
         */
        String startTagReading(JSONObject config);

        /** Ends the session: clears the flag and the stored tag, and turns reader mode off. */
        void stopTagReading();

        /**
         * @return the latest tag as {@code {uid, tech, techs, classicUnsupported?, memory?}},
         *         claimed once, or null. Validation is the shim's job, as for taps.
         */
        JSONObject consumeTag();

        /** @return true if some NFC or wireless settings screen was opened. */
        boolean openNfcSettings();
    }

    /**
     * Actions handled synchronously on the UI thread, in the order the page posted them.
     *
     * The web message listener is called on the UI thread in posting order, but the thread
     * pool that push actions go to is multi-threaded, so two requests sent there can finish in
     * either order. A stopTagReading posted just before a startTagReading (one screen closing
     * as the next opens) must not run last and leave the reader off under an open picker.
     * These actions only touch NfcAdapter and the activity, so they are cheap enough for the
     * UI thread.
     */
    private static final Set<String> UI_THREAD_ACTIONS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "nfcStatus", "startTagReading", "scanTag", "stopTagReading", "consumeTag",
                    "openNfcSettings")));

    /** @return true if the request names an action that must run on the UI thread. */
    public static boolean isUiThreadAction(String rawRequest) {
        try {
            return UI_THREAD_ACTIONS.contains(new JSONObject(rawRequest).optString("action", ""));
        } catch (JSONException e) {
            return false;
        }
    }

    private final Actions actions;

    public PrintLogBridgeRouter(Actions actions) {
        this.actions = actions;
    }

    /**
     * Handles one request and returns the JSON reply to post back.
     *
     * Never throws and never returns null: an unanswered request leaves a promise pending
     * forever on the page, which shows up as a feature that silently does nothing rather
     * than as an error anyone can act on.
     */
    public String handle(String rawRequest) {
        String id = "";
        JSONObject reply = new JSONObject();

        try {
            JSONObject request = new JSONObject(rawRequest);
            id = request.optString("id", "");
            String action = request.optString("action", "");
            String bearerToken = request.optString("bearerToken", null);

            reply.put("id", id);

            if ("requestPushPermission".equals(action)) {
                reply.put("ok", true);
                reply.put("permission", actions.requestPushPermission());
            } else if ("registerForPush".equals(action)) {
                reply.put("ok", bearerToken != null && actions.registerForPush(bearerToken));
            } else if ("unregisterForPush".equals(action)) {
                reply.put("ok", bearerToken != null && actions.unregisterForPush(bearerToken));
            } else if ("consumePendingTap".equals(action)) {
                reply.put("ok", true);
                reply.put("tap", actions.consumePendingTap());
            } else if ("nfcStatus".equals(action)) {
                reply.put("ok", true);
                reply.put("nfc", actions.nfcStatus());
            } else if ("startTagReading".equals(action)) {
                reply.put("ok", true);
                reply.put("nfc", actions.startTagReading(request.optJSONObject("config")));
            } else if ("scanTag".equals(action)) {
                // iOS shows its scan sheet here. Android reads passively while a session is
                // open, so there is nothing to start: answer the status, as iOS does.
                reply.put("ok", true);
                reply.put("nfc", actions.nfcStatus());
            } else if ("stopTagReading".equals(action)) {
                actions.stopTagReading();
                reply.put("ok", true);
            } else if ("consumeTag".equals(action)) {
                JSONObject tag = actions.consumeTag();
                reply.put("ok", true);
                reply.put("tag", tag == null ? JSONObject.NULL : tag);
            } else if ("openNfcSettings".equals(action)) {
                reply.put("ok", actions.openNfcSettings());
            } else {
                reply.put("ok", false);
                reply.put("error", "unknown action");
            }
        } catch (JSONException e) {
            return errorReply(id, "malformed request");
        } catch (RuntimeException e) {
            // An action blew up. Answer anyway, for the reason above.
            return errorReply(id, "action failed");
        }

        return reply.toString();
    }

    private static String errorReply(String id, String message) {
        // Hand-built rather than via JSONObject: this path exists precisely because JSON
        // handling failed, and it must not be able to fail in turn.
        return "{\"id\":\"" + escape(id) + "\",\"ok\":false,\"error\":\"" + escape(message) + "\"}";
    }

    private static String escape(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
