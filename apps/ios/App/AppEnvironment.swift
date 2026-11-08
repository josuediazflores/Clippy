import Foundation
import Security
import ClippyCore

/// Where the app gets its data. Chosen at sign-in, or forced by launch environment in tests.
enum AppMode: String, Codable, CaseIterable, Identifiable {
    case cloud, local, demo, fixture
    var id: String { rawValue }
    var title: String {
        switch self {
        case .cloud: "Cloud"
        case .local: "Local"
        case .demo: "Demo"
        case .fixture: "Preview"
        }
    }
}

struct AppConfig {
    let environment: [String: String]
    let bundle: Bundle

    static var current: AppConfig { AppConfig(environment: ProcessInfo.processInfo.environment, bundle: .main) }

    private func plist(_ key: String) -> String? {
        (bundle.object(forInfoDictionaryKey: key) as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// A mode forced by the launch environment (UI tests, demos). Skips the sign-in screen.
    var forcedMode: AppMode? {
        if environment["CLIPPY_FIXTURE"] != nil { return .fixture }
        if let raw = environment["CLIPPY_MODE"], let mode = AppMode(rawValue: raw) { return mode }
        if environment["CLIPPY_BASE_URL"] != nil || environment["CLIPPY_OFFLINE"] == "1" { return .local }
        return nil
    }

    var localBaseURL: URL { URL(string: environment["CLIPPY_BASE_URL"] ?? plist("ClippyLocalBaseURL") ?? "http://127.0.0.1:8787")! }
    var localUser: String { environment["CLIPPY_LOCAL_USER"] ?? "local-user-a" }
    var simulateOffline: Bool { environment["CLIPPY_OFFLINE"] == "1" }
    var resetOnLaunch: Bool { environment["CLIPPY_RESET"] == "1" }
    var fixtureName: String { environment["CLIPPY_FIXTURE"] ?? "ready" }

    var cloudBaseURL: URL? { plist("ClippyAPIBaseURL").flatMap(URL.init(string:)) }
    var cognito: CognitoConfiguration? {
        guard let domain = plist("ClippyCognitoDomain").flatMap(URL.init(string:)), let client = plist("ClippyCognitoClientID") else { return nil }
        return CognitoConfiguration(domain: domain, clientID: client)
    }
    /// Cloud sign-in appears only once a deployed API and Cognito client are configured.
    var cloudAvailable: Bool { cloudBaseURL != nil && cognito != nil }

    func resource(_ name: String, _ ext: String = "json") throws -> Data {
        guard let url = bundle.url(forResource: name, withExtension: ext) else { throw RepositoryFailure.server("MISSING_RESOURCE", nil) }
        return try Data(contentsOf: url)
    }
}

/// Stores Cognito tokens in the Keychain, never in the journal cache.
actor KeychainTokenStore: TokenStore {
    private let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.clippy.auth",
        kSecAttrAccount as String: "cognito",
    ]

    func load() -> TokenSet? {
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(TokenSet.self, from: data)
    }

    func save(_ tokens: TokenSet?) {
        SecItemDelete(query as CFDictionary)
        guard let tokens, let data = try? JSONEncoder().encode(tokens) else { return }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
