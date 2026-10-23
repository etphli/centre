import XCTest
@testable import CentreCore

private struct AuditRecordFeed: CloudTransport {
    let records:[CloudRecord]
    func changes(cursor:String) async throws -> ChangesPage { ChangesPage(records:records,cursor:"2",hasMore:false) }
    func put(_ mutation:CloudMutation) async throws -> MutationResponse { throw URLError(.notConnectedToInternet) }
    func run(_ request:AIRequest) async throws -> AIRun { throw URLError(.notConnectedToInternet) }
    func grade(_ request:GradeRequest) async throws -> AIRun { throw URLError(.notConnectedToInternet) }
}
final class AuditRegressionTests:XCTestCase {
    func testEditingBaselineRejectsRemotePayloadChangeBeforeRebasingCAS() async throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:directory) }
        let workspace=try WorkspaceKey(baseURL:URL(string:"https://fixture.invalid")!,workspaceId:"audit")
        let replica=try Replica(directory:directory,workspace:workspace)
        let initial=CloudRecord(kind:"resource",id:"note",version:1,cursor:"1",data:.object(["content":.string("Original")]))
        try await replica.synchronize(using:AuditRecordFeed(records:[initial]),allowAI:false)
        let baseline=EditingBaseline(kind:"resource",id:"note",records:await replica.snapshot().records)
        let remote=CloudRecord(kind:"resource",id:"note",version:2,cursor:"2",data:.object(["content":.string("Desktop")]))
        try await replica.synchronize(using:AuditRecordFeed(records:[remote]),allowAI:false)
        do {
            try await replica.stage([LocalChange(kind:"resource",id:"note",data:.object(["content":.string("Stale phone")]))],baseline:baseline)
            XCTFail("Stale content replaced the newer remote payload")
        } catch is CentreError {}
        let state=await replica.snapshot()
        XCTAssertTrue(state.outbox.isEmpty)
        XCTAssertEqual(state.records.first?.data,remote.data)
    }
    func testDraftBaselineIncludesRemoteCreationRevisionAndDeletion() {
        let empty=EditingBaseline(kind:"practice.draft",resourceId:"quiz",records:[])
        let first=CloudRecord(kind:"practice.draft",id:"draft",version:1,data:.object(["resourceId":.string("quiz"),"revision":.number(1)]))
        XCTAssertFalse(empty.matches([first]))
        let loaded=empty.refreshed([first])
        let changed=CloudRecord(kind:"practice.draft",id:"draft",version:2,data:first.data?.merging(.object(["revision":.number(2)])))
        XCTAssertFalse(loaded.matches([changed]))
        XCTAssertFalse(loaded.matches([]))
        let acknowledged=CloudRecord(kind:"practice.draft",id:"draft",version:2,data:first.data)
        XCTAssertTrue(loaded.matches([acknowledged]),"Transport-only acknowledgement must permit continued editing")
    }
    func testCalendarMetadataValidationAlsoAppliesWithoutStartChange() throws {
        for title in ["",String(repeating:"x",count:201),String(repeating:"😀",count:101)] {
            XCTAssertThrowsError(try CalendarPlan.validateMetadata(title:title,durationMinutes:60))
        }
        for minutes in [4,721] { XCTAssertThrowsError(try CalendarPlan.validateMetadata(title:"Plan",durationMinutes:minutes)) }
        for minutes in [5,90,720] { XCTAssertNoThrow(try CalendarPlan.validateMetadata(title:"Plan",durationMinutes:minutes)) }
        let operation=UUID()
        let invalid=ConnectorCommand(id:operation,path:"/v1/organato/sessions/\(UUID())",method:"PATCH",body:.object(["operationId":.string(operation.uuidString),"patch":.object(["title":.string("Plan"),"plannedDurationMinutes":.number(5.5)])]))
        XCTAssertThrowsError(try CalendarPlan.validateCommandMetadata(invalid))
        for patch:JSONValue in [.object(["subjectId":.string(String(repeating:"s",count:201))]),.object(["notes":.string(String(repeating:"n",count:20001))])] {
            let malformed=ConnectorCommand(id:operation,path:invalid.path,method:"PATCH",body:invalid.body.merging(.object(["patch":patch])))
            XCTAssertThrowsError(try CalendarPlan.validateCommandMetadata(malformed))
        }
    }
    func testReviewRequiresVisibleResourceAndRetainsHistoryForRestore() {
        let memory=CloudRecord(kind:"reviewMemory",id:"memory",data:.object(["resourceId":.string("resource"),"resolvedAt":.null]))
        let visible=CloudRecord(kind:"resource",id:"resource",data:.object([:]))
        let deleted=CloudRecord(kind:"resource",id:"resource",deleted:true,data:visible.data)
        XCTAssertEqual(RecordProjections.reviewMemories([memory,visible]),[memory])
        XCTAssertTrue(RecordProjections.reviewMemories([memory,deleted]).isEmpty)
        XCTAssertTrue(RecordProjections.reviewMemories([memory]).isEmpty)
        XCTAssertEqual(RecordProjections.reviewMemories([memory,visible]),[memory])
    }
    func testRecoverySkipsUnknownWrappersAndDomainVersionsWithoutDecodingThem() throws {
        let now=try Clock.date("2026-10-23T00:00:00Z")
        let timer=try StudyRules.start(title:"Current",subjectId:nil,timeZone:"UTC",now:now)
        let current=CloudRecord(kind:"studySession",id:timer.id,data:try JSONValue.encode(timer))
        let wrapper=CloudRecord(kind:"studySession",id:"future",schemaVersion:2,data:.object(["state":.array([])]))
        let domain=CloudRecord(kind:"studySession",id:"future-domain",data:.object(["schemaVersion":.number(2),"state":.array([])]))
        let result=try RecordProjections.recoverTimers([wrapper,domain,current],now:now.addingTimeInterval(60))
        XCTAssertEqual(result.map(\.id),[timer.id])
        XCTAssertEqual(try result[0].data!.decode(StudySession.self).state,.paused(reason:"recovery"))
    }
    func testLocalLocationValidationDoesNotRewriteLegacyPayloads() throws {
        let topic=CloudRecord(kind:"topic",id:"topic",data:.object(["subjectId":.string("subject")]))
        let personal:JSONValue = .object(["subjectId":.null,"topicId":.null])
        let valid:JSONValue = .object(["subjectId":.string("subject"),"topicId":.string("topic")])
        XCTAssertNoThrow(try RecordProjections.validateLocation(personal,topics:[]))
        XCTAssertNoThrow(try RecordProjections.validateLocation(valid,topics:[topic]))
        let legacy=valid.merging(.object(["topicId":.null]))
        XCTAssertThrowsError(try RecordProjections.validateLocation(legacy,topics:[topic]))
        XCTAssertEqual(legacy["subjectId"],.string("subject"))
        XCTAssertThrowsError(try RecordProjections.validateLocation(valid.merging(.object(["subjectId":.string("other")])),topics:[topic]))
    }
}
