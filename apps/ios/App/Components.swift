import SwiftUI
import ClippyCore

// Monochrome system: ink on paper, inverted in dark mode. No accent color.
extension Color {
    static let ink = Color.primary
    static let paper = Color(.systemBackground)
    static let hairline = Color.primary.opacity(0.12)
}

struct InkButtonStyle: ButtonStyle {
    var filled = true
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: ButtonStyleConfiguration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(filled ? Color.paper : Color.ink)
            .background(filled ? Color.ink : Color.clear, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.ink, lineWidth: filled ? 0 : 1))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.3)
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == InkButtonStyle {
    static var ink: InkButtonStyle { InkButtonStyle() }
    static var outline: InkButtonStyle { InkButtonStyle(filled: false) }
}

/// Small uppercase label above a group.
struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased()).font(.caption2.weight(.semibold)).tracking(1.4).foregroundStyle(.secondary)
    }
}

/// Icon plus one word, outlined.
struct Pill: View {
    let symbol: String
    let text: String
    var body: some View {
        Label(text, systemImage: symbol)
            .font(.footnote.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .overlay(Capsule().strokeBorder(Color.hairline))
    }
}

struct Hairline: View {
    var body: some View { Rectangle().fill(Color.hairline).frame(height: 1) }
}

/// The sparkle from the Clippy logo. Template-tinted: ink in light mode, white in dark mode.
struct Mark: View {
    var size: CGFloat = 64
    var body: some View {
        Image("Sparkle").resizable().renderingMode(.template).scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(Color.ink)
            .accessibilityHidden(true)
    }
}

/// The full "clippy" wordmark.
struct Wordmark: View {
    var height: CGFloat = 44
    var body: some View {
        Image("Logo").resizable().renderingMode(.template).scaledToFit()
            .frame(height: height)
            .foregroundStyle(Color.ink)
            .accessibilityLabel("Clippy")
    }
}

/// A large figure with a tiny caption, used in the device grid.
struct Metric: View {
    let symbol: String
    let value: String
    let caption: String
    var dimmed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol).font(.title3)
            Text(value).font(.title2.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
            Eyebrow(caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.hairline))
        .opacity(dimmed ? 0.45 : 1)
        .accessibilityElement(children: .combine)
    }
}

/// Banner shown only when something is off: offline, queued edits, demo data.
struct StatusStrip: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        let items = strip
        if !items.isEmpty {
            let pills = ForEach(items, id: \.id) { Pill(symbol: $0.symbol, text: $0.text).accessibilityIdentifier($0.id) }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { pills; Spacer(minLength: 0) }
                VStack(alignment: .leading, spacing: 8) { pills }
            }
        }
    }
    private var strip: [(symbol: String, text: String, id: String)] {
        var items: [(symbol: String, text: String, id: String)] = []
        if app.offline { items.append(("wifi.slash", "Offline", "state-offline")) }
        let queued = app.pending.filter { $0.status == .pending }.count
        if queued > 0 { items.append(("arrow.up.circle", "\(queued) queued", "queued-edits")) }
        if app.mode == .demo { items.append(("sparkles", "Demo", "mode-demo")) }
        if app.mode == .fixture { items.append(("eye", "Preview", "mode-preview")) }
        return items
    }
}
