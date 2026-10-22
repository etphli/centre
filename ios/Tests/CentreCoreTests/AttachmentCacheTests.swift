import XCTest
import CryptoKit
@testable import CentreCore

private actor AttachmentFixture: AttachmentTransport {
    let metadata: JSONValue
    let chunks: [String]
    var paths: [String] = []
    var suspended = false
    var continuation: CheckedContinuation<Void, Never>?
    var started: CheckedContinuation<Void, Never>?
    func suspendFirstRequest() { suspended = true }
    func waitForRequest() async { if paths.isEmpty { await withCheckedContinuation { started = $0 } } }
    func release() { continuation?.resume(); continuation = nil }
    init(metadata: JSONValue, chunks: [String]) { self.metadata = metadata; self.chunks = chunks }
    func attachmentGet(_ path: String) async throws -> JSONValue {
        paths.append(path)
        started?.resume(); started = nil
        if suspended && paths.count == 1 { await withCheckedContinuation { continuation = $0 } }
        if let url = URLComponents(string: path), url.path.contains("/chunks/"),
           let index = Int(url.path.split(separator: "/").last ?? ""), chunks.indices.contains(index) {
            return .object(["data": .string(chunks[index])])
        }
        return metadata
    }
    func requests() -> [String] { paths }
}

final class AttachmentCacheTests: XCTestCase {
    private var directory: URL!
    private let id = "36d29c38-4619-446d-901f-a8ffbd932c79"
    override func setUpWithError() throws { directory = FileManager.default.temporaryDirectory.appendingPathComponent("centre-attachments-\(UUID())") }
    override func tearDownWithError() throws { if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) } }
    private func workspace(_ name: String = "account-a", server: String = "https://cloud.example") throws -> WorkspaceKey {
        try WorkspaceKey(baseURL: URL(string: server)!, workspaceId: name)
    }
    private func cache(_ name: String = "account-a", limit: Int = 100 * 1024 * 1024) throws -> AttachmentCache {
        try AttachmentCache(directory: directory, workspace: workspace(name), byteLimit: limit)
    }
    private func metadata(_ bytes: Data, id: String? = nil, name: String = "worksheet.pdf", mime: String = "application/pdf") -> JSONValue {
        .object(["id": .string(id ?? self.id), "name": .string(name), "mimeType": .string(mime), "size": .number(Double(bytes.count)),
                 "sha256": .string(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())])
    }
    private func fixture(_ bytes: Data, id: String? = nil, name: String = "worksheet.pdf", mime: String = "application/pdf") -> AttachmentFixture {
        let chunks = stride(from: 0, to: bytes.count, by: 256 * 1024).map { bytes.subdata(in: $0..<min(bytes.count, $0 + 256 * 1024)).base64EncodedString() }
        return AttachmentFixture(metadata: metadata(bytes, id: id, name: name, mime: mime), chunks: chunks)
    }

    func testRealFilesReopenOfflineWithEveryChunkTargetEscapedAndPartitioned() async throws {
        let store = try cache(), bytes = Data(repeating: 42, count: 256 * 1024 + 17), chat = "active target/+?&=#"
        let network = fixture(bytes)
        let file = try await store.download(id: id, chatId: chat, using: network)
        XCTAssertEqual(try Data(contentsOf: file.url), bytes)
        XCTAssertEqual(file.url.pathExtension, "pdf")
        XCTAssertEqual(file.name, "worksheet.pdf")
        let reopened = try cache()
        let cached = try await reopened.cached(id: id.uppercased(), chatId: chat)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(cached).url), bytes)
        let calls = await network.requests()
        XCTAssertEqual(calls.count, 3)
        for (index, path) in calls.enumerated() {
            let components = try XCTUnwrap(URLComponents(string: path))
            XCTAssertEqual(components.queryItems, [URLQueryItem(name: "chatId", value: chat)])
            XCTAssertFalse(path.contains("+"), "A plus must not become a space in server query parsing")
            XCTAssertEqual(components.path, "/v1/attachments/\(id)" + (index == 0 ? "" : "/chunks/\(index - 1)"))
        }
        let otherTarget = try await reopened.cached(id: id, chatId: "other-chat")
        let otherAccount = try await (try cache("account-b")).cached(id: id, chatId: chat)
        let otherServer = try AttachmentCache(directory: directory, workspace: workspace(server: "https://other.example"))
        let foreign = try await otherServer.cached(id: id, chatId: chat)
        XCTAssertNil(otherTarget); XCTAssertNil(otherAccount); XCTAssertNil(foreign)
        let mode = try FileManager.default.attributesOfItem(atPath: file.url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        try await reopened.erase()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path))
    }

    func testIncompleteWrongSizeHashAndNoncanonicalBase64NeverPublishFiles() async throws {
        let bytes = Data([0, 1, 2]), store = try cache()
        var badHash = metadata(bytes); badHash["sha256"] = .string(String(repeating: "0", count: 64))
        var huge = metadata(bytes); huge["size"] = .number(Double(20 * 1024 * 1024 + 1))
        let cases = [
            AttachmentFixture(metadata: metadata(bytes), chunks: [Data([0, 1]).base64EncodedString()]),
            AttachmentFixture(metadata: badHash, chunks: [bytes.base64EncodedString()]),
            AttachmentFixture(metadata: huge, chunks: []),
            AttachmentFixture(metadata: metadata(bytes, id: UUID().uuidString), chunks: [bytes.base64EncodedString()]),
            AttachmentFixture(metadata: metadata(Data([0])), chunks: ["AB=="]),
            AttachmentFixture(metadata: metadata(bytes), chunks: ["AAEC\n"]),
            AttachmentFixture(metadata: metadata(bytes), chunks: [])
        ]
        for network in cases {
            do { _ = try await store.download(id: id, chatId: "chat", using: network); XCTFail("Accepted corrupt attachment") }
            catch { XCTAssertTrue(error is CentreError) }
            let file = try await store.cached(id: id, chatId: "chat")
            XCTAssertNil(file)
        }
    }

    func testCachedBytesAndMetadataAreReverifiedBeforeExposure() async throws {
        let store = try cache(), bytes = Data("verified".utf8)
        let file = try await store.download(id: id, chatId: "chat", using: fixture(bytes))
        try Data("modified".utf8).write(to: file.url, options: .atomic)
        do { _ = try await (try cache()).cached(id: id, chatId: "chat"); XCTFail("Returned corrupt cached bytes") }
        catch { XCTAssertTrue(error is CentreError) }
        let restored = try await store.download(id: id, chatId: "chat", using: fixture(bytes))
        XCTAssertEqual(try Data(contentsOf: restored.url), bytes)
        let manifest = restored.url.deletingLastPathComponent().appendingPathComponent("metadata.json")
        var value = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: manifest))
        value["chatId"] = .string("another-chat")
        try JSONEncoder().encode(value).write(to: manifest, options: .atomic)
        do { _ = try await store.cached(id: id, chatId: "chat"); XCTFail("Returned cache with altered target identity") }
        catch { XCTAssertTrue(error is CentreError) }
    }

    func testUnsafeIdentityNeverReachesNetworkAndFilenameCannotChooseExtensionOrPath() async throws {
        let store = try cache(), network = fixture(Data("hello".utf8), name: "../../escape.html", mime: "text/html")
        for (attachment, target) in [("../../escape", "chat"), (id, ""), (id, String(repeating: "x", count: 201))] {
            do { _ = try await store.download(id: attachment, chatId: target, using: network); XCTFail("Accepted invalid identity") }
            catch { XCTAssertTrue(error is CentreError) }
        }
        let untouched = await network.requests(); XCTAssertTrue(untouched.isEmpty)
        let file = try await store.download(id: id, chatId: "chat", using: network)
        XCTAssertEqual(file.url.lastPathComponent, "content.txt")
        XCTAssertEqual(file.name, "../../escape.html")
        XCTAssertTrue(file.url.standardizedFileURL.path.hasPrefix(directory.standardizedFileURL.path + "/"))
        let unexpectedOwner = metadata(Data([1])).merging(.object(["sourceChatId": .string("secret-owner")]))
        do { _ = try await store.download(id: id, chatId: "other", using: AttachmentFixture(metadata: unexpectedOwner, chunks: ["AQ=="])); XCTFail("Accepted unexpected public metadata") }
        catch { XCTAssertTrue(error is CentreError) }
    }

    func testBoundedAccountCacheEvictsOldEntryAndRejectsOversizeBudget() async throws {
        let store = try cache(limit: 2500), bytes = Data(repeating: 1, count: 1200)
        let first = try await store.download(id: id, chatId: "chat", using: fixture(bytes))
        let secondId = UUID().uuidString.lowercased()
        let second = try await store.download(id: secondId, chatId: "chat", using: fixture(bytes, id: secondId))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.url.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.url.path))
        let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey])!
        var total = 0
        for case let file as URL in files {
            let info = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            if info.isRegularFile == true { total += info.fileSize ?? 0 }
        }
        XCTAssertLessThanOrEqual(total, 2500)
        XCTAssertThrowsError(try cache(limit: 100 * 1024 * 1024 + 1))
        let tiny = try cache("tiny", limit: 1)
        do { _ = try await tiny.download(id: id, chatId: "chat", using: fixture(bytes)); XCTFail("Exceeded cache budget") }
        catch { XCTAssertTrue(error is CentreError) }
    }

    func testLogoutEraseCancelsAnAwaitingDownloadBeforeItCanRecreateTheCache() async throws {
        let store = try cache(), network = fixture(Data("private".utf8))
        await network.suspendFirstRequest()
        let download = Task { try await store.download(id: id, chatId: "chat", using: network) }
        await network.waitForRequest()
        try await store.erase()
        await network.release()
        do { _ = try await download.value; XCTFail("Published attachment after logout erase") }
        catch { XCTAssertTrue(error is CentreError) }
        let cached = try await store.cached(id: id, chatId: "chat")
        XCTAssertNil(cached)
    }

}
