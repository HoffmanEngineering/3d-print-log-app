import AuthenticationServices
import Cordova
import FirebaseMessaging
import UIKit
import UserNotifications
import WebKit
import cordova_plugin_firebasex_messaging

/// The iOS side of the native bridge: push registration, notification taps, spool tag reading
/// and the Auth0 login sheet for the remotely loaded app. The page-facing half is `www/printlog-native.js`, shared unchanged
/// with Android; this file supplies the `PrintLogNativeHost` object that the shim talks to.
///
/// Why it exists is the same as on Android: once the WebView navigates to
/// https://www.3dprintlog.com, cordova.js is gone and the page cannot reach plugins the
/// normal way. A WKScriptMessageHandler restores a channel, and every message is checked
/// against the sending frame's origin, because config.xml also lets Auth0 and Google pages
/// load in this WebView.
///
/// The FCM token never reaches page script. The page hands native its bearer token and
/// native performs the /api/devices call.
@objc(PrintLogNativePlugin)
final class PrintLogNativePlugin: CDVPlugin, PrintLogBridgeActions {

    private static let allowedHost = "www.3dprintlog.com"
    private static let handlerName = "printlogNative"
    private static let keyNotificationId = "notificationId"
    private static let keyPrintId = "printId"
    private static let httpTimeout: TimeInterval = 15
    private static let tokenTimeout: TimeInterval = 10

    private var router: PrintLogBridgeRouter!
    private var tapReceiver: PrintLogTapReceiver?

    /// Main thread only, like the NFC state below.
    private var pendingTap: [String: String]?

    private let scanner = SpoolTagScanner()
    private var tagSessionOpen = false
    /// Bumped by every start and stop, so a read from an earlier session is dropped.
    private var tagSession = 0
    private var latestTag: [String: Any]?

    /// The last permission read, so the injected host starts from a real value rather than
    /// always "default". Refreshed on every page load and when the app returns to the front.
    private var cachedPermission = "default"

    override func pluginInitialize() {
        super.pluginInitialize()
        router = PrintLogBridgeRouter(actions: self)

        // Taps reach firebasex's UNUserNotificationCenter delegate, which hands every
        // notification to registered receivers before anything else. Registering is what
        // the receiver's initializer does.
        tapReceiver = PrintLogTapReceiver { [weak self] userInfo in
            DispatchQueue.main.async { self?.capturePendingTap(userInfo) }
        }

        guard let webView = webView as? WKWebView else {
            NSLog("PrintLogNative: no WKWebView; the native bridge stays off.")
            return
        }
        guard let script = Self.bridgeScript() else {
            NSLog("PrintLogNative: could not read the bridge scripts; the native bridge stays off.")
            return
        }

        let controller = webView.configuration.userContentController
        controller.add(
            WeakScriptMessageHandler(self), contentWorld: .page, name: Self.handlerName)
        // Main frame only, and the host script itself refuses any other origin, so Auth0,
        // Google and the bootstrap page never get a PrintLogNative object.
        controller.addUserScript(WKUserScript(
            source: script,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))

        NotificationCenter.default.addObserver(
            self, selector: #selector(pageDidLoad),
            name: NSNotification.Name("CDVPageDidLoadNotification"), object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)

        refreshPermission { _ in }
    }

    // MARK: - Login (#30)
    //
    // Google refuses OAuth inside an embedded WebView, and App Review expects third-party login
    // in the system sheet. So the Auth0 /authorize navigation is cancelled here and opened in
    // ASWebAuthenticationSession instead, the iOS counterpart of Android's Custom Tab
    // (patch_auth_custom_tab.js). Auth0 redirects to the app's custom scheme, the session
    // returns that URL, and the page gets it through window.handleOpenURL, exactly as the
    // Android customurlscheme plugin delivers it.

    private var authSession: ASWebAuthenticationSession?

    /// Asked by CDVWebViewEngine for every navigation. Every plugin that answers must allow a
    /// navigation for it to happen, and IntentAndNavigationFilter (onload) always answers, so
    /// allowing here never widens config.xml's allow-navigation list.
    @objc(shouldOverrideLoadWithRequest:navigationType:info:)
    func shouldOverrideLoad(
        _ request: URLRequest, navigationType: Int32, info: [AnyHashable: Any]
    ) -> Bool {
        guard let url = request.url, PrintLogAuthRules.isAuthorize(url) else {
            return true
        }
        // Only a top-level navigation is the login page. A silent-auth iframe stays as it was.
        if let target = info["targetFrame"] as? WKFrameInfo, !target.isMainFrame {
            return true
        }
        DispatchQueue.main.async { self.startLogin(url) }
        return false
    }

    private func startLogin(_ url: URL) {
        guard authSession == nil else { return }

        let session = ASWebAuthenticationSession(
            url: url, callbackURLScheme: PrintLogAuthRules.callbackScheme
        ) { [weak self] callback, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.authSession = nil
                // Cancelled or failed: the page stays where it was, as when a Custom Tab is
                // closed on Android.
                guard let callback = callback, PrintLogAuthRules.isCallback(callback) else {
                    return
                }
                self.evaluateInPage(
                    "window.handleOpenURL && window.handleOpenURL("
                        + Self.jsonString(callback.absoluteString) + ");")
            }
        }
        session.presentationContextProvider = self
        // Shares Safari's cookies, so a user already signed in to Google there gets one tap.
        // The cost is iOS's "wants to use auth0.com to sign in" prompt before the sheet.
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        if !session.start() {
            authSession = nil
        }
    }

    // MARK: - The channel

    fileprivate func receive(_ message: WKScriptMessage) {
        // Sub-frames on the app origin (ads, embeds) and every other origin must not reach
        // native.
        guard Self.isAllowed(message.frameInfo), let raw = message.body as? String,
              let webView = message.webView
        else {
            return
        }

        let frame = message.frameInfo
        router.handle(raw) { reply in
            DispatchQueue.main.async {
                // callAsyncJavaScript passes the reply as an argument, so no script is ever
                // built out of reply text.
                webView.callAsyncJavaScript(
                    "window.PrintLogNativeHost && window.PrintLogNativeHost.__deliver(reply);",
                    arguments: ["reply": reply], in: frame, in: .page, completionHandler: nil)
            }
        }
    }

    private static func isAllowed(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return frame.isMainFrame
            && origin.protocol == "https"
            && origin.host == allowedHost
            && (origin.port == 0 || origin.port == 443)
    }

    private func pageIsAllowed() -> Bool {
        guard let url = (webView as? WKWebView)?.url else { return false }
        return url.scheme == "https" && url.host == Self.allowedHost
    }

    /// Runs a fixed script in the page, only when the page is the app's own origin.
    private func evaluateInPage(_ script: String) {
        guard pageIsAllowed(), let webView = webView as? WKWebView else { return }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    @objc private func pageDidLoad() {
        // Any full page load ends a reading session: the page that opened it is gone, so
        // nothing would claim its tags. Angular route changes never reach here.
        stopTagReading()

        // The user script seeded the permission from the cached value; correct it now that a
        // fresh read is cheap, so Settings never shows "disabled" for a user who granted it.
        refreshPermission { [weak self] permission in
            self?.evaluateInPage(
                "window.PrintLogNative && (window.PrintLogNative.pushPermission = "
                    + Self.jsonString(permission) + ");")
        }
    }

    @objc private func appDidBecomeActive() {
        refreshPermission { _ in }
    }

    // MARK: - Taps

    private func capturePendingTap(_ userInfo: [AnyHashable: Any]) {
        // On iOS every tap, cold or warm, arrives through
        // userNotificationCenter(_:didReceive:), which firebasex marks with "tap". A
        // notification shown in the foreground also passes through here, without it.
        guard userInfo["tap"] != nil,
              let notificationId = userInfo[Self.keyNotificationId] as? String
        else {
            return
        }

        var tap = [Self.keyNotificationId: notificationId]
        // Raw string; the shim accepts only a plain positive integer.
        if let printId = userInfo[Self.keyPrintId] {
            tap[Self.keyPrintId] = "\(printId)"
        }
        pendingTap = tap

        // The page may already be loaded, in which case nothing is going to ask for this tap
        // on its own: Cordova's resume event does not exist on the remote origin.
        evaluateInPage("window.PrintLogNative && window.PrintLogNative.signalPendingTap();")
    }

    // MARK: - PrintLogBridgeActions: push

    func requestPushPermission(completion: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
        ) { [weak self] granted, _ in
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
            guard let self = self else {
                completion(granted ? "granted" : "default")
                return
            }
            self.refreshPermission(completion)
        }
    }

    func registerForPush(bearerToken: String, completion: @escaping (Bool) -> Void) {
        guard let apiUrl = apiBaseUrl() else {
            completion(false)
            return
        }

        currentFcmToken { [weak self] token in
            guard let self = self, let token = token else {
                completion(false)
                return
            }

            let body: [String: Any] = [
                "token": token,
                "platform": 2, // DevicePlatform.Ios
                "appVersion": Self.appVersion(),
            ]
            self.send(
                url: apiUrl + "/api/devices", method: "POST", body: body,
                bearerToken: bearerToken, completion: completion)
        }
    }

    func unregisterForPush(bearerToken: String, completion: @escaping (Bool) -> Void) {
        guard let apiUrl = apiBaseUrl() else {
            completion(false)
            return
        }

        currentFcmToken { [weak self] token in
            guard let self = self, let token = token,
                  let encoded = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
            else {
                completion(false)
                return
            }

            self.send(
                url: apiUrl + "/api/devices/" + encoded, method: "DELETE", body: nil,
                bearerToken: bearerToken, completion: completion)
        }
    }

    func consumePendingTap() -> [String: String]? {
        // Claimed exactly once, so a second call (a resume racing the boot-time call) cannot
        // route the user twice. Messages arrive on the main thread, as taps are stored there.
        let tap = pendingTap
        pendingTap = nil
        return tap
    }

    // MARK: - PrintLogBridgeActions: NFC
    //
    // The page's session (startTagReading .. stopTagReading) means "a screen is listening",
    // as on Android, but on iOS it opens nothing: Core NFC has no passive mode, and starting a
    // reader session puts a system sheet over the page. The sheet opens only from scanTag(),
    // which the page calls on a user tap. All of these run on the main thread, in the order
    // the page posted them.

    func nfcStatus() -> String {
        SpoolTagScanner.available ? "ready" : "unsupported"
    }

    func startTagReading(config: [String: Any]?) -> String {
        // The config describes MIFARE Classic key formats, which iOS cannot use: Classic is
        // unreadable here, and Type 2 and ISO 15693 memory is read without keys.
        tagSessionOpen = true
        tagSession += 1
        latestTag = nil
        return nfcStatus()
    }

    func scanTag() -> String {
        let status = nfcStatus()
        if status == "ready" && tagSessionOpen {
            let session = tagSession
            scanner.onReading = { [weak self] in
                DispatchQueue.main.async {
                    guard let self = self, self.tagSession == session else { return }
                    self.evaluateInPage(
                        "window.PrintLogNative && window.PrintLogNative.signalTagReading();")
                }
            }
            scanner.onTag = { [weak self] tag in
                DispatchQueue.main.async {
                    // A read finishing after the screen closed, or a newer session began,
                    // belongs to nobody.
                    guard let self = self, self.tagSession == session else { return }
                    self.latestTag = tag
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    self.evaluateInPage("window.PrintLogNative && window.PrintLogNative.signalTag();")
                }
            }
            scanner.begin()
        }
        return status
    }

    func stopTagReading() {
        tagSessionOpen = false
        tagSession += 1
        latestTag = nil
        scanner.cancel()
    }

    func consumeTag() -> [String: Any]? {
        let tag = latestTag
        latestTag = nil
        return tag
    }

    /// iOS has no NFC switch to send the user to.
    func openNfcSettings() -> Bool { false }

    // MARK: - Helpers

    private func refreshPermission(_ completion: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            let permission: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: permission = "granted"
            case .denied: permission = "denied"
            default: permission = "default"
            }
            DispatchQueue.main.async {
                self?.cachedPermission = permission
                completion(permission)
            }
        }
    }

    /// Read from config.xml rather than accepted from the page. A page-supplied API base would
    /// let compromised page script point this bridge, and the user's bearer token, at a server
    /// of its choosing.
    private func apiBaseUrl() -> String? {
        let raw = commandDelegate?.settings.object(forKey: "printlogapiurl") as? String ?? ""
        let url = raw.trimmingCharacters(in: .whitespaces)
        if url.isEmpty || url.contains("SET_ME") {
            NSLog("PrintLogNative: PrintLogApiUrl is not configured; push registration is disabled.")
            return nil
        }
        return url.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    }

    /// Re-read on every call rather than cached, so token rotation is picked up: the app
    /// registers on every authenticated launch. The FCM token needs the APNs token first, which
    /// arrives asynchronously after registerForRemoteNotifications, so this asks for one and
    /// retries until the deadline.
    private func currentFcmToken(completion: @escaping (String?) -> Void) {
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
        let deadline = Date().addingTimeInterval(Self.tokenTimeout)

        func attempt() {
            Messaging.messaging().token { token, error in
                if let token = token, error == nil {
                    completion(token)
                } else if Date() < deadline {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5, execute: attempt)
                } else {
                    NSLog("PrintLogNative: could not read the FCM token: \(error?.localizedDescription ?? "none")")
                    completion(nil)
                }
            }
        }
        attempt()
    }

    /// Calls back with true only on a 2xx.
    private func send(
        url: String, method: String, body: [String: Any]?, bearerToken: String,
        completion: @escaping (Bool) -> Void
    ) {
        guard let target = URL(string: url) else {
            completion(false)
            return
        }

        var request = URLRequest(url: target, timeoutInterval: Self.httpTimeout)
        request.httpMethod = method
        request.setValue("Bearer " + bearerToken, forHTTPHeaderField: "Authorization")
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }

        URLSession.shared.dataTask(with: request) { _, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(status) {
                NSLog("PrintLogNative: \(method) \(target.path) returned \(status) \(error?.localizedDescription ?? "")")
            }
            completion((200..<300).contains(status))
        }.resume()
    }

    private static func appVersion() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    /// A JSON string literal, which is also a valid JavaScript string literal.
    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8)
        else {
            return "\"\""
        }
        return String(array.dropFirst().dropLast())
    }

    /// Both scripts ship as package resources, so they stay plain JavaScript files: the
    /// shim is the same file Android injects and test/bridge_contract.test.js executes, and
    /// the host is executed against it by test/ios_host.test.js. The host comes first, because
    /// the shim reads `window.PrintLogNativeHost` when it runs.
    private static func bridgeScript() -> String? {
        guard let host = resource("printlog-native-ios-host"),
              let shim = resource("printlog-native")
        else {
            return nil
        }
        let seeded = host.replacingOccurrences(
            of: "\"__PRINTLOG_APP_VERSION__\"", with: jsonString(appVersion()))
        return seeded + "\n" + shim
    }

    private static func resource(_ name: String) -> String? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "js") else {
            return nil
        }
        return try? String(contentsOf: url, encoding: .utf8)
    }
}

/// WKUserContentController retains its handlers strongly; this keeps that from pinning the
/// plugin.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var plugin: PrintLogNativePlugin?

    init(_ plugin: PrintLogNativePlugin) {
        self.plugin = plugin
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        plugin?.receive(message)
    }
}

/// Receives every notification firebasex handles, foreground and tapped. Creating one
/// registers it with FirebasePluginMessageReceiverManager.
private final class PrintLogTapReceiver: FirebasePluginMessageReceiver {
    private let onNotification: ([AnyHashable: Any]) -> Void

    init(onNotification: @escaping ([AnyHashable: Any]) -> Void) {
        self.onNotification = onNotification
        super.init()
    }

    override func sendNotification(_ notification: [AnyHashable: Any]) {
        onNotification(notification)
    }
}

extension PrintLogNativePlugin: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        viewController?.view.window ?? ASPresentationAnchor()
    }
}
