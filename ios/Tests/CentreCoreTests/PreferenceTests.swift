import XCTest
@testable import CentreCore

final class PreferenceTests: XCTestCase {
    func testCanonicalDefaultsAndValidation() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/settings-defaults-v1.json")
        let expected = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: fixture))
        XCTAssertEqual(StudyPreferences.defaults, expected)
        XCTAssertEqual(try StudyPreferences.validatedPatch(expected), expected)
        XCTAssertThrowsError(try StudyPreferences.validatedPatch(.object(["defaultFlashcardCount": .number(31)])))
        XCTAssertThrowsError(try StudyPreferences.validatedPatch(.object(["defaultTestMinutes": .number(4)])))
        XCTAssertThrowsError(try StudyPreferences.validatedPatch(.object(["codexThreadId": .string("private")])) )
    }
    func testSystemAccessibilitySizesArePreserved() {
        for category in 7...11 {
            for preference in ["small", "standard", "large", "extra-large"] {
                XCTAssertEqual(StudyPreferences.textSizeIndex(system: category, preference: preference), category)
            }
        }
        XCTAssertEqual(StudyPreferences.textSizeIndex(system: 3, preference: "standard"), 3)
        XCTAssertEqual(StudyPreferences.textSizeIndex(system: 3, preference: "extra-large"), 5)
    }
    func testFieldUpdatesPreserveOtherSettingsAndFutureFieldsOffline() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let workspace = try WorkspaceKey(baseURL: URL(string: "https://settings.invalid")!, workspaceId: "test")
        let replica = try Replica(directory: directory, workspace: workspace)
        try await replica.stage([LocalChange(kind: "preferences", id: "preferences", data: .object(["future": .bool(true)]))])
        try await replica.updatePreferences(.object(["theme": .string("light")]))
        try await replica.updatePreferences(.object(["textSize": .string("extra-large")]))
        let reopened = try Replica(directory: directory, workspace: workspace)
        let state = await reopened.snapshot()
        XCTAssertEqual(state.records.first?.data?["theme"], .string("light"))
        XCTAssertEqual(state.records.first?.data?["textSize"], .string("extra-large"))
        XCTAssertEqual(state.records.first?.data?["future"], .bool(true))
        XCTAssertEqual(state.outbox.count, 1)
    }
}
