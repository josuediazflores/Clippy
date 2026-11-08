import Foundation

/// A believable journal for Demo mode, built relative to "now" in the phone's time zone so the
/// latest day always reads as today. Purely illustrative content; nothing here came from a device.
public enum DemoJournal {
    struct Entry { let hour: Int; let minute: Int; let title: String; let detail: String }

    static let today: [Entry] = [
        Entry(hour: 15, minute: 4, title: "Kickoff at the hackathon table",
              detail: "Laptops open across a long table, a whiteboard sketch of the Clippy idea behind them and sticky notes everywhere."),
        Entry(hour: 15, minute: 42, title: "Wiring up the prototype",
              detail: "A Raspberry Pi, a tiny camera module and a tangle of jumper wires next to an open terminal window."),
        Entry(hour: 16, minute: 25, title: "Coffee break",
              detail: "An iced coffee on the counter of a busy café. A short walk away from the screen."),
        Entry(hour: 17, minute: 8, title: "Fitting the 3D-printed case",
              detail: "A freshly printed case held up to the light, with the camera lens lined up in the opening."),
        Entry(hour: 17, minute: 51, title: "Recording the demo video",
              detail: "A phone on a small tripod pointed at the device while the team gathers behind the laptop."),
        Entry(hour: 18, minute: 32, title: "Heading home",
              detail: "Street lights coming on at dusk, seen from the sidewalk on the way to the bus stop."),
        Entry(hour: 19, minute: 18, title: "Dinner at home",
              detail: "A bowl of pasta and a glass of water at the kitchen table."),
        Entry(hour: 20, minute: 40, title: "Gaming session",
              detail: "A racing game on the TV and a controller in hand on the couch."),
        Entry(hour: 22, minute: 50, title: "Lights out",
              detail: "A dim bedroom, a phone charging on the nightstand."),
    ]
    static let todaySummary = "A full afternoon building Clippy at the hackathon, from wiring the prototype to recording the demo video. You headed home around 6:30, had dinner, and unwound with a few races before lights out a little before 11."
    static let todayPrompt = "What was the best part of building Clippy today, and what would you do differently tomorrow?"

    static let yesterday: [Entry] = [
        Entry(hour: 9, minute: 15, title: "Morning lecture", detail: "Rows of seats facing a projector screen full of diagrams."),
        Entry(hour: 12, minute: 30, title: "Lunch with friends", detail: "Sandwiches and chips on a crowded table in the student union."),
        Entry(hour: 15, minute: 10, title: "Sketching the hackathon idea", detail: "A notebook page with a rough drawing of a small wearable camera."),
        Entry(hour: 19, minute: 45, title: "Evening run", detail: "A paved trail along the water just after sunset."),
    ]
    static let yesterdaySummary = "A steady day: a morning lecture, lunch with friends, and the first sketch of the hackathon idea, finished with an evening run by the water."
    static let yesterdayPrompt = "What made the hackathon idea click for you?"

    static let earlier: [Entry] = [
        Entry(hour: 10, minute: 5, title: "Library study session", detail: "A quiet desk with a laptop, notes and a pair of headphones."),
        Entry(hour: 18, minute: 20, title: "Cooking with roommates", detail: "A stovetop with two pans going and someone chopping vegetables."),
    ]
    static let earlierSummary = "A quieter day of studying at the library, then cooking dinner with your roommates."
    static let earlierPrompt = "Who did you enjoy spending time with today?"

    /// Today, yesterday and two days ago, newest first. Today's moments include evening times by design.
    public static func days(now: Date = Date(), zone: TimeZone = .current) -> [Day] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let start = calendar.startOfDay(for: now)
        let stories: [(Int, [Entry], String, String)] = [
            (0, today, todaySummary, todayPrompt),
            (-1, yesterday, yesterdaySummary, yesterdayPrompt),
            (-2, earlier, earlierSummary, earlierPrompt),
        ]
        return stories.compactMap { offset, entries, summary, prompt in
            guard let dayStart = calendar.date(byAdding: .day, value: offset, to: start),
                  let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return nil }
            return day(start: dayStart, end: dayEnd, calendar: calendar, entries: entries, summary: summary, prompt: prompt)
        }
    }

    static func day(start: Date, end: Date, calendar: Calendar, entries: [Entry], summary: String, prompt: String) -> Day {
        let parts = calendar.dateComponents([.year, .month, .day], from: start)
        let stamp = String(format: "%04d%02d%02d", parts.year ?? 2026, parts.month ?? 1, parts.day ?? 1)
        let dayID = "day_" + stamp
        let moments: [Moment] = entries.enumerated().compactMap { index, entry in
            guard let at = calendar.date(bySettingHour: entry.hour, minute: entry.minute, second: 0, of: start) else { return nil }
            let captureID = "cap_demo_\(stamp)_\(String(format: "%03d", index + 1))"
            return Moment(schemaVersion: 1, momentId: "moment_" + captureID, capturedAt: Instants.string(at),
                          title: entry.title, detail: entry.detail, evidence: [Evidence(type: "capture", id: captureID)])
        }
        let recap = Recap(schemaVersion: 1, dayId: dayID, inputRevision: 1, recapRevision: 1, deletionGeneration: 0, state: "ready",
                          summary: summary, moments: moments, questions: nil, reflectionPrompt: prompt,
                          coverage: Coverage(captured: moments.count, observed: moments.count, missing: 0, throughAt: moments.last?.capturedAt),
                          providerVersion: "demo", promptVersion: "demo")
        return Day(schemaVersion: 1, dayId: dayID, timeZone: calendar.timeZone.identifier, startAt: Instants.string(start),
                   endAt: Instants.string(end), inputRevision: 1, deletionGeneration: 0, state: "ready", calendarFreshness: "unavailable",
                   recap: recap, corrections: [], reflections: [], failureCode: nil)
    }
}
