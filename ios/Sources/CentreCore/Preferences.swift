import Foundation

/// The portable preferences contract. Unrecognized stored fields survive edits by older clients.
public enum StudyPreferences {
    public static let defaults: JSONValue = .object([
        "nickname": .string(""), "theme": .string("dark"), "density": .string("compact"),
        "textSize": .string("standard"), "studentYearLevel": .number(9), "timeZone": .string("Australia/Sydney"),
        "responseStyle": .string("balanced"), "defaultQuizQuestions": .number(8), "defaultTestLengthMode": .string("time"),
        "defaultTestMinutes": .number(45), "defaultTestQuestions": .number(10),
        "defaultQuizQuestionTypes": .array(responseTypes.map(JSONValue.string)),
        "defaultTestQuestionTypes": .array(responseTypes.map(JSONValue.string)), "defaultDifficulty": .string("standard"),
        "readingFont": .string("default"), "readingWidth": .string("standard"), "lineSpacing": .string("standard"),
        "reducedMotion": .string("system"), "contrast": .string("standard"), "sendKey": .string("enter"),
        "activityVisibility": .string("collapsed"), "greetingStyle": .string("rotating"),
        "defaultFlashcardCountMode": .string("auto"), "defaultFlashcardCount": .number(8)
    ])
    public static let responseTypes = ["multiple_choice", "short_response", "long_response"]
    private static let choices: [String: Set<String>] = [
        "theme": ["dark", "light", "midnight", "system"], "density": ["compact", "comfortable"],
        "textSize": ["small", "standard", "large", "extra-large"], "responseStyle": ["concise", "balanced", "detailed"],
        "defaultTestLengthMode": ["time", "questions"], "defaultDifficulty": ["gentle", "standard", "challenging"],
        "readingFont": ["default", "sans", "serif"], "readingWidth": ["standard", "narrow", "wide"],
        "lineSpacing": ["standard", "relaxed"], "reducedMotion": ["system", "reduce"], "contrast": ["standard", "more"],
        "sendKey": ["enter", "modifier-enter"], "activityVisibility": ["collapsed", "expanded"],
        "greetingStyle": ["rotating", "simple"], "defaultFlashcardCountMode": ["auto", "fixed"]
    ]
    private static let bounds: [String: ClosedRange<Int>] = [
        "studentYearLevel": 7...12, "defaultQuizQuestions": 1...30, "defaultTestQuestions": 1...30,
        "defaultTestMinutes": 5...180, "defaultFlashcardCount": 1...30
    ]
    public static func validatedPatch(_ patch: JSONValue) throws -> JSONValue {
        guard case .object(var fields) = patch else { throw CentreError.invalid("Invalid preferences.") }
        for (key, value) in fields {
            if let values = choices[key] {
                guard let string = value.string, values.contains(string) else { throw invalid(key) }
            } else if let range = bounds[key] {
                guard let integer = value.int, range.contains(integer) else { throw invalid(key) }
            } else if key == "nickname" {
                guard let string = value.string else { throw invalid(key) }
                let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
                guard trimmed.utf16.count <= 60 else { throw invalid(key) }
                fields[key] = .string(trimmed)
            } else if key == "timeZone" {
                guard let zone = value.string, zone.utf16.count <= 100, TimeZone(identifier: zone) != nil else { throw invalid(key) }
            } else if key == "defaultQuizQuestionTypes" || key == "defaultTestQuestionTypes" {
                guard case .array(let items) = value, !items.isEmpty else { throw invalid(key) }
                let strings = items.compactMap(\.string)
                guard strings.count == items.count, Set(strings).count == strings.count,
                      strings.allSatisfy(responseTypes.contains) else { throw invalid(key) }
            } else { throw CentreError.invalid("Only supported study preferences can be changed.") }
        }
        return .object(fields)
    }
    private static func invalid(_ field: String) -> CentreError { .invalid("Choose a valid value for \(field). Your preferences have not been saved.") }

    /// Ordered iOS Dynamic Type indices. Accessibility categories always retain the system selection.
    public static func textSizeIndex(system: Int, preference: String) -> Int {
        guard (0...6).contains(system) else { return system }
        let offset = ["small": -1, "large": 1, "extra-large": 2][preference] ?? 0
        return min(6, max(0, system + offset))
    }
}
