import Foundation
import CoreFoundation
import CryptoKit

public enum ContractFailure: Error { case invalid(String) }

// Deliberately limited to the frozen v1 schema vocabulary. This is not a general JSON Schema engine.
public struct ContractValidator {
    private let definitions: [String: Any]
    private let transitions: [String: [String: [String]]]
    public init(schema: Data, transitions: Data) throws {
        definitions = (try JSONSerialization.jsonObject(with: schema) as! [String: Any])["$defs"] as! [String: Any]
        self.transitions = try JSONDecoder().decode([String: [String: [String]]].self, from: transitions)
    }
    public func decode<T: Decodable>(_ type: T.Type, kind: String, data: Data) throws -> T {
        try validate(kind, data: data)
        return try JSONDecoder().decode(type, from: data)
    }
    public func validate(_ kind: String, data: Data) throws {
        let value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        guard let schema = definitions[kind] as? [String: Any], matches(value, schema), semantic(kind, value) else {
            throw ContractFailure.invalid(kind)
        }
    }
    private func matches(_ value: Any, _ schema: [String: Any]) -> Bool {
        if let ref = schema["$ref"] as? String {
            guard let target = definitions[String(ref.split(separator: "/").last!)] as? [String: Any] else { return false }
            return matches(value, target)
        }
        if let branches = schema["anyOf"] as? [[String: Any]] { return branches.contains { matches(value, $0) } }
        if let constant = schema["const"] { return equal(value, constant) }
        if let values = schema["enum"] as? [Any], !values.contains(where: { equal(value, $0) }) { return false }
        switch schema["type"] as? String {
        case "null": return value is NSNull
        case "object":
            guard let object = value as? [String: Any], let props = schema["properties"] as? [String: [String: Any]] else { return false }
            if let required = schema["required"] as? [String], !required.allSatisfy({ object[$0] != nil }) { return false }
            if schema["additionalProperties"] as? Bool == false && !Set(object.keys).isSubset(of: Set(props.keys)) { return false }
            return object.allSatisfy { key, item in props[key].map { matches(item, $0) } ?? true }
        case "array":
            guard let items = value as? [Any], let itemSchema = schema["items"] as? [String: Any] else { return false }
            return items.count >= (schema["minItems"] as? Int ?? 0) && items.count <= (schema["maxItems"] as? Int ?? Int.max) && items.allSatisfy { matches($0, itemSchema) }
        case "string":
            guard let text = value as? String else { return false }
            if text.unicodeScalars.count < (schema["minLength"] as? Int ?? 0) || text.unicodeScalars.count > (schema["maxLength"] as? Int ?? Int.max) { return false }
            if let pattern = schema["pattern"] as? String, text.range(of: pattern, options: .regularExpression) == nil { return false }
            if schema["format"] as? String == "date-time", instant(text) == nil { return false }
            if schema["format"] as? String == "uri", URL(string: text)?.scheme == nil { return false }
            return true
        case "integer", "number":
            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
            let v = n.doubleValue
            return v.isFinite && (schema["type"] as? String != "integer" || floor(v) == v) && v >= (schema["minimum"] as? Double ?? -Double.greatestFiniteMagnitude) && v <= (schema["maximum"] as? Double ?? Double.greatestFiniteMagnitude)
        case "boolean":
            guard let n = value as? NSNumber else { return false }
            return CFGetTypeID(n) == CFBooleanGetTypeID()
        default: return false
        }
    }
    private func equal(_ a: Any, _ b: Any) -> Bool {
        if let a = a as? NSNumber, let b = b as? NSNumber {
            return (CFGetTypeID(a) == CFBooleanGetTypeID()) == (CFGetTypeID(b) == CFBooleanGetTypeID()) && a == b
        }
        return (a as? String) != nil && (a as? String) == (b as? String)
    }
    private func instant(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: text), formatter.string(from: date) == text else { return nil }
        return date
    }
    private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func semantic(_ kind: String, _ value: Any) -> Bool {
        guard let v = value as? [String: Any] else { return true }
        if kind == "Capture" || kind == "ManifestEntry" {
            guard let date = instant(v["capturedAt"] as! String), let zone = TimeZone(identifier: v["timeZone"] as! String) else { return false }
            return zone.secondsFromGMT(for: date) == v["utcOffsetSeconds"] as! Int
        }
        if kind == "Manifest" {
            let entries = v["captures"] as! [[String: Any]], gaps = v["gaps"] as! [[String: Any]]
            let count = v["captureCount"] as! Int, start = v["sequenceStart"] as! Int, end = v["sequenceEnd"] as! Int
            guard entries.count == count, end >= start, end - start < 10000,
                  (v["startedAt"] as! String) <= (v["cutoffAt"] as! String),
                  Set(entries.map { $0["captureId"] as! String }).count == count,
                  Set(entries.map { $0["uploadId"] as! String }).count == count else { return false }
            var seen = Set<Int>()
            for entry in entries {
                let seq = entry["sequence"] as! Int
                guard semantic("Capture", entry), equal(entry["deviceId"]!, v["deviceId"]!), equal(entry["ownershipEpoch"]!, v["ownershipEpoch"]!),
                      (start...end).contains(seq), !seen.contains(seq),
                      entry["clockQuality"] as! String == "untrusted" || (entry["capturedAt"] as! String) <= (v["cutoffAt"] as! String) else { return false }
                seen.insert(seq)
            }
            for gap in gaps {
                let a = gap["sequenceStart"] as! Int, b = gap["sequenceEnd"] as! Int
                guard a >= start, b <= end, b >= a else { return false }
                for seq in a...b { if seen.contains(seq) { return false }; seen.insert(seq) }
            }
            return seen.count == end - start + 1
        }
        if kind == "CalendarBundle" {
            let snapshot = v["snapshot"] as! [String: Any], pages = v["pages"] as! [[String: Any]], completion = v["completion"] as! [String: Any]
            guard (snapshot["windowStart"] as! String) < (snapshot["windowEnd"] as! String), pages.count == snapshot["pageCount"] as! Int else { return false }
            var hashes: [String] = [], ids: [String] = []
            for (index, page) in pages.enumerated() {
                guard page["pageNumber"] as! Int == index, equal(page["snapshotId"]!, snapshot["snapshotId"]!),
                      let bytes = try? JSONSerialization.data(withJSONObject: page, options: [.sortedKeys, .withoutEscapingSlashes]) else { return false }
                hashes.append(hash(bytes))
                for event in page["occurrences"] as! [[String: Any]] {
                    guard (snapshot["selectedCalendarIds"] as! [String]).contains(event["calendarId"] as! String),
                          (event["startAt"] as! String) < (event["endAt"] as! String),
                          (event["startAt"] as! String) < (snapshot["windowEnd"] as! String),
                          (event["endAt"] as! String) > (snapshot["windowStart"] as! String),
                          TimeZone(identifier: event["timeZone"] as! String) != nil else { return false }
                    ids.append(event["occurrenceId"] as! String)
                }
            }
            return hashes == completion["pageHashes"] as! [String] && hash(Data(hashes.joined(separator: "\n").utf8)) == completion["completionDigest"] as! String && Set(ids).count == ids.count
        }
        if kind == "Transition" {
            return equal(v["revision"]!, v["expectedRevision"]!) && transitions[v["machine"] as! String]?[v["from"] as! String]?.contains(v["to"] as! String) == true
        }
        return true
    }
}
