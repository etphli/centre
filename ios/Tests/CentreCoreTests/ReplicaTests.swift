import XCTest
@testable import CentreCore

private enum AIOutcome { case failure(CloudFailure), timeout, status(String) }

private actor ReplicaTransport: CloudTransport {
    var puts: [CloudMutation] = []
    var receipts: [String: CloudRecord] = [:]
    var grades: [GradeRequest] = []
    var chats: [AIRequest] = []
    var aiOutcomes: [AIOutcome]
    var events: [String] = []
    var pages: [ChangesPage]
    var response: MutationResponse?
    var loseAcknowledgement: Bool
    var suspendFirstPut: Bool
    var putContinuation: CheckedContinuation<Void, Never>?
    var startedContinuation: CheckedContinuation<Void, Never>?
    var started = false

    init(pages: [ChangesPage] = [], response: MutationResponse? = nil, loseAcknowledgement: Bool = false, suspendFirstPut: Bool = false, aiOutcomes: [AIOutcome] = []) {
        self.pages = pages
        self.response = response
        self.loseAcknowledgement = loseAcknowledgement
        self.suspendFirstPut = suspendFirstPut
        self.aiOutcomes = aiOutcomes
    }
    func put(_ mutation: CloudMutation) async throws -> MutationResponse {
        puts.append(mutation)
        events.append("put:\(mutation.key)")
        started = true
        startedContinuation?.resume()
        startedContinuation = nil
        if suspendFirstPut && puts.count == 1 {
            await withCheckedContinuation { putContinuation = $0 }
        }
        if let response { return response }
        let accepted = receipts[mutation.mutationId] ?? CloudRecord(kind: mutation.kind, id: mutation.id, version: mutation.expectedVersion + 1, cursor: "1", deleted: mutation.deleted, data: mutation.data)
        receipts[mutation.mutationId] = accepted
        if loseAcknowledgement {
            loseAcknowledgement = false
            throw URLError(.timedOut)
        }
        return .accepted(accepted)
    }
    func waitForPut() async {
        if !started { await withCheckedContinuation { startedContinuation = $0 } }
    }
    func releasePut() { putContinuation?.resume(); putContinuation = nil }
    func sent() -> [CloudMutation] { puts }
    func gradeCalls() -> [GradeRequest] { grades }
    func chatCalls() -> [AIRequest] { chats }
    func eventLog() -> [String] { events }
    func changes(cursor: String) async throws -> ChangesPage {
        events.append("changes:\(cursor)")
        return pages.isEmpty ? ChangesPage(records: [], cursor: cursor, hasMore: false) : pages.removeFirst()
    }
    private func aiResult(id: String) throws -> AIRun {
        guard !aiOutcomes.isEmpty else { return AIRun(id: id, status: "completed") }
        switch aiOutcomes.removeFirst() {
        case .failure(let error): throw error
        case .timeout: throw URLError(.timedOut)
        case .status(let status): return AIRun(id: id, status: status)
        }
    }
    func run(_ request: AIRequest) async throws -> AIRun {
        chats.append(request); events.append("run:\(request.id)")
        return try aiResult(id: request.id)
    }
    func grade(_ request: GradeRequest) async throws -> AIRun {
        grades.append(request)
        events.append("grade:\(request.draftId)")
        return try aiResult(id: request.id)
    }
}

final class ReplicaTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("centre-replica-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func workspace(_ id: String = "workspace-a", server: String = "https://cloud.example") throws -> WorkspaceKey {
        try WorkspaceKey(baseURL: URL(string: server)!, workspaceId: id)
    }
    private func replica() throws -> Replica { try Replica(directory: directory, workspace: workspace()) }
    private func edit(_ title: String) -> LocalChange {
        LocalChange(kind: "resource", id: "r1", data: .object(["title": .string(title)]))
    }

    func testQueuedEditAndIdempotencyIdentitySurviveReopen() async throws {
        let original = try replica()
        try await original.stage([edit("Offline")])
        let staged = await original.snapshot()
        let reopened = try replica()
        let disk = await reopened.snapshot()
        XCTAssertEqual(disk.outbox, staged.outbox)
        XCTAssertEqual(disk.records, staged.records)
        XCTAssertNotNil(UUID(uuidString: disk.outbox[0].mutation.mutationId))
        XCTAssertEqual(disk.records[0].data?["title"], .string("Offline"))
    }

    func testLostAcknowledgementReplaysExactBodyAndKeepsNewerEdit() async throws {
        let original = try replica()
        try await original.stage([edit("First")])
        let network = ReplicaTransport(loseAcknowledgement: true)
        do { try await original.synchronize(using: network); XCTFail("Expected timeout") }
        catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        let reopened = try replica()
        let disk = await reopened.snapshot()
        XCTAssertTrue(disk.outbox[0].sent)
        try await reopened.stage([edit("Second")])
        let successor = await reopened.snapshot()
        XCTAssertEqual(successor.outbox.count, 2)
        XCTAssertNotEqual(successor.outbox[0].mutation.mutationId, successor.outbox[1].mutation.mutationId)
        try await reopened.synchronize(using: network)
        let calls = await network.sent()
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls[0], calls[1])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(try encoder.encode(calls[0]), try encoder.encode(calls[1]))
        XCTAssertEqual(calls[2].expectedVersion, 1)
        let result = await reopened.snapshot()
        XCTAssertTrue(result.outbox.isEmpty)
        XCTAssertEqual(result.records[0].data?["title"], .string("Second"))
    }

    func testEditWhileNetworkAwaitsRemainsQueuedAndReceivesAcknowledgedVersion() async throws {
        let store = try replica()
        try await store.stage([edit("First")])
        let network = ReplicaTransport(suspendFirstPut: true)
        let sync = Task { try await store.synchronize(using: network) }
        await network.waitForPut()
        defer { Task { await network.releasePut() } }
        do { try await store.erase(); XCTFail("Cannot erase a replica during an in-flight synchronization") }
        catch let error as CentreError {
            switch error {
            case .unavailable: break
            default: XCTFail("Expected synchronization erase guard, received \(error)")
            }
        } catch { XCTFail("Unexpected synchronization erase error: \(error)") }
        try await store.stage([edit("During request")])
        let pending = await store.snapshot()
        XCTAssertEqual(pending.outbox.count, 2)
        await network.releasePut()
        try await sync.value
        let calls = await network.sent()
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[1].expectedVersion, 1)
        XCTAssertEqual(calls[1].data?["title"], .string("During request"))
        let disk = await (try replica()).snapshot()
        XCTAssertTrue(disk.outbox.isEmpty)
        XCTAssertEqual(disk.records[0].version, 2)
    }

    func testProjectionAndCursorCommitTogetherAndMalformedPageCommitsNeither() async throws {
        let store = try replica()
        let first = CloudRecord(kind: "subject", id: "s1", version: 1, cursor: "5", data: .object(["name": .string("Math")]))
        try await store.synchronize(using: ReplicaTransport(pages: [ChangesPage(records: [first], cursor: "5", hasMore: false)]))
        var disk = await (try replica()).snapshot()
        XCTAssertEqual(disk.cursor, "5")
        XCTAssertEqual(disk.shadow[first.key], first)
        let valid = CloudRecord(kind: "topic", id: "t1", version: 1, cursor: "6", data: .object([:]))
        let invalid = CloudRecord(kind: "topic", id: "bad", version: 0, cursor: "7", data: .object([:]))
        do {
            try await store.synchronize(using: ReplicaTransport(pages: [ChangesPage(records: [valid, invalid], cursor: "7", hasMore: false)]))
            XCTFail("Expected invalid page rejection")
        } catch { XCTAssertTrue(error is CentreError) }
        disk = await (try replica()).snapshot()
        XCTAssertEqual(disk.cursor, "5")
        XCTAssertNil(disk.shadow[valid.key])
        XCTAssertNil(disk.shadow[invalid.key])
        XCTAssertEqual(disk.shadow[first.key], first)
    }

    func testServerAndWorkspaceCachesArePartitioned() async throws {
        let first = try replica()
        try await first.stage([edit("Private")])
        for key in [try workspace("workspace-b"), try workspace(server: "https://other.example")] {
            let other = try Replica(directory: directory, workspace: key)
            let state = await other.snapshot()
            XCTAssertTrue(state.records.isEmpty)
            XCTAssertTrue(state.outbox.isEmpty)
            XCTAssertNotEqual(key.fileKey, try workspace().fileKey)
        }
        let original = await (try replica()).snapshot()
        XCTAssertEqual(original.records[0].data?["title"], .string("Private"))
    }

    func testCASConflictPreservesBothVersionsAndUseLocalCreatesNewMutation() async throws {
        let store = try replica()
        try await store.stage([edit("Local")])
        let before = await store.snapshot()
        let remote = CloudRecord(kind: "resource", id: "r1", version: 8, cursor: "9", data: .object(["title": .string("Remote")]))
        try await store.synchronize(using: ReplicaTransport(response: .conflict(remote)))
        let disk = await (try replica()).snapshot()
        let conflict = try XCTUnwrap(disk.conflicts.first)
        XCTAssertEqual(conflict.local.data?["title"], .string("Local"))
        XCTAssertEqual(conflict.remote, remote)
        XCTAssertEqual(disk.outbox[0].mutation.mutationId, before.outbox[0].mutation.mutationId)
        try await store.resolve(conflict, useLocal: true)
        let resolved = await (try replica()).snapshot()
        XCTAssertTrue(resolved.conflicts.isEmpty)
        XCTAssertEqual(resolved.outbox.count, 1)
        XCTAssertEqual(resolved.outbox[0].mutation.expectedVersion, 8)
        XCTAssertFalse(resolved.outbox[0].sent)
        XCTAssertNotEqual(resolved.outbox[0].mutation.mutationId, before.outbox[0].mutation.mutationId)
        XCTAssertEqual(resolved.outbox[0].mutation.data?["title"], .string("Local"))
    }

    func testUnknownKindsAndFieldsSurviveAndTombstoneDoesNotCascade() async throws {
        let store = try replica()
        let unknown = CloudRecord(kind: "future.widget", id: "u1", schemaVersion: 4, version: 1, cursor: "1", data: .object(["nested": .array([.null, .bool(true), .object(["future": .string("kept")])])]))
        let parent = CloudRecord(kind: "subject", id: "s1", version: 1, cursor: "2", data: .object(["name": .string("Science")]))
        let child = CloudRecord(kind: "topic", id: "t1", version: 1, cursor: "3", data: .object(["subjectId": .string("s1")]))
        let deleted = CloudRecord(kind: "subject", id: "s1", version: 2, cursor: "4", deleted: true, data: nil)
        let network = ReplicaTransport(pages: [ChangesPage(records: [unknown, parent, child], cursor: "3", hasMore: true), ChangesPage(records: [deleted], cursor: "4", hasMore: false)])
        try await store.synchronize(using: network)
        let disk = await (try replica()).snapshot()
        XCTAssertEqual(disk.shadow[unknown.key], unknown)
        XCTAssertEqual(disk.shadow[child.key], child)
        XCTAssertEqual(disk.shadow[parent.key], deleted)
        XCTAssertEqual(disk.cursor, "4")
    }

    func testKeepLocalAdvancesDomainRevisionSeparatelyFromTransportVersion() async throws {
        let store = try replica()
        try await store.stage([LocalChange(kind: "interactiveProgress", id: "progress", data: .object(["revision": .number(3)]))])
        let remote = CloudRecord(kind: "interactiveProgress", id: "progress", version: 20, cursor: "40", data: .object(["revision": .number(8)]))
        try await store.synchronize(using: ReplicaTransport(response: .conflict(remote)))
        let conflicted = await store.snapshot()
        let conflict = try XCTUnwrap(conflicted.conflicts.first)
        try await store.resolve(conflict, useLocal: true)
        let disk = await (try replica()).snapshot()
        XCTAssertEqual(disk.outbox.first?.mutation.expectedVersion, 20)
        XCTAssertEqual(disk.outbox.first?.mutation.data?["revision"].int, 9)
    }

    func testKeepLocalTimerPreservesLeaseAndSegmentsButNormalRecoveryStillPauses() async throws {
        let store=try replica(), start=try Clock.date("2026-10-22T00:00:00.000Z")
        let started=try StudyRules.start(title:"Local study",subjectId:nil,timeZone:"Australia/Sydney",now:start)
        let local=try StudyRules.heartbeat(started,now:start.addingTimeInterval(15),activity:true)
        var cloud=try StudyRules.recover(local,now:start.addingTimeInterval(20),restart:true)
        XCTAssertEqual(local.revision,2);XCTAssertEqual(cloud.revision,3)
        cloud.title="Cloud copy"
        try await store.stage([LocalChange(kind:"studySession",id:local.id,data:JSONValue.encode(local))])
        let remote=CloudRecord(kind:"studySession",id:local.id,version:8,cursor:"9",data:try JSONValue.encode(cloud))
        try await store.synchronize(using:ReplicaTransport(response:.conflict(remote)))
        let conflicted=await store.snapshot(), conflict=try XCTUnwrap(conflicted.conflicts.first)
        try await store.resolve(conflict,useLocal:true)
        let disk=await (try replica()).snapshot(), queued=try XCTUnwrap(disk.outbox.first)
        let chosen=try XCTUnwrap(queued.mutation.data).decode(StudySession.self)
        var expected=local;expected.revision=4
        XCTAssertEqual(chosen,expected,"Only domain revision changes; the owned lease, checkpoint, open span and segments stay exact")
        XCTAssertEqual(queued.mutation.expectedVersion,8)
        let restarted=try StudyRules.recover(chosen,now:start.addingTimeInterval(60),restart:true)
        XCTAssertEqual(restarted.state,.paused(reason:"recovery"));XCTAssertEqual(restarted.revision,5)
        XCTAssertEqual(restarted.segments,[StudySegment(start:Clock.iso(start),end:Clock.iso(start.addingTimeInterval(15)))])
    }

    func testAttemptConflictOnlyAcceptsCloudResultAndPreservesItAcrossRestart() async throws {
        for kind in ["attempt", "practice.attempt"] {
            let store = try Replica(directory: directory, workspace: workspace(kind))
            try await store.stage([LocalChange(kind: kind, id: "attempt", data: .object(["revision": .number(1), "totalScore": .number(2)]))])
            let remote = CloudRecord(kind: kind, id: "attempt", version: 1, cursor: "4", data: .object(["revision": .number(1), "totalScore": .number(3)]))
            try await store.synchronize(using: ReplicaTransport(response: .conflict(remote)))
            let before = await store.snapshot()
            let conflict = try XCTUnwrap(before.conflicts.first)
            do { try await store.resolve(conflict, useLocal: true); XCTFail("Immutable attempt must reject local overwrite") }
            catch let error as CentreError { guard case .invalid = error else { return XCTFail("Unexpected error: \(error)") } }
            let unchanged = await store.snapshot()
            XCTAssertEqual(unchanged.outbox, before.outbox)
            XCTAssertEqual(unchanged.conflicts, before.conflicts)
            try await store.resolve(conflict, useLocal: false)
            let disk = await (try Replica(directory: directory, workspace: workspace(kind))).snapshot()
            XCTAssertTrue(disk.outbox.isEmpty)
            XCTAssertTrue(disk.conflicts.isEmpty)
            XCTAssertEqual(disk.records, [remote])
        }
    }

    func testPartialEditPreservesUnknownJSONFields() async throws {
        let store = try replica()
        let record = CloudRecord(kind: "resource", id: "r1", version: 1, cursor: "1", data: .object(["title": .string("Old"), "future": .array([.number(1), .bool(false), .null])]))
        try await store.synchronize(using: ReplicaTransport(pages: [ChangesPage(records: [record], cursor: "1", hasMore: false)]))
        try await store.stage([edit("New")])
        let disk = await (try replica()).snapshot()
        XCTAssertEqual(disk.records[0].data?["future"], record.data?["future"])
        XCTAssertEqual(disk.records[0].data?["title"], .string("New"))
    }

    func testGradeWaitsForDraftSyncAndRemainsBlockedByConflict() async throws {
        let store = try replica()
        let draft = LocalChange(kind: "practice.draft", id: "d1", data: .object(["revision": .number(2)]))
        let request = GradeRequest(id: UUID().uuidString, draftId: "d1", resourceId: "r1", expectedDraftRevision: 2)
        try await store.stage([draft], ai: .grade(request, nil))
        let remote = CloudRecord(kind: "practice.draft", id: "d1", version: 3, cursor: "3", data: .object(["revision": .number(3)]))
        let blocked = ReplicaTransport(response: .conflict(remote))
        try await store.synchronize(using: blocked)
        let grades = await blocked.gradeCalls()
        XCTAssertTrue(grades.isEmpty)
        let state = await store.snapshot()
        XCTAssertEqual(state.ai.count, 1)
        try await store.resolve(try XCTUnwrap(state.conflicts.first), useLocal: true)
        let resolved = await store.snapshot()
        XCTAssertTrue(resolved.ai.isEmpty, "Conflict resolution requires a fresh explicit grade submission")
        let revision = try XCTUnwrap(resolved.records.first(where: { $0.key == "practice.draft/d1" })?.data?["revision"].int)
        let resubmission = GradeRequest(id: UUID().uuidString, draftId: "d1", resourceId: "r1", expectedDraftRevision: revision)
        try await store.stage([], ai: .grade(resubmission, nil))
        let accepted = ReplicaTransport()
        try await store.synchronize(using: accepted)
        let events = await accepted.eventLog()
        XCTAssertEqual(Array(events.prefix(2)), ["put:practice.draft/d1", "grade:d1"])
        let sentGrades = await accepted.gradeCalls()
        XCTAssertEqual(sentGrades, [resubmission])
    }

    func testErasedReplicaCannotRecreatePrivateCacheThroughRetainedActorHandle() async throws {
        let retained = try replica()
        try await retained.stage([edit("Private local edit")])
        let remote = CloudRecord(kind: "resource", id: "r1", version: 5, cursor: "5", data: .object(["title": .string("Remote")]))
        try await retained.synchronize(using: ReplicaTransport(response: .conflict(remote)))
        let conflicted = await retained.snapshot()
        let conflict = try XCTUnwrap(conflicted.conflicts.first)
        let pending = AIRequest(chatId: "chat-after-signout", messageId: "message-after-signout")
        try await retained.stage([], ai: .chat(pending, nil))
        try await retained.cacheConnector(.object(["events": .array([.object(["title": .string("Private plan")])])]))
        let file = directory.appendingPathComponent(try workspace().fileKey + ".json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))

        try await retained.erase()
        let erased = await retained.snapshot()
        XCTAssertTrue(erased.records.isEmpty && erased.shadow.isEmpty && erased.outbox.isEmpty)
        XCTAssertTrue(erased.ai.isEmpty && erased.conflicts.isEmpty)
        XCTAssertEqual(erased.connector, .object([:]))
        XCTAssertEqual(erased.cursor, "0")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))

        func rejectsStaleHandle(_ operation: () async throws -> Void) async {
            do { try await operation(); XCTFail("Erased actor accepted a stale operation") }
            catch let error as CentreError { XCTAssertEqual(error, .authentication) }
            catch { XCTFail("Expected authentication error, received \(error)") }
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "Stale operation recreated signed-out cache")
        }
        await rejectsStaleHandle { try await retained.stage([self.edit("Late save")]) }
        await rejectsStaleHandle { try await retained.cacheConnector(.object(["events": .array([])])) }
        await rejectsStaleHandle { try await retained.resolve(conflict, useLocal: true) }
        await rejectsStaleHandle { try await retained.dismissAI(id: pending.id) }
        let network = ReplicaTransport()
        await rejectsStaleHandle { try await retained.synchronize(using: network) }
        let networkEvents = await network.eventLog()
        XCTAssertTrue(networkEvents.isEmpty, "Signed-out actor must not contact transport")
        let reopened = await (try replica()).snapshot()
        XCTAssertTrue(reopened.records.isEmpty && reopened.outbox.isEmpty && reopened.conflicts.isEmpty && reopened.ai.isEmpty)
        XCTAssertEqual(reopened.connector, .object([:]))
        XCTAssertEqual(reopened.cursor, "0")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }


    func testAIAdmissionErrorsPersistPerJobButStillImportChangesAndRetryOriginalIdentity() async throws {
        for status in [429, 503] {
            let key = try workspace("ai-admission-\(status)")
            let store = try Replica(directory: directory, workspace: key)
            let rejected = AIRequest(chatId: "first-chat", messageId: "first-message")
            let other = AIRequest(chatId: "second-chat", messageId: "second-message")
            try await store.stage([], ai: .chat(rejected, nil))
            try await store.stage([], ai: .chat(other, nil))
            let detail: JSONValue = .object(["code": .string(status == 429 ? "rate_limited" : "service_unavailable"), "message": .string("Try again later")])
            let failure = CloudFailure(status: status, body: .object(["error": detail]))
            let foreign = CloudRecord(kind: "resource", id: "foreign", version: 1, cursor: "12", data: .object(["title": .string("Other device")]))
            let network = ReplicaTransport(pages: [ChangesPage(records: [foreign], cursor: "12", hasMore: false)], aiOutcomes: [.failure(failure), .status("processing")])
            do { try await store.synchronize(using: network); XCTFail("AI failure must remain visible after the pull") }
            catch let error as CloudFailure { XCTAssertEqual(error.status, status) }
            let reopened = try Replica(directory: directory, workspace: key)
            let disk = await reopened.snapshot()
            XCTAssertEqual(disk.cursor, "12")
            XCTAssertEqual(disk.shadow[foreign.key], foreign)
            let waiting = try XCTUnwrap(disk.ai.first(where: { $0.id == rejected.id })?.run)
            XCTAssertEqual(waiting.id, rejected.id); XCTAssertEqual(waiting.status, "unavailable")
            XCTAssertEqual(waiting.error, detail)
            let independent = try XCTUnwrap(disk.ai.first(where: { $0.id == other.id })?.run)
            XCTAssertEqual(independent.status, "processing"); XCTAssertNil(independent.error)
            let retry = ReplicaTransport(aiOutcomes: [.status("completed"), .status("processing")])
            try await reopened.synchronize(using: retry)
            let retried = await retry.chatCalls()
            XCTAssertEqual(retried, [rejected, other])
            let finished = await reopened.snapshot()
            XCTAssertFalse(finished.ai.contains(where: { $0.id == rejected.id }))
        }
    }

    func testMissingAITargetBecomesTerminalWhileArchivedChatAndCursorStillImport() async throws {
        let store = try replica(), request = AIRequest(chatId: "archived-chat", messageId: "message")
        try await store.stage([], ai: .chat(request, nil))
        let archived = CloudRecord(kind: "chat", id: request.chatId, version: 2, cursor: "25", deleted: true, data: nil)
        let errorBody: JSONValue = .object(["code": .string("not_found"), "message": .string("Chat or message not found")])
        let network = ReplicaTransport(pages: [ChangesPage(records: [archived], cursor: "25", hasMore: false)], aiOutcomes: [.failure(CloudFailure(status: 404, body: .object(["error": errorBody])))])
        do { try await store.synchronize(using: network); XCTFail("Missing target should report its error after pulling") }
        catch let error as CloudFailure { XCTAssertEqual(error.status, 404) }
        let reopened = try replica(), disk = await reopened.snapshot()
        XCTAssertEqual(disk.cursor, "25"); XCTAssertEqual(disk.shadow[archived.key], archived)
        XCTAssertEqual(disk.ai.first?.run?.status, "failed")
        XCTAssertEqual(disk.ai.first?.run?.error, errorBody)
        let next = ReplicaTransport()
        try await reopened.synchronize(using: next)
        let calls = await next.chatCalls(), events = await next.eventLog()
        XCTAssertTrue(calls.isEmpty)
        XCTAssertEqual(events, ["changes:25"])
    }

    func testAmbiguousAINetworkFailurePullsChangesWithoutInventingTerminalRunAndRetriesSameGrade() async throws {
        let store = try replica()
        let request = GradeRequest(id: UUID().uuidString.lowercased(), draftId: "draft", resourceId: "resource", expectedDraftRevision: 4)
        try await store.stage([], ai: .grade(request, nil))
        let foreign = CloudRecord(kind: "future.record", id: "foreign", version: 1, cursor: "31", data: .object(["retained": .bool(true)]))
        let network = ReplicaTransport(pages: [ChangesPage(records: [foreign], cursor: "31", hasMore: false)], aiOutcomes: [.timeout])
        do { try await store.synchronize(using: network); XCTFail("Expected ambiguous provider/network outcome") }
        catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        let reopened = try replica(), disk = await reopened.snapshot()
        XCTAssertEqual(disk.cursor, "31"); XCTAssertEqual(disk.shadow[foreign.key], foreign)
        XCTAssertEqual(disk.ai, [.grade(request, nil)], "Unknown outcome must not become a fabricated failed run")
        let retry = ReplicaTransport()
        try await reopened.synchronize(using: retry)
        let first = await network.gradeCalls(), second = await retry.gradeCalls()
        XCTAssertEqual(first, [request]); XCTAssertEqual(second, first)
        let finished = await reopened.snapshot(); XCTAssertTrue(finished.ai.isEmpty)
    }

    func testExplicitInvalidSubmissionIsTerminalAndStillPullsBeforeThrowing() async throws {
        for (status, code, terminal) in [(400, "validation", "failed"), (409, "conflict", "conflict"), (409, "idempotency_mismatch", "conflict")] {
            let key = try workspace("invalid-\(status)-\(code)")
            let store = try Replica(directory: directory, workspace: key)
            let request = GradeRequest(id: UUID().uuidString.lowercased(), draftId: "draft", resourceId: "resource", expectedDraftRevision: 4)
            try await store.stage([], ai: .grade(request, nil))
            let detail: JSONValue = .object(["code": .string(code), "message": .string("Invalid saved submission")])
            let network = ReplicaTransport(pages: [ChangesPage(records: [], cursor: "40", hasMore: false)], aiOutcomes: [.failure(CloudFailure(status: status, body: .object(["error": detail])))])
            do { try await store.synchronize(using: network); XCTFail("Expected explicit submission failure") }
            catch let error as CloudFailure { XCTAssertEqual(error.status, status) }
            let reopened = try Replica(directory: directory, workspace: key), disk = await reopened.snapshot()
            XCTAssertEqual(disk.cursor, "40"); XCTAssertEqual(disk.ai.first?.run?.status, terminal)
            XCTAssertEqual(disk.ai.first?.run?.error, detail)
            let next = ReplicaTransport(); try await reopened.synchronize(using: next)
            let calls = await next.gradeCalls(); XCTAssertTrue(calls.isEmpty)
        }
    }

    func testDisabledAIStillPushesAndPullsRecordsWhileKeepingOriginalPendingRequest() async throws {
        let store = try replica(), request = AIRequest(chatId: "chat", messageId: "message")
        try await store.stage([edit("Offline edit")], ai: .chat(request, nil))
        let foreign = CloudRecord(kind: "resource", id: "other-device", version: 1, cursor: "55", data: .object(["title": .string("Remote")]))
        let network = ReplicaTransport(pages: [ChangesPage(records: [foreign], cursor: "55", hasMore: false)])
        try await store.synchronize(using: network, allowAI: false)
        let reopened = try replica(), disk = await reopened.snapshot()
        XCTAssertEqual(disk.cursor, "55"); XCTAssertEqual(disk.shadow[foreign.key], foreign)
        XCTAssertTrue(disk.outbox.isEmpty)
        XCTAssertEqual(disk.ai, [.chat(request, nil)])
        let calls = await network.chatCalls(), grades = await network.gradeCalls()
        XCTAssertTrue(calls.isEmpty && grades.isEmpty)
        let retry = ReplicaTransport()
        try await reopened.synchronize(using: retry, allowAI: true)
        let enabledCalls = await retry.chatCalls(); XCTAssertEqual(enabledCalls, [request])
        let finished = await reopened.snapshot(); XCTAssertTrue(finished.ai.isEmpty)
    }

}
