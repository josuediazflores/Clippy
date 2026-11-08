import SwiftUI
import VisionKit
import AVFoundation
import ClippyCore

struct DeviceView: View {
    @Environment(AppModel.self) private var app
    @State private var model = DeviceModel()
    @State private var pairing = false

    private var deviceID: String? { app.devices.first?.deviceId }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                StatusStrip()
                if deviceID != nil { device } else { empty }
            }
            .padding(.horizontal, 24).padding(.vertical, 12)
        }
        .background(Color.paper)
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await reload() }
        .task(id: deviceID) { await reload() }
        .onDisappear { model.stop() }
        .sheet(isPresented: $pairing, onDismiss: { Task { await app.refresh() } }) { PairingView() }
    }

    private func reload() async {
        guard let deviceID, let services = app.services else { return }
        await model.load(deviceID, services: services)
    }

    private var empty: some View {
        VStack(spacing: 24) {
            Mark(size: 72)
            Text("No Clippy").font(.title2.weight(.semibold)).accessibilityIdentifier("no-device")
            Button("Pair") { pairing = true }.buttonStyle(.ink).frame(maxWidth: 220).disabled(app.readOnly).accessibilityIdentifier("pair")
        }
        .frame(maxWidth: .infinity).padding(.top, 140)
    }

    @ViewBuilder private var device: some View {
        let status = DeviceStatus(model.detail?.state)
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(deviceID ?? "")
            Wordmark(height: 46).padding(.vertical, 4)
            HStack(spacing: 8) {
                Pill(symbol: status.state?.connectivity == "online" ? "wifi" : "wifi.slash", text: status.connectivity)
                Pill(symbol: "clock", text: status.seen).accessibilityIdentifier(status.isStale ? "seen-stale" : "seen-fresh")
            }
        }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            Metric(symbol: status.captureSymbol, value: status.capture, caption: "Camera")
            Metric(symbol: status.batterySymbol, value: status.battery, caption: status.isStale ? "Last known" : "Battery", dimmed: status.isStale)
            Metric(symbol: "photo.stack", value: status.queue, caption: "Queued", dimmed: status.isStale)
            Metric(symbol: "checkmark.seal", value: model.configApplied ? "Applied" : "Pending", caption: "Settings")
        }
        sync
        settings
        if let message = model.status { Text(message).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("device-status") }
        Button("Pair another") { pairing = true }.buttonStyle(.outline).disabled(app.readOnly)
    }

    @ViewBuilder private var sync: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow("Sync")
            if let progress = model.syncProgress, !progress.isFinished || progress.state == "uploaded" || progress.state == "cancelled" {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(progress.label).font(.headline).accessibilityIdentifier("sync-status")
                        Spacer()
                        if progress.canCancel, let services = app.services {
                            Button("Cancel") { Task { await model.cancelSync(services: services) } }.font(.subheadline).accessibilityIdentifier("sync-cancel")
                        }
                    }
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.hairline)
                            Capsule().fill(Color.ink).frame(width: max(6, proxy.size.width * progress.fraction))
                        }
                    }
                    .frame(height: 4)
                    .animation(.easeInOut, value: progress.fraction)
                }
                if progress.isFinished, let services = app.services {
                    Button("Sync again") { Task { await model.syncNow(services: services) } }.buttonStyle(.outline)
                }
            } else {
                Button("Sync now") { if let services = app.services { Task { await model.syncNow(services: services) } } }
                    .buttonStyle(.ink).disabled(app.readOnly || app.offline || model.busy)
                    .accessibilityIdentifier("sync-now")
            }
        }
    }

    @ViewBuilder private var settings: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("Capture").padding(.bottom, 12)
            Picker("Every", selection: $model.draft.intervalMinutes) {
                ForEach([5, 10, 15, 30], id: \.self) { Text("\($0)m").tag($0) }
            }
            .pickerStyle(.segmented).padding(.bottom, 16)
            Toggle("Nightly sync", isOn: $model.draft.automaticSync).padding(.vertical, 12)
            Hairline()
            if model.draft.automaticSync {
                DatePicker("Time", selection: nightlyBinding, displayedComponents: .hourAndMinute).padding(.vertical, 12)
                Hairline()
            }
            Toggle("Only when charging", isOn: $model.draft.chargingOnly).padding(.vertical, 12)
            if model.configDirty, let services = app.services {
                Button("Save") { Task { await model.saveConfig(services: services, timeZone: app.latest?.timeZone ?? "UTC") } }
                    .buttonStyle(.ink).disabled(model.busy || app.readOnly).padding(.top, 12)
                    .accessibilityIdentifier("save-config")
            }
        }
        .tint(.primary)
    }

    private var nightlyBinding: Binding<Date> {
        Binding(
            get: {
                let parts = model.draft.nightlyTime.split(separator: ":").compactMap { Int($0) }
                return Calendar.current.date(from: DateComponents(hour: parts.first ?? 2, minute: parts.last ?? 0)) ?? Date()
            },
            set: { date in
                let c = Calendar.current.dateComponents([.hour, .minute], from: date)
                model.draft.nightlyTime = String(format: "%02d:%02d", c.hour ?? 2, c.minute ?? 0)
            }
        )
    }
}

// MARK: Pairing

struct PairingView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model = PairingModel()
    @State private var manual = false
    @State private var manualText = ""
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                switch model.step {
                case .scan: scan
                case .claiming, .confirming: Spacer(); ProgressView().controlSize(.large); Spacer()
                case .code: code
                case .done: result(symbol: "checkmark.circle", text: "Paired", id: "pairing-done")
                case .failed(let message): result(symbol: "xmark.circle", text: message, id: "pairing-failed")
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.paper)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .animation(.easeInOut, value: model.step)
        }
    }

    @ViewBuilder private var scan: some View {
        ScannerFrame { text in Task { if let services = app.services { await model.scanned(text, services: services) } } }
        Text("Scan the code on Clippy").font(.title3.weight(.semibold))
        Spacer()
        if manual {
            TextField("clippy://pair?…", text: $manualText)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(.vertical, 10).overlay(alignment: .bottom) { Hairline() }
                .accessibilityIdentifier("pairing-input")
            Button("Continue") { Task { if let services = app.services { await model.scanned(manualText, services: services) } } }
                .buttonStyle(.ink).disabled(manualText.isEmpty).accessibilityIdentifier("pairing-submit")
        } else {
            Button("Enter code") { manual = true }.buttonStyle(.outline).accessibilityIdentifier("pairing-manual")
        }
    }

    @ViewBuilder private var code: some View {
        @Bindable var model = model
        Spacer()
        Mark(size: 48)
        Text("Code on Clippy").font(.title3.weight(.semibold))
        TextField("000000", text: $model.code)
            .font(.system(size: 44, weight: .semibold, design: .monospaced)).multilineTextAlignment(.center)
            .keyboardType(.numberPad).focused($codeFocused)
            .onChange(of: model.code) { _, new in model.code = String(new.filter(\.isNumber).prefix(6)) }
            .accessibilityIdentifier("pairing-code")
        if let failed = model.failedCode { Text(failed).font(.footnote).foregroundStyle(.secondary) }
        Spacer()
        Button("Confirm") { Task { if let services = app.services { await model.confirm(services: services) } } }
            .buttonStyle(.ink).disabled(model.code.count != 6).accessibilityIdentifier("pairing-confirm")
            .onAppear { codeFocused = true }
    }

    @ViewBuilder private func result(symbol: String, text: String, id: String) -> some View {
        Spacer()
        Image(systemName: symbol).font(.system(size: 64, weight: .light))
        Text(text).font(.title2.weight(.semibold)).multilineTextAlignment(.center).accessibilityIdentifier(id)
        Spacer()
        if case .done = model.step { Button("Done") { dismiss() }.buttonStyle(.ink) }
        else { Button("Try again") { model.reset() }.buttonStyle(.outline) }
    }
}

/// Square camera viewfinder. Falls back to a plain frame on the simulator or when camera access is off.
struct ScannerFrame: View {
    let onCode: (String) -> Void
    @State private var authorization = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        RoundedRectangle(cornerRadius: 28)
            .fill(Color.ink)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if authorization == .denied || authorization == .restricted {
                    VStack(spacing: 14) {
                        Image(systemName: "camera.fill").font(.largeTitle)
                        Text("Camera off").font(.headline)
                        Button("Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(Color.paper)
                    .accessibilityIdentifier("camera-denied")
                } else if DataScannerViewController.isSupported, authorization == .authorized {
                    QRScanner(onCode: onCode).clipShape(RoundedRectangle(cornerRadius: 28))
                } else {
                    Image(systemName: "qrcode.viewfinder").font(.system(size: 72, weight: .ultraLight)).foregroundStyle(Color.paper.opacity(0.7))
                }
            }
            .task {
                if authorization == .notDetermined, DataScannerViewController.isSupported {
                    _ = await AVCaptureDevice.requestAccess(for: .video)
                    authorization = AVCaptureDevice.authorizationStatus(for: .video)
                }
            }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) { scanner.stopScanning() }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var delivered = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for case .barcode(let code) in items {
                if let value = code.payloadStringValue { delivered = true; onCode(value); return }
            }
        }
    }
}
