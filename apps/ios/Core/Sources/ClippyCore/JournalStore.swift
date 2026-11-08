import Foundation

/// On-disk snapshot of everything needed to read the journal offline.
public struct CachedJournal: Codable, Sendable {
    public static let currentFormat = 1
    public var format: Int
    public var days: [Day]
    public var deviceIDs: [String]
    public init(format: Int = CachedJournal.currentFormat, days: [Day] = [], deviceIDs: [String] = []) {
        self.format = format; self.days = days; self.deviceIDs = deviceIDs
    }
}

/// Actor-owned cache for completed recaps. Writes are atomic file replacements.
public actor JournalStore {
    private let url: URL
    private let legacyDayURL: URL?
    private var value: CachedJournal?

    /// - Parameter legacyDayURL: the P03 single-day cache. It is imported once, then removed.
    public init(url: URL, legacyDayURL: URL? = nil) { self.url = url; self.legacyDayURL = legacyDayURL }

    public func read() -> CachedJournal {
        if let value { return value }
        var loaded = CachedJournal()
        if let data = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode(CachedJournal.self, from: data), decoded.format <= CachedJournal.currentFormat {
            loaded = decoded
        } else if let legacyDayURL, let data = try? Data(contentsOf: legacyDayURL), let day = try? JSONDecoder().decode(Day.self, from: data) {
            loaded = CachedJournal(days: [day])
            try? persist(loaded)
            try? FileManager.default.removeItem(at: legacyDayURL)
        }
        value = loaded
        return loaded
    }

    public func day(_ id: String) -> Day? { read().days.first { $0.dayId == id } }

    /// Replaces the day list. Days are kept newest first.
    public func replaceDays(_ days: [Day]) throws {
        var journal = read()
        journal.days = days.sorted { $0.startAt > $1.startAt }
        try persist(journal)
    }

    public func upsert(_ day: Day) throws {
        var journal = read()
        journal.days.removeAll { $0.dayId == day.dayId }
        journal.days.append(day)
        journal.days.sort { $0.startAt > $1.startAt }
        try persist(journal)
    }

    public func remove(dayID: String) throws {
        var journal = read()
        journal.days.removeAll { $0.dayId == dayID }
        try persist(journal)
    }

    public func setDevices(_ ids: [String]) throws {
        var journal = read()
        journal.deviceIDs = ids
        try persist(journal)
    }

    public func clear() throws {
        value = CachedJournal()
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    private func persist(_ journal: CachedJournal) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(journal).write(to: url, options: [.atomic, .completeFileProtection])
        value = journal
    }
}
