import SwiftUI
import ClippyCore

@main
struct ClippyApp: App {
    @State private var model: JournalModel
    init() {
        let environment = ProcessInfo.processInfo.environment
        let schema = try! Data(contentsOf: Bundle.main.url(forResource: "schema", withExtension: "json")!)
        let transitions = try! Data(contentsOf: Bundle.main.url(forResource: "transitions", withExtension: "json")!)
        let client = try! HTTPJournalRepository(baseURL: URL(string: environment["CLIPPY_BASE_URL"] ?? "http://127.0.0.1:8787")!, schema: schema, transitions: transitions)
        let cacheURL = URL.documentsDirectory.appendingPathComponent("synthetic-day.json")
        let cache = DayCache(url: cacheURL)
        let fixture = environment["CLIPPY_FIXTURE"]
        let repository: any JournalRepository
        if let fixture {
            repository = try! FixtureJournalRepository(data: Data(contentsOf: Bundle.main.url(forResource: fixture, withExtension: "json")!))
        } else if environment["CLIPPY_OFFLINE"] == "1" { repository = OfflineJournalRepository() }
        else { repository = client }
        _model = State(initialValue: JournalModel(repository: repository, services: fixture == nil ? client : nil, cache: cache, preview: fixture != nil))
    }
    var body: some Scene { WindowGroup { JournalView(model: model) } }
}

struct JournalView: View {
    @Bindable var model: JournalModel
    @State private var selectedMoment: Moment?
    @FocusState private var reflectionFocused: Bool
    var body: some View {
        TabView {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        HStack { Label("Synthetic local demo", systemImage: "testtube.2").font(.caption).foregroundStyle(.secondary); Spacer() }
                        VStack(alignment: .leading, spacing: 5) {
                            Text("November 7, 2026").font(.subheadline).foregroundStyle(.secondary)
                            Text("Your day, so far").font(.largeTitle.bold())
                        }
                        statusCard
                        if let recap = model.day?.recap {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Daily recap").font(.title2.bold())
                                Text(recap.summary).font(.body).accessibilityIdentifier("recap-summary")
                                Text("Through \(String((recap.coverage.throughAt ?? "").dropFirst(11).prefix(5))) UTC · \(recap.coverage.observed) of \(recap.coverage.captured) moments")
                                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("coverage")
                            }
                            VStack(alignment: .leading, spacing: 14) {
                                Text("Moments").font(.title2.bold())
                                ForEach(recap.moments, id: \.momentId) { moment in
                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack(alignment: .firstTextBaseline) {
                                            Text(String(moment.capturedAt.dropFirst(11).prefix(5))).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                            Text(displayTitle(moment)).font(.headline)
                                        }
                                        Text(moment.detail).font(.subheadline).foregroundStyle(.secondary)
                                        Button("Correct this moment") { selectedMoment = moment }
                                            .font(.subheadline).accessibilityIdentifier("correct-\(moment.momentId)")
                                            .disabled(model.offline || model.preview)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                                }
                            }
                            VStack(alignment: .leading, spacing: 12) {
                                Text("A moment to reflect").font(.title2.bold())
                                Text(recap.reflectionPrompt).foregroundStyle(.secondary)
                                TextField("Write your reflection", text: $model.reflectionDraft, axis: .vertical)
                                    .lineLimit(3...8).textFieldStyle(.roundedBorder).focused($reflectionFocused).accessibilityIdentifier("reflection-editor")
                                Button("Save reflection") { Task { await model.saveReflection(); if model.message == "Reflection saved" { reflectionFocused = false } } }
                                    .buttonStyle(.borderedProminent).disabled(model.saving || model.offline || model.preview)
                                    .accessibilityIdentifier("save-reflection")
                            }
                        }
                        if let message = model.message { Text(message).font(.callout).accessibilityIdentifier("action-message") }
                        Text("Calendar unavailable · Nightly schedule off").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(20)
                }
                .background(Color(.systemGroupedBackground))
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }.accessibilityIdentifier("refresh") } }
                .navigationTitle("Clippy").navigationBarTitleDisplayMode(.inline)
            }
            .tabItem { Label("Home", systemImage: "sun.max") }
            NavigationStack {
                List {
                    Section("Local journal") {
                        if let day = model.day { VStack(alignment: .leading, spacing: 6) { Text("November 7, 2026"); Text(day.state.capitalized).font(.caption).foregroundStyle(.secondary) } }
                        else { Text("No saved days yet") }
                    }
                }.navigationTitle("History")
            }.tabItem { Label("History", systemImage: "calendar") }
            NavigationStack {
                List {
                    Section("Simulated wearable") {
                        LabeledContent("Capture", value: model.device?.state?.captureState.capitalized ?? "Unknown")
                        LabeledContent("Last observation", value: model.device?.state?.observedAt ?? "Not available")
                        LabeledContent("Battery", value: "Unknown")
                        Text("The wearable screen is authoritative while disconnected.").font(.caption).foregroundStyle(.secondary)
                        Button("Sync now") { Task { await model.syncNow() } }.disabled(model.offline || model.preview).accessibilityIdentifier("sync-now")
                    }
                    Section("Local foundation") {
                        LabeledContent("Nightly schedule", value: "Off")
                        LabeledContent("Apple Calendar", value: "Not connected")
                        Text("Pairing, hardware capture, and account connections are later phases.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let message = model.message { Text(message) }
                }.navigationTitle("Device")
            }.tabItem { Label("Device", systemImage: "camera") }
        }
        .tint(Color(red: 0.17, green: 0.38, blue: 0.29))
        .task { await model.refresh() }
        .sheet(item: $selectedMoment) { moment in CorrectionSheet(model: model, moment: moment, initial: displayTitle(moment)) }
    }
    private func displayTitle(_ moment: Moment) -> String {
        model.day?.corrections.last(where: { $0.momentId == moment.momentId && !$0.deleted })?.text ?? moment.title
    }
    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(model.label, systemImage: model.offline ? "wifi.slash" : model.state == "ready" ? "checkmark.circle" : "clock")
                .font(.headline).accessibilityIdentifier("state-\(model.state)")
            Text(model.explanation).font(.subheadline).foregroundStyle(.secondary)
            if model.state == "failure" { Text("Retry processing from the local demo command.").font(.caption) }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

extension Moment: @retroactive Identifiable { public var id: String { momentId } }
struct CorrectionSheet: View {
    @Environment(\.dismiss) private var dismiss
    var model: JournalModel
    let moment: Moment
    @State private var text: String
    init(model: JournalModel, moment: Moment, initial: String) { self.model = model; self.moment = moment; _text = State(initialValue: initial) }
    var body: some View {
        NavigationStack {
            Form {
                Section("Your wording") { TextField("Correct this moment", text: $text, axis: .vertical).accessibilityIdentifier("correction-editor") }
                Text("Your correction stays separate from generated text and survives later snapshots.").font(.caption).foregroundStyle(.secondary)
                if let message = model.message { Text(message) }
                Button("Save correction") { Task { if await model.saveCorrection(moment: moment, text: text) { dismiss() } } }
                    .disabled(model.saving).accessibilityIdentifier("save-correction")
            }
            .navigationTitle("Correct moment").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
