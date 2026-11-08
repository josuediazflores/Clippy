import SwiftUI
import AuthenticationServices
import ClippyCore

@main
struct ClippyApp: App {
    @State private var app = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .tint(.primary)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        Group {
            if app.mode == nil || (app.needsSignIn && app.mode == .cloud) { SignInView() }
            else { MainTabs() }
        }
        .animation(.easeInOut(duration: 0.25), value: app.mode)
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        TabView {
            Tab("Today", systemImage: "circle.circle") { NavigationStack { HomeView() } }
            Tab("History", systemImage: "square.grid.2x2") { NavigationStack { HistoryView() } }
            Tab("Device", systemImage: "camera.aperture") { NavigationStack { DeviceView() } }
            Tab("You", systemImage: "person") { NavigationStack { AccountView() } }
        }
        .task(id: app.mode) { await app.refresh() }
    }
}

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var error: String?
    @State private var working = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Mark(size: 88)
            Text("Clippy").font(.system(size: 44, weight: .bold, design: .default)).padding(.top, 24)
            Text("Your day, remembered.").font(.title3).foregroundStyle(.secondary).padding(.top, 6)
            Spacer()
            VStack(spacing: 12) {
                if app.config.cloudAvailable {
                    Button("Sign in") { Task { await signIn(signUp: false) } }.buttonStyle(.ink).accessibilityIdentifier("sign-in")
                    Button("Create account") { Task { await signIn(signUp: true) } }.buttonStyle(.outline).accessibilityIdentifier("sign-up")
                }
                HStack(spacing: 20) {
                    Button("Local") { choose(.local) }.accessibilityIdentifier("use-local")
                    Button("Demo") { choose(.demo) }.accessibilityIdentifier("use-demo")
                }
                .font(.subheadline).foregroundStyle(.secondary).padding(.top, 8)
                if let error { Text(error).font(.footnote).foregroundStyle(.secondary).padding(.top, 4) }
            }
            .disabled(working)
            .padding(.horizontal, 28).padding(.bottom, 32)
        }
        .frame(maxWidth: .infinity)
        .background(Color.paper)
    }

    private func choose(_ mode: AppMode) {
        do { try app.activate(mode); error = nil } catch { self.error = app.failureText(error) }
    }

    private func signIn(signUp: Bool) async {
        guard let cognito = app.config.cognito else { return }
        working = true; defer { working = false }
        do {
            try app.activate(.cloud)
            let pkce = PKCE.generate()
            let callback = try await webAuth.authenticate(using: pkce.authorizeURL(cognito, signUp: signUp), callbackURLScheme: "clippy", preferredBrowserSession: .ephemeral)
            try await app.cognitoSession?.complete(callback: callback, pkce: pkce)
            app.needsSignIn = false
            await app.refresh()
        } catch {
            await app.signOut()
            self.error = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin ? nil : (signUp ? "Sign up failed" : "Sign in failed")
        }
    }
}
