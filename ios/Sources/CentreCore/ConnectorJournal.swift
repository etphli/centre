import Foundation

public struct ConnectorCommand: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let path: String
    public let method: String
    public let body: JSONValue
    public internal(set) var sent: Bool
    public internal(set) var receipt: JSONValue?
    public init(id: UUID = UUID(), path: String, method: String, body: JSONValue) {
        self.id=id; self.path=path; self.method=method; self.body=body; self.sent=false; self.receipt=nil
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
        try Self.validate(command)
        if let existing=state.commands.first(where: { $0.id == command.id }) {
            guard existing.path == command.path, existing.method == command.method, existing.body == command.body else {
                throw CentreError.invalid("This operation ID already belongs to a different calendar change.")
            }
            return
        }
        guard !command.sent, command.receipt == nil else { throw CentreError.invalid("Stage a new unsent calendar operation.") }
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
        var next=state; next.commands[index].receipt=receipt
        let succeeded=next.commands.filter { $0.receipt?["status"].string == "succeeded" }
        let expired=Set(succeeded.prefix(max(0, succeeded.count - 100)).map(\.id))
        next.commands.removeAll { expired.contains($0.id) }
        try persist(next)
    }
    public func process(using transport: any ConnectorTransport) async throws {
        guard !processing else { return }
        processing=true; defer { processing=false }
        for id in state.commands.map(\.id) {
            guard let index=state.commands.firstIndex(where: { $0.id == id }) else { continue }
            let command=state.commands[index]
            if let status=command.receipt?["status"].string, ["succeeded", "failed", "conflict"].contains(status) { continue }
            let receipt: JSONValue
            if command.sent {
                receipt=try await transport.receipt(id: command.id.uuidString.lowercased())
            } else {
                try Self.validate(command)
                var next=state; next.commands[index].sent=true; try persist(next)
                do { receipt=try await transport.send(state.commands[index]) }
                catch let rejection as CloudFailure where rejection.status == 503 && rejection.body["error"]["code"].string == "organato_unconfigured" {
                    // This explicit pre-operation rejection proves no upstream write began.
                    var rejected=state;rejected.commands[index].sent=false;try persist(rejected);throw rejection
                }
            }
            try updateReceipt(receipt)
        }
    }
    public func acknowledge(_ id:UUID) throws {
        guard let command=state.commands.first(where:{$0.id == id}),["failed","conflict"].contains(command.receipt?["status"].string ?? "") else {
            throw CentreError.unavailable("An uncertain calendar change must be reconciled before it can be closed.")
        }
        var next=state;next.commands.removeAll{$0.id == id};try persist(next)
    }
    public func erase() throws {
        guard !processing else { throw CentreError.unavailable("Wait for calendar synchronization to finish before signing out.") }
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        state.commands=[]
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
        let encoder=JSONEncoder(); encoder.outputFormatting=[.sortedKeys]
        try encoder.encode(next).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        state=next
    }
}
