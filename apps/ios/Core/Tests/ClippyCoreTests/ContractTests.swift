import XCTest
@testable import ClippyCore

final class ContractTests: XCTestCase {
    private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }
    private func read(_ path: String) throws -> Data { try Data(contentsOf: root.appendingPathComponent(path)) }
    func testSharedFixturesAndTransitions() throws {
        let validator = try ContractValidator(schema: read("contracts/schema.json"), transitions: read("contracts/transitions.json"))
        struct Fixture: Decodable { let file: String; let schema: String; let valid: Bool }
        let fixtures = try JSONDecoder().decode([Fixture].self, from: read("fixtures/index.json"))
        for fixture in fixtures {
            let data = try read(fixture.file)
            if fixture.valid {
                XCTAssertNoThrow(try validator.validate(fixture.schema, data: data), fixture.file)
                XCTAssertNoThrow(try WireDecoder.decodeShape(fixture.schema, data: data), fixture.file)
            } else { XCTAssertThrowsError(try validator.validate(fixture.schema, data: data), fixture.file) }
        }
        let cases = try JSONSerialization.jsonObject(with: read("fixtures/transitions.json")) as! [[String: Any]]
        for item in cases {
            let data = try JSONSerialization.data(withJSONObject: item["value"]!)
            if item["valid"] as! Bool { XCTAssertNoThrow(try validator.validate("Transition", data: data)) }
            else { XCTAssertThrowsError(try validator.validate("Transition", data: data)) }
        }
        print("Swift: \(fixtures.count) shared fixtures + \(cases.count) state/revision cases passed")
    }
    func testTypedDayPreservesSourcesAndUserText() throws {
        let validator = try ContractValidator(schema: read("contracts/schema.json"), transitions: read("contracts/transitions.json"))
        let day = try validator.decode(Day.self, kind: "Day", data: read("fixtures/valid/day.json"))
        XCTAssertEqual(day.recap?.moments.first?.evidence.first?.id, "cap_sample_001")
        XCTAssertEqual(day.reflections.first?.text, "I enjoyed this synthetic day.")
        XCTAssertEqual(day.reflections.first?.revision, 1)
    }
}
