import SwiftUI
import CentreCore
import GoogleSignIn

struct PairingInvitation: Identifiable { let id=UUID();let baseURL:URL;let code:String }

@MainActor final class AppModel: ObservableObject {
    @Published var records:[CloudRecord]=[]
    @Published var connector:JSONValue = .object([:])
    @Published var pendingCount=0
    @Published var conflicts:[SyncConflict]=[]
    @Published var status="Sign in to Centre Cloud to bring your study to iPhone."
    @Published var error:String?
    @Published var busy=false
    @Published var session:CloudSession?
    @Published var baseURL=Bundle.main.object(forInfoDictionaryKey:"CentreCloudURL") as? String ?? ""
    @Published var selectedTab=0
    @Published var pairingInvitation:PairingInvitation?
    @Published var aiRuns:[AIRun]=[]
    @Published var calendarCommands:[ConnectorCommand]=[]
    private var replica:Replica?
    private var calendarJournal:ConnectorJournal?
    private var client:CloudHTTP?
    private var scheduledSync:Task<Void,Never>?
    private var syncing=false
    private var lastInteraction=Date()
    private var aiJobs:[PendingAI]=[]
    private var ownedTimers:Set<String>=[]
    private let directory:URL
    private var fixture=false

    init() {
        directory=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("Centre",isDirectory:true)
        #if DEBUG
        fixture=ProcessInfo.processInfo.arguments.contains("-ui-testing")
        #endif
        Task { await launch() }
    }
    func launch() async {
        do {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-ui-testing-unconfigured") { baseURL="";return }
            if fixture { try await seedFixture();return }
            #endif
            if let saved=try SessionVault.read() {
                guard let url=URL(string:saved.baseURL) else { throw CentreError.invalid("The saved cloud address is invalid.") }
                baseURL=saved.baseURL;session=saved.session
                client=try CloudHTTP(baseURL:url,token:saved.session.token)
                let workspace=try WorkspaceKey(baseURL:url,workspaceId:saved.session.workspaceId)
                replica=try Replica(directory:directory,workspace:workspace)
                calendarJournal=try ConnectorJournal(directory:directory,workspace:workspace)
                try await recoverTimers()
                await refresh()
                await sync()
            }
        } catch { self.error=error.localizedDescription }
    }
    var preferences:JSONValue { record(kind:"preferences",id:"preferences")?.data ?? .object(["theme":.string("dark"),"textSize":.string("standard"),"timeZone":.string("Australia/Sydney")]) }
    var timeZone:String { preferences["timeZone"].string ?? "Australia/Sydney" }
    func items(_ kind:String) -> [CloudRecord] { records.filter{$0.kind == kind && !$0.deleted && $0.schemaVersion == 1 && $0.data?["deletedAt"].string == nil} }
    func record(kind:String,id:String) -> CloudRecord? { items(kind).first{$0.id == id} }
    func data(_ record:CloudRecord) -> JSONValue { record.data ?? .object([:]) }
    var activeTimer:CloudRecord? { items("studySession").first { ["running","paused"].contains($0.data?["state"]["kind"].string ?? "") } }
    var sessions:[StudySession] { items("studySession").compactMap { try? $0.data?.decode(StudySession.self) } }
    var studyMinutes:Double { ((try? StudyRules.weeklyDuration(sessions,at:Date(),timeZone:timeZone)) ?? 0)/60 }
    var goalMinutes:Int {
        guard let week=try? StudyRules.weekStart(at:Date(),timeZone:timeZone) else { return 0 }
        return items("studyGoal").first{$0.data?["weekStart"].string == week && $0.data?["timeZone"].string == timeZone}?.data?["targetMinutes"].int ?? 0
    }
    func touch() { lastInteraction=Date() }
    func refresh() async {
        guard let replica else { return }
        let value=await replica.snapshot()
        calendarCommands=await calendarJournal?.snapshot() ?? []
        records=value.records;pendingCount=value.pendingCount+calendarCommands.filter(\.pending).count;conflicts=value.conflicts;connector=value.connector;aiJobs=value.ai;aiRuns=value.ai.compactMap(\.run)
    }
    func chatRun(chatId:String,messageId:String) -> AIRun? {
        aiJobs.compactMap { job -> AIRun? in
            if case .chat(let request,let run)=job,request.chatId == chatId,request.messageId == messageId { return run };return nil
        }.last
    }
    private func scheduleSync() {
        scheduledSync?.cancel()
        scheduledSync=Task { [weak self] in
            try? await Task.sleep(for:.milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }
    private func perform(_ action:() async throws -> Void) async -> Bool {
        guard replica != nil else { error="Connect your Centre account first.";return false }
        touch();error=nil
        do { try await action();await refresh();status=pendingCount > 0 ? "Saved on iPhone. \(pendingCount) changes waiting to sync." : "Saved on iPhone.";scheduleSync();return true }
        catch { self.error=error.localizedDescription;return false }
    }
    @discardableResult
    func save(kind:String,id:String,data:JSONValue,deleted:Bool=false) async -> Bool {
        let saved = await perform {
            guard let replica else { return }
            guard data["id"].string == id || kind == "preferences" else { throw CentreError.invalid("Invalid record identity.") }
            if kind == "preferences" {
                let allowed:Set<String>=["nickname","theme","density","textSize","studentYearLevel","timeZone","responseStyle","defaultQuizQuestions","defaultTestLengthMode","defaultTestMinutes","defaultTestQuestions","defaultQuizQuestionTypes","defaultTestQuestionTypes","defaultDifficulty"]
                guard case .object(let fields)=data,fields.keys.allSatisfy(allowed.contains) else { throw CentreError.invalid("Only study preferences can be synchronized.") }
            }
            if kind == "studySession" {
                let value=try data.decode(StudySession.self)
                try StudyRules.validate(value,others:sessions.filter{$0.id != id},now:Date())
            }
            try await replica.stage([LocalChange(kind:kind,id:id,data:data,deleted:deleted)])
        }
        return saved
    }
    func send(chatId:String?,text:String) async -> String? {
        let text=text.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !text.isEmpty,text.utf16.count <= 8000 else { error="Write a message of up to 8,000 characters.";return nil }
        let chatId=chatId ?? UUID().uuidString.lowercased(),messageId=UUID().uuidString.lowercased(),now=Clock.iso(Date())
        var committed=false
        await perform {
            guard let replica else { return }
            let existing=record(kind:"chat",id:chatId)?.data
            let chat=existing?.merging(.object(["updatedAt":.string(now)])) ?? .object([
                "id":.string(chatId),"title":.string(String(text.prefix(60))),"createdAt":.string(now),"updatedAt":.string(now),"deletedAt":.null,"pinnedAt":.null,"folderId":.null,"sortOrder":.number(0),"modelSelection":.null,"lineage":.object(["schemaVersion":.number(1),"kind":.string("root")])])
            let message:JSONValue = .object(["id":.string(messageId),"chatId":.string(chatId),"role":.string("user"),"content":.string(text),"createdAt":.string(now),"responseDurationMs":.null,"resourceIds":.array([]),"attachmentIds":.array([]),"requestContext":.object(["page":.string("chat")])])
            try await replica.stage([LocalChange(kind:"chat",id:chatId,data:chat),LocalChange(kind:"message",id:messageId,data:message)],ai:.chat(AIRequest(chatId:chatId,messageId:messageId),nil))
            committed=true
        }
        if committed { Task { await sync() };return chatId }
        return nil
    }
    @discardableResult
    func saveDraft(resource:CloudRecord,answers:[String:String],currentQuestion:Int) async -> Bool {
        let saved = await perform {
            guard let replica else { return }
            let existing=items("practice.draft").first{$0.data?["resourceId"].string == resource.id}
            if aiJobs.contains(where:{ if case .grade(let request,_) = $0 { return request.resourceId == resource.id };return false }) { throw CentreError.unavailable("This quiz is submitted for marking. Wait for its result before changing answers.") }
            let questions=resource.data?["questions"].array ?? []
            let ids=Set(questions.compactMap{$0["id"].string})
            guard !questions.isEmpty,currentQuestion >= 0,currentQuestion < questions.count,currentQuestion < 30,answers.keys.allSatisfy(ids.contains),answers.values.allSatisfy({$0.utf16.count <= 4000}) else { throw CentreError.invalid("The quiz answers do not match its questions.") }
            let id=existing?.id ?? UUID().uuidString.lowercased(),now=Clock.iso(Date())
            let body:JSONValue = .object(["schemaVersion":.number(1),"id":.string(id),"revision":.number(Double((existing?.data?["revision"].int ?? 0)+1)),"resourceId":.string(resource.id),"answers":.object(answers.mapValues(JSONValue.string)),"currentQuestion":.number(Double(currentQuestion)),"createdAt":existing?.data?["createdAt"] ?? .string(now),"updatedAt":.string(now),"deletedAt":.null])
            try await replica.stage([LocalChange(kind:"practice.draft",id:id,data:body)])
        }
        return saved
    }
    @discardableResult
    func submitQuiz(resource:CloudRecord) async -> Bool {
        let saved = await perform {
            guard let replica,let draft=items("practice.draft").first(where:{$0.data?["resourceId"].string == resource.id}),let revision=draft.data?["revision"].int else { throw CentreError.invalid("Save your answers before submitting.") }
            guard !aiJobs.contains(where:{if case .grade(let request,_)=$0{return request.draftId == draft.id};return false}) else { throw CentreError.unavailable("This quiz is already waiting for marking.") }
            let request=GradeRequest(id:UUID().uuidString.lowercased(),draftId:draft.id,resourceId:resource.id,expectedDraftRevision:revision)
            try await replica.stage([],ai:.grade(request,nil))
        }
        return saved
    }
    func isQuizSubmitted(resourceId:String) -> Bool {
        aiJobs.contains { if case .grade(let request,let run)=$0 { return request.resourceId == resourceId && !["failed","interrupted","conflict"].contains(run?.status ?? "") };return false }
    }
    func quizFailure(resourceId:String) -> String? {
        aiJobs.contains { if case .grade(let request,let run)=$0 { return request.resourceId == resourceId && ["failed","interrupted","conflict"].contains(run?.status ?? "") };return false } ? "Marking could not finish safely. Your answers are saved. Start over to submit a fresh draft." : nil
    }
    @discardableResult func startOverQuiz(resource:CloudRecord) async -> Bool {
        guard !isQuizSubmitted(resourceId:resource.id) else { error="This quiz is waiting for marking. Synchronize before starting over.";return false }
        return await perform {
            guard let replica else { return }
            for job in aiJobs { if case .grade(let request,_)=job,request.resourceId == resource.id { try await replica.dismissAI(id:job.id) } }
            if let draft=items("practice.draft").first(where:{$0.data?["resourceId"].string == resource.id}),var data=draft.data {
                data["revision"] = .number(Double((data["revision"].int ?? 0)+1));data["updatedAt"] = .string(Clock.iso(Date()));data["deletedAt"] = data["updatedAt"]
                try await replica.stage([LocalChange(kind:"practice.draft",id:draft.id,data:data)])
            }
        }
    }
    @discardableResult func timer(action:String,id:String?,title:String,subjectId:String?) async -> Bool {
        let saved = await perform {
            guard let replica else { return }
            let now=Date(),value:StudySession
            var previous:StudySession?
            if action == "start" {
                guard activeTimer == nil else { throw CentreError.invalid("Finish your current timer before starting another.") }
                value=try StudyRules.start(title:title,subjectId:subjectId,timeZone:timeZone,now:now)
            } else {
                guard let id,let record=record(kind:"studySession",id:id),let data=record.data else { throw CentreError.invalid("This timer is unavailable.") }
                let session=try data.decode(StudySession.self);previous=session
                switch action {
                case "pause":value=try StudyRules.pause(session,now:now)
                case "resume":value=try StudyRules.resume(session,now:now)
                case "stop":value=try StudyRules.stop(session,now:now)
                case "confirm":value=try StudyRules.heartbeat(session,now:now,activity:true,confirm:true)
                default:throw CentreError.invalid("Unknown timer action.")
                }
            }
            try StudyRules.validate(value,others:sessions.filter{$0.id != value.id},now:now,previous:previous)
            try await replica.stage([LocalChange(kind:"studySession",id:value.id,data:JSONValue.encode(value))])
            if value.state.kind == "running" { ownedTimers.insert(value.id) } else { ownedTimers.remove(value.id) }
        }
        return saved
    }
    func heartbeat() async {
        guard let replica,let timer=activeTimer,let body=timer.data,body["state"]["kind"].string == "running" else { return }
        do {
            let original=try body.decode(StudySession.self)
            let value=try StudyRules.heartbeat(original,now:Date(),activity:Date().timeIntervalSince(lastInteraction)<15)
            try StudyRules.validate(value,others:sessions.filter{$0.id != value.id},now:Date(),previous:original)
            try await replica.stage([LocalChange(kind:"studySession",id:value.id,data:JSONValue.encode(value))]);await refresh();scheduleSync()
        } catch { self.error=error.localizedDescription }
    }
    func recoverTimers(excludingLocal:Bool=false) async throws {
        guard let replica else { return }
        let snapshot=await replica.snapshot()
        let changes=try snapshot.records.filter{$0.kind == "studySession" && !$0.deleted && (!excludingLocal || !ownedTimers.contains($0.id))}.compactMap { record -> LocalChange? in
            guard let data=record.data else { return nil }
            let value=try data.decode(StudySession.self),recovered=try StudyRules.recover(value,now:Date(),restart:true)
            return recovered == value ? nil : LocalChange(kind:"studySession",id:record.id,data:try JSONValue.encode(recovered))
        }
        if !changes.isEmpty { try await replica.stage(changes) }
    }
    func background() async {
        do { ownedTimers.removeAll();try await recoverTimers();await refresh() } catch { self.error=error.localizedDescription }
    }
    @discardableResult
    func manualSession(title:String,subjectId:String?,start:Date,end:Date) async -> Bool {
        let saved = await perform {
            guard let replica else { return }
            let value=try StudyRules.manual(title:title,subjectId:subjectId,timeZone:timeZone,start:start,end:end,now:Date())
            try StudyRules.validate(value,others:sessions,now:Date())
            try await replica.stage([LocalChange(kind:"studySession",id:value.id,data:JSONValue.encode(value))])
        }
        return saved
    }
    @discardableResult
    func setGoal(minutes:Int) async -> Bool {
        let saved = await perform {
            guard let replica else { return }
            let week=try StudyRules.weekStart(at:Date(),timeZone:timeZone)
            let old=try items("studyGoal").first{$0.data?["weekStart"].string == week && $0.data?["timeZone"].string == timeZone}?.data?.decode(WeeklyStudyGoal.self)
            let goal=try StudyRules.goal(minutes:minutes,at:Date(),timeZone:timeZone,existing:old)
            try await replica.stage([LocalChange(kind:"studyGoal",id:goal.id,data:JSONValue.encode(goal))])
        }
        return saved
    }
    func resolve(conflict:SyncConflict,useLocal:Bool) async {
        await perform { try await replica?.resolve(conflict,useLocal:useLocal) }
        await sync()
    }
    func receive(_ url:URL) {
        if GIDSignIn.sharedInstance.handle(url) { return }
        do { let value=try CloudURL.pairing(url);pairingInvitation=PairingInvitation(baseURL:value.baseURL,code:value.code) }
        catch { self.error=error.localizedDescription }
    }
    func pair(baseURL:String,code:String) async {
        guard !busy else { return };busy=true;defer{busy=false}
        do {
            guard let url=URL(string:baseURL) else { throw CentreError.invalid("Enter your Centre Cloud HTTPS address.") }
            let api=try CloudHTTP(baseURL:url),newSession=try await api.pair(code:code.trimmingCharacters(in:.whitespacesAndNewlines),deviceName:"Centre iPhone")
            try await bind(newSession,base:url)
            pairingInvitation=nil;await sync()
        } catch { self.error=error.localizedDescription }
    }
    func googleSignIn() async {
        guard !busy else { return };busy=true;defer{busy=false}
        do {
            guard let url=URL(string:baseURL) else { throw CentreError.invalid("Enter your Centre Cloud HTTPS address.") }
            let api=try CloudHTTP(baseURL:url)
            guard let client=Bundle.main.object(forInfoDictionaryKey:"GIDClientID") as? String,!client.isEmpty,!client.hasPrefix("$("),
                  let server=Bundle.main.object(forInfoDictionaryKey:"GIDServerClientID") as? String,!server.isEmpty,!server.hasPrefix("$(") else { throw CentreError.unavailable("Google sign-in is not configured for this build. Use a one-time account pairing code.") }
            guard let controller=UIApplication.shared.connectedScenes.compactMap({$0 as? UIWindowScene}).flatMap(\.windows).first(where:\.isKeyWindow)?.rootViewController else { throw CentreError.unavailable("Sign-in cannot open yet. Try again.") }
            GIDSignIn.sharedInstance.configuration=GIDConfiguration(clientID:client,serverClientID:server)
            let result=try await GIDSignIn.sharedInstance.signIn(withPresenting:controller)
            guard let idToken=result.user.idToken?.tokenString else { throw CentreError.authentication }
            let newSession=try await api.signIn(idToken:idToken,deviceName:"Centre iPhone")
            GIDSignIn.sharedInstance.signOut()
            try await bind(newSession,base:url);await sync()
        } catch { self.error=error.localizedDescription }
    }
    private func bind(_ newSession:CloudSession,base:URL) async throws {
        if let session,session.workspaceId != newSession.workspaceId || (client != nil && client?.baseURL != base) { throw CentreError.invalid("Sign out before connecting a different workspace. Your pending study data must stay with its original account.") }
        let api=try CloudHTTP(baseURL:base,token:newSession.token)
        try await api.bootstrap(workspaceId:newSession.workspaceId)
        let store=try Replica(directory:directory,workspace:WorkspaceKey(baseURL:base,workspaceId:newSession.workspaceId))
        let journal=try ConnectorJournal(directory:directory,workspace:WorkspaceKey(baseURL:base,workspaceId:newSession.workspaceId))
        try SessionVault.save(SavedSession(baseURL:base.absoluteString,session:newSession))
        self.baseURL=base.absoluteString;self.session=newSession;client=api;replica=store;calendarJournal=journal
        try await recoverTimers();await refresh()
    }
    func logout(discard:Bool) async {
        guard !syncing else { error="Wait for synchronization to finish before signing out.";return }
        guard pendingCount == 0 && conflicts.isEmpty || discard else { error="You have pending study changes. Synchronize them or explicitly discard them before signing out.";return }
        do {
            try await backgroundAndErase()
            if let client,let session,!fixture { _ = try? await client.call("/v1/devices/revoke",method:"POST",body:.object(["deviceId":.string(session.deviceId)])) }
            try SessionVault.clear();GIDSignIn.sharedInstance.signOut()
            scheduledSync?.cancel();session=nil;client=nil;replica=nil;calendarJournal=nil;calendarCommands=[];records=[];connector = .object([:]);pendingCount=0;conflicts=[];aiJobs=[];aiRuns=[];status="Signed out. Private data removed from this iPhone."
        } catch { self.error=error.localizedDescription }
    }
    private func backgroundAndErase() async throws { try await calendarJournal?.erase();try await replica?.erase() }
    func sync() async {
        guard !syncing,let replica else { return }
        if fixture { await refresh();status="Offline test workspace. Changes saved on iPhone.";return }
        guard let client,let session else { return }
        syncing=true;busy=true;defer{syncing=false;busy=false}
        do {
            status="Synchronizing"
            try await client.bootstrap(workspaceId:session.workspaceId)
            try await replica.synchronize(using:client)
            do {
                try await calendarJournal?.process(using:client)
                // Connector writes are committed by the hosted module, then imported through the same feed.
                try await replica.synchronize(using:client)
            } catch { self.error="Calendar changes remain saved. \(error.localizedDescription)" }
            // Imported timers pause at their persisted checkpoint. They never start a second device lease.
            try await recoverTimers(excludingLocal:true);await refresh()
            do { let snapshot=try await client.call("/v1/organato/snapshot");try await replica.cacheConnector(snapshot);await refresh() }
            catch { status="Study data synchronized. Calendar connection unavailable." }
            if aiRuns.contains(where:{["failed","interrupted","conflict"].contains($0.status)}) { status="Cloud AI could not finish. Your saved message or quiz draft is preserved." }
            else if !conflicts.isEmpty { status="\(conflicts.count) conflicts need your choice in Settings." }
            else if pendingCount > 0 { status="\(pendingCount) changes waiting to sync." }
            else if status == "Synchronizing" { status="Synchronized with Centre Cloud." }
        } catch { status="Offline. Study changes remain saved on iPhone.";self.error=error.localizedDescription;await refresh() }
    }
    @discardableResult func calendarCreate(title:String,date:Date,subjectId:String?,durationMinutes:Int=60) async -> Bool {
        await perform {
            guard let calendarJournal else { throw CentreError.unavailable("Connect your Centre account before planning study.") }
            let event=try CalendarPlan.create(title:title,start:date,timeZone:timeZone,durationMinutes:durationMinutes,subjectId:subjectId)
            let operation=UUID()
            try await calendarJournal.stage(ConnectorCommand(id:operation,path:"/v1/organato/sessions",method:"POST",body:.object(["operationId":.string(operation.uuidString.lowercased()),"id":event["id"],"data":event])))
        }
    }
    @discardableResult func calendarComplete(event:JSONValue,completed:Bool) async -> Bool {
        await calendarChange(event:event,suffix:"/complete",method:"POST",fields:["completed":.bool(completed)])
    }
    @discardableResult func calendarArchive(event:JSONValue) async -> Bool {
        await calendarChange(event:event,suffix:"/archive",method:"POST",fields:[:])
    }
    @discardableResult func calendarEdit(event:JSONValue,title:String,start:Date,durationMinutes:Int) async -> Bool {
        do {
            var patch:JSONValue = .object(["title":.string(title.trimmingCharacters(in:.whitespacesAndNewlines)),"plannedDurationMinutes":.number(Double(durationMinutes))])
            // Metadata-only edits preserve an existing repeated-hour instant and exact fractional seconds.
            if let saved=event["startAt"].string,abs(try Clock.date(saved).timeIntervalSince(start)) > 0.001 {
                let changed=try CalendarPlan.create(title:title,start:start,timeZone:event["timeZone"].string ?? timeZone,durationMinutes:durationMinutes)
                patch["date"]=changed["date"];patch["time"]=changed["time"]
            }
            return await calendarChange(event:event,suffix:"",method:"PATCH",fields:["patch":patch])
        } catch { self.error=error.localizedDescription;return false }
    }
    private func calendarChange(event:JSONValue,suffix:String,method:String,fields:[String:JSONValue]) async -> Bool {
        await perform {
            guard let calendarJournal,let id=event["id"].string,let record=record(kind:"calendarEvent",id:id),let revision=record.data?["revision"].int else { throw CentreError.invalid("Synchronize this Centre session before changing it.") }
            guard !calendarCommands.contains(where:{$0.pending && ($0.body["id"].string == id || $0.path.hasPrefix("/v1/organato/sessions/\(id)"))}) else { throw CentreError.unavailable("This session already has a pending calendar change. Check its receipt before editing again.") }
            let operation=UUID()
            var body=fields;body["operationId"] = .string(operation.uuidString.lowercased());body["expectedVersion"] = .number(Double(record.version));body["expectedRevision"] = .number(Double(revision))
            try await calendarJournal.stage(ConnectorCommand(id:operation,path:"/v1/organato/sessions/\(id)\(suffix)",method:method,body:.object(body)))
        }
    }
    func calendarLink(event:JSONValue) async {
        guard let id=event["id"].string,let record=record(kind:"calendarEvent",id:id),let revision=record.data?["revision"].int,let client,!fixture else { error="Connect to Centre Cloud to verify this calendar link.";return }
        do {
            _ = try await client.call("/v1/organato/sessions/\(id)/link",method:"POST",body:.object(["expectedVersion":.number(Double(record.version)),"expectedRevision":.number(Double(revision))]))
            await sync()
        } catch { self.error=error.localizedDescription }
    }
    func reconcileCalendar(_ command:ConnectorCommand,applied:Bool,organatoId:String) async {
        guard let calendarJournal,let client,!fixture else { error="Connect to Centre Cloud to check the calendar outcome.";return }
        do {
            var body:JSONValue = .object(["resolution":.string(applied ? "applied":"not_applied")])
            if applied,!organatoId.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty { body["organatoId"] = .string(organatoId.trimmingCharacters(in:.whitespacesAndNewlines)) }
            let receipt=try await client.call("/v1/organato/operations/\(command.id.uuidString.lowercased())/reconcile",method:"POST",body:body)
            try await calendarJournal.updateReceipt(receipt);await refresh();await sync()
        } catch { self.error=error.localizedDescription }
    }
    func acknowledgeCalendar(_ command:ConnectorCommand) async {
        _ = await perform { try await calendarJournal?.acknowledge(command.id) }
    }
    func configureOrganato(baseURL:String,apiKey:String) async -> Bool {
        guard let client,!fixture else { error="Connect to Centre Cloud before adding an Organato connection.";return false }
        guard !apiKey.isEmpty,apiKey.utf16.count <= 2000,let url=URL(string:baseURL),(try? CloudURL.validate(url)) != nil else { error="Enter the Organato HTTPS address and its API key.";return false }
        busy=true;defer { busy=false }
        do {
            let connection=try await client.call("/v1/organato/connection",method:"POST",body:.object(["baseUrl":.string(baseURL),"apiKey":.string(apiKey)]))
            try await replica?.cacheConnector(connector.merging(.object(["connection":connection])));await refresh();await sync();return true
        } catch { self.error=error.localizedDescription;return false }
    }
    func removeOrganato() async {
        guard let client,!fixture else { error="Connect to Centre Cloud to remove this connection.";return }
        do {
            let connection=try await client.call("/v1/organato/connection/remove",method:"POST",body:.object([:]))
            try await replica?.cacheConnector(.object(["connection":connection]));await refresh()
        } catch { self.error=error.localizedDescription }
    }
    #if DEBUG
    private func seedFixture() async throws {
        let base=URL(string:"https://ui-fixture.invalid")!, key=try WorkspaceKey(baseURL:base,workspaceId:"offline-ui-fixture-v1")
        var store=try Replica(directory:directory,workspace:key)
        var journal=try ConnectorJournal(directory:directory,workspace:key)
        if ProcessInfo.processInfo.arguments.contains("-reset-fixture") { try await store.erase();try await journal.erase();store=try Replica(directory:directory,workspace:key);journal=try ConnectorJournal(directory:directory,workspace:key) }
        replica=store;calendarJournal=journal;session=CloudSession(token:"ctr_fixture_not_a_credential",deviceId:"ui-test",workspaceId:key.workspaceId,expiresAt:"2099-01-01T00:00:00.000Z");baseURL=base.absoluteString
        let existing=await store.snapshot()
        if existing.records.isEmpty {
            let now=Clock.iso(Date()), chatId="07cc79cc-af72-4768-b211-94b365c50a64", resourceId="55dcb531-b6a9-497e-aa7b-955767275ec9"
            let resource:JSONValue = .object(["id":.string(resourceId),"subjectId":.null,"topicId":.null,"title":.string("Cell biology practice"),"kind":.string("quiz"),"createdAt":.string(now),"updatedAt":.string(now),"content":.string("Practise from a saved resource without a network connection."),"questions":.array([.object(["id":.string("q1"),"prompt":.string("Which organelle produces most cellular ATP?"),"answer":.string("Mitochondria"),"explanation":.string("Aerobic respiration produces ATP in mitochondria."),"marks":.number(1),"responseType":.string("multiple_choice"),"choices":.array([.string("Mitochondria"),.string("Nucleus"),.string("Ribosome")])])]),"questionTypes":.array([.string("multiple_choice")]),"testLength":.null,"durationMinutes":.null,"completedAt":.null,"deletedAt":.null])
            let chat:JSONValue = .object(["id":.string(chatId),"title":.string("Cell biology"),"createdAt":.string(now),"updatedAt":.string(now),"deletedAt":.null,"pinnedAt":.null,"folderId":.null,"sortOrder":.number(0),"modelSelection":.null,"lineage":.object(["schemaVersion":.number(1),"kind":.string("root")])])
            let messageId="c2b7dd30-cb15-473d-b615-f7457f170e43"
            let message:JSONValue = .object(["id":.string(messageId),"chatId":.string(chatId),"role":.string("assistant"),"content":.string("This is a local UI test workspace. No hosted AI response has been requested.\n\nOpen Resources to practise your saved quiz, or record actual study in Log."),"createdAt":.string(now),"responseDurationMs":.null,"resourceIds":.array([.string(resourceId)]),"attachmentIds":.array([]),"requestContext":.null])
            let reviewId="28a04f7b-70e9-44f2-925a-5c7559791aa4"
            let review:JSONValue = .object(["id":.string(reviewId),"subjectId":.null,"topicId":.null,"resourceId":.string(resourceId),"question":.string("How do mitochondria supply energy?"),"note":.string("Explain ATP in your own words."),"createdAt":.string(now),"nextReviewAt":.string(now),"resolvedAt":.null])
            let diagramId="fdd186b8-aea0-4d85-9538-390f076f0379"
            let diagram=resource.merging(.object(["id":.string(diagramId),"title":.string("Navigation containment"),"kind":.string("diagram"),"questions":.array([]),"content":.string("<h2>Saved drawing stays here</h2><p><a href=\"https://example.invalid/escape\">Attempt external navigation</a></p><script>window.location='https://example.invalid/script-escape'</script><img src=\"https://example.invalid/image-escape\"><form action=\"https://example.invalid/form-escape\"><input type=submit value=Escape></form>")]))
            try await store.stage([LocalChange(kind:"resource",id:resourceId,data:resource),LocalChange(kind:"resource",id:diagramId,data:diagram),LocalChange(kind:"chat",id:chatId,data:chat),LocalChange(kind:"message",id:messageId,data:message),LocalChange(kind:"reviewMemory",id:reviewId,data:review)])
            try await store.cacheConnector(.object(["subjects":.array([]),"assignments":.array([]),"events":.array([])]))
        }
        try await recoverTimers();await refresh();status="Offline UI test workspace. All changes stay on this simulator."
    }
    #endif

}
