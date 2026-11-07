import SwiftUI
import ClippyCore

@main
struct ClippyApp: App {
    var body: some Scene { WindowGroup { FoundationView() } }
}
struct FoundationView: View {
    private var day: Day? {
        guard let url = Bundle.main.url(forResource: "day", withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Day.self, from: data)
    }
    var body: some View {
        NavigationStack {
            List {
                Section("Local foundation") { Text("Synthetic data only") }
                Section("November 7, 2026") {
                    Text(day?.recap?.summary ?? "No recap yet")
                    ForEach(day?.recap?.moments ?? [], id: \.momentId) { Text($0.title) }
                }
            }
            .navigationTitle("Clippy")
        }
    }
}
