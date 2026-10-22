import XCTest
@testable import CentreCore
private actor JournalTransport: ConnectorTransport {
    var sends=0
    var reads=0
    let status: String
    var timeout: Bool
    var missing=false
    var suspend=false
    var continuation: CheckedContinuation<Void, Never>?
    var start: CheckedContinuation<Void, Never>?
    init(status: String = "unknown", timeout: Bool = false) { self.status=status; self.timeout=timeout }
    func receiptValue(_ id: String) -> JSONValue { .object(["operationId": .string(id), "status": .string(status)]) }
    func send(_ command: ConnectorCommand) async throws -> JSONValue {
        sends += 1; start?.resume(); start=nil
        if suspend { await withCheckedContinuation { continuation=$0 } }
        if timeout { throw URLError(.timedOut) }
        return receiptValue(command.id.uuidString)
    }
    func receipt(id: String) async throws -> JSONValue {
        reads += 1
        if missing { throw CloudFailure(status: 404, body: .object([:])) }
        return receiptValue(id)
    }
    func configure(missing: Bool = false, suspend: Bool = false) { self.missing=missing; self.suspend=suspend }
    func waitForSend() async { if sends == 0 { await withCheckedContinuation { start=$0 } } }
    func release() { continuation?.resume(); continuation=nil }
    func counts() -> [Int] { [sends, reads] }
}
final class ConnectorJournalTests: XCTestCase {
    var directory: URL!
    override func setUpWithError() throws {
        directory=FileManager.default.temporaryDirectory.appendingPathComponent("centre-journal-\(UUID().uuidString)")
    }
    override func tearDownWithError() throws { if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) } }
    func journal(_ workspace: String = "account-a", server: String = "https://cloud.example") throws -> ConnectorJournal {
        try ConnectorJournal(directory: directory, workspace: WorkspaceKey(baseURL: URL(string: server)!, workspaceId: workspace))
    }
    func command(id: UUID = UUID(), path: String = "/v1/organato/sessions", method: String = "POST", title: String = "Plan") -> ConnectorCommand {
        ConnectorCommand(id: id, path: path, method: method, body: .object(["operationId": .string(id.uuidString.lowercased()), "title": .string(title)]))
    }
    func receipt(_ id: UUID, _ status: String) -> JSONValue { .object(["operationId": .string(id.uuidString), "status": .string(status)]) }
    func testRealFileReopenKeepsExactBodyAndLostOutcomeOnlyReadsReceiptsEvenAfter404() async throws {
        let original=try journal(), change=command(), network=JournalTransport(timeout: true)
        try await original.stage(change)
        let staged=await (try journal()).snapshot()
        XCTAssertEqual(staged, [change])
        do { try await original.process(using: network); XCTFail("Expected lost acknowledgement") } catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        let reopened=try journal()
        try await reopened.stage(change)
        let saved=await reopened.snapshot()
        XCTAssertTrue(saved[0].sent); XCTAssertEqual(saved[0].body, change.body)
        await network.configure(missing: true)
        do { try await reopened.process(using: network); XCTFail("Expected missing receipt") } catch let error as CloudFailure { XCTAssertEqual(error.status, 404) }
        await network.configure()
        try await reopened.process(using: network)
        try await reopened.process(using: network)
        let counts=await network.counts()
        XCTAssertEqual(counts, [1, 3])
        let pending=await reopened.pendingCount
        XCTAssertEqual(pending, 1)
        let isolated=await (try journal("account-b")).snapshot()
        let otherServer=await (try journal(server: "https://other.example")).snapshot()
        XCTAssertTrue(isolated.isEmpty && otherServer.isEmpty)
    }
    func testInvalidPathsIdentityAndChangedDuplicateBodiesAreRejectedBeforeSend() async throws {
        let store=try journal(), id=UUID()
        for path in ["https://evil.example/v1/organato/sessions", "/v1/organato/connection", "/v1/organato/sessions/../complete", "/v1/organato/sessions/\(UUID())/complete?x=1", "/v1/organato/sessions/"] {
            do { try await store.stage(command(path: path)); XCTFail("Accepted \(path)") } catch { XCTAssertTrue(error is CentreError) }
        }
        do { try await store.stage(command(method: "DELETE")); XCTFail("Accepted unsafe method") } catch { XCTAssertTrue(error is CentreError) }
        let mismatched=ConnectorCommand(id: id, path: "/v1/organato/sessions", method: "POST", body: .object(["operationId": .string(UUID().uuidString)]))
        do { try await store.stage(mismatched); XCTFail("Accepted body identity mismatch") } catch { XCTAssertTrue(error is CentreError) }
        let change=command(id: id)
        try await store.stage(change); try await store.stage(change)
        do { try await store.stage(command(id: id, title: "Different")); XCTFail("Changed duplicate operation") } catch { XCTAssertTrue(error is CentreError) }
        let state=await store.snapshot()
        XCTAssertEqual(state, [change])
    }
    func testAuthoritativeStatusesAreRetainedWithoutPretendingSuccess() async throws {
        for status in ["failed", "conflict", "unknown", "pending", "succeeded"] {
            let store=try journal(status), change=command(), network=JournalTransport(status: status)
            try await store.stage(change); try await store.process(using: network)
            try await store.process(using: network)
            let state=await (try journal(status)).snapshot()
            XCTAssertEqual(state[0].receipt?["status"], .string(status))
            let pending=await store.pendingCount
            XCTAssertEqual(pending, status == "succeeded" ? 0 : 1)
            let counts=await network.counts()
            XCTAssertEqual(counts, [1, ["unknown", "pending"].contains(status) ? 1 : 0])
        }
        let terminal=JournalTransport()
        let fresh=try journal("terminal-only")
        let change=command(); try await fresh.stage(change)
        try await fresh.process(using: JournalTransport(status: "failed"))
        try await fresh.process(using: terminal)
        let counts=await terminal.counts(); XCTAssertEqual(counts, [0, 0])
    }
    func testReceiptIdentityAndStatusAreValidatedAndSucceededHistoryIsBounded() async throws {
        let store=try journal(), network=JournalTransport(status: "succeeded")
        let change=command(); try await store.stage(change); try await store.process(using: network)
        for value in [receipt(UUID(), "succeeded"), receipt(change.id, "not_applied"), receipt(change.id, "unknown")] {
            do { try await store.updateReceipt(value); XCTFail("Accepted invalid or regressive receipt") } catch { XCTAssertTrue(error is CentreError) }
        }
        for _ in 0..<101 { try await store.stage(command()) }
        try await store.process(using: network)
        let state=await (try journal()).snapshot()
        XCTAssertEqual(state.count, 100)
        XCTAssertTrue(state.allSatisfy { $0.receipt?["status"].string == "succeeded" })
    }
    func testConcurrentProcessingCannotDispatchTwiceAndEraseIsBlocked() async throws {
        let store=try journal(), network=JournalTransport(status: "succeeded")
        try await store.stage(command()); await network.configure(suspend: true)
        let first=Task { try await store.process(using: network) }
        await network.waitForSend()
        try await store.process(using: network)
        do { try await store.erase(); XCTFail("Erased an in-flight journal") } catch { XCTAssertTrue(error is CentreError) }
        await network.release(); try await first.value
        let counts=await network.counts(); XCTAssertEqual(counts, [1, 0])
        try await store.erase()
        let empty=await (try journal()).snapshot(); XCTAssertTrue(empty.isEmpty)
    }
}
