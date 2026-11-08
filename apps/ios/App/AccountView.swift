import SwiftUI
import ClippyCore

struct AccountView: View {
    @Environment(AppModel.self) private var app
    @State private var profile: Profile?
    @State private var retention = 30
    @State private var confirmDelete = false
    @State private var notice: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 16) {
                    Mark(size: 44)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("You").font(.title2.weight(.bold))
                        Text(app.mode?.title ?? "").font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("mode")
                    }
                }
                .padding(.vertical, 8)
            }
            Section {
                LabeledContent("Time zone", value: profile?.journalTimeZone ?? "UTC")
                Stepper(value: $retention, in: 1...30) {
                    LabeledContent("Keep photos", value: "\(retention)d")
                }
                .disabled(profile == nil || app.readOnly)
                .onChange(of: retention) { _, new in if new != profile?.retentionDays { Task { await saveRetention(new) } } }
            } header: { Eyebrow("Journal") }
            Section {
                LabeledContent("Apple Calendar", value: "Soon").foregroundStyle(.secondary)
            } header: { Eyebrow("Connected") }
            Section {
                Button("Sign out") { Task { await app.signOut() } }.foregroundStyle(Color.ink).accessibilityIdentifier("sign-out")
                Button("Delete everything", role: .destructive) { confirmDelete = true }.foregroundStyle(Color.ink).disabled(app.readOnly)
                if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.paper)
        .navigationTitle("")
        .toolbar(.hidden, for: .navigationBar)
        .task(id: app.mode) { await load() }
        .confirmationDialog("Delete all your data?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete everything", role: .destructive) { Task { notice = await app.deleteAccount() } }
        }
    }

    private func load() async {
        guard let services = app.services, let loaded = try? await services.profile() else { return }
        profile = loaded; retention = loaded.retentionDays
    }

    private func saveRetention(_ days: Int) async {
        guard let services = app.services, let profile else { return }
        do {
            self.profile = try await services.updatePreferences(Preferences(schemaVersion: 1, expectedRevision: profile.revision, journalTimeZone: profile.journalTimeZone, retentionDays: days), key: OperationID.make())
            notice = nil
        } catch {
            notice = app.failureText(error)
            retention = profile.retentionDays
        }
    }
}
