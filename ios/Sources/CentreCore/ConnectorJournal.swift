import Foundation

public struct ConnectorCommand: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let path: String
    public let method: String
    public let body: JSONValue
    public internal(set) var sent: Bool
    public internal(set) var receipt: JSONValue?
    public internal(set) var missingOnServer:Bool?=nil
    public init(id: UUID = UUID(), path: String, method: String, body: JSONValue) {
        self.id=id; self.path=path; self.method=method; self.body=body; self.sent=false; self.receipt=nil
    }
    public internal(set) var localRejection: String?=nil
    public var status: String {
        if localRejection != nil { return "failed" }
        if let status=receipt?["status"].string { return status }
        return missingOnServer == true ? "missing" : (sent ? "unknown" : "queued")
    }
    public var pending: Bool { receipt?["status"].string != "succeeded" }
}

public protocol ConnectorTransport: Sendable {
    func send(_ command: ConnectorCommand) async throws -> JSONValue
    func receipt(id: String) async throws -> JSONValue
}

/// A separate durable ledger for planned calendar writes. Uncertain writes are never replayed.
public actor ConnectorJournal {
    private struct State: Codable {
        let schemaVersion: Int
        let workspace: WorkspaceKey
        var commands: [ConnectorCommand]
    }
    private var state: State
    private let file: URL
    private var processing = false
    private var erased=false
    public init(directory: URL, workspace: WorkspaceKey) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        file=directory.appendingPathComponent(workspace.fileKey + "-organato.json")
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                let loaded=try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
                guard loaded.schemaVersion == 1, loaded.workspace == workspace,
                      Set(loaded.commands.map(\.id)).count == loaded.commands.count else { throw CentreError.invalid("Invalid connector journal binding.") }
                for command in loaded.commands {
                    try Self.validate(command)
                    if let receipt=command.receipt {
                        guard command.sent else { throw CentreError.invalid("An unsent operation has a receipt.") }
                        try Self.validate(receipt, id: command.id)
                    }
                }
                state=loaded
            } catch { throw CentreError.storage("Saved calendar operations could not be read. The original file has been preserved.") }
        } else { state=State(schemaVersion: 1, workspace: workspace, commands: []) }
    }
    public func snapshot() -> [ConnectorCommand] { state.commands }
    public var pendingCount: Int { state.commands.filter(\.pending).count }
    public func stage(_ command: ConnectorCommand) throws {
        if erased { throw CentreError.authentication }
        try Self.validate(command)
        try CalendarPlan.validateCommandMetadata(command)
        if let existing=state.commands.first(where: { $0.id == command.id }) {
            guard existing.path == command.path, existing.method == command.method, existing.body == command.body else {
                throw CentreError.invalid("This operation ID already belongs to a different calendar change.")
            }
            return
        }
        guard !command.sent, command.receipt == nil, command.localRejection == nil else { throw CentreError.invalid("Stage a new unsent calendar operation.") }
        var next=state; next.commands.append(command); try persist(next)
    }
    public func updateReceipt(_ receipt: JSONValue) throws {
        guard let raw=receipt["operationId"].string, let id=UUID(uuidString: raw),
              let index=state.commands.firstIndex(where: { $0.id == id }), state.commands[index].sent else {
            throw CentreError.invalid("The calendar receipt has an unexpected operation identity.")
        }
        try Self.validate(receipt, id: id)
        if state.commands[index].receipt?["status"].string == "succeeded", receipt["status"].string != "succeeded" {
            throw CentreError.invalid("A successful calendar operation cannot return to pending.")
        }
        var next=state; next.commands[index].receipt=receipt;next.commands[index].missingOnServer=nil;next.commands[index].localRejection=nil
        let succeeded=next.commands.filter { $0.receipt?["status"].string == "succeeded" }
        let expired=Set(succeeded.prefix(max(0, succeeded.count - 100)).map(\.id))
        next.commands.removeAll { expired.contains($0.id) }
        try persist(next)
    }
    public func process(using transport: any ConnectorTransport) async throws {
        if erased { throw CentreError.authentication }
        guard !processing else { return }
        processing=true; defer { processing=false }
        for id in state.commands.map(\.id) {
            guard let index=state.commands.firstIndex(where: { $0.id == id }) else { continue }
            let command=state.commands[index]
            if ["succeeded", "failed", "conflict"].contains(command.status) { continue }
            let receipt: JSONValue
            if command.sent {
                do { receipt=try await transport.receipt(id: command.id.uuidString.lowercased()) }
                catch let missing as CloudFailure where missing.status == 404 && missing.body["error"]["code"].string == "operation_not_found" {
                    var next=state;next.commands[index].missingOnServer=command.receipt == nil ? true:nil;try persist(next)
                    _ = try rejectInvalidMetadata(at:index)
                    continue
                }
            } else {
                try Self.validate(command)
                if try rejectInvalidMetadata(at:index) { continue }
                var next=state; next.commands[index].sent=true; try persist(next)
                do { receipt=try await transport.send(state.commands[index]) }
                catch let rejection as CloudFailure where rejection.status == 400 && rejection.body["error"]["code"].string == "invalid_request" {
                    _ = try rejectInvalidMetadata(at:index)
                    throw rejection
                }
                catch let rejection as CloudFailure where rejection.status == 503 && rejection.body["error"]["code"].string == "organato_unconfigured" {
                    // This explicit pre-operation rejection proves no upstream write began.
                    var rejected=state;rejected.commands[index].sent=false;try persist(rejected);throw rejection
                }
            }
            try updateReceipt(receipt)
        }
    }
    /// Only an explicit user action retries an absent receipt, with the original immutable gateway identity.
    public func retryMissing(id:UUID,using transport:any ConnectorTransport) async throws {
        guard !erased else { throw CentreError.authentication }
        guard !processing else { throw CentreError.unavailable("Wait for calendar synchronization to finish.") }
        guard let index=state.commands.firstIndex(where:{$0.id == id}),state.commands[index].sent,state.commands[index].missingOnServer == true,state.commands[index].receipt == nil,state.commands[index].localRejection == nil else {
            throw CentreError.unavailable("Check this change's receipt before trying it again.")
        }
        processing=true;defer { processing=false }
        if try rejectInvalidMetadata(at:index) { return }
        let command=state.commands[index]
        var next=state;next.commands[index].missingOnServer=nil;try persist(next)
        let receipt=try await transport.send(command)
        try updateReceipt(receipt)
    }
    public func acknowledge(_ id:UUID) throws {
        guard !processing else { throw CentreError.unavailable("Wait for calendar synchronization to finish.") }
        guard let command=state.commands.first(where:{$0.id == id}),["failed","conflict"].contains(command.status) else {
            throw CentreError.unavailable("An uncertain calendar change must be reconciled before it can be closed.")
        }
        var next=state;next.commands.removeAll{$0.id == id};try persist(next)
    }
    public func erase() throws {
        guard !processing else { throw CentreError.unavailable("Wait for calendar synchronization to finish before signing out.") }
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        state.commands=[];erased=true
    }
    /// A valid-body 400 can describe an upstream response after a write. Never
    /// release that operation. Invalid original metadata cannot pass gateway validation.
    private func rejectInvalidMetadata(at index:Int) throws -> Bool {
        guard state.commands[index].receipt == nil else { return false }
        do { try CalendarPlan.validateCommandMetadata(state.commands[index]); return false }
        catch {
            var next=state
            next.commands[index].localRejection="This saved calendar change has invalid metadata and cannot be applied. Close it, then edit the session again. " + error.localizedDescription
            try persist(next)
            return true
        }
    }
    private static func validate(_ command: ConnectorCommand) throws {
        guard case .object = command.body, let operation=command.body["operationId"].string,
              UUID(uuidString: operation) == command.id else { throw CentreError.invalid("Calendar operation identity does not match its body.") }
        let prefix="/v1/organato/sessions"
        if command.path == prefix, command.method == "POST" { return }
        guard command.path.hasPrefix(prefix + "/") else { throw CentreError.invalid("Invalid calendar operation path.") }
        let parts=String(command.path.dropFirst(prefix.count + 1)).split(separator: "/", omittingEmptySubsequences: false)
        guard let session=parts.first, UUID(uuidString: String(session)) != nil else { throw CentreError.invalid("Invalid calendar session identity.") }
        if parts.count == 1, command.method == "PATCH" { return }
        if parts.count == 2, ["complete", "archive"].contains(String(parts[1])), command.method == "POST" { return }
        throw CentreError.invalid("Invalid calendar operation path or method.")
    }
    private static func validate(_ receipt: JSONValue, id: UUID) throws {
        guard case .object = receipt, let operation=receipt["operationId"].string, UUID(uuidString: operation) == id,
              let status=receipt["status"].string, ["succeeded", "unknown", "conflict", "failed", "pending"].contains(status) else {
            throw CentreError.invalid("The calendar receipt has an invalid identity or status.")
        }
    }
    private func persist(_ next: State) throws {
        if erased { throw CentreError.authentication }
        let encoder=JSONEncoder(); encoder.outputFormatting=[.sortedKeys]
        try encoder.encode(next).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        state=next
    }
}
