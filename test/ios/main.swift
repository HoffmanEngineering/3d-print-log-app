// Unit tests for the Foundation-only Swift files of the iOS plugin (PrintLogBridgeRouter,
// SpoolTagRulesIOS, PrintLogAuthRules), compiled with them by CI's ios job:
//
//   swiftc -o router-tests <src/ios>/PrintLogBridgeRouter.swift <src/ios>/SpoolTagRulesIOS.swift \
//     <src/ios>/PrintLogAuthRules.swift test/ios/main.swift && ./router-tests
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
    var scans = 0
    func scanTag() -> String {
        scans += 1
        return "ready"
    }
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

// scanTag reaches the action and passes its status back.
replies = handle(#"{"id":"r10","action":"scanTag"}"#, router)
check(actions.scans == 1 && replies.first?["nfc"] as? String == "ready", "scanTag runs and answers")

// ---- SpoolTagRulesIOS ----

func bytes(_ hex: String) -> Data {
    var data = Data()
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        data.append(UInt8(hex[index..<next], radix: 16)!)
        index = next
    }
    return data
}

check(SpoolTagRulesIOS.nfcaUid(bytes("04A23F11223344"), family: .ultralight) == "04A23F11223344",
      "an NTAG UID is uppercase hex")
check(SpoolTagRulesIOS.nfcaUid(bytes("08A23F11"), family: .unknown) == nil,
      "a 4-byte UID starting 0x08 is a random ID and is dropped")
check(SpoolTagRulesIOS.nfcaUid(bytes("08A23F11223344"), family: .unknown) != nil,
      "only a 4-byte UID can be a random ID")
check(SpoolTagRulesIOS.nfcaUid(bytes("04A23F11223344"), family: .isoDep) == nil,
      "DESFire and Plus are ISO-DEP and are dropped, as on Android")
check(SpoolTagRulesIOS.nfcaUid(Data(), family: .ultralight) == nil, "no UID, no tag")

check(SpoolTagRulesIOS.nfcvUid(bytes("E004015012345678")) == "E004015012345678",
      "an ISO 15693 UID already in printed order stays")
check(SpoolTagRulesIOS.nfcvUid(bytes("78563412500104E0")) == "E004015012345678",
      "an ISO 15693 UID least significant byte first is reversed to the E0 order")
check(SpoolTagRulesIOS.nfcvUid(Data()) == nil, "no UID, no tag")

let page = Data(repeating: 0xAB, count: 16)
let type2 = SpoolTagRulesIOS.memory(kind: "type2", data: page)
check(type2?["kind"] as? String == "type2", "memory carries its kind")
check(type2?["data"] as? String == page.base64EncodedString(), "memory is base64")
check(SpoolTagRulesIOS.memory(kind: "type2", data: Data()) == nil, "nothing read, no memory")
let oversized = SpoolTagRulesIOS.memory(kind: "type2", data: Data(repeating: 1, count: 4000))
check(Data(base64Encoded: oversized?["data"] as? String ?? "")?.count == 1024,
      "Type 2 memory is capped at 1024 bytes")
let nfcv = SpoolTagRulesIOS.memory(kind: "nfcv", data: Data(repeating: 1, count: 4000))
check(Data(base64Encoded: nfcv?["data"] as? String ?? "")?.count == 2048,
      "NFC-V memory is capped at 2048 bytes")

// ---- PrintLogAuthRules ----

func url(_ string: String) -> URL { URL(string: string)! }

check(PrintLogAuthRules.isAuthorize(url("https://dev-3dprintlog.auth0.com/authorize?client_id=x")),
      "a tenant's /authorize is the login page")
check(PrintLogAuthRules.isAuthorize(url("https://login.eu.auth0.com/authorize")),
      "a regional tenant counts too")
check(!PrintLogAuthRules.isAuthorize(url("https://dev-3dprintlog.auth0.com/v2/logout")),
      "logout loads in the WebView as before")
check(!PrintLogAuthRules.isAuthorize(url("https://dev-3dprintlog.auth0.com/u/login")),
      "Auth0's own login pages, once in the sheet, are not intercepted again")
check(!PrintLogAuthRules.isAuthorize(url("http://dev-3dprintlog.auth0.com/authorize")),
      "plain http is not the login page")
check(!PrintLogAuthRules.isAuthorize(url("https://evilauth0.com/authorize")),
      "a host merely ending in auth0.com is not Auth0")
check(!PrintLogAuthRules.isAuthorize(url("https://www.3dprintlog.com/authorize")),
      "the app's own origin is not Auth0")

check(PrintLogAuthRules.isCallback(url(
    "com.hoffmanengineering.printlog://cordova/com.hoffmanengineering.printlog/callback?code=a&state=b")),
      "the UI's Cordova callback URI is accepted")
check(!PrintLogAuthRules.isCallback(url("com.hoffmanengineering.printlog://cordova/other")),
      "a URL without /callback? is not a login callback")
check(!PrintLogAuthRules.isCallback(url("https://www.3dprintlog.com/callback?code=a")),
      "the web callback is not the app's")

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("iOS plugin helpers: all checks passed")
