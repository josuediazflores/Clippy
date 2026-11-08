import SwiftUI
import ClippyCore

struct MomentRoute: Hashable { let dayID: String; let momentID: String }
struct DayRoute: Hashable { let dayID: String }

extension AppModel {
    /// The user's wording wins over generated text: queued edit, then saved correction, then the model's title.
    func title(for moment: Moment, in day: Day) -> String {
        let recordID = EditRecordID.correction(momentID: moment.momentId)
        if let queued = pendingEdit(recordID, dayID: day.dayId), !queued.isRejected { return queued.edit.text }
        return day.corrections.last { $0.momentId == moment.momentId && !$0.deleted }?.text ?? moment.title
    }
}

// MARK: Today

struct HomeView: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                StatusStrip()
                if let day = app.latest { DayContent(day: day, headline: "Today") }
                else { EmptyJournal(loading: app.loading) }
            }
            .padding(.horizontal, 24).padding(.vertical, 12)
        }
        .refreshable { await app.refresh() }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.paper)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: MomentRoute.self) { MomentDetailView(route: $0) }
    }
}

struct EmptyJournal: View {
    let loading: Bool
    var body: some View {
        VStack(spacing: 20) {
            Mark(size: 56).opacity(loading ? 0.3 : 1)
            Text(loading ? "Loading" : "Nothing yet").font(.title3).foregroundStyle(.secondary)
                .accessibilityIdentifier(loading ? "state-loading" : "state-empty")
        }
        .frame(maxWidth: .infinity).padding(.top, 160)
    }
}

// MARK: Shared day layout

struct DayContent: View {
    @Environment(AppModel.self) private var app
    let day: Day
    var headline: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 36) {
            header
            if let recap = day.recap {
                Text(recap.summary)
                    .font(.title3).lineSpacing(4)
                    .accessibilityIdentifier("recap-summary")
                if !recap.moments.isEmpty { timeline(recap) }
                ReflectionEditor(day: day, prompt: recap.reflectionPrompt)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(Instants.dayTitle(day.startAt, zone: day.timeZone))
            Text(headline ?? Instants.dayTitle(day.startAt, zone: day.timeZone))
                .font(.system(.largeTitle, weight: .bold))
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { statusParts(separated: true) }
                VStack(alignment: .leading, spacing: 4) { statusParts(separated: false) }
            }
            .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    @ViewBuilder private func statusParts(separated: Bool) -> some View {
        Label(DayStatus.label(day.state), systemImage: DayStatus.symbol(day.state)).accessibilityIdentifier("state-\(day.state)")
        if let coverage = day.recap?.coverage {
            if separated { Text("·") }
            Text("\(coverage.observed)/\(coverage.captured)").monospacedDigit().accessibilityIdentifier("coverage")
            if let through = coverage.throughAt {
                if separated { Text("·") }
                Text(Instants.clock(through, zone: day.timeZone)).monospacedDigit()
            }
        }
    }

    private func timeline(_ recap: Recap) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("Moments").padding(.bottom, 14)
            ForEach(Array(recap.moments.enumerated()), id: \.element.momentId) { index, moment in
                NavigationLink(value: MomentRoute(dayID: day.dayId, momentID: moment.momentId)) {
                    HStack(alignment: .top, spacing: 16) {
                        Text(Instants.clock(moment.capturedAt, zone: day.timeZone))
                            .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                            .lineLimit(1).fixedSize()
                            .frame(width: 72, alignment: .leading)
                        VStack(spacing: 0) {
                            Circle().fill(Color.ink).frame(width: 7, height: 7).padding(.top, 6)
                            if index < recap.moments.count - 1 { Rectangle().fill(Color.hairline).frame(width: 1).frame(maxHeight: .infinity) }
                        }
                        Text(app.title(for: moment, in: day))
                            .font(.body.weight(.medium)).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.bottom, 22)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).padding(.top, 4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("moment-\(moment.momentId)")
            }
        }
    }
}

// MARK: Reflection

struct ReflectionEditor: View {
    @Environment(AppModel.self) private var app
    let day: Day
    let prompt: String
    @State private var draft = ""
    @State private var dirty = false
    @State private var state: AppModel.SaveState = .idle
    @FocusState private var focused: Bool

    private var serverText: String? { day.reflections.first { $0.recordId == EditRecordID.reflection && !$0.deleted }?.text }
    private var queued: PendingEdit? { app.pendingEdit(EditRecordID.reflection, dayID: day.dayId) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow("Reflect")
            Text(prompt).font(.body).foregroundStyle(.secondary)
            TextField("Write", text: $draft, axis: .vertical)
                .font(.body).lineLimit(2...8).focused($focused)
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) { Hairline() }
                .onChange(of: draft) { _, new in if focused { dirty = new != resolvedServer; state = .idle } }
                .disabled(app.readOnly)
                .accessibilityIdentifier("reflection-editor")
            HStack {
                saveIndicator
                Spacer()
                Button("Save") { Task { await save() } }
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 20).padding(.vertical, 9)
                    .foregroundStyle(Color.paper).background(Color.ink, in: Capsule())
                    .opacity(canSave ? 1 : 0.25)
                    .disabled(!canSave)
                    .accessibilityIdentifier("save-reflection")
            }
            if queued?.isConflict == true { ConflictChoice(recordID: EditRecordID.reflection, dayID: day.dayId) }
        }
        .onAppear { draft = resolvedServer }
        .onChange(of: day.reflections.map(\.revision)) { if !dirty { draft = resolvedServer } }
        .onChange(of: queued?.edit.operationId) { if !dirty { draft = resolvedServer } }
    }

    private var resolvedServer: String { EditorText.resolve(server: serverText, pending: queued, draft: draft, dirty: false) }
    private var canSave: Bool { !app.readOnly && state != .saving && (dirty || queued?.status == .pending) }

    @ViewBuilder private var saveIndicator: some View {
        switch state {
        case .saving: ProgressView().controlSize(.small)
        case .saved: Label("Saved", systemImage: "checkmark").font(.footnote).accessibilityIdentifier("save-status")
        case .queued: Label("Queued", systemImage: "arrow.up.circle").font(.footnote).accessibilityIdentifier("save-status")
        case .failed: Label("Failed", systemImage: "xmark").font(.footnote).accessibilityIdentifier("save-status")
        case .conflict, .idle: EmptyView()
        }
    }

    private func save() async {
        state = .saving
        let result = await app.saveReflection(day: day, text: draft)
        state = result
        if result != .failed { dirty = false; focused = false }
    }
}

struct ConflictChoice: View {
    @Environment(AppModel.self) private var app
    let recordID: String
    let dayID: String
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.branch")
            Text("Changed elsewhere").font(.footnote)
            Spacer()
            Button("Keep mine") { Task { await app.keepMine(recordID, dayID: dayID) } }.font(.footnote.weight(.semibold))
            Button("Use theirs") { Task { await app.useTheirs(recordID, dayID: dayID) } }.font(.footnote)
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.ink))
        .accessibilityIdentifier("conflict-\(recordID)")
    }
}

// MARK: Moment

struct MomentDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let route: MomentRoute
    @State private var image: UIImage?
    @State private var imageMissing = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var notice: String?

    private var day: Day? { app.day(route.dayID) }
    private var moment: Moment? { day?.recap?.moments.first { $0.momentId == route.momentID } }
    private var captureID: String? { moment?.evidence.first { $0.type == "capture" }?.id }

    var body: some View {
        ScrollView {
            if let day, let moment {
                VStack(alignment: .leading, spacing: 24) {
                    photo
                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow(Instants.dayTitle(moment.capturedAt, zone: day.timeZone) + "  " + Instants.clock(moment.capturedAt, zone: day.timeZone))
                        Text(app.title(for: moment, in: day)).font(.system(.title, weight: .bold)).accessibilityIdentifier("moment-title")
                        Text(moment.detail).font(.body).foregroundStyle(.secondary)
                    }
                    if app.pendingEdit(EditRecordID.correction(momentID: moment.momentId), dayID: day.dayId)?.isConflict == true {
                        ConflictChoice(recordID: EditRecordID.correction(momentID: moment.momentId), dayID: day.dayId)
                    }
                    if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                }
                .padding(24)
            }
        }
        .background(Color.paper)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Edit", systemImage: "pencil") { editing = true }.disabled(app.readOnly).accessibilityIdentifier("edit-moment")
            }
            if captureID != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Delete photo", systemImage: "trash") { confirmDelete = true }.disabled(app.readOnly).accessibilityIdentifier("delete-capture")
                }
            }
        }
        .confirmationDialog("Delete photo?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        }
        .sheet(isPresented: $editing) {
            if let day, let moment { CorrectionSheet(day: day, moment: moment, initial: app.title(for: moment, in: day)) }
        }
        .task(id: captureID) { await loadImage() }
    }

    private var photo: some View {
        RoundedRectangle(cornerRadius: 22)
            .fill(Color.ink.opacity(0.05))
            .aspectRatio(4 / 3, contentMode: .fit)
            .overlay {
                if let image { Image(uiImage: image).resizable().scaledToFill() }
                else { Image(systemName: imageMissing ? "photo" : "camera.aperture").font(.largeTitle).foregroundStyle(.tertiary) }
            }
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .accessibilityLabel(image == nil ? "No photo" : "Photo")
    }

    private func loadImage() async {
        guard let captureID, let services = app.services, image == nil else { return }
        if let data = try? await services.captureImage(captureID), let decoded = UIImage(data: data) { image = decoded } else { imageMissing = true }
    }

    private func delete() async {
        guard let captureID else { return }
        notice = await app.deleteCapture(captureID, dayID: route.dayID)
        if moment == nil { dismiss() }
    }
}

struct CorrectionSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let day: Day
    let moment: Moment
    @State private var text: String
    @State private var saving = false
    @State private var failed = false
    @FocusState private var focused: Bool

    init(day: Day, moment: Moment, initial: String) { self.day = day; self.moment = moment; _text = State(initialValue: initial) }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                TextField("Title", text: $text, axis: .vertical)
                    .font(.system(.title, weight: .bold)).focused($focused)
                    .padding(.vertical, 8).overlay(alignment: .bottom) { Hairline() }
                    .accessibilityIdentifier("correction-editor")
                if failed { Label("Failed", systemImage: "xmark").font(.footnote) }
                Spacer()
                Button("Save") { Task { await save() } }
                    .buttonStyle(.ink).disabled(saving || text.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("save-correction")
            }
            .padding(24)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
    }

    private func save() async {
        saving = true; defer { saving = false }
        let result = await app.saveCorrection(day: day, moment: moment, text: text)
        if result == .failed { failed = true } else { dismiss() }
    }
}

// MARK: History

struct HistoryView: View {
    @Environment(AppModel.self) private var app
    @State private var deleting: Day?
    @State private var notice: String?

    var body: some View {
        List {
            ForEach(app.days, id: \.dayId) { day in
                NavigationLink(value: DayRoute(dayID: day.dayId)) {
                    HStack(spacing: 14) {
                        Image(systemName: DayStatus.symbol(day.state)).font(.footnote).frame(width: 18)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(Instants.dayTitle(day.startAt, zone: day.timeZone)).font(.headline)
                            Text(DayStatus.label(day.state)).font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(day.recap?.moments.count ?? 0)").font(.title3.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }
                .accessibilityIdentifier("day-\(day.dayId)")
                .swipeActions {
                    if !app.readOnly { Button("Delete", systemImage: "trash", role: .destructive) { deleting = day } }
                }
            }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary).listRowSeparator(.hidden) }
        }
        .listStyle(.plain)
        .overlay { if app.days.isEmpty { EmptyJournal(loading: app.loading) } }
        .refreshable { await app.refresh() }
        .navigationTitle("History")
        .navigationDestination(for: DayRoute.self) { route in
            ScrollView {
                if let day = app.day(route.dayID) { DayContent(day: day).padding(24) }
            }
            .background(Color.paper)
            .navigationBarTitleDisplayMode(.inline)
        }
        .navigationDestination(for: MomentRoute.self) { MomentDetailView(route: $0) }
        .confirmationDialog("Delete this day?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) { if let day = deleting { Task { notice = await app.deleteDay(day) } } }
        }
    }
}
