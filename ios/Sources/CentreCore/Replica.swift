import Foundation

public struct SyncConflict: Codable, Equatable, Identifiable, Sendable {
    public var id: String { key }
    public let key: String
    public let local: CloudRecord
    public let remote: CloudRecord?
}
public struct QueuedMutation: Codable, Equatable, Sendable {
    public var mutation: CloudMutation
    public var sent: Bool
    public var changedAt: String? = nil
}
public struct GradeRequest: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let draftId: String
    public let resourceId: String
    public let expectedDraftRevision: Int
    public init(id: String, draftId: String, resourceId: String, expectedDraftRevision: Int) {
        self.id=id;self.draftId=draftId;self.resourceId=resourceId;self.expectedDraftRevision=expectedDraftRevision
    }
}
public enum PendingAI: Codable, Equatable, Sendable {
    case chat(AIRequest, AIRun?), grade(GradeRequest, AIRun?)
    public var id: String { switch self { case .chat(let r,_):return r.id; case .grade(let r,_):return r.id } }
    public var run: AIRun? { switch self { case .chat(_,let r),.grade(_,let r):return r } }
    func updating(_ run: AIRun) -> PendingAI { switch self { case .chat(let r,_):return .chat(r,run); case .grade(let r,_):return .grade(r,run) } }
}
public struct ReplicaState: Codable, Sendable {
    public let schemaVersion: Int
    public let workspace: WorkspaceKey
    public var cursor: String
    public var shadow: [String: CloudRecord]
    public var outbox: [QueuedMutation]
    public var conflicts: [SyncConflict]
    public var ai: [PendingAI]
    public var connector: JSONValue
    public var records: [CloudRecord] {
        var result = shadow
        for queued in outbox {
            let item = queued.mutation
            let stamp=queued.changedAt ?? item.data?["updatedAt"].string ?? item.data?["createdAt"].string ?? shadow[item.key]?.updatedAt ?? "1970-01-01T00:00:00.000Z"
            let prior=result[item.key]
            result[item.key] = CloudRecord(kind:item.kind,id:item.id,version:item.expectedVersion,cursor:prior?.cursor ?? "0",createdCursor:prior?.createdCursor,updatedAt:stamp,deleted:item.deleted,data:item.data)
        }
        return result.values.sorted { $0.key < $1.key }
    }
    public var pendingCount: Int { outbox.count + ai.count }
}
public struct LocalChange: Sendable {
    public let kind: String
    public let id: String
    public let data: JSONValue?
    public let deleted: Bool
    public init(kind:String,id:String,data:JSONValue?,deleted:Bool=false) { self.kind=kind;self.id=id;self.data=data;self.deleted=deleted }
}

/// One actor and one atomic file per server/workspace. The projection and outbox commit together.
public actor Replica {
    private var state: ReplicaState
    private let file: URL
    private var synchronizing = false
    private var erased=false
    public init(directory: URL, workspace: WorkspaceKey) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories:true, attributes:[.posixPermissions:0o700])
        file = directory.appendingPathComponent(workspace.fileKey + ".json")
        if FileManager.default.fileExists(atPath:file.path) {
            do { state = try JSONDecoder().decode(ReplicaState.self, from:Data(contentsOf:file)) }
            catch { throw CentreError.storage("Saved study data could not be read. The original file has been preserved.") }
            guard state.schemaVersion == 1, state.workspace == workspace else { throw CentreError.storage("This cache belongs to a different workspace or a newer app.") }
        } else {
            state = ReplicaState(schemaVersion:1, workspace:workspace, cursor:"0", shadow:[:], outbox:[], conflicts:[], ai:[], connector:.object([:]))
        }
    }
    public func snapshot() -> ReplicaState { state }
    public func stage(_ changes: [LocalChange], ai: PendingAI? = nil) throws {
        try requireActive()
        var next = state
        for change in changes {
            guard !change.kind.isEmpty, !change.id.isEmpty else { throw CentreError.invalid("Missing record identity.") }
            let key = "\(change.kind)/\(change.id)"
            guard !next.conflicts.contains(where:{$0.key == key}) else { throw CentreError.conflict }
            let prior = next.records.first(where:{$0.key == key})
            let data = change.deleted ? change.data : prior?.data?.merging(change.data ?? .null) ?? change.data
            if let index = next.outbox.lastIndex(where:{$0.mutation.key == key}), !next.outbox[index].sent {
                let old = next.outbox[index].mutation
                next.outbox[index].mutation = CloudMutation(mutationId:old.mutationId,kind:change.kind,id:change.id,expectedVersion:old.expectedVersion,deleted:change.deleted,data:data)
                next.outbox[index].changedAt=Clock.iso(Date())
            } else {
                next.outbox.append(QueuedMutation(mutation:CloudMutation(kind:change.kind,id:change.id,expectedVersion:next.shadow[key]?.version ?? 0,deleted:change.deleted,data:data),sent:false,changedAt:Clock.iso(Date())))
            }
        }
        if let ai, !next.ai.contains(where:{$0.id == ai.id}) { next.ai.append(ai) }
        try persist(next)
    }
    public func cacheConnector(_ connector: JSONValue) throws { try requireActive();var next=state;next.connector=connector;try persist(next) }
    public func resolve(_ conflict: SyncConflict, useLocal: Bool) throws {
        try requireActive()
        guard !useLocal || !["attempt","practice.attempt"].contains(conflict.local.kind) else {
            throw CentreError.invalid("Marked attempts are immutable. Keep the cloud result.")
        }
        guard let current = state.conflicts.first(where:{$0.key == conflict.key}), current == conflict else { throw CentreError.invalid("This conflict changed. Reload it before choosing.") }
        var next=state
        next.outbox.removeAll(where:{$0.mutation.key == conflict.key})
        next.conflicts.removeAll(where:{$0.key == conflict.key})
        next.ai.removeAll { job in
            if case .grade(let request, _) = job { return conflict.key == "practice.draft/\(request.draftId)" }
            return false
        }
        if let remote=conflict.remote { next.shadow[conflict.key]=remote } else { next.shadow.removeValue(forKey:conflict.key) }
        if useLocal {
            var data=conflict.local.data
            if let revision=data?["revision"].int { data?["revision"] = .number(Double(max(revision,conflict.remote?.data?["revision"].int ?? 0)+1)) }
            let mutation=CloudMutation(kind:conflict.local.kind,id:conflict.local.id,expectedVersion:conflict.remote?.version ?? 0,deleted:conflict.local.deleted,data:data)
            next.outbox.append(QueuedMutation(mutation:mutation,sent:false,changedAt:Clock.iso(Date())))
        }
        try persist(next)
    }
    public func dismissAI(id: String) throws { try requireActive();var next=state;next.ai.removeAll(where:{$0.id == id});try persist(next) }
    public func erase() throws {
        guard !synchronizing else { throw CentreError.unavailable("Wait for synchronization to finish before signing out.") }
        if FileManager.default.fileExists(atPath:file.path) { try FileManager.default.removeItem(at:file) }
        erased=true
        state=ReplicaState(schemaVersion:1,workspace:state.workspace,cursor:"0",shadow:[:],outbox:[],conflicts:[],ai:[],connector:.object([:]))
    }
    public func synchronize(using transport: any CloudTransport, allowAI: Bool = true) async throws {
        try requireActive()
        guard !synchronizing else { return }
        synchronizing=true; defer { synchronizing=false }
        // Mark sent before network. Timeout/restart must replay the exact same body and UUID.
        var attempts=0
        while let index=state.outbox.firstIndex(where:{ queued in !state.conflicts.contains(where:{$0.key == queued.mutation.key}) }) {
            attempts += 1
            guard attempts <= 500 else { throw CentreError.unavailable("More changes remain. Synchronize again to continue.") }
            var sent=state;sent.outbox[index].sent=true;try persist(sent)
            let mutation=state.outbox[index].mutation
            let response=try await transport.put(mutation)
            var next=state
            switch response {
            case .accepted(let record):
                try Self.validate(record)
                guard record.key == mutation.key else { throw CentreError.invalid("The service returned a different record.") }
                if (next.shadow[record.key]?.version ?? 0) <= record.version { next.shadow[record.key]=record }
                next.outbox.removeAll(where:{$0.mutation.mutationId == mutation.mutationId})
                // Only an unsent successor can receive the acknowledged transport version.
                if let successor=next.outbox.firstIndex(where:{$0.mutation.key == mutation.key && !$0.sent}) { next.outbox[successor].mutation.expectedVersion=record.version }
            case .conflict(let remote):
                if let remote { try Self.validate(remote); guard remote.key == mutation.key else { throw CentreError.invalid("Invalid conflict identity.") } }
                let local=next.records.first(where:{$0.key == mutation.key}) ?? CloudRecord(kind:mutation.kind,id:mutation.id,deleted:mutation.deleted,data:mutation.data)
                next.conflicts.removeAll(where:{$0.key == mutation.key})
                next.conflicts.append(SyncConflict(key:mutation.key,local:local,remote:remote))
            }
            try persist(next)
        }
        // AI failures must not prevent importing archived chats or other cloud changes.
        var firstAIError: Error?
        if allowAI {
            for job in state.ai {
                if let status=job.run?.status, ["failed","interrupted","conflict"].contains(status) { continue }
                // No AI begins until every referenced local record has reached the server.
                let blocked: Bool
                switch job {
                case .chat(let request,_): blocked=state.outbox.contains(where:{$0.mutation.key == "chat/\(request.chatId)" || $0.mutation.key == "message/\(request.messageId)"})
                case .grade(let request,_): blocked=state.outbox.contains(where:{$0.mutation.key == "practice.draft/\(request.draftId)" || $0.mutation.key == "resource/\(request.resourceId)"})
                }
                if blocked { continue }
                let run: AIRun
                do {
                    switch job { case .chat(let request,_):run=try await transport.run(request); case .grade(let request,_):run=try await transport.grade(request) }
                } catch {
                    if firstAIError == nil { firstAIError=error }
                    if let failure=error as? CloudFailure, let run=Self.rejectedAI(job.id, failure:failure),
                       let index=state.ai.firstIndex(where:{$0.id == job.id}) {
                        var next=state; next.ai[index]=next.ai[index].updating(run); try persist(next)
                    }
                    continue
                }
                guard run.id == job.id else {
                    if firstAIError == nil { firstAIError=CentreError.invalid("The AI result has an unexpected identity.") }
                    continue
                }
                var next=state
                if run.status == "completed" { next.ai.removeAll(where:{$0.id == job.id}) }
                else if let index=next.ai.firstIndex(where:{$0.id == job.id}) { next.ai[index]=job.updating(run) }
                try persist(next)
            }
        }
        var pages=0
        while true {
            pages += 1
            guard pages <= 200 else { throw CentreError.unavailable("More cloud data remains. Synchronize again to continue.") }
            let page=try await transport.changes(cursor:state.cursor)
            guard !page.cursor.isEmpty, page.cursor.allSatisfy(\.isNumber), page.records.count <= 100 else { throw CentreError.invalid("Invalid synchronization page.") }
            guard !page.hasMore || page.cursor != state.cursor else { throw CentreError.invalid("Synchronization did not advance.") }
            var next=state
            for record in page.records {
                try Self.validate(record)
                if (next.shadow[record.key]?.version ?? 0) <= record.version { next.shadow[record.key]=record }
            }
            next.cursor=page.cursor
            try persist(next) // cursor advances in the same atomic commit as its records
            if !page.hasMore { break }
        }
        if let firstAIError { throw firstAIError }
    }
    private static func rejectedAI(_ id:String, failure:CloudFailure) -> AIRun? {
        let code=failure.body["error"]["code"].string ?? ""
        let status:String
        switch failure.status {
        case 429,503: status="unavailable"
        case 404 where code == "not_found": status="failed"
        case 400 where ["validation","invalid_request","invalid_message","invalid_json"].contains(code): status="failed"
        case 409 where ["conflict","idempotency_mismatch","grade_in_progress"].contains(code): status="conflict"
        default: return nil
        }
        return AIRun(id:id,status:status,error:failure.body["error"])
    }
    private static func validate(_ record:CloudRecord) throws {
        guard record.schemaVersion >= 1, record.version > 0, !record.kind.isEmpty, !record.id.isEmpty,
              record.cursor.allSatisfy(\.isNumber), !record.cursor.isEmpty,
              record.deleted || record.data != nil else { throw CentreError.invalid("Invalid cloud record.") }
        _ = try Clock.date(record.updatedAt)
        if let data=record.data, case .object = data {} else if !record.deleted { throw CentreError.invalid("Invalid cloud record payload.") }
    }
    private func persist(_ next:ReplicaState) throws {
        try requireActive()
        let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
        let bytes=try encoder.encode(next)
        try bytes.write(to:file,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600], ofItemAtPath:file.path)
        state=next
    }
    private func requireActive() throws { if erased { throw CentreError.authentication } }
}
