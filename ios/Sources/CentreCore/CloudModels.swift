import Foundation
import CryptoKit

public enum CentreError: Error, LocalizedError, Equatable {
    case invalid(String), unavailable(String), conflict, authentication, storage(String)
    public var errorDescription: String? {
        switch self {
        case .invalid(let text), .unavailable(let text), .storage(let text): return text
        case .conflict: return "This record changed on another device. Choose which version to keep in Settings."
        case .authentication: return "Sign in again to synchronize. Your pending changes are saved on this iPhone."
        }
    }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let object = try? value.decode([String: JSONValue].self) { self = .object(object) }
        else if let array = try? value.decode([JSONValue].self) { self = .array(array) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else { self = .number(try value.decode(Double.self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .bool(let item): try value.encode(item)
        case .null: try value.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue {
        get { if case .object(let item) = self { return item[key] ?? .null }; return .null }
        set { if case .object(var item) = self { item[key] = newValue; self = .object(item) } }
    }
    public var string: String? { if case .string(let item) = self { return item }; return nil }
    public var int: Int? { if case .number(let item) = self, item.isFinite, item >= Double(Int.min), item < Double(Int.max) { return Int(exactly: item) }; return nil }
    public var array: [JSONValue] { if case .array(let item) = self { return item }; return [] }
    public func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
    public static func encode<T: Encodable>(_ item: T) throws -> Self { try JSONDecoder().decode(Self.self, from: JSONEncoder().encode(item)) }
    public func merging(_ patch: JSONValue) -> JSONValue {
        guard case .object(var base) = self, case .object(let fields) = patch else { return patch }
        for (key, value) in fields { base[key] = value }
        return .object(base)
    }
}

public struct WorkspaceKey: Codable, Equatable, Sendable {
    public let baseURL: URL
    public let workspaceId: String
    public init(baseURL: URL, workspaceId: String) throws {
        self.baseURL = try CloudURL.validate(baseURL)
        guard !workspaceId.isEmpty, workspaceId.count <= 200 else { throw CentreError.invalid("Invalid workspace.") }
        self.workspaceId = workspaceId
    }
    public var fileKey: String {
        SHA256.hash(data: Data("\(baseURL.absoluteString)\n\(workspaceId)".utf8)).map { String(format:"%02x", $0) }.joined()
    }
}

public enum CloudURL {
    public static func validate(_ url: URL, allowLoopback: Bool = false) throws -> URL {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", parts.scheme == "https" || (allowLoopback && parts.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)) else {
            throw CentreError.invalid("Use the HTTPS address of your Centre Cloud service, without a path or credentials.")
        }
        return url
    }
    public static func pairing(_ url: URL) throws -> (baseURL: URL, code: String) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw invalidPairingLink()
        }

        if parts.scheme == "centre" {
            guard parts.host == "pair", parts.percentEncodedPath.isEmpty,
                  parts.user == nil, parts.password == nil, parts.fragment == nil,
                  let items = parts.queryItems, items.count == 2,
                  items.filter({ $0.name == "baseUrl" }).count == 1,
                  items.filter({ $0.name == "code" }).count == 1,
                  let base = items.first(where: { $0.name == "baseUrl" })?.value.flatMap(URL.init(string:)),
                  let code = items.first(where: { $0.name == "code" })?.value,
                  isPairingCode(code) else {
                throw invalidPairingLink()
            }
            return (try validate(base), code)
        }

        // The web handoff link carries its one-time code only in the fragment, so it
        // is not sent to the public Worker when Safari requests /pair.
        guard parts.scheme == "https", parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil,
              parts.percentEncodedPath == "/pair",
              parts.percentEncodedQuery == nil,
              let fragment = parts.percentEncodedFragment,
              fragment.hasPrefix("code=") else {
            throw invalidPairingLink()
        }
        let code = String(fragment.dropFirst("code=".count))
        guard isPairingCode(code) else { throw invalidPairingLink() }

        var origin = parts
        origin.percentEncodedPath = ""
        origin.query = nil
        origin.fragment = nil
        guard let base = origin.url else { throw invalidPairingLink() }
        return (try validate(base), code)
    }

    private static func isPairingCode(_ code: String) -> Bool {
        let bytes = Array(code.utf8)
        guard (32...200).contains(bytes.count) else { return false }
        return bytes.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45
        }
    }

    private static func invalidPairingLink() -> CentreError {
        .invalid("This pairing code is invalid. Create a new code in desktop Settings.")
    }
}

public struct CloudSession: Codable, Equatable, Sendable {
    public let token: String
    public let deviceId: String
    public let workspaceId: String
    public let expiresAt: String
    public init(token: String, deviceId: String, workspaceId: String, expiresAt: String) {
        self.token = token; self.deviceId = deviceId; self.workspaceId = workspaceId; self.expiresAt = expiresAt
    }
}

public struct CloudRecord: Codable, Equatable, Identifiable, Sendable {
    public let kind: String
    public let id: String
    public let schemaVersion: Int
    public var version: Int
    public var cursor: String
    public var createdCursor:String?
    public var updatedAt: String
    public var deleted: Bool
    public var data: JSONValue?
    public var key: String { "\(kind)/\(id)" }
    public init(kind: String, id: String, schemaVersion: Int = 1, version: Int = 0, cursor: String = "0", createdCursor:String?=nil,updatedAt: String = Clock.iso(Date()), deleted: Bool = false, data: JSONValue?) {
        self.kind=kind; self.id=id; self.schemaVersion=schemaVersion; self.version=version; self.cursor=cursor;self.createdCursor=createdCursor; self.updatedAt=updatedAt; self.deleted=deleted; self.data=data
    }
}

public struct CloudMutation: Codable, Equatable, Identifiable, Sendable {
    public var mutationId: String
    public let kind: String
    public let id: String
    public let schemaVersion: Int
    public var expectedVersion: Int
    public let deleted: Bool
    public let data: JSONValue?
    public var key: String { "\(kind)/\(id)" }
    public init(mutationId: String = UUID().uuidString.lowercased(), kind: String, id: String, expectedVersion: Int, deleted: Bool = false, data: JSONValue?) {
        self.mutationId=mutationId; self.kind=kind; self.id=id; self.schemaVersion=1; self.expectedVersion=expectedVersion; self.deleted=deleted; self.data=data
    }
}

public struct ChangesPage: Codable, Sendable {
    public let records: [CloudRecord]
    public let cursor: String
    public let hasMore: Bool
    public init(records: [CloudRecord], cursor: String, hasMore: Bool) { self.records=records; self.cursor=cursor; self.hasMore=hasMore }
}
public enum MutationResponse: Sendable { case accepted(CloudRecord), conflict(CloudRecord?) }
public protocol CloudTransport: Sendable {
    func changes(cursor: String) async throws -> ChangesPage
    func put(_ mutation: CloudMutation) async throws -> MutationResponse
    func run(_ request: AIRequest) async throws -> AIRun
    func grade(_ request: GradeRequest) async throws -> AIRun
}
public struct AIRequest: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let chatId: String
    public let messageId: String
    public init(id: String = UUID().uuidString.lowercased(), chatId: String, messageId: String) { self.id=id; self.chatId=chatId; self.messageId=messageId }
}
public struct AIRun: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let status: String
    public let model: String?
    public let provider: String?
    public let assistantMessageId: String?
    public let error: JSONValue?
    public init(id:String,status:String,model:String?=nil,provider:String?=nil,assistantMessageId:String?=nil,error:JSONValue?=nil) { self.id=id;self.status=status;self.model=model;self.provider=provider;self.assistantMessageId=assistantMessageId;self.error=error }
}

public enum Clock {
    public static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    public static func date(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let result = formatter.date(from: value) { return result }
        formatter.formatOptions = [.withInternetDateTime]
        guard let result = formatter.date(from: value) else { throw CentreError.invalid("Invalid saved date.") }
        return result
    }
}
