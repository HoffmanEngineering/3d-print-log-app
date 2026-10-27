// Unit tests for PrintLogBridgeRouter.swift, compiled with it by CI's ios job:
//
//   swiftc -o router-tests \
//     plugins-local/cordova-plugin-printlog-native/src/ios/PrintLogBridgeRouter.swift \
//     test/ios/main.swift && ./router-tests
//
// Plain asserts rather than XCTest, so it needs nothing but the compiler, the way the Java
// helpers are tested with javac. Exits non-zero on the first failure.

import Foundation

final class FakeActions: PrintLogBridgeActions {
    var registered: [String] = []
    var tap: [String: String]? = ["notificationId": "n1", "printId": "42"]
    var stopped = false
    var deferredRegistration: ((Bool) -> Void)?

    func requestPushPermission(completion: @escaping (String) -> Void) { completion("granted") }

    func registerForPush(bearerToken: String, completion: @escaping (Bool) -> Void) {
        registered.append(bearerToken)
        if bearerToken == "slow" {
            deferredRegistration = completion
        } else {
            completion(true)
        }
    }

    func unregisterForPush(bearerToken: String, completion: @escaping (Bool) -> Void) {
        completion(false)
    }

    func consumePendingTap() -> [String: String]? {
        defer { tap = nil }
        return tap
    }

    func nfcStatus() -> String { "unsupported" }
    func startTagReading(config: [String: Any]?) -> String { "unsupported" }
    func stopTagReading() { stopped = true }
    func consumeTag() -> [String: Any]? { nil }
    func openNfcSettings() -> Bool { false }
}

var failures = 0

func check(_ condition: Bool, _ message: String, line: Int = #line) {
    if !condition {
        print("FAIL line \(line): \(message)")
        failures += 1
    }
}

func object(_ json: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
}

/// Runs one request and returns every reply it produced.
func handle(_ request: String, _ router: PrintLogBridgeRouter) -> [[String: Any]] {
    var replies: [[String: Any]] = []
    router.handle(request) { replies.append(object($0)) }
    return replies
}

let actions = FakeActions()
let router = PrintLogBridgeRouter(actions: actions)

// Registration carries the bearer through and echoes the request id.
var replies = handle(#"{"id":"r1","action":"registerForPush","bearerToken":"abc"}"#, router)
check(replies.count == 1, "one reply per request")
check(replies.first?["id"] as? String == "r1", "the reply echoes the request id")
check(replies.first?["ok"] as? Bool == true, "a successful registration is ok")
check(actions.registered == ["abc"], "the bearer reaches the action")

// No bearer: refused without calling the action.
replies = handle(#"{"id":"r2","action":"registerForPush"}"#, router)
check(replies.first?["ok"] as? Bool == false, "registration without a bearer fails")
check(actions.registered == ["abc"], "the action is not called without a bearer")

// An asynchronous action replies exactly once, when it completes.
replies = []
router.handle(#"{"id":"r3","action":"registerForPush","bearerToken":"slow"}"#) {
    replies.append(object($0))
}
check(replies.isEmpty, "no reply before the action completes")
actions.deferredRegistration?(true)
check(replies.count == 1 && replies[0]["id"] as? String == "r3", "the late reply carries its id")

// A tap is handed over once, then null.
replies = handle(#"{"id":"r4","action":"consumePendingTap"}"#, router)
let tap = replies.first?["tap"] as? [String: Any]
check(tap?["notificationId"] as? String == "n1", "the tap's notification id")
check(tap?["printId"] as? String == "42", "the tap's print id stays a raw string")
replies = handle(#"{"id":"r5","action":"consumePendingTap"}"#, router)
check(replies.first?["tap"] is NSNull, "a claimed tap is gone")

// NFC answers synchronously.
replies = handle(#"{"id":"r6","action":"nfcStatus"}"#, router)
check(replies.first?["nfc"] as? String == "unsupported", "nfcStatus passes the status through")
replies = handle(#"{"id":"r7","action":"stopTagReading"}"#, router)
check(actions.stopped && replies.first?["ok"] as? Bool == true, "stopTagReading runs and answers")

// Unknown and malformed requests are still answered.
replies = handle(#"{"id":"r8","action":"launchMissiles"}"#, router)
check(replies.first?["ok"] as? Bool == false, "an unknown action fails")
check(replies.first?["error"] as? String == "unknown action", "and says why")
replies = handle("not json", router)
check(replies.count == 1 && replies[0]["ok"] as? Bool == false, "malformed JSON is answered")

// The hand-built error reply stays valid JSON whatever the id holds.
let hostile = PrintLogBridgeRouter.errorReply(id: "a\"b\\c\nd", message: "x")
check(object(hostile)["id"] as? String == "a\"b\\c\nd", "the error reply escapes the id")

// The response never carries a token.
replies = handle(#"{"id":"r9","action":"requestPushPermission"}"#, router)
check(replies.first?["permission"] as? String == "granted", "permission passes through")
check(!replies.contains { $0.keys.contains { $0.lowercased().contains("token") } },
      "no reply carries a token")

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("PrintLogBridgeRouter: all checks passed")
