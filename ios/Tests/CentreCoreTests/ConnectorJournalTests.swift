import XCTest
@testable import CentreCore
private actor JournalTransport: ConnectorTransport {
    var sends=0
    var reads=0
    let status: String
    var timeout: Bool
    var missing=false
    var missingCode: String?
    var sendCode: String?
    var commands: [ConnectorCommand] = []
    var suspend=false
    var continuation: CheckedContinuation<Void, Never>?
    var start: CheckedContinuation<Void, Never>?
    init(status: String = "unknown", timeout: Bool = false) { self.status=status; self.timeout=timeout }
    func receiptValue(_ id: String) -> JSONValue { .object(["operationId": .string(id), "status": .string(status)]) }
    func send(_ command: ConnectorCommand) async throws -> JSONValue {
        sends += 1; commands.append(command); start?.resume(); start=nil
        if suspend { await withCheckedContinuation { continuation=$0 } }
        if timeout { throw URLError(.timedOut) }
        if let sendCode { throw CloudFailure(status: 503, body: .object(["error": .object(["code": .string(sendCode)])])) }
        return receiptValue(command.id.uuidString)
    }
    func receipt(id: String) async throws -> JSONValue {
        reads += 1
        if missing { throw CloudFailure(status: 404, body: missingCode.map { .object(["error": .object(["code": .string($0)])]) } ?? .object([:])) }
        return receiptValue(id)
    }
    func configure(missing: Bool = false, suspend: Bool = false, missingCode: String? = nil, sendCode: String? = nil) {
        self.missing=missing; self.suspend=suspend; self.missingCode=missingCode; self.sendCode=sendCode
    }
    func sentCommands() -> [ConnectorCommand] { commands }
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
        let afterPlain404 = await reopened.snapshot()
        XCTAssertNotEqual(afterPlain404[0].missingOnServer, true, "A generic 404 is not proof that an operation is absent")
        XCTAssertTrue(afterPlain404[0].sent)
        XCTAssertNil(afterPlain404[0].receipt)
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

    func testAuthenticatedMissingReceiptAllowsOtherCommandsAndOnlyExplicitExactRetry() async throws {
        let original = try journal(), change = command(), offline = JournalTransport(timeout: true)
        try await original.stage(change)
        do { try await original.process(using: offline); XCTFail("Expected lost initial acknowledgement") }
        catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        let reopened = try journal(), other = command(title: "Independent plan")
        try await reopened.stage(other)
        let recovery = JournalTransport(status: "succeeded")
        await recovery.configure(missing: true, missingCode: "operation_not_found")
        try await reopened.process(using: recovery)
        var disk = await (try journal()).snapshot()
        let missing = try XCTUnwrap(disk.first(where: { $0.id == change.id }))
        XCTAssertEqual(missing.missingOnServer, true)
        XCTAssertTrue(missing.sent)
        XCTAssertNil(missing.receipt)
        XCTAssertEqual(disk.first(where: { $0.id == other.id })?.receipt?["status"], .string("succeeded"))
        try await reopened.process(using: recovery)
        let beforeExplicit = await recovery.counts()
        XCTAssertEqual(beforeExplicit, [1, 2], "Missing operation must not stop independent work or trigger automatic resend")
        do { try await reopened.stage(command(id: change.id, title: "Changed body")); XCTFail("Changed missing operation body") }
        catch { XCTAssertTrue(error is CentreError) }
        try await reopened.retryMissing(id: change.id, using: recovery)
        let originalSends = await offline.sentCommands(), recoveredSends = await recovery.sentCommands()
        XCTAssertEqual(originalSends.count, 1)
        XCTAssertEqual(recoveredSends.map(\.id), [other.id, change.id])
        let retry = try XCTUnwrap(recoveredSends.last)
        XCTAssertEqual(retry.id, originalSends[0].id)
        XCTAssertEqual(retry.path, originalSends[0].path)
        XCTAssertEqual(retry.method, originalSends[0].method)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(try encoder.encode(retry.body), try encoder.encode(originalSends[0].body))
        disk = await (try journal()).snapshot()
        let succeeded = try XCTUnwrap(disk.first(where: { $0.id == change.id }))
        XCTAssertEqual(succeeded.receipt?["status"], .string("succeeded"))
        XCTAssertNotEqual(succeeded.missingOnServer, true)
        try await reopened.process(using: recovery)
        let finalCounts = await recovery.counts()
        XCTAssertEqual(finalCounts, [2, 2])
    }

    func testPendingUnknownAndUnsentCommandsCannotBeRetriedOrAcknowledged() async throws {
        for status in ["pending", "unknown"] {
            let store = try journal(status), change = command(), network = JournalTransport(status: status)
            try await store.stage(change)
            do { try await store.retryMissing(id: change.id, using: network); XCTFail("Retried an unsent operation without missing proof") }
            catch { XCTAssertTrue(error is CentreError) }
            try await store.process(using: network)
            do { try await store.retryMissing(id: change.id, using: network); XCTFail("Retried an uncertain upstream operation") }
            catch { XCTAssertTrue(error is CentreError) }
            do { try await store.acknowledge(change.id); XCTFail("Closed an uncertain operation") }
            catch { XCTAssertTrue(error is CentreError) }
            let calls = await network.counts(), state = await store.snapshot()
            XCTAssertEqual(calls, [1, 0])
            XCTAssertEqual(state.count, 1)
            XCTAssertEqual(state[0].receipt?["status"], .string(status))
        }
    }

    func testOnlyExplicitUnconfiguredRejectionResetsSentStateForSafeFirstDispatch() async throws {
        for code in ["organato_unconfigured", "upstream_unavailable"] {
            let store = try journal(code), change = command(), rejected = JournalTransport()
            try await store.stage(change)
            await rejected.configure(sendCode: code)
            do { try await store.process(using: rejected); XCTFail("Expected service rejection") }
            catch let error as CloudFailure { XCTAssertEqual(error.status, 503) }
            let reopened = try journal(code), disk = await reopened.snapshot()
            XCTAssertEqual(disk[0].sent, code != "organato_unconfigured")
            XCTAssertNil(disk[0].receipt)
            let healthy = JournalTransport(status: "succeeded")
            try await reopened.process(using: healthy)
            let calls = await healthy.counts()
            XCTAssertEqual(calls, code == "organato_unconfigured" ? [1, 0] : [0, 1])
            let healthyCommands = await healthy.sentCommands()
            if let sent = healthyCommands.first {
                XCTAssertEqual(sent.id, change.id); XCTAssertEqual(sent.body, change.body)
            }
        }
    }

    func testAcknowledgementRemovesOnlyKnownFailedOrConflictingReceipts() async throws {
        for status in ["failed", "conflict", "succeeded"] {
            let store = try journal(status), change = command()
            try await store.stage(change)
            try await store.process(using: JournalTransport(status: status))
            if status == "succeeded" {
                do { try await store.acknowledge(change.id); XCTFail("Acknowledged a successful receipt as failure") }
                catch { XCTAssertTrue(error is CentreError) }
            } else { try await store.acknowledge(change.id) }
            let disk = await (try journal(status)).snapshot()
            XCTAssertEqual(disk.count, status == "succeeded" ? 1 : 0)
        }
    }

    func testInvalidMetadataIsRejectedBeforeStageAndLegacyMissingCommandCanClose() async throws {
        let workspace=try WorkspaceKey(baseURL:URL(string:"https://cloud.example")!,workspaceId:"account-a")
        let store=try journal(), id=UUID()
        var invalid=ConnectorCommand(id:id,path:"/v1/organato/sessions/\(UUID())",method:"PATCH",body:.object(["operationId":.string(id.uuidString),"patch":.object(["title":.string(String(repeating:"x",count:201))])]))
        do { try await store.stage(invalid); XCTFail("Invalid metadata staged") } catch is CentreError {}
        let before=await store.snapshot(); XCTAssertTrue(before.isEmpty)
        invalid.sent=true
        let legacy:JSONValue = .object(["schemaVersion":.number(1),"workspace":try JSONValue.encode(workspace),"commands":.array([try JSONValue.encode(invalid)])])
        try JSONEncoder().encode(legacy).write(to:directory.appendingPathComponent(workspace.fileKey+"-organato.json"))
        let reopened=try journal(), network=JournalTransport()
        await network.configure(missing:true,missingCode:"operation_not_found")
        try await reopened.process(using:network)
        let rejected=await reopened.snapshot()
        XCTAssertEqual(rejected[0].status,"failed")
        XCTAssertNil(rejected[0].receipt,"Local rejection must not impersonate a server receipt")
        XCTAssertEqual(rejected[0].body,invalid.body)
        let persisted=try journal()
        try await persisted.acknowledge(id)
        let closed=await persisted.snapshot(), counts=await network.counts()
        XCTAssertTrue(closed.isEmpty); XCTAssertEqual(counts,[0,1])
    }

    func testInvalidMetadataWithPriorUnknownReceiptStillNeedsReconciliation() async throws {
        let workspace=try WorkspaceKey(baseURL:URL(string:"https://cloud.example")!,workspaceId:"account-a")
        _ = try journal()
        let id=UUID()
        var invalid=ConnectorCommand(id:id,path:"/v1/organato/sessions/\(UUID())",method:"PATCH",body:.object(["operationId":.string(id.uuidString),"patch":.object(["title":.string(String(repeating:"x",count:201))])]))
        invalid.sent=true; invalid.receipt=receipt(id,"unknown")
        let legacy:JSONValue = .object(["schemaVersion":.number(1),"workspace":try JSONValue.encode(workspace),"commands":.array([try JSONValue.encode(invalid)])])
        try JSONEncoder().encode(legacy).write(to:directory.appendingPathComponent(workspace.fileKey+"-organato.json"))
        let reopened=try journal(), network=JournalTransport()
        await network.configure(missing:true,missingCode:"operation_not_found")
        try await reopened.process(using:network)
        do { try await reopened.acknowledge(id); XCTFail("Closed a prior uncertain receipt") } catch is CentreError {}
        do { try await reopened.retryMissing(id:id,using:network); XCTFail("Retried a prior uncertain receipt") } catch is CentreError {}
        let state=await reopened.snapshot()
        XCTAssertEqual(state[0].status,"unknown")
        XCTAssertNil(state[0].localRejection)
        XCTAssertEqual(state[0].receipt?["status"],.string("unknown"))
    }

}
