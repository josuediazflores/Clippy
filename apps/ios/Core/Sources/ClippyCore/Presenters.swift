import Foundation

// MARK: Pairing QR

/// Payload shown as a QR on an unclaimed device: `clippy://pair?v=1&d=<deviceId>&c=<challengeId>`.
/// Proposed in P06 (decision D41); P05 renders it and P07 freezes it.
public struct PairingCode: Sendable, Equatable {
    public let deviceID: String
    public let challengeID: String

    public init?(_ text: String) {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "clippy", components.host == "pair" else { return nil }
        let value = { (name: String) in components.queryItems?.first { $0.name == name }?.value }
        guard value("v") == "1", let device = value("d"), let challenge = value("c"),
              PairingCode.isID(device), PairingCode.isID(challenge) else { return nil }
        deviceID = device; challengeID = challenge
    }

    public var url: String { "clippy://pair?v=1&d=\(deviceID)&c=\(challengeID)" }
    public var claimInput: ClaimInput { ClaimInput(schemaVersion: 1, deviceId: deviceID, challengeId: challengeID) }

    /// Contract `Id`: `^[a-z][a-z0-9_]{2,95}$`.
    public static func isID(_ value: String) -> Bool {
        value.range(of: "^[a-z][a-z0-9_]{2,95}$", options: .regularExpression) != nil
    }
}

// MARK: Time

public enum Instants {
    public static func date(_ instant: String?) -> Date? {
        guard let instant else { return nil }
        return try? Date(instant, strategy: .iso8601)
    }
    /// Contract `Instant`: whole seconds, UTC, trailing `Z`.
    public static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = .gmt
        return formatter.string(from: date)
    }
    public static func zone(_ name: String) -> TimeZone { TimeZone(identifier: name) ?? .gmt }
    /// "09:40" in the day's journal time zone.
    public static func clock(_ instant: String, zone: String) -> String {
        guard let date = date(instant) else { return "--:--" }
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = Instants.zone(zone)
        return date.formatted(style)
    }
    /// "Sat, Nov 7".
    public static func dayTitle(_ instant: String, zone: String) -> String {
        guard let date = date(instant) else { return "" }
        var style = Date.FormatStyle().weekday(.abbreviated).month(.abbreviated).day()
        style.timeZone = Instants.zone(zone)
        return date.formatted(style)
    }
    public static func relative(_ instant: String?, now: Date) -> String? {
        guard let date = date(instant) else { return nil }
        if now.timeIntervalSince(date) < 60 { return "now" }
        return date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated).locale(Locale(identifier: "en_US")))
    }
}

// MARK: Sync progress

public struct SyncProgress: Sendable, Equatable {
    public static let steps = ["waiting_for_device", "preparing", "uploading", "verifying", "uploaded"]
    public let state: String
    public init(_ state: String) { self.state = state }

    public var isFinished: Bool { ["uploaded", "cancelled", "failed_terminal"].contains(state) }
    public var canCancel: Bool { !isFinished && state != "cancel_requested" }
    public var isProblem: Bool { ["failed_retryable", "failed_terminal", "waiting_for_network", "waiting_for_power"].contains(state) }

    /// 0...1 along the happy path. Waiting branches keep the last reached step.
    public var fraction: Double {
        switch state {
        case "requested": 0.05
        case "waiting_for_network", "waiting_for_power", "failed_retryable": 0.3
        case "cancel_requested", "cancelled", "failed_terminal": 0
        default: Double((SyncProgress.steps.firstIndex(of: state) ?? 0) + 1) / Double(SyncProgress.steps.count)
        }
    }

    public var label: String {
        switch state {
        case "requested": "Requested"
        case "waiting_for_device": "Waiting for Clippy"
        case "preparing": "Preparing"
        case "uploading": "Uploading"
        case "verifying": "Verifying"
        case "uploaded": "Uploaded"
        case "waiting_for_network": "No Wi-Fi"
        case "waiting_for_power": "Needs power"
        case "cancel_requested": "Cancelling"
        case "cancelled": "Cancelled"
        case "failed_retryable": "Retrying"
        case "failed_terminal": "Failed"
        default: state
        }
    }
}

// MARK: Device status

public struct DeviceStatus: Sendable {
    /// Values older than this are shown as last known, not current.
    public static let staleAfter: TimeInterval = 30 * 60
    public let state: DeviceState?
    public let now: Date
    public init(_ state: DeviceState?, now: Date = Date()) { self.state = state; self.now = now }

    public var isStale: Bool {
        guard let observed = Instants.date(state?.observedAt) else { return true }
        return now.timeIntervalSince(observed) > DeviceStatus.staleAfter
    }

    public var capture: String {
        switch state?.captureState {
        case "capturing": "On"
        case "paused": "Paused"
        case "storage_full": "Storage full"
        case "camera_error": "Camera error"
        case "disabled": "Off"
        default: "Unknown"
        }
    }

    public var captureSymbol: String {
        switch state?.captureState {
        case "capturing": "camera.fill"
        case "paused": "pause.fill"
        case "storage_full": "externaldrive.badge.xmark"
        case "camera_error": "exclamationmark.triangle"
        default: "camera"
        }
    }

    public var battery: String {
        guard let percent = state?.batteryPercent else { return "--" }
        return "\(percent)%" + (state?.charging == true ? " ⚡︎" : "")
    }

    public var batterySymbol: String {
        guard let percent = state?.batteryPercent else { return "battery.0percent" }
        if state?.charging == true { return "battery.100percent.bolt" }
        switch percent {
        case 76...: return "battery.100percent"
        case 51...: return "battery.75percent"
        case 26...: return "battery.50percent"
        case 11...: return "battery.25percent"
        default: return "battery.0percent"
        }
    }

    public var connectivity: String {
        switch state?.connectivity {
        case "online": "Online"
        case "offline": "Offline"
        default: "Unknown"
        }
    }

    public var queue: String {
        guard let count = state?.queuedCaptures else { return "--" }
        return "\(count)"
    }

    public var seen: String { Instants.relative(state?.observedAt, now: now) ?? "Never" }
}

// MARK: Day status

public enum DayStatus {
    public static func label(_ state: String) -> String {
        switch state {
        case "pending": "Processing"
        case "partial": "Partial"
        case "ready": "Ready"
        case "failure": "Failed"
        default: "Empty"
        }
    }
    public static func symbol(_ state: String) -> String {
        switch state {
        case "pending": "circle.dashed"
        case "partial": "circle.lefthalf.filled"
        case "ready": "circle.fill"
        case "failure": "exclamationmark.circle"
        default: "circle"
        }
    }
}

public enum DeletionStatus {
    public static func label(_ job: DeletionJob) -> String {
        switch job.state {
        case "complete": "Deleted"
        case "waiting_for_clients": job.pendingDeviceIds.isEmpty ? "Deleted" : "Deleted from cloud. Clippy will clear its copy when it reconnects."
        case "failed_retryable": "Retrying"
        case "failed_terminal": "Failed"
        default: "Deleting"
        }
    }
    public static func settled(_ job: DeletionJob) -> Bool { ["complete", "waiting_for_clients", "failed_terminal"].contains(job.state) }
}
