import Foundation
import CentreCore

private struct SettingsFailure: Error { let message: String }
private func settingsCheck(_ condition: Bool, _ message: String) throws {
    if !condition { throw SettingsFailure(message: message) }
}

public enum SettingsRegressions {
    public static func run() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("centre-settings-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let workspace = try WorkspaceKey(baseURL: URL(string: "https://settings.invalid")!, workspaceId: "fixture")
        let replica = try Replica(directory: directory, workspace: workspace)
        try await replica.stage([LocalChange(kind: "preferences", id: "preferences", data: .object(["futureSetting": .object(["retained": .bool(true)])]))])
        try await replica.updatePreferences(.object(["theme": .string("light")]))
        try await replica.updatePreferences(.object(["textSize": .string("extra-large")]))
        let saved = await replica.snapshot()
        let data = saved.records.first { $0.kind == "preferences" }!.data!
        try settingsCheck(data["theme"] == .string("light") && data["textSize"] == .string("extra-large"), "A later setting reverted an earlier change")
        try settingsCheck(data["futureSetting"]["retained"] == .bool(true), "Unknown stored preferences were lost")
        let reopened = try Replica(directory: directory, workspace: workspace)
        let disk = await reopened.snapshot()
        try settingsCheck(disk.outbox == saved.outbox && disk.records == saved.records, "Offline preference edits did not survive reopen")
        try settingsCheck(saved.outbox.count == 1, "Unsent preference edits were not coalesced")
        print("PASS settings field patches, future-field preservation, offline reopen and coalescing")

        let invalid: [JSONValue] = [
            .object(["textSize": .string("huge")]), .object(["defaultFlashcardCount": .number(0)]),
            .object(["defaultFlashcardCount": .number(31)]), .object(["defaultTestMinutes": .number(4)]),
            .object(["defaultTestMinutes": .number(181)]), .object(["defaultQuizQuestions": .number(2.5)]),
            .object(["studentYearLevel": .number(6)]), .object(["timeZone": .string("invalid/zone")]),
            .object(["nickname": .string(String(repeating: "🧠", count: 31))]),
            .object(["defaultQuizQuestionTypes": .array([])]),
            .object(["defaultTestQuestionTypes": .array([.string("multiple_choice"), .string("multiple_choice")])]),
            .object(["codexThreadId": .string("desktop-only")]), .object(["readingFont": .string("comic")]),
            .object(["defaultQuizQuestionTypes": .array([.number(1)])])
        ]
        for patch in invalid {
            do { try await replica.updatePreferences(patch); throw SettingsFailure(message: "Invalid preference was accepted: \(patch)") }
            catch is CentreError { }
            let after = await replica.snapshot()
            try settingsCheck(after.records == saved.records && after.outbox == saved.outbox, "Rejected settings changed saved data")
        }
        try settingsCheck(try StudyPreferences.validatedPatch(.object(["nickname": .string("  Alex \n")])) == .object(["nickname": .string("Alex")]), "Nickname trimming differs from contract")
        _ = try StudyPreferences.validatedPatch(StudyPreferences.defaults)
        for count in [1, 30] { _ = try StudyPreferences.validatedPatch(.object(["defaultFlashcardCount": .number(Double(count))])) }
        let types = try Replica(directory: directory.appendingPathComponent("types"), workspace: workspace)
        try await types.updateResponseType(key: "defaultQuizQuestionTypes", type: "multiple_choice", enabled: false)
        try await types.updateResponseType(key: "defaultQuizQuestionTypes", type: "short_response", enabled: false)
        let typeState = await types.snapshot()
        try settingsCheck(typeState.records.first?.data?["defaultQuizQuestionTypes"] == .array([.string("long_response")]), "Response-type toggles overwrote each other")
        do { try await types.updateResponseType(key: "defaultQuizQuestionTypes", type: "long_response", enabled: false); throw SettingsFailure(message: "Last response type was removed") }
        catch is CentreError { }
        print("PASS portable defaults, exact enum/range/UTF-16/response-type validation and unchanged state after rejection")

        for system in 0...11 {
            for preference in ["small", "standard", "large", "extra-large"] {
                let actual = StudyPreferences.textSizeIndex(system: system, preference: preference)
                if system >= 7 { try settingsCheck(actual == system, "Accessibility text size changed") }
                else { try settingsCheck((0...6).contains(actual), "Text size escaped ordinary category bounds") }
            }
        }
        try settingsCheck(StudyPreferences.textSizeIndex(system: 3, preference: "standard") == 3, "Standard failed to reset")
        try settingsCheck(StudyPreferences.textSizeIndex(system: 3, preference: "extra-large") == 5, "Extra large failed to scale")
        print("PASS native relative text scale, Standard reset, and all five accessibility sizes")

        let failureDirectory = directory.appendingPathComponent("blocked")
        let failing = try Replica(directory: failureDirectory, workspace: workspace)
        try FileManager.default.removeItem(at: failureDirectory)
        try Data("fixture obstruction".utf8).write(to: failureDirectory)
        var rejected = false
        do { try await failing.updatePreferences(.object(["theme": .string("light")])) }
        catch { rejected = true }
        try settingsCheck(rejected, "Disk failure reported success")
        let failed = await failing.snapshot()
        try settingsCheck(failed.records.isEmpty && failed.outbox.isEmpty, "Failed disk save changed in-memory preferences")
        try FileManager.default.removeItem(at: failureDirectory)
        try FileManager.default.createDirectory(at: failureDirectory, withIntermediateDirectories: true)
        try await failing.updatePreferences(.object(["theme": .string("light")]))
        let recovered = try Replica(directory: failureDirectory, workspace: workspace)
        let recovery = await recovered.snapshot()
        try settingsCheck(recovery.records.first?.data?["theme"] == .string("light"), "Corrected storage did not permit retry")
        print("PASS failed disk save retains original preferences/outbox and explicit retry recovers")
    }
}
