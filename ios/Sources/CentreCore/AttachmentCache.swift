import Foundation
import CryptoKit

public struct AttachmentFile: Sendable {
    public let url: URL
    public let name: String
    public let mimeType: String
}
public protocol AttachmentTransport: Sendable {
    func attachmentGet(_ path: String) async throws -> JSONValue
}
extension CloudHTTP: AttachmentTransport {
    public func attachmentGet(_ path: String) async throws -> JSONValue { try await call(path) }
}

/// Verified, read-only downloads. A chat target is part of every request and local cache identity.
public actor AttachmentCache {
    private struct Metadata: Codable {
        let id: String
        let name: String
        let mimeType: String
        let size: Int
        let sha256: String
    }
    private struct Entry: Codable {
        let schemaVersion: Int
        let workspace: WorkspaceKey
        let chatId: String
        let attachment: Metadata
    }
    private let directory: URL
    private let workspace: WorkspaceKey
    private let byteLimit: Int
    private var generation = 0
    private var erased=false
    private static let chunkBytes = 256 * 1024
    private static let fileLimit = 20 * 1024 * 1024
    public init(directory: URL, workspace: WorkspaceKey, byteLimit: Int = 100 * 1024 * 1024) throws {
        guard byteLimit > 0, byteLimit <= 100 * 1024 * 1024 else { throw CentreError.invalid("Invalid attachment cache limit.") }
        self.directory = directory.appendingPathComponent(workspace.fileKey + "-attachments", isDirectory: true)
        self.workspace = workspace; self.byteLimit = byteLimit
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.directory.path)
    }
    public func cached(id: String, chatId: String) throws -> AttachmentFile? {
        let id = try Self.identity(id, chatId: chatId)
        let folder = location(id, chatId: chatId)
        guard FileManager.default.fileExists(atPath: folder.path) else { return nil }
        do {
            let entry = try JSONDecoder().decode(Entry.self, from: Self.read(folder.appendingPathComponent("metadata.json")))
            guard entry.schemaVersion == 1, entry.workspace == workspace, entry.chatId == chatId,
                  UUID(uuidString: entry.attachment.id)?.uuidString.lowercased() == id else { throw CentreError.invalid("Attachment cache identity changed.") }
            try Self.validate(entry.attachment, id: id)
            let url = folder.appendingPathComponent("content." + Self.fileExtension(entry.attachment.mimeType))
            let bytes = try Self.read(url)
            guard bytes.count == entry.attachment.size, Self.digest(bytes) == entry.attachment.sha256.lowercased() else {
                throw CentreError.invalid("Attachment cache verification failed.")
            }
            return AttachmentFile(url: url, name: entry.attachment.name, mimeType: entry.attachment.mimeType)
        } catch { throw CentreError.storage("This saved attachment is incomplete or damaged. Download it again while connected.") }
    }
    public func download(id: String, chatId: String, using transport: any AttachmentTransport) async throws -> AttachmentFile {
        if erased { throw CentreError.authentication }
        let id = try Self.identity(id, chatId: chatId), started = generation
        if let file = try? cached(id: id, chatId: chatId) { return file }
        let metadataValue = try await transport.attachmentGet(Self.path(id, chatId: chatId))
        guard case .object(let fields) = metadataValue, Set(fields.keys) == Set(["id", "name", "mimeType", "size", "sha256"]) else {
            throw CentreError.invalid("Invalid attachment metadata.")
        }
        let metadata = try metadataValue.decode(Metadata.self)
        try Self.validate(metadata, id: id)
        var bytes = Data(); bytes.reserveCapacity(metadata.size)
        let count = (metadata.size + Self.chunkBytes - 1) / Self.chunkBytes
        for index in 0..<count {
            guard generation == started else { throw CentreError.unavailable("Attachment download was cancelled.") }
            let response = try await transport.attachmentGet(Self.path(id, chatId: chatId, index: index))
            let expected = min(Self.chunkBytes, metadata.size - bytes.count)
            guard let encoded = response["data"].string, encoded.utf8.count == ((expected + 2) / 3) * 4,
                  let chunk = Data(base64Encoded: encoded), chunk.count == expected,
                  chunk.base64EncodedString() == encoded else { throw CentreError.invalid("Invalid or incomplete attachment chunk.") }
            bytes.append(chunk)
        }
        guard generation == started else { throw CentreError.unavailable("Attachment download was cancelled.") }
        guard bytes.count == metadata.size, Self.digest(bytes) == metadata.sha256.lowercased() else { throw CentreError.invalid("Attachment checksum does not match.") }
        if let file = try? cached(id: id, chatId: chatId) { return file }
        let entry = Entry(schemaVersion: 1, workspace: workspace, chatId: chatId, attachment: metadata)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let manifest = try encoder.encode(entry)
        guard bytes.count + manifest.count <= byteLimit else { throw CentreError.unavailable("This attachment exceeds the local cache limit.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let final = location(id, chatId: chatId)
        if FileManager.default.fileExists(atPath: final.path) { try FileManager.default.removeItem(at: final) }
        try makeRoom(for: bytes.count + manifest.count)
        let temporary = directory.appendingPathComponent(".pending-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: temporary) }
        let contentName = "content." + Self.fileExtension(metadata.mimeType)
        try bytes.write(to: temporary.appendingPathComponent(contentName), options: .atomic)
        try manifest.write(to: temporary.appendingPathComponent("metadata.json"), options: .atomic)
        for name in [contentName, "metadata.json"] { try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.appendingPathComponent(name).path) }
        try FileManager.default.moveItem(at: temporary, to: final)
        return AttachmentFile(url: final.appendingPathComponent(contentName), name: metadata.name, mimeType: metadata.mimeType)
    }
    public func erase() throws {
        generation += 1;erased=true
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
    private func location(_ id: String, chatId: String) -> URL {
        directory.appendingPathComponent(Self.digest(Data((id + "\n" + chatId).utf8)), isDirectory: true)
    }
    private static func identity(_ id: String, chatId: String) throws -> String {
        guard let uuid = UUID(uuidString: id), !chatId.isEmpty, chatId.utf16.count <= 200 else { throw CentreError.invalid("Invalid attachment or chat identity.") }
        return uuid.uuidString.lowercased()
    }
    private static func path(_ id: String, chatId: String, index: Int? = nil) throws -> String {
        var parts = URLComponents()
        parts.path = "/v1/attachments/" + id + (index.map { "/chunks/\($0)" } ?? "")
        parts.queryItems = [URLQueryItem(name: "chatId", value: chatId)]
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let path = parts.string else { throw CentreError.invalid("Invalid attachment request path.") }
        return path
    }
    private static func validate(_ metadata: Metadata, id: String) throws {
        guard UUID(uuidString: metadata.id)?.uuidString.lowercased() == id,
              !metadata.name.isEmpty, metadata.name.utf16.count <= 200,
              !metadata.mimeType.isEmpty, metadata.mimeType.utf16.count <= 200,
              metadata.size > 0, metadata.size <= fileLimit,
              metadata.sha256.utf8.count == 64, metadata.sha256.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) else {
            throw CentreError.invalid("Invalid attachment metadata.")
        }
    }
    private static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private static func fileExtension(_ mime: String) -> String {
        let types = ["application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/heic": "heic", "image/webp": "webp", "text/plain": "txt", "text/csv": "csv", "application/rtf": "rtf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx"]
        return types[mime.lowercased()] ?? "txt"
    }
    private static func read(_ url: URL) throws -> Data {
        let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true, let size = info.fileSize, size <= fileLimit + 4096 else { throw CentreError.invalid("Invalid attachment cache file.") }
        return try Data(contentsOf: url)
    }
    private func makeRoom(for needed: Int) throws {
        let children = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])
        let entries = try children.map { url -> (url: URL, size: Int, date: Date) in
            let files = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.fileSizeKey])
            let size = try files.reduce(0) { total, file in
                guard let count = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize else { throw CentreError.storage("Attachment cache size could not be read.") }
                return total + count
            }
            return (url, size, try url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast)
        }.sorted { $0.date < $1.date }
        var total = entries.reduce(0) { $0 + $1.size }
        for entry in entries where total + needed > byteLimit {
            try FileManager.default.removeItem(at: entry.url); total -= entry.size
        }
    }
}
