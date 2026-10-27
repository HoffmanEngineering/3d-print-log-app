import Foundation

/// Which navigations are the Auth0 login, and where it comes back to. Foundation only, so
/// CI's ios job compiles it with test/ios/main.swift and runs it with plain swiftc.
enum PrintLogAuthRules {
    /// The app's custom scheme, the one the UI's cordovaCallbackUri uses
    /// (`com.hoffmanengineering.printlog://cordova/com.hoffmanengineering.printlog/callback`).
    static let callbackScheme = "com.hoffmanengineering.printlog"

    /// Auth0's /authorize on an auth0.com tenant: the page that offers Google, Apple and
    /// password login. The same rule as Android's patch_auth_custom_tab.js
    /// (`url.contains("auth0.com/authorize")`), made exact: https, a host that is auth0.com or
    /// ends in .auth0.com, and that path. Logout and every other Auth0 page load as before.
    static func isAuthorize(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else {
            return false
        }
        let auth0 = host == "auth0.com" || host.hasSuffix(".auth0.com")
        return auth0 && url.path == "/authorize"
    }

    /// True for the callback the UI's handleOpenURL accepts.
    static func isCallback(_ url: URL) -> Bool {
        url.scheme?.lowercased() == callbackScheme && url.absoluteString.contains("/callback?")
    }
}
