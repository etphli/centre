import Foundation
import CentreCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private struct AuditFailure: Error { let message:String }
private func require(_ value:Bool,_ message:String) throws {
    if !value { throw AuditFailure(message:message) }
}
private func mustReject(_ action:() async throws -> Void) async throws {
    do { try await action() } catch is CentreError { return }
    throw AuditFailure(message:"Expected a local rejection")
}
private struct AuditFeed:CloudTransport {
    let records:[CloudRecord]
    func changes(cursor:String) async throws -> ChangesPage { ChangesPage(records:records,cursor:"2",hasMore:false) }
    func put(_ mutation:CloudMutation) async throws -> MutationResponse {
        .accepted(CloudRecord(kind:mutation.kind,id:mutation.id,version:mutation.expectedVersion+1,cursor:"3",deleted:mutation.deleted,data:mutation.data))
    }
    func run(_ request:AIRequest) async throws -> AIRun { throw CentreError.unavailable("No inference in audit fixtures") }
    func grade(_ request:GradeRequest) async throws -> AIRun { throw CentreError.unavailable("No grading in audit fixtures") }
}
private actor AuditConnector:ConnectorTransport {
    let failure:Bool
    var writes=0
    var reads=0
    var sent:[ConnectorCommand]=[]
    init(failure:Bool=false) { self.failure=failure }
    func send(_ command:ConnectorCommand) async throws -> JSONValue {
        writes += 1; sent.append(command)
        if failure { return try await auditClient("https://connector.invalid").call("/v1/test-invalid") }
        throw URLError(.timedOut)
    }
    func receipt(id:String) async throws -> JSONValue {
        reads += 1
        return try await auditClient("https://connector.invalid").receipt(id:id)
    }
    func counts() -> [Int] { [writes,reads] }
    func sentCommands() -> [ConnectorCommand] { sent }
}

/// Runs with the package verifier and with a Swift interpreter when XCTest is unavailable.
enum AuditRegressions {
    static func run() async throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("centre-audit-regressions-\(UUID())")
        defer { try? FileManager.default.removeItem(at:directory) }
        let workspace=try WorkspaceKey(baseURL:URL(string:"https://audit.invalid")!,workspaceId:"audit")
        func store(_ name:String) throws -> Replica { try Replica(directory:directory.appendingPathComponent(name),workspace:workspace) }
        let original:JSONValue = .object(["id":.string("note"),"title":.string("Original"),"content":.string("Original content"),"subjectId":.null,"topicId":.null,"future":.object(["keep":.bool(true)])])
        let first=CloudRecord(kind:"resource",id:"note",version:1,cursor:"1",data:original)
        let newer=CloudRecord(kind:"resource",id:"note",version:2,cursor:"2",data:original.merging(.object(["title":.string("Desktop title"),"content":.string("Desktop content")])))
        let notes=try store("notes")
        try await notes.synchronize(using:AuditFeed(records:[first]),allowAI:false)
        let loaded=EditingBaseline(kind:"resource",id:"note",records:await notes.snapshot().records)
        try await notes.synchronize(using:AuditFeed(records:[newer]),allowAI:false)
        try await mustReject { try await notes.stage([LocalChange(kind:"resource",id:"note",data:original.merging(.object(["content":.string("Stale phone content")])))],baseline:loaded) }
        let unchanged=await notes.snapshot()
        try require(unchanged.outbox.isEmpty && unchanged.records.first?.data == newer.data,"Stale note overwrote desktop content")
        let fresh=loaded.refreshed(unchanged.records)
        let updated=try await notes.stage([LocalChange(kind:"resource",id:"note",data:newer.data!.merging(.object(["content":.string("Fresh edit")])))],baseline:fresh)
        let staged=await notes.snapshot()
        try require(staged.outbox.first?.mutation.expectedVersion == 2 && updated?.records.first?.data?["future"] == original["future"],"Fresh edit lost CAS/unknown fields")
        try await notes.synchronize(using:AuditFeed(records:[]),allowAI:false)
        try require(updated?.matches(await notes.snapshot().records) == true,"Own ACK incorrectly staled the editor")
        let reopened=try store("notes"), reopenedState=await reopened.snapshot()
        try require(reopenedState.records.first?.data?["content"] == .string("Fresh edit"),"Accepted note did not persist")
        print("PASS IOS-01 stale note blocked atomically; fresh CAS, unknown fields, own ACK and disk reopen")

        let drafts=try store("drafts")
        let draftData:JSONValue = .object(["id":.string("draft"),"resourceId":.string("quiz"),"revision":.number(1),"answers":.object(["q1":.string("Phone")])])
        let d1=CloudRecord(kind:"practice.draft",id:"draft",version:1,cursor:"1",data:draftData)
        let absent=EditingBaseline(kind:"practice.draft",resourceId:"quiz",records:[])
        try await drafts.synchronize(using:AuditFeed(records:[d1]),allowAI:false)
        try await mustReject { try await drafts.stage([LocalChange(kind:"practice.draft",id:"other-draft",data:draftData)],baseline:absent) }
        let draftBaseline=absent.refreshed(await drafts.snapshot().records)
        let d2=CloudRecord(kind:"practice.draft",id:"draft",version:2,cursor:"2",data:draftData.merging(.object(["revision":.number(2),"answers":.object(["q1":.string("Desktop")])])))
        try await drafts.synchronize(using:AuditFeed(records:[d2]),allowAI:false)
        try await mustReject { try await drafts.stage([LocalChange(kind:"practice.draft",id:"draft",data:draftData)],baseline:draftBaseline) }
        let deleted=CloudRecord(kind:"practice.draft",id:"draft",version:3,cursor:"3",deleted:true,data:d2.data)
        try await drafts.synchronize(using:AuditFeed(records:[deleted]),allowAI:false)
        try await mustReject { try await drafts.stage([LocalChange(kind:"practice.draft",id:"draft",data:draftData)],baseline:draftBaseline) }
        try require(await drafts.snapshot().outbox.isEmpty,"Stale draft was queued")
        print("PASS IOS-01 quiz draft remote revision, concurrent creation and tombstone cannot be overwritten")

        try await calendar(directory:directory,workspace:workspace)
        let memory=CloudRecord(kind:"reviewMemory",id:"memory",version:1,data:.object(["resourceId":.string("note"),"resolvedAt":.null]))
        let deletedNote=CloudRecord(kind:"resource",id:"note",version:2,deleted:true,data:original)
        try require(RecordProjections.reviewMemories([memory,first]).count == 1,"Visible review missing")
        try require(RecordProjections.reviewMemories([memory,deletedNote]).isEmpty,"Deleted resource remained in Review")
        try require(RecordProjections.reviewMemories([memory,first]).count == 1,"Restore did not reveal retained review history")
        let softDeleted=CloudRecord(kind:"resource",id:"note",version:2,data:original.merging(.object(["deletedAt":.string("2026-10-23T00:00:00Z")])))
        try require(RecordProjections.reviewMemories([memory,softDeleted]).isEmpty,"Soft deleted resource remained visible")
        print("PASS IOS-03 Review hides missing/deleted resources and reappears on restore without deleting history")

        let now=try Clock.date("2026-10-23T00:00:00Z")
        let timer=try StudyRules.start(title:"Supported timer",subjectId:nil,timeZone:"UTC",now:now)
        let timerJSON=try JSONValue.encode(timer)
        let supported=CloudRecord(kind:"studySession",id:timer.id,version:1,data:timerJSON)
        let futureWrapper=CloudRecord(kind:"studySession",id:"future-wrapper",schemaVersion:2,version:1,data:timerJSON)
        let opaque=CloudRecord(kind:"studySession",id:"opaque-future",schemaVersion:2,version:1,data:.object(["state":.array([])]))
        let futurePayload=CloudRecord(kind:"studySession",id:"future-domain",version:1,data:timerJSON.merging(.object(["schemaVersion":.number(2),"state":.array([])])))
        let timers=try store("timers")
        try await timers.synchronize(using:AuditFeed(records:[supported,futureWrapper,opaque,futurePayload]),allowAI:false)
        let recovery=try RecordProjections.recoverTimers(await timers.snapshot().records,now:now.addingTimeInterval(60))
        try require(recovery.count == 1 && recovery[0].id == timer.id,"Unknown timer was mutated or blocked supported recovery")
        let recovered=try recovery[0].data!.decode(StudySession.self)
        try require(recovered.state == .paused(reason:"recovery") && recovered.segments.isEmpty,"Recovery credited closed-app time")
        try await timers.stage(recovery)
        let timerState=await timers.snapshot()
        try require(timerState.records.contains(opaque) && timerState.records.contains(futurePayload),"Opaque future records changed")
        try require(try RecordProjections.recoverTimers([supported],excluding:[timer.id],now:now).isEmpty,"Owned timer recovered during sync")
        print("PASS IOS-05 unknown wrapper/domain/opaque payload preserved; supported timer alone recovered without closed-app credit")

        let topic=CloudRecord(kind:"topic",id:"topic",data:.object(["subjectId":.string("subject")]))
        try RecordProjections.validateLocation(original,topics:[])
        let located=original.merging(.object(["subjectId":.string("subject"),"topicId":.string("topic")]))
        try RecordProjections.validateLocation(located,topics:[topic])
        for invalid in [located.merging(.object(["topicId":.null])),located.merging(.object(["subjectId":.null])),located.merging(.object(["subjectId":.string("other")]))] {
            try await mustReject { try RecordProjections.validateLocation(invalid,topics:[topic]) }
        }
        let legacy=CloudRecord(kind:"resource",id:"legacy",version:1,data:original.merging(.object(["id":.string("legacy"),"subjectId":.string("subject")])))
        let imports=try store("imports")
        try await imports.synchronize(using:AuditFeed(records:[legacy]),allowAI:false)
        try require(await imports.snapshot().records.first?.data == legacy.data,"Old asymmetric record blocked import or was rewritten")
        print("PASS IOS-06 personal/paired locations valid; asymmetric/wrong-subject edits rejected; legacy import retained")

        AuditURLProtocol.clear()
        let priorOrigin=try auditClient("https://prior.invalid")
        let formOrigin=try auditClient("https://displayed.invalid")
        _ = priorOrigin // The saved origin differs from the form's selected origin.
        let signedIn=try await formOrigin.signIn(idToken:"fixture-id-token",deviceName:"Audit phone")
        let authenticated=try auditClient(formOrigin.baseURL.absoluteString,token:signedIn.token)
        try await authenticated.bootstrap(workspaceId:signedIn.workspaceId)
        let requests=AuditURLProtocol.requests()
        try require(requests.count == 2 && requests.allSatisfy{$0.url?.host == "displayed.invalid"},"Authentication escaped the selected form origin")
        try require(requests[0].value(forHTTPHeaderField:"Authorization") == nil && requests[1].value(forHTTPHeaderField:"Authorization") == "Bearer " + signedIn.token,"Session was not bound to selected origin")
        let selectedWorkspace=try WorkspaceKey(baseURL:formOrigin.baseURL,workspaceId:signedIn.workspaceId)
        let priorWorkspace=try WorkspaceKey(baseURL:priorOrigin.baseURL,workspaceId:signedIn.workspaceId)
        try require(selectedWorkspace.fileKey != priorWorkspace.fileKey,"Selected origin reused previous cache")
        print("PASS IOS-04 simulated Google exchange/bootstrap use displayed origin and isolated workspace cache; native SDK/UI remains unverified")

        let durationRecords=[90,5,720].map { duration in
            CloudRecord(kind:"calendarEvent",id:"duration-\(duration)",version:1,data:.object(["plannedDurationMinutes":.number(Double(duration)),"dueAt":.null]))
        }
        let durationStore=try store("durations")
        try await durationStore.synchronize(using:AuditFeed(records:durationRecords),allowAI:false)
        let importedDurations=await (try store("durations")).snapshot()
        try require(importedDurations.outbox.isEmpty,"Imported canonical duration caused a native mutation")
        for duration in [90,5,720] {
            let event=importedDurations.records.first{$0.id == "duration-\(duration)"}!.data!
            try require(event["plannedDurationMinutes"].int == duration && event["dueAt"] == .null,"Native import changed canonical duration/deadline")
            try CalendarPlan.validateMetadata(title:"Session",durationMinutes:duration)
        }
        let archive=CloudRecord(kind:"calendarEvent",id:"duration-90",version:2,cursor:"4",deleted:true,data:nil)
        try await durationStore.synchronize(using:AuditFeed(records:[archive]),allowAI:false)
        let archived=await durationStore.snapshot()
        try require(archived.outbox.isEmpty && archived.records.contains(archive) && !RecordProjections.visible(archive),"Null archive tombstone was rejected or rewritten")
        print("PASS canonical integer durations 90/5/720 and null deadline persist unchanged; null archive tombstone imports without mutation")
    }

    private static func calendar(directory:URL,workspace:WorkspaceKey) async throws {
        let journalDirectory=directory.appendingPathComponent("calendar")
        func journal() throws -> ConnectorJournal { try ConnectorJournal(directory:journalDirectory,workspace:workspace) }
        func command(_ title:String) -> ConnectorCommand {
            let id=UUID()
            return ConnectorCommand(id:id,path:"/v1/organato/sessions/\(UUID().uuidString.lowercased())",method:"PATCH",body:.object(["operationId":.string(id.uuidString.lowercased()),"expectedVersion":.number(1),"expectedRevision":.number(1),"patch":.object(["title":.string(title),"plannedDurationMinutes":.number(60)])]))
        }
        let store=try journal(), invalid=command(String(repeating:"x",count:201))
        try await mustReject { try await store.stage(invalid) }
        try require(await store.snapshot().isEmpty,"Invalid metadata staged")
        for duration in [4,721] { try await mustReject { try CalendarPlan.validateMetadata(title:"Plan",durationMinutes:duration) } }
        for patch:JSONValue in [
            .object(["title":.string(String(repeating:"😀",count:101))]),
            .object(["plannedDurationMinutes":.number(5.5)]),
            .object(["subjectId":.string(String(repeating:"s",count:201))]),
            .object(["notes":.string(String(repeating:"n",count:20001))])
        ] {
            let malformed=ConnectorCommand(id:invalid.id,path:invalid.path,method:invalid.method,body:invalid.body.merging(.object(["patch":patch])))
            try await mustReject { try await store.stage(malformed) }
        }
        // Persist an actual older journal shape, as produced before this fix.
        let oldSent=QueuedLegacyCommand(command:invalid,sent:true)
        let disk=LegacyJournal(schemaVersion:1,workspace:workspace,commands:[oldSent])
        try FileManager.default.createDirectory(at:journalDirectory,withIntermediateDirectories:true)
        try JSONEncoder().encode(disk).write(to:journalDirectory.appendingPathComponent(workspace.fileKey+"-organato.json"))
        let reopened=try journal(), network=AuditConnector()
        try await reopened.process(using:network)
        let rejected=await reopened.snapshot()
        try require(rejected[0].status == "failed" && rejected[0].receipt == nil && rejected[0].body == invalid.body,"Old invalid missing operation did not become a distinct local rejection")
        let recovered=try journal()
        try await recovered.acknowledge(invalid.id)
        try require(await recovered.snapshot().isEmpty,"Invalid operation could not be closed")
        try require(await network.counts() == [0,1],"Invalid old operation was resent")
        // A valid request with 400 may have reached upstream. Missing receipt is not
        // permission to close it or change the original identity/body.
        let valid=command("Valid metadata"), uncertain=AuditConnector(failure:true)
        try await recovered.stage(valid)
        do { try await recovered.process(using:uncertain) } catch is CloudFailure {}
        try await recovered.process(using:uncertain)
        try await mustReject { try await recovered.acknowledge(valid.id) }
        let uncertainState=await recovered.snapshot()
        try require(uncertainState[0].sent && uncertainState[0].localRejection == nil && uncertainState[0].missingOnServer == true,"Uncertain valid-body write was released")
        try require(await uncertain.counts() == [1,1],"Uncertain operation automatically replayed")
        // A timeout with valid metadata remains immutable and requires explicit retry.
        let timeoutDirectory=directory.appendingPathComponent("calendar-timeout")
        let timeoutStore=try ConnectorJournal(directory:timeoutDirectory,workspace:workspace)
        let timeoutCommand=command("Timed out"), timeoutNetwork=AuditConnector()
        try await timeoutStore.stage(timeoutCommand)
        do { try await timeoutStore.process(using:timeoutNetwork) } catch {}
        try await timeoutStore.process(using:timeoutNetwork)
        try await mustReject { try await timeoutStore.acknowledge(timeoutCommand.id) }
        do { try await timeoutStore.retryMissing(id:timeoutCommand.id,using:timeoutNetwork) } catch {}
        let sent=await timeoutNetwork.sentCommands()
        try require(sent.count == 2 && sent[0].id == sent[1].id && sent[0].body == sent[1].body,"Explicit retry changed uncertain command identity/body")
        let unknown=QueuedLegacyCommand(command:invalid,sent:true,receipt:.object(["operationId":.string(invalid.id.uuidString),"status":.string("unknown")]))
        try JSONEncoder().encode(LegacyJournal(schemaVersion:1,workspace:workspace,commands:[unknown])).write(to:journalDirectory.appendingPathComponent(workspace.fileKey+"-organato.json"))
        let unknownStore=try journal()
        try await unknownStore.process(using:network)
        try await mustReject { try await unknownStore.acknowledge(invalid.id) }
        try await mustReject { try await unknownStore.retryMissing(id:invalid.id,using:network) }
        try require(await unknownStore.snapshot()[0].localRejection == nil,"Prior unknown receipt was released as a local rejection")
        print("PASS IOS-02 invalid metadata cannot stage; old invalid missing command closes after disk reopen; valid-body 400 remains uncertain")
    }
}
private struct LegacyJournal:Encodable { let schemaVersion:Int;let workspace:WorkspaceKey;let commands:[QueuedLegacyCommand] }
private struct QueuedLegacyCommand:Encodable {
    let id:UUID;let path:String;let method:String;let body:JSONValue;let sent:Bool;let receipt:JSONValue?
    init(command:ConnectorCommand,sent:Bool,receipt:JSONValue?=nil) { id=command.id;path=command.path;method=command.method;body=command.body;self.sent=sent;self.receipt=receipt }
}

private func auditClient(_ baseURL:String,token:String?=nil) throws -> CloudHTTP {
    let config=URLSessionConfiguration.ephemeral
    config.protocolClasses=[AuditURLProtocol.self]
    return try CloudHTTP(baseURL:URL(string:baseURL)!,token:token,session:URLSession(configuration:config))
}
private final class AuditURLProtocol:URLProtocol,@unchecked Sendable {
    private static let lock=NSLock()
    private static var captured:[URLRequest]=[]
    static func clear() { lock.lock();defer { lock.unlock() };captured=[] }
    static func requests() -> [URLRequest] { lock.lock();defer { lock.unlock() };return captured }
    override class func canInit(with request:URLRequest) -> Bool { true }
    override class func canonicalRequest(for request:URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock();Self.captured.append(request);Self.lock.unlock()
        let status:Int, value:JSONValue
        switch request.url?.path {
        case "/v1/auth/google":
            status=200;value = .object(["token":.string("ctr_"+String(repeating:"x",count:43)),"deviceId":.string("fixture-device"),"workspaceId":.string("fixture-workspace"),"expiresAt":.string("2099-01-01T00:00:00Z")])
        case "/v1/bootstrap":status=200;value = .object(["schemaVersion":.number(1),"workspaceId":.string("fixture-workspace")])
        case "/v1/test-invalid":status=400;value = .object(["error":.object(["code":.string("invalid_request")])])
        default:status=404;value = .object(["error":.object(["code":.string("operation_not_found")])])
        }
        do {
            let data=try JSONEncoder().encode(value)
            let response=HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!
            client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self,didFailWithError:error) }
    }
    override func stopLoading() {}
}
