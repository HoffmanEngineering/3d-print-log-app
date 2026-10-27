// swift-tools-version:5.9

// The iOS half of the plugin, built as a Swift package the way cordova-ios 8 links any plugin
// whose plugin.xml marks its iOS platform package="swift". cordova-ios copies this directory
// into platforms/ios/packages/ next to firebasex's packages, which is what the relative path
// below points at, and rewrites the cordova-ios dependency to its local copy.

import PackageDescription

let package = Package(
    name: "cordova-plugin-printlog-native",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "cordova-plugin-printlog-native",
            targets: ["cordova-plugin-printlog-native"]
        )
    ],
    dependencies: [
        .package(path: "../cordova-plugin-firebasex-messaging"),
        .package(url: "https://github.com/apache/cordova-ios.git", branch: "master"),
        // Must match the version firebasex pins, or SwiftPM refuses to resolve the graph.
        .package(url: "https://github.com/firebase/firebase-ios-sdk.git", exact: "12.14.0")
    ],
    targets: [
        .target(
            name: "cordova-plugin-printlog-native",
            dependencies: [
                .product(name: "Cordova", package: "cordova-ios"),
                .product(
                    name: "cordova-plugin-firebasex-messaging",
                    package: "cordova-plugin-firebasex-messaging"),
                .product(name: "FirebaseMessaging", package: "firebase-ios-sdk")
            ],
            // The plugin root, so the shim can be a resource: www/printlog-native.js stays the
            // single file both platforms ship and test/bridge_contract.test.js executes.
            path: ".",
            exclude: ["src/android", "plugin.xml", "package.json"],
            sources: ["src/ios"],
            resources: [
                .copy("www/printlog-native.js"),
                .copy("www/printlog-native-ios-host.js")
            ]
        )
    ]
)
