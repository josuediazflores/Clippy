import Foundation
import CryptoKit

/// Cognito hosted UI settings. Public native client: authorization code with PKCE, no client secret.
public struct CognitoConfiguration: Sendable, Equatable {
    public let domain: URL
    public let clientID: String
    public let redirectURI: String
    public let scopes: [String]
    public init(domain: URL, clientID: String, redirectURI: String = "clippy://auth/callback", scopes: [String] = ["openid", "clippy/journal"]) {
        self.domain = domain; self.clientID = clientID; self.redirectURI = redirectURI; self.scopes = scopes
    }
}

public struct PKCE: Sendable, Equatable {
    public let verifier: String
    public let challenge: String
    public let state: String

    public init(verifier: String, state: String) {
        self.verifier = verifier
        self.state = state
        challenge = PKCE.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
    public static func generate() -> PKCE { PKCE(verifier: randomToken(32), state: randomToken(16)) }

    static func randomToken(_ bytes: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        return base64URL(Data((0..<bytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Hosted sign-in. `signUp` opens Cognito's sign-up page with the same PKCE parameters; after email
    /// verification it redirects back with an authorization code like a normal sign-in.
    public func authorizeURL(_ config: CognitoConfiguration, signUp: Bool = false) -> URL {
        var components = URLComponents(url: config.domain.appendingPathComponent(signUp ? "signup" : "oauth2/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: config.clientID),
            .init(name: "redirect_uri", value: config.redirectURI),
            .init(name: "scope", value: config.scopes.joined(separator: " ")),
            .init(name: "state", value: state),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "code_challenge", value: challenge),
        ]
        return components.url!
    }

    /// Extracts the authorization code from the callback, rejecting a mismatched state or an error response.
    public func code(from callback: URL) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard value("error") == nil, value("state") == state, let code = value("code"), !code.isEmpty else { throw RepositoryFailure.unauthorized }
        return code
    }
}

public struct TokenSet: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date
    public init(accessToken: String, refreshToken: String?, expiresAt: Date) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresAt = expiresAt
    }
    struct Response: Decodable { let access_token: String; let refresh_token: String?; let expires_in: Int }
    static func decode(_ data: Data, now: Date, previousRefresh: String?) throws -> TokenSet {
        let response = try JSONDecoder().decode(Response.self, from: data)
        return TokenSet(accessToken: response.access_token, refreshToken: response.refresh_token ?? previousRefresh, expiresAt: now.addingTimeInterval(TimeInterval(response.expires_in)))
    }
}

/// Persistent token storage. The app supplies a Keychain implementation; tests use memory.
public protocol TokenStore: Sendable {
    func load() async -> TokenSet?
    func save(_ tokens: TokenSet?) async
}

public actor MemoryTokenStore: TokenStore {
    private var value: TokenSet?
    public init(_ value: TokenSet? = nil) { self.value = value }
    public func load() -> TokenSet? { value }
    public func save(_ tokens: TokenSet?) { value = tokens }
}

/// Cognito session: exchanges codes, refreshes before expiry, and reports `unauthorized` when sign-in is needed.
public actor CognitoAuthSession: AuthSession {
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let config: CognitoConfiguration
    private let store: any TokenStore
    private let transport: Transport
    private let now: @Sendable () -> Date

    public init(config: CognitoConfiguration, store: any TokenStore, transport: Transport? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.config = config; self.store = store; self.now = now
        self.transport = transport ?? { try await URLSession.shared.data(for: $0) }
    }

    public func signedIn() async -> Bool { await store.load() != nil }

    public func authorization() async throws -> String {
        guard let tokens = await store.load() else { throw RepositoryFailure.unauthorized }
        if tokens.expiresAt.timeIntervalSince(now()) > 60 { return tokens.accessToken }
        guard let refresh = tokens.refreshToken else { await store.save(nil); throw RepositoryFailure.unauthorized }
        do {
            let renewed = try await token(["grant_type": "refresh_token", "refresh_token": refresh], previousRefresh: refresh)
            await store.save(renewed)
            return renewed.accessToken
        } catch RepositoryFailure.offline {
            throw RepositoryFailure.offline
        } catch {
            await store.save(nil)
            throw RepositoryFailure.unauthorized
        }
    }

    public func complete(callback: URL, pkce: PKCE) async throws {
        let code = try pkce.code(from: callback)
        let tokens = try await token(["grant_type": "authorization_code", "code": code, "redirect_uri": config.redirectURI, "code_verifier": pkce.verifier], previousRefresh: nil)
        await store.save(tokens)
    }

    public func signOut() async { await store.save(nil) }

    private func token(_ fields: [String: String], previousRefresh: String?) async throws -> TokenSet {
        var request = URLRequest(url: config.domain.appendingPathComponent("oauth2/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = (fields.merging(["client_id": config.clientID]) { a, _ in a }).sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = Data((form.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
        let data: Data, response: URLResponse
        do { (data, response) = try await transport(request) } catch is URLError { throw RepositoryFailure.offline }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw RepositoryFailure.unauthorized }
        return try TokenSet.decode(data, now: now(), previousRefresh: previousRefresh)
    }
}
