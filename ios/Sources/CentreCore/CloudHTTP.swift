import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public struct CloudFailure: Error, LocalizedError, Sendable {
    public let status: Int
    public let body: JSONValue
    public var errorDescription: String? {
        if status == 401 { return CentreError.authentication.errorDescription }
        return body["error"]["message"].string ?? "Centre Cloud returned \(status). Try synchronizing again."
    }
}

public final class CloudHTTP: CloudTransport, ConnectorTransport, @unchecked Sendable {
    public let baseURL: URL
    private let token: String?
    private let session: URLSession
    public init(baseURL: URL, token: String? = nil, allowLoopback: Bool = false, session: URLSession? = nil) throws {
        self.baseURL=try CloudURL.validate(baseURL,allowLoopback:allowLoopback);self.token=token
        let configuration=URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest=60;configuration.timeoutIntervalForResource=90
        configuration.httpCookieStorage=nil;configuration.urlCache=nil
        self.session=session ?? URLSession(configuration:configuration,delegate:NoRedirects(),delegateQueue:nil)
    }
    public func call(_ path:String,method:String="GET",body:JSONValue?=nil) async throws -> JSONValue {
        guard path.hasPrefix("/v1/"), !path.contains(".."), let target=URL(string:path,relativeTo:baseURL)?.absoluteURL,
              target.host == baseURL.host, target.scheme == baseURL.scheme, target.port == baseURL.port else { throw CentreError.invalid("Invalid Centre Cloud path.") }
        var request=URLRequest(url:target);request.httpMethod=method
        request.setValue("application/json",forHTTPHeaderField:"Accept")
        if let token { request.setValue("Bearer \(token)",forHTTPHeaderField:"Authorization") }
        if let body { request.httpBody=try JSONEncoder().encode(body);request.setValue("application/json",forHTTPHeaderField:"Content-Type") }
        let (bytes,response)=try await session.data(for:request)
        guard let response=response as? HTTPURLResponse else { throw CentreError.unavailable("Centre Cloud did not return a response.") }
        guard bytes.count <= 30 * 1024 * 1024 else { throw CentreError.invalid("The cloud response exceeds the device limit.") }
        let value=(try? JSONDecoder().decode(JSONValue.self,from:bytes)) ?? .null
        guard (200..<300).contains(response.statusCode) else { throw CloudFailure(status:response.statusCode,body:value) }
        return value
    }
    public func pair(code:String,deviceName:String) async throws -> CloudSession {
        let value=try await call("/v1/auth/pair",method:"POST",body:.object(["code":.string(code),"deviceName":.string(deviceName)]))
        return try Self.validSession(value)
    }
    public func signIn(idToken:String,deviceName:String) async throws -> CloudSession {
        let value=try await call("/v1/auth/google",method:"POST",body:.object(["idToken":.string(idToken),"deviceName":.string(deviceName)]))
        return try Self.validSession(value)
    }
    private static func validSession(_ value:JSONValue) throws -> CloudSession {
        let result=try value.decode(CloudSession.self)
        guard result.token.hasPrefix("ctr_"), result.token.count >= 40, result.token.count <= 200, !result.deviceId.isEmpty, !result.workspaceId.isEmpty,
              try Clock.date(result.expiresAt) > Date() else { throw CentreError.invalid("Centre returned an invalid session.") }
        return result
    }
    public func bootstrap(workspaceId:String) async throws {
        let value=try await call("/v1/bootstrap")
        guard value["schemaVersion"].int == 1, value["workspaceId"].string == workspaceId else { throw CentreError.authentication }
    }
    public func changes(cursor:String) async throws -> ChangesPage {
        guard !cursor.isEmpty,cursor.allSatisfy(\.isNumber) else { throw CentreError.invalid("Invalid cloud cursor.") }
        return try await call("/v1/changes?cursor=\(cursor)&limit=100").decode(ChangesPage.self)
    }
    public func put(_ mutation:CloudMutation) async throws -> MutationResponse {
        do {
            let value=try await call("/v1/records",method:"POST",body:JSONValue.encode(mutation))
            return .accepted(try value["record"].decode(CloudRecord.self))
        } catch let failure as CloudFailure where failure.status == 409 && failure.body["error"]["code"].string == "conflict" {
            return .conflict(failure.body["current"] == .null ? nil : try failure.body["current"].decode(CloudRecord.self))
        }
    }
    public func run(_ request:AIRequest) async throws -> AIRun {
        try await aiCall("/v1/ai/runs",body:JSONValue.encode(request))
    }
    public func grade(_ request:GradeRequest) async throws -> AIRun {
        try await aiCall("/v1/ai/grades",body:JSONValue.encode(request))
    }
    public func send(_ command:ConnectorCommand) async throws -> JSONValue {
        do { return try await call(command.path,method:command.method,body:command.body) }
        catch let failure as CloudFailure {
            // A 409/502 can contain an authoritative blocked receipt. Preserve it instead of replaying.
            if failure.body["operationId"].string == command.id.uuidString.lowercased(),
               ["unknown","conflict","failed","pending"].contains(failure.body["status"].string ?? "") { return failure.body }
            throw failure
        }
    }
    public func receipt(id:String) async throws -> JSONValue {
        guard UUID(uuidString:id) != nil else { throw CentreError.invalid("Invalid calendar operation identity.") }
        return try await call("/v1/organato/operations/\(id)")
    }
    private func aiCall(_ path:String,body:JSONValue) async throws -> AIRun {
        do {
            let value=try await call(path,method:"POST",body:body)
            return try (value["run"] == .null ? value : value["run"]).decode(AIRun.self)
        } catch let failure as CloudFailure {
            if let run=try? failure.body["run"].decode(AIRun.self),["failed","interrupted","conflict"].contains(run.status) { return run }
            throw failure
        }
    }
}
