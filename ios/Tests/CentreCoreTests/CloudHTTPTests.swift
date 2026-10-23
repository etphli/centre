import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import CentreCore

private final class CloudURLProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var handler: ((URLRequest) throws -> (Int, Data))?
    static func install(_ value: @escaping (URLRequest) throws -> (Int, Data)) {
        lock.lock(); defer { lock.unlock() }; handler = value
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handler; Self.lock.unlock()
        do {
            let (status, body) = try XCTUnwrap(handler)(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class CloudHTTPTests: XCTestCase {
    private func client(token: String? = "ctr_test") throws -> CloudHTTP {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CloudURLProtocol.self]
        return try CloudHTTP(baseURL: URL(string: "https://cloud.example")!, token: token, session: URLSession(configuration: configuration))
    }
    private func data(_ value: JSONValue) throws -> Data { try JSONEncoder().encode(value) }

    func testJSONRoundTripPreservesUnknownNestedValuesAndBooleanTypes() throws {
        let input = Data(#"{"future":{"array":[true,false,null,1,1.5,"text",{"nested":[]}],"extra":"kept"},"title":"Old"}"#.utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: input)
        let result = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(result, value)
        XCTAssertEqual(result["future"]["array"].array[0], .bool(true))
        XCTAssertEqual(result["future"]["array"].array[3], .number(1))
        let merged = value.merging(.object(["title": .string("New")]))
        XCTAssertEqual(merged["future"], value["future"])
        XCTAssertEqual(merged["title"], .string("New"))
    }

    func testCloudURLRejectsCredentialsAndUntrustedAddressParts() throws {
        for address in ["http://cloud.example", "https://user:password@cloud.example", "https://cloud.example/path", "https://cloud.example?token=secret", "https://cloud.example#secret", "file:///tmp/centre", "https://"] {
            if let url = URL(string: address) { XCTAssertThrowsError(try CloudURL.validate(url), address) }
        }
        XCTAssertEqual(try CloudURL.validate(URL(string: "https://cloud.example")!).host, "cloud.example")
        XCTAssertThrowsError(try CloudURL.validate(URL(string: "http://127.0.0.1:8787")!))
        XCTAssertNoThrow(try CloudURL.validate(URL(string: "http://127.0.0.1:8787")!, allowLoopback: true))
        XCTAssertThrowsError(try CloudURL.validate(URL(string: "http://public.example")!, allowLoopback: true))
    }

    func testPairingAcceptsOnlyOneTimeCodeAndValidatedServer() throws {
        let code = String(repeating: "a", count: 43)
        let valid = URL(string: "centre://pair?baseUrl=https%3A%2F%2Fcloud.example&code=\(code)")!
        let pairing = try CloudURL.pairing(valid)
        XCTAssertEqual(pairing.baseURL.absoluteString, "https://cloud.example")
        XCTAssertEqual(pairing.code, code)
        for address in [
            "centre://pair?baseUrl=https%3A%2F%2Fuser%3Apass%40cloud.example&code=\(code)",
            "centre://pair?baseUrl=https%3A%2F%2Fcloud.example&code=short",
            "centre://pair?baseUrl=https%3A%2F%2Fcloud.example&code=\(code)&token=ctr_secret",
            "centre://pair?baseUrl=https%3A%2F%2Fcloud.example&code=\(code)&code=\(code)",
            "centre://pair/path?baseUrl=https%3A%2F%2Fcloud.example&code=\(code)",
            "centre://user:pass@pair?baseUrl=https%3A%2F%2Fcloud.example&code=\(code)",
            "centre://pair?baseUrl=https%3A%2F%2Fcloud.example&code=\(code)#fragment"
        ] { XCTAssertThrowsError(try CloudURL.pairing(URL(string: address)!), address) }
    }

    func testPairingAcceptsCanonicalHTTPSHandoffLinks() throws {
        let minimumCode = String(repeating: "Az09_-", count: 5) + "aA"
        XCTAssertEqual(minimumCode.utf8.count, 32)
        let maximumCode = String(repeating: "x", count: 200)
        for (address, expectedBase, expectedCode) in [
            ("https://cloud.example/pair#code=\(minimumCode)", "https://cloud.example", minimumCode),
            ("https://cloud.example:8443/pair#code=\(maximumCode)", "https://cloud.example:8443", maximumCode)
        ] {
            let pairing = try CloudURL.pairing(URL(string: address)!)
            XCTAssertEqual(pairing.baseURL.absoluteString, expectedBase)
            XCTAssertEqual(pairing.code, expectedCode)
        }
    }

    func testHTTPSPairingRejectsNoncanonicalPathsAndURLFields() throws {
        let code = String(repeating: "a", count: 32)
        for address in [
            "http://cloud.example/pair#code=\(code)",
            "https://user:password@cloud.example/pair#code=\(code)",
            "https://cloud.example/pair?code=\(code)",
            "https://cloud.example/pair?source=desktop#code=\(code)",
            "https://cloud.example/pair?#code=\(code)",
            "https://cloud.example/path#code=\(code)",
            "https://cloud.example/pair/#code=\(code)",
            "https://cloud.example/p%61ir#code=\(code)",
            "https://cloud.example/pair#code=\(code)&code=\(code)",
            "https://cloud.example/pair#code=\(code)&extra=value",
            "https://cloud.example/pair#other=\(code)",
            "https://cloud.example/pair#code=short",
            "https://cloud.example/pair#code=\(String(repeating: "a", count: 201))",
            "https://cloud.example/pair#code=\(code)%26extra%3Dvalue",
            "https://cloud.example/pair#code=%25\(code)"
        ] {
            XCTAssertThrowsError(try CloudURL.pairing(URL(string: address)!), address)
        }
    }

    func testRequestUsesBearerOnlyOnBoundOriginAndRejectsEscapingPaths() async throws {
        CloudURLProtocol.install { request in
            XCTAssertEqual(request.url?.host, "cloud.example")
            XCTAssertEqual(request.url?.path, "/v1/records")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ctr_test")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertEqual(request.httpMethod, "POST")
            return (200, Data("{}".utf8))
        }
        let service = try client()
        _ = try await service.call("/v1/records", method: "POST", body: .object(["hello": .string("world")]))
        CloudURLProtocol.install { _ in XCTFail("Invalid path reached transport"); return (200, Data("{}".utf8)) }
        for path in ["https://evil.example/v1/records", "//evil.example/v1/records", "/v1/../secret", "/auth"] {
            do { _ = try await service.call(path); XCTFail("Expected rejection for \(path)") }
            catch { XCTAssertTrue(error is CentreError) }
        }
    }

    func testExpiredAuthenticationProducesActionableErrorAndBootstrapBindsWorkspace() async throws {
        CloudURLProtocol.install { _ in (401, Data(#"{"error":{"code":"unauthorized","message":"expired"}}"#.utf8)) }
        let service = try client()
        do { _ = try await service.changes(cursor: "0"); XCTFail("Expected authentication failure") }
        catch let failure as CloudFailure {
            XCTAssertEqual(failure.status, 401)
            XCTAssertEqual(failure.errorDescription, CentreError.authentication.errorDescription)
        }
        CloudURLProtocol.install { _ in (200, Data(#"{"schemaVersion":1,"workspaceId":"different-account"}"#.utf8)) }
        do { try await service.bootstrap(workspaceId: "my-account"); XCTFail("Expected account binding rejection") }
        catch let error as CentreError { XCTAssertEqual(error, .authentication) }
    }

    func testPairRejectsInvalidOrExpiredSession() async throws {
        let service = try client(token: nil)
        for session in [
            CloudSession(token: "wrong-prefix", deviceId: "d", workspaceId: "w", expiresAt: "2099-01-01T00:00:00Z"),
            CloudSession(token: "ctr_" + String(repeating: "a", count: 43), deviceId: "d", workspaceId: "w", expiresAt: "2000-01-01T00:00:00Z"),
            CloudSession(token: "ctr_" + String(repeating: "a", count: 43), deviceId: "d", workspaceId: "", expiresAt: "2099-01-01T00:00:00Z")
        ] {
            let bytes = try JSONEncoder().encode(session)
            CloudURLProtocol.install { request in
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return (200, bytes)
            }
            do { _ = try await service.pair(code: String(repeating: "x", count: 43), deviceName: "Test phone"); XCTFail("Expected invalid session") }
            catch { XCTAssertTrue(error is CentreError) }
        }
    }

    func testHTTPWrongRecordIdentityCannotAcknowledgeOrRemoveQueuedEdit() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("centre-http-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let workspace = try WorkspaceKey(baseURL: URL(string: "https://cloud.example")!, workspaceId: "w")
        let store = try Replica(directory: directory, workspace: workspace)
        try await store.stage([LocalChange(kind: "resource", id: "r1", data: .object(["title": .string("Local")]))])
        let before = await store.snapshot()
        let wrong = CloudRecord(kind: "resource", id: "other-record", version: 1, cursor: "1", data: .object(["title": .string("Wrong")]))
        let response = try data(.object(["record": JSONValue.encode(wrong)]))
        CloudURLProtocol.install { _ in (200, response) }
        do { try await store.synchronize(using: client()); XCTFail("Expected identity rejection") }
        catch { XCTAssertTrue(error is CentreError) }
        let reopened = try Replica(directory: directory, workspace: workspace)
        let state = await reopened.snapshot()
        XCTAssertEqual(state.outbox.count, 1)
        XCTAssertEqual(state.outbox[0].mutation, before.outbox[0].mutation)
        XCTAssertTrue(state.outbox[0].sent)
        XCTAssertTrue(state.shadow.isEmpty)
        XCTAssertEqual(state.cursor, "0")
    }

    func testHTTPConflictEnvelopePreservesRemoteRecord() async throws {
        let remote = CloudRecord(kind: "resource", id: "r1", version: 7, cursor: "9", data: .object(["title": .string("Remote")]))
        let response = try data(.object(["error": .object(["code": .string("conflict")]), "current": JSONValue.encode(remote)]))
        CloudURLProtocol.install { _ in (409, response) }
        let result = try await client().put(CloudMutation(kind: "resource", id: "r1", expectedVersion: 1, data: .object([:])))
        guard case .conflict(let current) = result else { return XCTFail("Expected conflict") }
        XCTAssertEqual(current, remote)
    }

    func testIdempotencyMismatchIsAnErrorAndCannotBecomeAResolvableConflict() async throws {
        CloudURLProtocol.install { _ in
            (409, Data(#"{"error":{"code":"idempotency_mismatch","message":"Mutation body changed"}}"#.utf8))
        }
        do {
            _ = try await client().put(CloudMutation(kind: "resource", id: "r1", expectedVersion: 1, data: .object([:])))
            XCTFail("Expected idempotency mismatch error")
        } catch let failure as CloudFailure {
            XCTAssertEqual(failure.status, 409)
            XCTAssertEqual(failure.body["error"]["code"], .string("idempotency_mismatch"))
        }
    }

    #if os(macOS)
    func testDefaultSessionRefusesRedirectBeforeForwardingBearer() async throws {
        let script = #"""
import http.server
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/v1/redirect':
            self.send_response(302)
            self.send_header('Location', '/leaked')
            self.end_headers()
            self.wfile.write(b'{}')
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"forwarded":true}')
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
"""#
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", "-u", "-c", script]
        let output = Pipe(); process.standardOutput = output
        try process.run()
        defer { process.terminate(); process.waitUntilExit() }
        var line = Data()
        while true {
            let byte = output.fileHandleForReading.readData(ofLength: 1)
            guard !byte.isEmpty else { throw CentreError.unavailable("Local HTTP fixture failed to start") }
            if byte == Data([10]) { break }; line.append(byte)
        }
        let port = try XCTUnwrap(Int(String(decoding: line, as: UTF8.self)))
        let service = try CloudHTTP(baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "ctr_test_only", allowLoopback: true)
        do { _ = try await service.call("/v1/redirect"); XCTFail("Followed redirect carrying a bearer") }
        catch let error as CloudFailure { XCTAssertEqual(error.status, 302) }
    }
    #endif
}
