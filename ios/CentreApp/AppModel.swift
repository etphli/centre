import SwiftUI
import CentreCore
import GoogleSignIn
import CryptoKit

struct PairingInvitation: Identifiable { let id=UUID();let baseURL:URL;let code:String }

@MainActor final class AppModel: ObservableObject {
    private struct ComposerDraftKey: Hashable {
        let workspaceFileKey:String
        let chatId:String
    }
    private struct ComposerDraftWrite {
        let id:UUID
        let workspace:WorkspaceKey
        let chatId:String
        let text:String
        let replica:Replica
    }

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
    @Published var cloudAIAllowed=false
    @Published private(set) var composerDrafts:[String:String]=[:]
    @Published private(set) var workspaceKey:WorkspaceKey?
    private var replica:Replica?
    private var calendarJournal:ConnectorJournal?
    private var attachmentCache:AttachmentCache?
    private var client:CloudHTTP?
    private var scheduledSync:Task<Void,Never>?
    private var syncing=false
    private var signingOut=false
    private var timerHeartbeatRunning=false
    private var lastInteraction=Date()
    private var aiJobs:[PendingAI]=[]
    private var ownedTimers:Set<String>=[]
    private var pendingComposerDraftWrites:[ComposerDraftKey:ComposerDraftWrite]=[:]
    private var composerDraftWriter:Task<Void,Never>?
    private var composerDraftWriterID:UUID?
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
                let newClient=try CloudHTTP(baseURL:url,token:saved.session.token)
                let workspace=try WorkspaceKey(baseURL:url,workspaceId:saved.session.workspaceId)
                let newReplica=try Replica(directory:directory,workspace:workspace)
                composerDrafts=(await newReplica.snapshot()).composerDrafts
                workspaceKey=workspace;baseURL=saved.baseURL;session=saved.session;cloudAIAllowed=saved.cloudAIAllowed == true
                client=newClient;replica=newReplica
                calendarJournal=try ConnectorJournal(directory:directory,workspace:workspace)
                attachmentCache=try AttachmentCache(directory:directory,workspace:workspace)
                try await recoverTimers()
                await refresh()
                await sync()
            }
        } catch { self.error=error.localizedDescription }
    }
    var preferences:JSONValue { StudyPreferences.defaults.merging(record(kind:"preferences",id:"preferences")?.data ?? .object([:])) }
    var timeZone:String { preferences["timeZone"].string ?? "Australia/Sydney" }
    func items(_ kind:String) -> [CloudRecord] { records.filter{$0.kind == kind && !$0.deleted && $0.schemaVersion == 1 && $0.data?["deletedAt"].string == nil} }
    func record(kind:String,id:String) -> CloudRecord? { items(kind).first{$0.id == id} }
    func data(_ record:CloudRecord) -> JSONValue { record.data ?? .object([:]) }
    var activeTimer:CloudRecord? {
        let active=items("studySession")
        let id=StudyRules.preferredSession(active.compactMap{try? $0.data?.decode(StudySession.self)})?.id
        return active.first{$0.id == id}
    }
    var sessions:[StudySession] { items("studySession").compactMap { try? $0.data?.decode(StudySession.self) } }
    var studyMinutes:Double { ((try? StudyRules.weeklyDuration(sessions,at:Date(),timeZone:timeZone)) ?? 0)/60 }
    var goalMinutes:Int {
        guard let week=try? StudyRules.weekStart(at:Date(),timeZone:timeZone) else { return 0 }
        return items("studyGoal").first{$0.data?["weekStart"].string == week && $0.data?["timeZone"].string == timeZone}?.data?["targetMinutes"].int ?? 0
    }
    func touch() { lastInteraction=Date() }
    func refresh() async {
        guard let workspace=workspaceKey,let replica else { return }
        let journal=calendarJournal
        let value=await replica.snapshot()
        guard workspaceKey == workspace,self.replica === replica else { return }
        let commands=await journal?.snapshot() ?? []
        guard workspaceKey == workspace,self.replica === replica else { return }
        calendarCommands=commands
        records=value.records;pendingCount=value.pendingCount+calendarCommands.filter(\.pending).count;conflicts=value.conflicts;connector=value.connector;aiJobs=value.ai;aiRuns=value.ai.compactMap(\.run)
    }
    func saveComposerDraft(workspace:WorkspaceKey,chatId:String,text:String) {
        guard !signingOut,session != nil,workspaceKey == workspace,let replica,!chatId.isEmpty,chatId.utf16.count <= 200,text.utf16.count <= 100_000 else { return }
        if text.isEmpty { composerDrafts.removeValue(forKey:chatId) }
        else { composerDrafts[chatId]=text }
        let key=ComposerDraftKey(workspaceFileKey:workspace.fileKey,chatId:chatId)
        pendingComposerDraftWrites[key]=ComposerDraftWrite(id:UUID(),workspace:workspace,chatId:chatId,text:text,replica:replica)
        scheduleComposerDraftWrites()
    }
    private func scheduleComposerDraftWrites() {
        guard composerDraftWriter == nil,!pendingComposerDraftWrites.isEmpty else { return }
        let writerID=UUID()
        composerDraftWriterID=writerID
        composerDraftWriter=Task { [weak self] in
            guard let self else { return }
            await self.persistComposerDraftWrites(writerID:writerID)
        }
    }
    private func persistComposerDraftWrites(writerID:UUID) async {
        try? await Task.sleep(for:.milliseconds(150))
        while !Task.isCancelled,let (key,write)=pendingComposerDraftWrites.first {
            guard !signingOut,workspaceKey == write.workspace,replica === write.replica else { pendingComposerDraftWrites.removeValue(forKey:key);continue }
            do { try await write.replica.setComposerDraft(write.text.isEmpty ? nil:write.text,forChatId:write.chatId) }
            catch { if !signingOut,workspaceKey == write.workspace,replica === write.replica { self.error=error.localizedDescription } }
            if pendingComposerDraftWrites[key]?.id == write.id { pendingComposerDraftWrites.removeValue(forKey:key) }
        }
        if composerDraftWriterID == writerID {
            composerDraftWriter=nil;composerDraftWriterID=nil
            if !signingOut { scheduleComposerDraftWrites() }
        }
    }
    private func flushComposerDraftWrites() async {
        while true {
            scheduleComposerDraftWrites()
            guard let writer=composerDraftWriter else { return }
            await writer.value
        }
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
        guard !signingOut else { return false }
        guard replica != nil else { error="Connect your Centre account first.";return false }
        touch();error=nil
        do { try await action();await refresh();status=pendingCount > 0 ? "Saved on iPhone. \(pendingCount) changes waiting to sync." : "Saved on iPhone.";scheduleSync();return true }
        catch { self.error=error.localizedDescription;return false }
    }
    @discardableResult
    func save(kind:String,id:String,data:JSONValue,deleted:Bool=false,baseline:EditingBaseline?=nil) async -> Bool {
        let saved = await perform {
            guard let replica else { return }
            guard data["id"].string == id || kind == "preferences" else { throw CentreError.invalid("Invalid record identity.") }
            if kind == "preferences" {
                _ = try StudyPreferences.validatedPatch(data)
            }
            if kind == "studySession" {
                let value=try data.decode(StudySession.self)
                try StudyRules.validate(value,others:sessions.filter{$0.id != id},now:Date())
            }
            if kind == "resource", !deleted { try RecordProjections.validateLocation(data,topics:records.filter{$0.kind == "topic"}) }
            try await replica.stage([LocalChange(kind:kind,id:id,data:data,deleted:deleted)],baseline:baseline)
        }
        return saved
    }
    @discardableResult
    func savePreferences(_ patch: JSONValue) async -> Bool {
        await perform {
            guard let replica else { return }
            try await replica.updatePreferences(patch)
        }
    }
    func setResponseType(key: String, type: String, enabled: Bool) async {
        _ = await perform {
            guard let replica else { return }
            try await replica.updateResponseType(key: key, type: type, enabled: enabled)
        }
    }
    func send(workspace:WorkspaceKey,chatId:String,text:String) async -> String? {
        guard !signingOut,workspaceKey == workspace,let originatingReplica=replica else { return nil }
        guard cloudAIAllowed else { error="Allow Cloudflare AI before sending a message.";return nil }
        let composerText=text,messageText=text.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !messageText.isEmpty,messageText.utf16.count <= 8000 else { error="Write a message of up to 8,000 characters.";return nil }
        await flushComposerDraftWrites()
        guard !signingOut,workspaceKey == workspace,replica === originatingReplica else { return nil }
        let messageId=UUID().uuidString.lowercased(),now=Clock.iso(Date())
        var committed=false
        await perform {
            guard !signingOut,workspaceKey == workspace,replica === originatingReplica else { throw CentreError.unavailable("This chat changed workspaces before the message was saved.") }
            let existing=record(kind:"chat",id:chatId)?.data
            let chat=existing?.merging(.object(["updatedAt":.string(now)])) ?? .object([
                "id":.string(chatId),"title":.string(String(messageText.prefix(60))),"createdAt":.string(now),"updatedAt":.string(now),"deletedAt":.null,"pinnedAt":.null,"folderId":.null,"sortOrder":.number(0),"modelSelection":.null,"lineage":.object(["schemaVersion":.number(1),"kind":.string("root")])])
            let message:JSONValue = .object(["id":.string(messageId),"chatId":.string(chatId),"role":.string("user"),"content":.string(messageText),"createdAt":.string(now),"responseDurationMs":.null,"resourceIds":.array([]),"attachmentIds":.array([]),"requestContext":.object(["page":.string("chat")])])
            try await originatingReplica.stage([LocalChange(kind:"chat",id:chatId,data:chat),LocalChange(kind:"message",id:messageId,data:message)],ai:.chat(AIRequest(chatId:chatId,messageId:messageId),nil),clearingComposerDraft:(chatId:chatId,text:composerText))
            committed=true
        }
        if committed {
            if workspaceKey == workspace,replica === originatingReplica {
                if composerDrafts[chatId] == composerText { composerDrafts.removeValue(forKey:chatId) }
                Task { await sync() }
            }
            return chatId
        }
        return nil
    }
    @discardableResult
    func saveDraft(resource:CloudRecord,answers:[String:String],currentQuestion:Int,baseline:EditingBaseline) async -> EditingBaseline? {
        var updated:EditingBaseline?
        let saved = await perform {
            guard let replica else { return }
            let existing=items("practice.draft").first{$0.data?["resourceId"].string == resource.id}
            if aiJobs.contains(where:{ if case .grade(let request,_) = $0 { return request.resourceId == resource.id };return false }) { throw CentreError.unavailable("This quiz is submitted for marking. Wait for its result before changing answers.") }
            let questions=resource.data?["questions"].array ?? []
            let ids=Set(questions.compactMap{$0["id"].string})
            guard !questions.isEmpty,currentQuestion >= 0,currentQuestion < questions.count,currentQuestion < 30,answers.keys.allSatisfy(ids.contains),answers.values.allSatisfy({$0.utf16.count <= 4000}) else { throw CentreError.invalid("The quiz answers do not match its questions.") }
            let id=existing?.id ?? UUID().uuidString.lowercased(),now=Clock.iso(Date())
            let body:JSONValue = .object(["schemaVersion":.number(1),"id":.string(id),"revision":.number(Double((existing?.data?["revision"].int ?? 0)+1)),"resourceId":.string(resource.id),"answers":.object(answers.mapValues(JSONValue.string)),"currentQuestion":.number(Double(currentQuestion)),"createdAt":existing?.data?["createdAt"] ?? .string(now),"updatedAt":.string(now),"deletedAt":.null])
            updated=try await replica.stage([LocalChange(kind:"practice.draft",id:id,data:body)],baseline:baseline)
        }
        return saved ? updated : nil
    }
    @discardableResult
    func submitQuiz(resource:CloudRecord,baseline:EditingBaseline) async -> Bool {
        guard cloudAIAllowed else { error="Allow Cloudflare AI before submitting for marking.";return false }
        let saved = await perform {
            guard let replica,let draft=items("practice.draft").first(where:{$0.data?["resourceId"].string == resource.id}),let revision=draft.data?["revision"].int else { throw CentreError.invalid("Save your answers before submitting.") }
            guard !aiJobs.contains(where:{if case .grade(let request,_)=$0{return request.draftId == draft.id};return false}) else { throw CentreError.unavailable("This quiz is already waiting for marking.") }
            let request=GradeRequest(id:UUID().uuidString.lowercased(),draftId:draft.id,resourceId:resource.id,expectedDraftRevision:revision)
            try await replica.stage([],ai:.grade(request,nil),baseline:baseline)
        }
        return saved
    }
    func isQuizSubmitted(resourceId:String) -> Bool {
        aiJobs.contains { if case .grade(let request,let run)=$0 { return request.resourceId == resourceId && !["failed","interrupted","conflict"].contains(run?.status ?? "") };return false }
    }
    func quizFailure(resourceId:String) -> String? {
        aiJobs.contains { if case .grade(let request,let run)=$0 { return request.resourceId == resourceId && ["failed","interrupted","conflict"].contains(run?.status ?? "") };return false } ? "Marking could not finish safely. Your answers are saved. Start over to submit a fresh draft." : nil
    }
    func quizWaiting(resourceId:String) -> String? {
        aiJobs.compactMap { job -> String? in
            if case .grade(let request,let run)=job,request.resourceId == resourceId,run?.status == "unavailable" { return run?.error?["message"].string };return nil
        }.last
    }
    @discardableResult func startOverQuiz(resource:CloudRecord,baseline:EditingBaseline) async -> Bool {
        guard !isQuizSubmitted(resourceId:resource.id) else { error="This quiz is waiting for marking. Synchronize before starting over.";return false }
        return await perform {
            guard let replica else { return }
            var changes:[LocalChange]=[]
            if let draft=items("practice.draft").first(where:{$0.data?["resourceId"].string == resource.id}),var data=draft.data {
                data["revision"] = .number(Double((data["revision"].int ?? 0)+1));data["updatedAt"] = .string(Clock.iso(Date()));data["deletedAt"] = data["updatedAt"]
                changes.append(LocalChange(kind:"practice.draft",id:draft.id,data:data))
            }
            try await replica.stage(changes,baseline:baseline)
            for job in aiJobs { if case .grade(let request,_)=job,request.resourceId == resource.id { try await replica.dismissAI(id:job.id) } }
        }
    }
    @discardableResult func timer(action:String,id:String?,title:String,subjectId:String?,targetMinutes:Int?=nil) async -> Bool {
        let saved = await perform {
            guard let replica else { return }
            let now=Date(),value:StudySession
            var previous:StudySession?
            if action == "start" {
                guard activeTimer == nil else { throw CentreError.invalid("Finish your current timer before starting another.") }
                value=try StudyRules.start(title:title,subjectId:subjectId,targetMinutes:targetMinutes,timeZone:timeZone,now:now)
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
        guard !signingOut else { return }
        guard let replica,let timer=activeTimer,let body=timer.data,body["state"]["kind"].string == "running" else { return }
        guard !timerHeartbeatRunning else { return }
        timerHeartbeatRunning=true
        defer { timerHeartbeatRunning=false }
        do {
            let now=Date()
            let original=try body.decode(StudySession.self)
            let value=try StudyRules.heartbeat(original,now:now,activity:now.timeIntervalSince(lastInteraction)<15)
            try StudyRules.validate(value,others:sessions.filter{$0.id != value.id},now:now,previous:original)
            try await replica.stage([LocalChange(kind:"studySession",id:value.id,data:JSONValue.encode(value))])
            if value.state.kind == "running" { ownedTimers.insert(value.id) } else { ownedTimers.remove(value.id) }
            await refresh();scheduleSync()
        } catch { self.error=error.localizedDescription }
    }
    func recoverTimers(excludingLocal:Bool=false) async throws {
        guard let replica else { return }
        let snapshot=await replica.snapshot()
        let changes=try RecordProjections.recoverTimers(snapshot.records,excluding:excludingLocal ? ownedTimers:[],now:Date())
        if !changes.isEmpty { try await replica.stage(changes) }
    }
    func background() async {
        guard !signingOut else { return }
        await flushComposerDraftWrites()
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
        await perform {
            try await replica?.resolve(conflict,useLocal:useLocal)
            if conflict.local.kind == "studySession", !useLocal {
                ownedTimers.remove(conflict.local.id)
                try await recoverTimers(excludingLocal:true)
            }
        }
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
    func googleSignIn(baseURL:String) async {
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
        let workspace=try WorkspaceKey(baseURL:base,workspaceId:newSession.workspaceId)
        let store=try Replica(directory:directory,workspace:workspace)
        let savedComposerDrafts=(await store.snapshot()).composerDrafts
        let journal=try ConnectorJournal(directory:directory,workspace:workspace)
        try SessionVault.save(SavedSession(baseURL:base.absoluteString,session:newSession))
        let attachments=try AttachmentCache(directory:directory,workspace:workspace)
        composerDrafts=savedComposerDrafts;workspaceKey=workspace
        self.baseURL=base.absoluteString;self.session=newSession;client=api;replica=store;calendarJournal=journal;attachmentCache=attachments;cloudAIAllowed=false
        try await recoverTimers();await refresh()
    }
    func logout(discard:Bool) async {
        guard !syncing,!busy,!signingOut else { error="Wait for synchronization to finish before signing out.";return }
        guard pendingCount == 0 && conflicts.isEmpty || discard else { error="You have pending study changes. Synchronize them or explicitly discard them before signing out.";return }
        signingOut=true;busy=true;scheduledSync?.cancel();composerDraftWriter?.cancel();composerDraftWriter=nil;composerDraftWriterID=nil;pendingComposerDraftWrites.removeAll()
        defer { signingOut=false;busy=false }
        let store=replica,journal=calendarJournal,attachments=attachmentCache,api=client,oldSession=session
        do {
            // Block every producer before the first await. Erased actors also reject retained stale handles.
            try await store?.erase();try await journal?.erase();try await attachments?.erase()
            try SessionVault.clear();GIDSignIn.sharedInstance.signOut()
            scheduledSync?.cancel();session=nil;client=nil;replica=nil;workspaceKey=nil;calendarJournal=nil;attachmentCache=nil;calendarCommands=[];records=[];connector = .object([:]);pendingCount=0;conflicts=[];aiJobs=[];aiRuns=[];composerDrafts=[:];cloudAIAllowed=false;status="Signed out. Private data removed from this iPhone."
            if let api,let oldSession,!fixture { _ = try? await api.call("/v1/devices/revoke",method:"POST",body:.object(["deviceId":.string(oldSession.deviceId)])) }
        } catch { self.error=error.localizedDescription }
    }
    func attachment(id:String,chatId:String) async throws -> AttachmentFile {
        guard !signingOut,record(kind:"chat",id:chatId) != nil,
              items("message").contains(where:{$0.data?["chatId"].string == chatId && ($0.data?["attachmentIds"].array ?? []).contains(.string(id))}),
              let attachmentCache else { throw CentreError.invalid("This file is not associated with an active chat.") }
        if let file=try? await attachmentCache.cached(id:id,chatId:chatId) { return file }
        guard let client,!fixture else { throw CentreError.unavailable("This file hasn't downloaded. Connect to Centre Cloud to save it for offline reading.") }
        let file=try await attachmentCache.download(id:id,chatId:chatId,using:client)
        guard record(kind:"chat",id:chatId) != nil else { throw CentreError.invalid("This chat was archived while the file downloaded.") }
        return file
    }
    func sync() async {
        guard !signingOut,!syncing,let replica else { return }
        if fixture { await refresh();status="Offline test workspace. Changes saved on iPhone.";return }
        guard let client,let session else { return }
        syncing=true;busy=true;defer{syncing=false;busy=false}
        do {
            status="Synchronizing"
            try await client.bootstrap(workspaceId:session.workspaceId)
            try await replica.synchronize(using:client,allowAI:cloudAIAllowed)
            do {
                try await calendarJournal?.process(using:client)
                // Connector writes are committed by the hosted module, then imported through the same feed.
                try await replica.synchronize(using:client,allowAI:cloudAIAllowed)
            } catch { self.error="Calendar changes remain saved. \(error.localizedDescription)" }
            // Imported timers pause at their persisted checkpoint. They never start a second device lease.
            try await recoverTimers(excludingLocal:true);await refresh()
            do { let snapshot=try await client.call("/v1/organato/snapshot");try await replica.cacheConnector(snapshot);await refresh() }
            catch { status="Study data synchronized. Calendar connection unavailable." }
            if aiRuns.contains(where:{["failed","interrupted","conflict"].contains($0.status)}) { status="Cloud AI could not finish. Your saved message or quiz draft is preserved." }
            else if !conflicts.isEmpty { status="\(conflicts.count) conflicts need your choice in Settings." }
            else if pendingCount > 0 { status="\(pendingCount) changes waiting to sync." }
            else if status == "Synchronizing" { status="Synchronized with Centre Cloud." }
        } catch {
            if let failure=error as? CloudFailure {
                switch failure.status {
                case 401:status="Sign in again to synchronize. Study changes stay saved on iPhone."
                case 429:status="The cloud allowance is reached. Study changes stay saved on iPhone."
                case 503:status="A cloud service is unavailable. Study changes stay saved on iPhone."
                default:status="Cloud synchronization needs attention. Study changes stay saved on iPhone."
                }
            } else { status="Offline. Study changes remain saved on iPhone." }
            self.error=error.localizedDescription;await refresh()
        }
    }
    @discardableResult func allowCloudAI(_ allowed:Bool) -> Bool {
        guard !signingOut,let session else { return false }
        guard allowed || !busy else { error="Wait for the current cloud request to finish before changing AI access.";return false }
        do {
            if !fixture { try SessionVault.save(SavedSession(baseURL:baseURL,session:session,cloudAIAllowed:allowed)) }
            cloudAIAllowed=allowed;return true
        } catch { self.error=error.localizedDescription;return false }
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
            try CalendarPlan.validateMetadata(title:title,durationMinutes:durationMinutes)
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
        guard !signingOut,!busy,let id=event["id"].string,let record=record(kind:"calendarEvent",id:id),let revision=record.data?["revision"].int,let client,!fixture else { error="Connect to Centre Cloud to verify this calendar link.";return }
        busy=true;defer { busy=false }
        do {
            _ = try await client.call("/v1/organato/sessions/\(id)/link",method:"POST",body:.object(["expectedVersion":.number(Double(record.version)),"expectedRevision":.number(Double(revision))]))
            await sync()
        } catch { self.error=error.localizedDescription }
    }
    func reconcileCalendar(_ command:ConnectorCommand,applied:Bool,organatoId:String) async {
        guard !signingOut,!busy,let calendarJournal,let client,!fixture else { error="Connect to Centre Cloud to check the calendar outcome.";return }
        busy=true;defer { busy=false }
        do {
            var body:JSONValue = .object(["resolution":.string(applied ? "applied":"not_applied")])
            if applied,!organatoId.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty { body["organatoId"] = .string(organatoId.trimmingCharacters(in:.whitespacesAndNewlines)) }
            let receipt=try await client.call("/v1/organato/operations/\(command.id.uuidString.lowercased())/reconcile",method:"POST",body:body)
            try await calendarJournal.updateReceipt(receipt);await refresh();await sync()
        } catch { self.error=error.localizedDescription }
    }
    func retryMissingCalendar(_ command:ConnectorCommand) async {
        guard !signingOut,!busy,let calendarJournal,let client,!fixture else { error="Connect to Centre Cloud to try the saved change.";return }
        busy=true;defer { busy=false }
        do { try await calendarJournal.retryMissing(id:command.id,using:client);await refresh();await sync() }
        catch { self.error=error.localizedDescription;await refresh() }
    }
    func acknowledgeCalendar(_ command:ConnectorCommand) async {
        _ = await perform { try await calendarJournal?.acknowledge(command.id) }
    }
    func configureOrganato(baseURL:String,apiKey:String) async -> Bool {
        guard !signingOut,!busy,let client,!fixture else { error="Connect to Centre Cloud before adding an Organato connection.";return false }
        guard !apiKey.isEmpty,apiKey.utf16.count <= 2000,let url=URL(string:baseURL),(try? CloudURL.validate(url)) != nil else { error="Enter the Organato HTTPS address and its API key.";return false }
        busy=true;defer { busy=false }
        do {
            let connection=try await client.call("/v1/organato/connection",method:"POST",body:.object(["baseUrl":.string(baseURL),"apiKey":.string(apiKey)]))
            try await replica?.cacheConnector(connector.merging(.object(["connection":connection])));await refresh();await sync();return true
        } catch { self.error=error.localizedDescription;return false }
    }
    func removeOrganato() async {
        guard !signingOut,!busy,let client,!fixture else { error="Connect to Centre Cloud to remove this connection.";return }
        busy=true;defer { busy=false }
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
        var attachments=try AttachmentCache(directory:directory,workspace:key)
        if ProcessInfo.processInfo.arguments.contains("-reset-fixture") { try await store.erase();try await journal.erase();try await attachments.erase();store=try Replica(directory:directory,workspace:key);journal=try ConnectorJournal(directory:directory,workspace:key);attachments=try AttachmentCache(directory:directory,workspace:key) }
        composerDrafts=(await store.snapshot()).composerDrafts;workspaceKey=key
        replica=store;calendarJournal=journal;attachmentCache=attachments;session=CloudSession(token:"ctr_fixture_not_a_credential",deviceId:"ui-test",workspaceId:key.workspaceId,expiresAt:"2099-01-01T00:00:00.000Z");baseURL=base.absoluteString
        let existing=await store.snapshot()
        if existing.records.isEmpty {
            let now=Clock.iso(Date()), chatId="07cc79cc-af72-4768-b211-94b365c50a64", resourceId="55dcb531-b6a9-497e-aa7b-955767275ec9"
            let resource:JSONValue = .object(["id":.string(resourceId),"subjectId":.null,"topicId":.null,"title":.string("Cell biology practice"),"kind":.string("quiz"),"createdAt":.string(now),"updatedAt":.string(now),"content":.string("Practise from a saved resource without a network connection."),"questions":.array([.object(["id":.string("q1"),"prompt":.string("Which organelle produces most cellular ATP?"),"answer":.string("Mitochondria"),"explanation":.string("Aerobic respiration produces ATP in mitochondria."),"marks":.number(1),"responseType":.string("multiple_choice"),"choices":.array([.string("Mitochondria"),.string("Nucleus"),.string("Ribosome")])])]),"questionTypes":.array([.string("multiple_choice")]),"testLength":.null,"durationMinutes":.null,"completedAt":.null,"deletedAt":.null])
            let chat:JSONValue = .object(["id":.string(chatId),"title":.string("Cell biology"),"createdAt":.string(now),"updatedAt":.string(now),"deletedAt":.null,"pinnedAt":.null,"folderId":.null,"sortOrder":.number(0),"modelSelection":.null,"lineage":.object(["schemaVersion":.number(1),"kind":.string("root")])])
            let messageId="c2b7dd30-cb15-473d-b615-f7457f170e43"
            let attachmentId=UIAttachmentFixture.id
            let message:JSONValue = .object(["id":.string(messageId),"chatId":.string(chatId),"role":.string("assistant"),"content":.string("This is a local UI test workspace. No hosted AI response has been requested.\n\nOpen Resources to practise your saved quiz, or record actual study in Log."),"createdAt":.string(now),"responseDurationMs":.null,"resourceIds":.array([.string(resourceId)]),"attachmentIds":.array([.string(attachmentId)]),"requestContext":.null])
            let reviewId="28a04f7b-70e9-44f2-925a-5c7559791aa4"
            let review:JSONValue = .object(["id":.string(reviewId),"subjectId":.null,"topicId":.null,"resourceId":.string(resourceId),"question":.string("How do mitochondria supply energy?"),"note":.string("Explain ATP in your own words."),"createdAt":.string(now),"nextReviewAt":.string(now),"resolvedAt":.null])
            let diagramId="fdd186b8-aea0-4d85-9538-390f076f0379"
            let diagram=resource.merging(.object(["id":.string(diagramId),"title":.string("Navigation containment"),"kind":.string("diagram"),"questions":.array([]),"content":.string("<h2>Saved drawing stays here</h2><p><a href=\"https://example.invalid/escape\">Attempt external navigation</a></p><script>window.location='https://example.invalid/script-escape'</script><img src=\"https://example.invalid/image-escape\"><form action=\"https://example.invalid/form-escape\"><input type=submit value=Escape></form>")]))
            _ = try await attachments.download(id:attachmentId,chatId:chatId,using:UIAttachmentFixture())
            let includesPracticeHistory = ProcessInfo.processInfo.arguments.contains("-ui-testing-attempt-history")
            let savedResource = includesPracticeHistory
                ? resource.merging(.object(["subjectId":.string("biology")]))
                : resource
            var fixtureChanges = [
                LocalChange(kind:"resource",id:resourceId,data:savedResource),
                LocalChange(kind:"resource",id:diagramId,data:diagram),
                LocalChange(kind:"chat",id:chatId,data:chat),
                LocalChange(kind:"message",id:messageId,data:message),
                LocalChange(kind:"attachment",id:attachmentId,data:UIAttachmentFixture.metadata),
                LocalChange(kind:"reviewMemory",id:reviewId,data:review)
            ]
            if includesPracticeHistory {
                func attempt(_ id: String, kind: String = "practice.attempt", resourceId: String,
                             questionId: String = "q1", createdAt: String, answer: String,
                             score: Double, feedback: String) -> LocalChange {
                    let data: JSONValue = .object([
                        "schemaVersion":.number(1),"revision":.number(1),"id":.string(id),
                        "resourceId":.string(resourceId),"answers":.object([questionId:.string(answer)]),
                        "result":.object(["score":.number(score),"total":.number(1),"feedback":.array([
                            .object(["questionId":.string(questionId),"concept":.string("Energy"),
                                     "score":.number(score),"maxScore":.number(1),
                                     "feedback":.string(feedback),"needsReview":.bool(score < 1)])
                        ])]),
                        "createdAt":.string(createdAt)
                    ])
                    return LocalChange(kind:kind,id:id,data:data)
                }
                fixtureChanges.append(contentsOf: [
                    attempt("10000000-0000-4000-8000-000000000001", resourceId:resourceId,
                            createdAt:"2026-10-19T01:00:00.000Z", answer:"First saved response", score:0.25, feedback:"First saved feedback."),
                    attempt("10000000-0000-4000-8000-000000000002", resourceId:resourceId,
                            createdAt:"2026-10-20T01:00:00.000Z", answer:"Second saved response", score:0.75, feedback:"Second saved feedback."),
                    attempt("10000000-0000-4000-8000-000000000003", resourceId:resourceId,
                            createdAt:"2026-10-21T01:00:00.000Z", answer:"Third saved response", score:0.5, feedback:"Third saved feedback."),
                    attempt("10000000-0000-4000-8000-000000000004", resourceId:resourceId,
                            createdAt:"2026-10-22T01:00:00.000Z", answer:"Latest saved response", score:0.25, feedback:"Latest saved feedback."),
                    attempt("20000000-0000-4000-8000-000000000001", kind:"attempt", resourceId:"deleted-resource",
                            questionId:"saved-question-id", createdAt:"2026-10-18T01:00:00.000Z",
                            answer:"Saved deleted-resource answer", score:0, feedback:"Saved deleted-resource feedback.")
                ])
            }
            try await store.stage(fixtureChanges)
            let subjects: [JSONValue] = includesPracticeHistory
                ? [.object(["id":.string("biology"),"name":.string("Biology"),"shortName":.string("Bio"),"color":.string("blue"),"icon":.string("book")])]
                : []
            try await store.cacheConnector(.object(["subjects":.array(subjects),"assignments":.array([]),"events":.array([])]))
        }
        if ProcessInfo.processInfo.arguments.contains("-ui-testing-timer-conflict") {
            let now=Date()
            var local=try StudyRules.start(title:"Local running timer",subjectId:nil,timeZone:"Australia/Sydney",now:now.addingTimeInterval(-20))
            local.id=UITimerConflictFixture.id
            local=try StudyRules.heartbeat(local,now:now.addingTimeInterval(-5),activity:true)
            var remote=local;remote.revision=3
            if !ProcessInfo.processInfo.arguments.contains("-ui-testing-cloud-running") {
                remote=try StudyRules.recover(local,now:now,restart:true)
            }
            try await store.stage([LocalChange(kind:"studySession",id:local.id,data:JSONValue.encode(local))])
            try await store.synchronize(using:UITimerConflictFixture(remote:CloudRecord(kind:"studySession",id:remote.id,version:8,cursor:"9",data:JSONValue.encode(remote))))
            ownedTimers.insert(local.id)
        }
        try await recoverTimers(excludingLocal:true);await refresh();status="Offline UI test workspace. All changes stay on this simulator."
    }
    #endif

}

#if DEBUG
private struct UITimerConflictFixture:CloudTransport {
    static let id="f3bfad1e-27c4-4c5c-b4cd-431fe759e43b"
    let remote:CloudRecord
    func put(_ mutation:CloudMutation) async throws -> MutationResponse {
        if mutation.kind == "studySession" { return .conflict(remote) }
        return .accepted(CloudRecord(kind:mutation.kind,id:mutation.id,version:mutation.expectedVersion+1,cursor:"1",deleted:mutation.deleted,data:mutation.data))
    }
    func changes(cursor:String) async throws -> ChangesPage { ChangesPage(records:[],cursor:cursor,hasMore:false) }
    func run(_ request:AIRequest) async throws -> AIRun { throw CentreError.unavailable("No fixture inference.") }
    func grade(_ request:GradeRequest) async throws -> AIRun { throw CentreError.unavailable("No fixture grading.") }
}

private struct UIAttachmentFixture:AttachmentTransport {
    static let id="45c6ec2f-2aa0-40a4-b5ba-fd6b301f1594"
    static let bytes=Data("Saved attachment, available offline.\nThis file is an explicit simulator fixture. No cloud download was requested.\n".utf8)
    static var metadata:JSONValue { .object(["id":.string(id),"name":.string("Offline reading.txt"),"mimeType":.string("text/plain"),"size":.number(Double(bytes.count)),"sha256":.string(SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined())]) }
    func attachmentGet(_ path:String) async throws -> JSONValue { path.contains("/chunks/") ? .object(["data":.string(Self.bytes.base64EncodedString())]):Self.metadata }
}
#endif
