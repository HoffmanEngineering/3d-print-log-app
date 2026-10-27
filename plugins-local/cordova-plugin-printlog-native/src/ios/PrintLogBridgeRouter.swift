import Foundation

/// What the iOS plugin can actually do. The Swift counterpart of
/// `PrintLogBridgeRouter.Actions` on Android, with completions where iOS is asynchronous
/// (the permission prompt and the API calls).
protocol PrintLogBridgeActions: AnyObject {
    /// Calls back with `granted`, `denied` or `default`.
    func requestPushPermission(completion: @escaping (String) -> Void)

    /// Calls back with true if the device was registered with the API.
    func registerForPush(bearerToken: String, completion: @escaping (Bool) -> Void)

    /// Calls back with true if the registration was deleted.
    func unregisterForPush(bearerToken: String, completion: @escaping (Bool) -> Void)

    /// The pending tap as `{notificationId, printId}`, both raw strings, claimed once. The shim
    /// validates them: it is the layer that acts on the value.
    func consumePendingTap() -> [String: String]?

    /// `unsupported`, `off` or `ready`.
    func nfcStatus() -> String

    /// Starts a tag-reading session and returns the NFC status. `config` is untrusted.
    func startTagReading(config: [String: Any]?) -> String

    func stopTagReading()

    /// The latest tag, claimed once.
    func consumeTag() -> [String: Any]?

    func openNfcSettings() -> Bool
}

/// The request/response protocol spoken over the bridge, the same one
/// `PrintLogBridgeRouter.java` speaks, so `www/printlog-native.js` is shared unchanged.
///
/// Deliberately free of UIKit, WebKit and Cordova: everything here is string and JSON
/// handling. Replies never carry the FCM token; the page hands native its bearer and native
/// makes the API call.
final class PrintLogBridgeRouter {
    private weak var actions: PrintLogBridgeActions?

    init(actions: PrintLogBridgeActions) {
        self.actions = actions
    }

    /// Handles one request and calls `reply` exactly once with the JSON to post back.
    ///
    /// Never drops a request: an unanswered one leaves a promise pending forever on the page,
    /// which shows up as a feature that silently does nothing. Synchronous actions reply
    /// before this returns, so requests the page posts in order are answered in order.
    func handle(_ rawRequest: String, reply: @escaping (String) -> Void) {
        guard let data = rawRequest.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            reply(Self.errorReply(id: "", message: "malformed request"))
            return
        }

        let id = request["id"] as? String ?? ""
        let send: ([String: Any]) -> Void = { fields in reply(Self.encode(id: id, fields)) }

        guard let actions = actions else {
            reply(Self.errorReply(id: id, message: "action failed"))
            return
        }

        let bearerToken = request["bearerToken"] as? String

        switch request["action"] as? String ?? "" {
        case "requestPushPermission":
            actions.requestPushPermission { send(["ok": true, "permission": $0]) }
        case "registerForPush":
            guard let bearerToken = bearerToken else {
                send(["ok": false])
                return
            }
            actions.registerForPush(bearerToken: bearerToken) { send(["ok": $0]) }
        case "unregisterForPush":
            guard let bearerToken = bearerToken else {
                send(["ok": false])
                return
            }
            actions.unregisterForPush(bearerToken: bearerToken) { send(["ok": $0]) }
        case "consumePendingTap":
            send(["ok": true, "tap": actions.consumePendingTap() ?? NSNull()])
        case "nfcStatus":
            send(["ok": true, "nfc": actions.nfcStatus()])
        case "startTagReading":
            let config = request["config"] as? [String: Any]
            send(["ok": true, "nfc": actions.startTagReading(config: config)])
        case "stopTagReading":
            actions.stopTagReading()
            send(["ok": true])
        case "consumeTag":
            send(["ok": true, "tag": actions.consumeTag() ?? NSNull()])
        case "openNfcSettings":
            send(["ok": actions.openNfcSettings()])
        default:
            send(["ok": false, "error": "unknown action"])
        }
    }

    static func encode(id: String, _ fields: [String: Any]) -> String {
        var reply = fields
        reply["id"] = id
        guard JSONSerialization.isValidJSONObject(reply),
              let data = try? JSONSerialization.data(withJSONObject: reply),
              let json = String(data: data, encoding: .utf8)
        else {
            return errorReply(id: id, message: "action failed")
        }
        return json
    }

    /// Hand-built rather than serialized: this path exists because JSON handling failed, and
    /// it must not be able to fail in turn.
    static func errorReply(id: String, message: String) -> String {
        return "{\"id\":\"\(escape(id))\",\"ok\":false,\"error\":\"\(escape(message))\"}"
    }

    private static func escape(_ value: String) -> String {
        var escaped = ""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\\": escaped += "\\\\"
            case "\"": escaped += "\\\""
            case _ where scalar.value < 0x20: escaped += String(format: "\\u%04x", scalar.value)
            default: escaped.unicodeScalars.append(scalar)
            }
        }
        return escaped
    }
}
