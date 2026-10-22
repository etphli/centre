import SwiftUI
import WebKit
import QuickLook
import CentreCore

// MARK: - Root

@MainActor
struct CentreRootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.dynamicTypeSize) private var systemTextSize
    @State private var showSettings = false

    init() { CentreFont.configureTitleFonts() }

    private var theme: String? { model.preferences["theme"].string }

    var body: some View {
        let palette = CentrePalette.resolve(theme: theme, system: systemScheme)
        Group {
            if model.session == nil {
                NavigationStack { ConnectScreen() }
            } else {
                TabView(selection: $model.selectedTab) {
                    ChatTab(showSettings: $showSettings)
                        .tabItem { Label("Chat", systemImage: "bubble.left") }.tag(0)
                    ResourcesTab(showSettings: $showSettings)
                        .tabItem { Label("Resources", systemImage: "books.vertical") }.tag(1)
                    ReviewTab(showSettings: $showSettings)
                        .tabItem { Label("Review", systemImage: "arrow.uturn.backward.circle") }.tag(2)
                    CalendarTab(showSettings: $showSettings)
                        .tabItem { Label("Calendar", systemImage: "calendar") }.tag(3)
                    LogTab(showSettings: $showSettings)
                        .tabItem { Label("Log", systemImage: "clock") }.tag(4)
                }
            }
        }
        .tint(palette.accent)
        .centreWindowTint(palette.accent)
        .environment(\.centre, palette)
        .dynamicTypeSize(adjustedTextSize)
        .preferredColorScheme(CentrePalette.preferredScheme(theme: theme))
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(model)
                .environment(\.centre, palette)
                .tint(palette.accent)
                .preferredColorScheme(CentrePalette.preferredScheme(theme: theme))
        }
    }
    private var adjustedTextSize: DynamicTypeSize {
        // Respect all accessibility sizes. Centre's preference only adjusts the ordinary reading sizes.
        guard !systemTextSize.isAccessibilitySize else { return systemTextSize }
        let sizes:[DynamicTypeSize]=[.xSmall,.small,.medium,.large,.xLarge,.xxLarge,.xxxLarge]
        let index=sizes.firstIndex(of:systemTextSize) ?? 3
        let offset=model.preferences["textSize"].string == "large" ? 1 : model.preferences["textSize"].string == "small" ? -1 : 0
        return sizes[min(sizes.count-1,max(0,index+offset))]
    }
}

/// Shared tab chrome: settings/sync button, error notice and Centre bar colours.
@MainActor
private struct TabChrome: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Binding var showSettings: Bool

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                if let error = model.error {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                        Text(error).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("Problem: \(error)")
                            .accessibilityIdentifier("error.message")
                        Button { model.error = nil } label: {
                            Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
                        }
                        .accessibilityLabel("Dismiss problem")
                        .accessibilityIdentifier("error.dismiss")
                    }
                    .font(.footnote)
                    .foregroundStyle(palette.warn)
                    .padding(.leading, 16).padding(.trailing, 4)
                    .background(palette.surface)
                    .overlay(alignment: .bottom) { Rectangle().fill(palette.line).frame(height: 1) }
                    .accessibilityElement(children: .contain)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        HStack(spacing: 5) {
                            if !model.conflicts.isEmpty {
                                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath").foregroundStyle(palette.warn)
                            } else if model.pendingCount > 0 {
                                Text("\(model.pendingCount)").font(.footnote.monospacedDigit())
                                Image(systemName: "arrow.triangle.2.circlepath")
                            } else if model.busy {
                                ProgressView().controlSize(.small)
                            }
                            Image(systemName: "gearshape")
                        }
                    }
                    .accessibilityLabel("Settings")
                    .accessibilityValue(syncSummary)
                    .accessibilityIdentifier("settings.open")
                }
            }
            .toolbarBackground(palette.bg, for: .navigationBar)
            .toolbarBackground(palette.bg, for: .tabBar)
    }

    private var syncSummary: String {
        if !model.conflicts.isEmpty { return "\(model.conflicts.count) conflicts need a choice" }
        if model.pendingCount > 0 { return "\(model.pendingCount) changes waiting to sync" }
        return model.busy ? "Syncing" : "Up to date"
    }
}

private extension View {
    func tabChrome(showSettings: Binding<Bool>) -> some View { modifier(TabChrome(showSettings: showSettings)) }
}

// MARK: - Chat

private enum ChatRoute: Hashable { case new(UUID), chat(String) }

@MainActor
private struct ChatTab: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Binding var showSettings: Bool
    @State private var path: [ChatRoute] = []

    var body: some View {
        let chats = model.items("chat").sorted { a, b in
            let pinA = model.data(a)["pinnedAt"].string != nil, pinB = model.data(b)["pinnedAt"].string != nil
            if pinA != pinB { return pinA }
            return (model.data(a)["updatedAt"].string ?? a.updatedAt) > (model.data(b)["updatedAt"].string ?? b.updatedAt)
        }
        NavigationStack(path: $path) {
            List {
                ForEach(chats) { chat in
                    NavigationLink(value: ChatRoute.chat(chat.id)) { ChatRow(chat: chat) }
                        .centreRow(palette)
                        .accessibilityIdentifier("chat.row.\(chat.id)")
                }
            }
            .centreList(palette)
            .overlay {
                if chats.isEmpty {
                    ContentUnavailableView {
                        Label("No chats yet", systemImage: "bubble.left")
                    } description: {
                        Text("Ask about anything you're studying. Chats from Centre on your Mac appear here after they sync.")
                    } actions: {
                        Button("New chat") { path.append(.new(UUID())) }.buttonStyle(CentrePrimaryButtonStyle()).frame(maxWidth: 220)
                    }
                }
            }
            .refreshable { await model.sync() }
            .navigationTitle("Chat")
            .navigationDestination(for: ChatRoute.self) { route in
                switch route {
                case .new: ChatThreadView(chatId: nil)
                case .chat(let id): ChatThreadView(chatId: id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { path.append(.new(UUID())) } label: { Label("New chat", systemImage: "square.and.pencil") }
                        .accessibilityIdentifier("chat.new")
                }
            }
            .tabChrome(showSettings: $showSettings)
        }
    }
}

@MainActor
private struct ChatRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let chat: CloudRecord

    var body: some View {
        let data = model.data(chat)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if data["pinnedAt"].string != nil {
                    Image(systemName: "pin.fill").font(.caption).foregroundStyle(palette.text3).accessibilityLabel("Pinned")
                }
                Text(data["title"].string.nonEmpty ?? "Untitled chat").lineLimit(2)
            }
            if let updated = When.parse(data["updatedAt"].string ?? chat.updatedAt) {
                Text(updated, format: .relative(presentation: .named))
                    .font(.footnote).foregroundStyle(palette.text3)
            }
        }
        .padding(.vertical, 2)
    }
}

@MainActor
private struct ChatThreadView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @State private var chatId: String?
    @State private var draft = ""
    @State private var sending = false
    @State private var waitedOut = false
    @State private var confirmCloudAI=false
    @ScaledMetric(relativeTo: .body) private var sendSize: CGFloat = 44

    init(chatId: String?) { _chatId = State(initialValue: chatId) }

    var body: some View {
        let messages = thread()
        let chatData = chatId.flatMap { model.record(kind: "chat", id: $0) }.map { model.data($0) }
        let fromDesktop = chatData.map { !$0["modelSelection"].uiIsNull } ?? false
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    Text(fromDesktop
                         ? "Started in Centre on your Mac with Codex. Replies sent from this iPhone come from Llama 3.1 in Centre Cloud."
                         : "Replies come from Llama 3.1 in Centre Cloud, within a daily allowance.")
                        .font(.footnote).foregroundStyle(palette.text3)
                    ForEach(messages) { message in
                        MessageRow(record: message).id(message.id)
                    }
                    if let status = replyStatus(messages) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if status.working {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: status.failed ? "exclamationmark.triangle" : "icloud.and.arrow.up")
                            }
                            Text(status.text)
                        }
                        .font(.footnote).foregroundStyle(status.failed ? palette.warn : palette.text2)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("chat.replyStatus")
                        .id("status")
                    }
                }
                .padding(16)
            }
            .background(palette.bg)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { waitedOut = false; await model.sync() }
            .onAppear { if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            .onChange(of: messages.count) { _, _ in
                if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
        // While a reply is outstanding, check for it for up to two minutes, then stop and say so.
        .task(id: "\(messages.count)-\(replyStatus(messages)?.working == true && !sending)") {
            guard !sending, replyStatus(thread())?.working == true else { return }
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { return }
                await model.sync()
                if replyStatus(thread())?.working != true { return }
            }
            waitedOut = true
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(chatData?["title"].string.nonEmpty ?? "New chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(palette.bg, for: .navigationBar)
        .confirmationDialog("Allow Cloudflare AI?",isPresented:$confirmCloudAI,titleVisibility:.visible) {
            Button("Allow and send") { if model.allowCloudAI(true) { send() } }.accessibilityIdentifier("chat.allowAI")
            Button("Cancel",role:.cancel) {}
        } message:{ Text("Your message and recent chat history will be sent to Cloudflare's Llama 3.1 to answer. Written quiz marking also uses this service. You can turn this off in Settings.") }
    }

    private func thread() -> [CloudRecord] {
        guard let chatId else { return [] }
        return CloudMessageOrder.sorted(model.items("message").filter { model.data($0)["chatId"].string == chatId })
    }

    /// Match the durable submission to this exact user message; a failed quiz never changes a chat's state.
    private func replyStatus(_ messages: [CloudRecord]) -> (text: String, working: Bool, failed: Bool)? {
        if sending { return ("Saving your message…", true, false) }
        guard let last = messages.last, model.data(last)["role"].string == "user" else { return nil }
        if !model.cloudAIAllowed { return ("Cloud AI is paused. Your message is saved. Allow Cloudflare AI in Settings to send it.",false,false) }
        if let chatId,let run=model.chatRun(chatId:chatId,messageId:last.id),run.status == "unavailable" {
            return ((run.error?["message"].string ?? "Cloud AI is unavailable.")+" Your message is saved. Pull down to check again.",false,false)
        }
        if let chatId,let run = model.chatRun(chatId:chatId,messageId:last.id),["failed","interrupted","conflict"].contains(run.status) {
            let reason = run.error?["message"].string.nonEmpty.map { " \($0)" } ?? ""
            return ("Cloud AI couldn't finish a reply.\(reason) Your message is saved on this iPhone.", false, true)
        }
        if waitedOut {
            return ("No reply yet. Your message is saved on this iPhone. Pull down to check again.", false, false)
        }
        return ("Waiting for a reply from Llama 3.1. Your message is saved on this iPhone and sends when Centre Cloud is reachable.", true, false)
    }

    private var canSend: Bool { !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message Centre", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .accessibilityIdentifier("chat.composer")
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(palette.line))
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.semibold))
                    .frame(width: sendSize, height: sendSize)
                    .foregroundStyle(canSend ? palette.accentInk : palette.text3)
                    .background(canSend ? palette.accent : palette.surface2, in: Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("chat.send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(palette.bg)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard model.cloudAIAllowed else { confirmCloudAI=true;return }
        draft = ""
        sending = true
        waitedOut = false
        model.error = nil
        Task {
            if let id = await model.send(chatId: chatId, text: text) {
                chatId = id
            } else {
                draft = text
            }
            sending = false
        }
    }
}

@MainActor
private struct MessageRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let record: CloudRecord

    var body: some View {
        let data = model.data(record)
        let content = data["content"].string ?? ""
        let isUser = data["role"].string == "user"
        let resources = data["resourceIds"].array.compactMap { $0.string }
            .compactMap { model.record(kind: "resource", id: $0) }
            .compactMap { model.data($0)["title"].string }
        let attachmentIds = data["attachmentIds"].array.compactMap(\.string)
        let attachments=attachmentIds.count
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            if isUser {
                Text(content)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(palette.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.leading, 44)
            } else {
                Text(Markdown.inline(content))
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !resources.isEmpty {
                Text("Uses \(resources.joined(separator: ", "))").font(.footnote).foregroundStyle(palette.text3)
            }
            if let chatId=data["chatId"].string {
                ForEach(attachmentIds,id:\.self) { id in AttachmentButton(id:id,chatId:chatId) }
            }
        }
        .textSelection(.enabled)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(spokenLabel(isUser: isUser, content: content, resources: resources, attachments: attachments))
        .accessibilityIdentifier("chat.message.\(record.id)")
    }

    /// Speaks who wrote the message followed by the whole message, so VoiceOver never hides content.
    private func spokenLabel(isUser: Bool, content: String, resources: [String], attachments: Int) -> String {
        var parts = ["\(isUser ? "You" : "Centre"): \(String(Markdown.inline(content).characters))"]
        if !resources.isEmpty { parts.append("Uses \(resources.joined(separator: ", "))") }
        if attachments > 0 { parts.append(attachments == 1 ? "1 attachment" : "\(attachments) attachments") }
        return parts.joined(separator: ". ")
    }
}

@MainActor private struct AttachmentButton:View {
    @EnvironmentObject private var model:AppModel
    @Environment(\.centre) private var palette
    let id:String
    let chatId:String
    @State private var loading=false
    @State private var failure:String?
    @State private var file:AttachmentPreview?
    private var name:String { model.record(kind:"attachment",id:id)?.data?["name"].string ?? "Attachment" }
    var body:some View {
        VStack(alignment:.leading,spacing:4) {
            Button {
                loading=true;failure=nil
                Task { do { file=AttachmentPreview(file:try await model.attachment(id:id,chatId:chatId)) } catch { failure=error.localizedDescription };loading=false }
            } label:{ Label(loading ? "Downloading…":name,systemImage:"paperclip").font(.subheadline).frame(minHeight:44) }
                .buttonStyle(.borderless).disabled(loading).accessibilityIdentifier("attachment.open.\(id)")
            if let failure { Text(failure).font(.footnote).foregroundStyle(palette.warn) }
        }.sheet(item:$file) { preview in
            NavigationStack {
                AttachmentQuickLook(file:preview.file).navigationTitle(preview.file.name).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Done") { file=nil } } }
            }
        }
    }
}
private struct AttachmentPreview:Identifiable { let id=UUID();let file:AttachmentFile }
private struct AttachmentQuickLook:UIViewControllerRepresentable {
    let file:AttachmentFile
    func makeCoordinator()->Coordinator { Coordinator(file:file) }
    func makeUIViewController(context:Context)->QLPreviewController { let controller=QLPreviewController();controller.dataSource=context.coordinator;return controller }
    func updateUIViewController(_ controller:QLPreviewController,context:Context) {}
    final class Coordinator:NSObject,QLPreviewControllerDataSource {
        let file:AttachmentFile
        init(file:AttachmentFile) { self.file=file }
        func numberOfPreviewItems(in controller:QLPreviewController)->Int { 1 }
        func previewController(_ controller:QLPreviewController,previewItemAt index:Int)->QLPreviewItem { file.url as NSURL }
    }
}

// MARK: - Resources

private enum ResourceRoute: Hashable { case resource(String), newNote }

@MainActor
private struct ResourcesTab: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Binding var showSettings: Bool
    @State private var path: [ResourceRoute] = []
    @State private var query = ""

    var body: some View {
        let all = model.items("resource")
        let q = query.trimmingCharacters(in: .whitespaces)
        let shown = all.filter { q.isEmpty || (model.data($0)["title"].string ?? "").localizedCaseInsensitiveContains(q) }
            .sorted { (model.data($0)["updatedAt"].string ?? "") > (model.data($1)["updatedAt"].string ?? "") }
        let groups = Dictionary(grouping: shown) { model.data($0)["subjectId"].string ?? "" }
        let subjects = Subjects.all(model)
        let keys = subjects.map(\.id).filter { groups[$0] != nil }
            + groups.keys.filter { key in !key.isEmpty && !subjects.contains { $0.id == key } }.sorted()
            + (groups[""] != nil ? [""] : [])
        NavigationStack(path: $path) {
            List {
                ForEach(keys, id: \.self) { key in
                    Section(key.isEmpty ? "Personal" : Subjects.name(model, key) ?? "Other subject") {
                        ForEach(groups[key] ?? []) { resource in
                            NavigationLink(value: ResourceRoute.resource(resource.id)) { ResourceRow(resource: resource) }
                                .centreRow(palette)
                                .accessibilityIdentifier("resources.row.\(resource.id)")
                        }
                    }
                }
            }
            .centreList(palette)
            .searchable(text: $query, prompt: "Search resources")
            .overlay {
                if all.isEmpty {
                    ContentUnavailableView {
                        Label("No resources yet", systemImage: "books.vertical")
                    } description: {
                        Text("Quizzes, tests and notes you make in Centre appear here, and stay readable offline.")
                    } actions: {
                        Button("Write a note") { path.append(.newNote) }.buttonStyle(CentrePrimaryButtonStyle()).frame(maxWidth: 220)
                    }
                } else if shown.isEmpty {
                    ContentUnavailableView.search(text: q)
                }
            }
            .refreshable { await model.sync() }
            .navigationTitle("Resources")
            .navigationDestination(for: ResourceRoute.self) { route in
                switch route {
                case .resource(let id): ResourceDetailView(resourceId: id)
                case .newNote: NoteEditorView(resourceId: nil, inSheet: false)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { path.append(.newNote) } label: { Label("New note", systemImage: "square.and.pencil") }
                        .accessibilityIdentifier("resources.newNote")
                }
            }
            .tabChrome(showSettings: $showSettings)
        }
    }
}

private enum ResourceKind {
    static func label(_ kind: String?) -> String {
        switch kind {
        case "quiz": return "Quiz"
        case "test": return "Test"
        case "flashcards": return "Flashcards"
        case "diagram": return "Diagram"
        default: return "Notes"
        }
    }
    static func symbol(_ kind: String?) -> String {
        switch kind {
        case "quiz": return "checklist"
        case "test": return "doc.text.magnifyingglass"
        case "flashcards": return "rectangle.on.rectangle"
        case "diagram": return "point.3.connected.trianglepath.dotted"
        default: return "doc.text"
        }
    }
}

@MainActor
private struct ResourceRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let resource: CloudRecord

    var body: some View {
        let data = model.data(resource)
        let kind = data["kind"].string
        let topic = data["topicId"].string.flatMap { model.record(kind: "topic", id: $0) }.flatMap { model.data($0)["name"].string }
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: ResourceKind.symbol(kind)).foregroundStyle(palette.text2).frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(data["title"].string.nonEmpty ?? "Untitled").lineLimit(2)
                Text([ResourceKind.label(kind), topic].compactMap { $0 }.joined(separator: ", "))
                    .font(.footnote).foregroundStyle(palette.text3)
            }
            Spacer(minLength: 0)
            if data["completedAt"].string != nil {
                Image(systemName: "checkmark").font(.footnote).foregroundStyle(palette.text3).accessibilityLabel("Completed")
            }
        }
        .padding(.vertical, 2)
    }
}

@MainActor
private struct ResourceDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let resourceId: String
    @State private var editing = false

    var body: some View {
        if let resource = model.record(kind: "resource", id: resourceId) {
            let data = model.data(resource)
            switch data["kind"].string {
            case "quiz", "test":
                QuizView(resource: resource)
            case "flashcards":
                FlashcardsView(resource: resource)
            case "diagram":
                DiagramView(resource: resource)
            default:
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(data["title"].string.nonEmpty ?? "Untitled").font(CentreFont.serif(.title))
                        if let updated = When.parse(data["updatedAt"].string) {
                            Text("Edited \(updated.formatted(date: .abbreviated, time: .shortened))")
                                .font(.footnote).foregroundStyle(palette.text3)
                        }
                        Text(Markdown.inline(data["content"].string ?? ""))
                            .lineSpacing(4)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                }
                .background(palette.bg)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Edit") { editing = true }.accessibilityIdentifier("note.edit") }
                .sheet(isPresented: $editing) {
                    NavigationStack { NoteEditorView(resourceId: resourceId, inSheet: true) }
                        .environmentObject(model)
                        .environment(\.centre, palette)
                }
            }
        } else {
            ContentUnavailableView("This resource was removed", systemImage: "trash",
                                   description: Text("It was deleted on this iPhone or another device."))
                .background(palette.bg)
        }
    }
}

@MainActor
private struct NoteEditorView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Environment(\.dismiss) private var dismiss
    let resourceId: String?
    let inSheet: Bool
    @State private var title = ""
    @State private var content = ""
    @State private var subjectId: String?
    @State private var topicId: String?
    @State private var loaded = false
    @State private var saving = false
    @State private var confirmDelete = false
    @State private var failure: String?

    var body: some View {
        let topics = model.items("topic").filter { subjectId != nil && model.data($0)["subjectId"].string == subjectId }
        Form {
            Section { TextField("Title", text: $title).accessibilityIdentifier("note.title") }
            Section {
                SubjectPicker(subjects: Subjects.all(model), selection: $subjectId)
                if !topics.isEmpty {
                    Picker("Topic", selection: $topicId) {
                        Text("None").tag(String?.none)
                        ForEach(topics) { topic in
                            Text(model.data(topic)["name"].string ?? "Untitled topic").tag(Optional(topic.id))
                        }
                    }
                }
            }
            Section("Note") {
                TextEditor(text: $content)
                    .frame(minHeight: 260)
                    .accessibilityLabel("Note")
                    .accessibilityIdentifier("note.body")
            }
            if let failure { Section { Text(failure).foregroundStyle(palette.danger).accessibilityIdentifier("note.failure") } }
            if resourceId != nil {
                Section { Button("Delete note", role: .destructive) { confirmDelete = true }.accessibilityIdentifier("note.delete") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.bg)
        .navigationTitle(resourceId == nil ? "New note" : "Edit note")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if inSheet {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("note.save")
            }
        }
        .onChange(of: subjectId) { _, _ in
            if let topicId, !topics.contains(where: { $0.id == topicId }) { self.topicId = nil }
        }
        .onAppear(perform: load)
        .confirmationDialog("Delete this note?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete note", role: .destructive) { Task { await delete() } }
        } message: {
            Text("It's removed from Centre on all your devices after it syncs.")
        }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let id = resourceId, let record = model.record(kind: "resource", id: id) else { return }
        let data = model.data(record)
        title = data["title"].string ?? ""
        content = data["content"].string ?? ""
        subjectId = data["subjectId"].string
        topicId = data["topicId"].string
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let now = When.iso(Date())
        let id = resourceId ?? UUID().uuidString.lowercased()
        let base: JSONValue = model.record(kind: "resource", id: id).map { model.data($0) } ?? .object([
            "id": .string(id), "kind": .string("notes"), "createdAt": .string(now), "completedAt": .null, "deletedAt": .null,
            "questions": .array([]), "testLength": .null, "durationMinutes": .null,
            "questionTypes": .array(["multiple_choice", "short_response", "long_response"].map(JSONValue.string)),
        ])
        let patch: JSONValue = .object([
            "id": .string(id), "title": .string(title.trimmingCharacters(in: .whitespaces)), "content": .string(content),
            "subjectId": JSONValue.optional(subjectId), "topicId": JSONValue.optional(topicId), "updatedAt": .string(now),
        ])
        failure = nil
        model.error = nil
        guard await model.save(kind: "resource", id: id, data: base.merging(patch)) else {
            failure = model.error ?? "The note couldn't be saved on this iPhone."
            return
        }
        dismiss()
    }

    private func delete() async {
        guard let id = resourceId, let record = model.record(kind: "resource", id: id) else { return }
        let now = When.iso(Date())
        failure = nil
        model.error = nil
        guard await model.save(kind: "resource", id: id,
                               data: model.data(record).merging(.object(["deletedAt": .string(now), "updatedAt": .string(now)])),
                               deleted: true) else {
            failure = model.error ?? "The note couldn't be deleted."
            return
        }
        dismiss()
    }
}

@MainActor
private struct FlashcardsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let resource: CloudRecord
    @State private var revealed: Set<Int> = []

    var body: some View {
        let data = model.data(resource)
        let cards = data["questions"].array
        List {
            Section {
                Text(data["title"].string.nonEmpty ?? "Flashcards").font(CentreFont.serif(.title2))
                    .listRowBackground(Color.clear)
            }
            if cards.isEmpty, let content = data["content"].string.nonEmpty {
                Section { Text(Markdown.inline(content)) }.centreRow(palette)
            }
            ForEach(Array(cards.enumerated()), id: \.offset) { index, card in
                Section {
                    Button {
                        if revealed.contains(index) { revealed.remove(index) } else { revealed.insert(index) }
                    } label: {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(card["prompt"].string ?? "").font(CentreFont.serif(.title3))
                            if revealed.contains(index) {
                                Text(card["answer"].string ?? "").foregroundStyle(palette.text2)
                            } else {
                                Text("Show answer").font(.footnote).foregroundStyle(palette.accent)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(revealed.contains(index) ? "Hides the answer" : "Shows the answer")
                }
                .centreRow(palette)
            }
        }
        .centreList(palette)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Diagrams

/// Read-only rendering of a saved HTML/SVG diagram. Scripts are off, nothing loads from the network,
/// and the page has no bridge to the app, its storage or its credentials.
@MainActor
private struct DiagramView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Environment(\.colorScheme) private var scheme
    let resource: CloudRecord
    @State private var failure: String?
    @State private var blockedNavigations=0

    var body: some View {
        let data = model.data(resource)
        let content = data["content"].string ?? ""
        let theme = DiagramDocument.theme(model.preferences["theme"].string, scheme: scheme)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(data["title"].string.nonEmpty ?? "Diagram").font(CentreFont.serif(.title2))
                    .accessibilityAddTraits(.isHeader)
                if DiagramDocument.hasScripts(content) {
                    Text("Interactive parts of this diagram are off on iPhone. The saved drawing is shown as it is.")
                        .font(.footnote).foregroundStyle(palette.text3)
                        .accessibilityIdentifier("diagram.scriptsNote")
                }
                if let failure {
                    Label(failure, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(palette.warn)
                        .accessibilityIdentifier("diagram.failure")
                }
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-ui-testing"),blockedNavigations > 0 {
                    Text("\(blockedNavigations) navigation blocked").font(.footnote)
                        .accessibilityIdentifier("diagram.blockedNavigationCount")
                }
                #endif
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.vertical, 12)
            if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ContentUnavailableView("The diagram is empty", systemImage: ResourceKind.symbol("diagram"))
            } else {
                StaticHTMLView(html: DiagramDocument.html(content, theme: theme), failure: $failure,blockedNavigations:$blockedNavigations)
                    .accessibilityIdentifier("diagram.view")
            }
        }
        .background(palette.bg)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private enum DiagramDocument {
    /// Stricter than the desktop policy: no script-src, so inline and external scripts never run.
    static let csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"

    private static let palettes: [String: [String: String]] = [
        "dark": ["bg": "#1b1b1a", "surface": "#20201f", "surface-2": "#262625", "text": "#ecebe7", "text-2": "#a8a7a1", "line": "#3b3b38", "accent": "#ecebe7"],
        "light": ["bg": "#f9f9f7", "surface": "#ffffff", "surface-2": "#f3f3f0", "text": "#131313", "text-2": "#7b7974", "line": "#d8d8d5", "accent": "#131313"],
        "midnight": ["bg": "#101114", "surface": "#18191e", "surface-2": "#202126", "text": "#e8e9ec", "text-2": "#a1a3ac", "line": "#36383f", "accent": "#e8e9ec"],
    ]

    static func theme(_ preference: String?, scheme: ColorScheme) -> String {
        switch preference {
        case "light", "midnight": return preference ?? "dark"
        case "system": return scheme == .light ? "light" : "dark"
        default: return "dark"
        }
    }

    static func hasScripts(_ html: String) -> Bool { html.range(of: "<script", options: .caseInsensitive) != nil }

    /// Mirrors server/diagram.ts: strips saved wrappers and the desktop bridge, then rewraps with a strict policy first.
    static func html(_ content: String, theme: String) -> String {
        var body = content
        for pattern in ["<!--centre:bridge-->[\\s\\S]*?<!--/centre:bridge-->", "<script\\b[\\s\\S]*?</script\\s*>",
                        "<!doctype[^>]*>", "</?(?:html|head|body)\\b[^>]*>", "<meta\\b[^>]*>", "<base\\b[^>]*>"] {
            body = body.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        let colours = palettes[theme] ?? palettes["dark"] ?? [:]
        let variables = colours.map { "--centre-\($0.key):\($0.value)" }.joined(separator: ";")
        return """
        <!doctype html><html><head><meta charset="utf-8">\
        <meta http-equiv="Content-Security-Policy" content="\(csp)">\
        <meta name="viewport" content="width=device-width,initial-scale=1">\
        <style>:root{\(variables);--bg:var(--centre-bg);--surface:var(--centre-surface);--surface-2:var(--centre-surface-2);\
        --text:var(--centre-text);--text-2:var(--centre-text-2);--line:var(--centre-line);--accent:var(--centre-accent);\
        color-scheme:\(theme == "light" ? "light" : "dark")}\
        html,body{margin:0;background:var(--centre-bg);color:var(--centre-text);-webkit-text-size-adjust:auto}\
        body{font:-apple-system-body;padding:0 16px 24px;overflow-wrap:anywhere}\
        *,*::before,*::after{box-sizing:border-box}img,svg,canvas{max-width:100%;height:auto}</style>\
        </head><body>\(body)</body></html>
        """
    }
}

/// WKWebView locked to one in-memory document: ephemeral storage, JavaScript off, no message handlers or
/// user scripts, every request other than the document itself blocked, no navigation, windows or downloads.
@MainActor
private struct StaticHTMLView: UIViewRepresentable {
    let html: String
    @Binding var failure: String?
    @Binding var blockedNavigations:Int

    func makeCoordinator() -> Coordinator { Coordinator(failure: $failure,blockedNavigations:$blockedNavigations) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController = WKUserContentController()
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsInlineMediaPlayback = false
        configuration.dataDetectorTypes = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsLinkPreview = false
        view.allowsBackForwardNavigationGestures = false
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        context.coordinator.attach(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.failure = $failure
        context.coordinator.blockedNavigations = $blockedNavigations
        context.coordinator.show(html)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var failure: Binding<String?>
        var blockedNavigations:Binding<Int>
        private weak var view: WKWebView?
        private var rulesReady = false
        private var pending: String?
        private var shown: String?
        private var allowDocumentLoad = false

        /// Blocks every request; only the in-memory document and inline data: images and fonts are exempt.
        private static let rules = """
        [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},
         {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}}]
        """

        init(failure: Binding<String?>,blockedNavigations:Binding<Int>) { self.failure = failure;self.blockedNavigations=blockedNavigations }

        func attach(_ view: WKWebView) {
            self.view = view
            guard let store = WKContentRuleListStore.default() else {
                failure.wrappedValue = "The diagram viewer couldn't start."
                return
            }
            store.compileContentRuleList(forIdentifier: "centre.diagram.offline", encodedContentRuleList: Self.rules) { [weak self] list, _ in
                Task { @MainActor in
                    guard let self else { return }
                    guard let list, let view = self.view else {
                        self.failure.wrappedValue = "The diagram viewer couldn't start."
                        return
                    }
                    view.configuration.userContentController.add(list)
                    self.rulesReady = true
                    if let pending = self.pending { self.show(pending) }
                }
            }
        }

        func show(_ html: String) {
            guard html != shown else { return }
            guard rulesReady, let view else { pending = html; return }
            pending = nil
            shown = html
            allowDocumentLoad = true
            view.loadHTMLString(html, baseURL: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            let isDocument = navigationAction.request.url?.absoluteString == "about:blank"
                && navigationAction.targetFrame?.isMainFrame == true
                && navigationAction.navigationType == .other
            guard allowDocumentLoad, isDocument, !navigationAction.shouldPerformDownload else {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-ui-testing") { blockedNavigations.wrappedValue += 1 }
                #endif
                return .cancel
            }
            allowDocumentLoad = false
            return .allow
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            navigationResponse.canShowMIMEType && navigationResponse.isForMainFrame ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            failure.wrappedValue = "The diagram couldn't be shown."
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            failure.wrappedValue = "The diagram couldn't be shown."
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            shown = nil
            failure.wrappedValue = "The diagram viewer stopped. Go back and open it again."
        }
    }
}

// MARK: - Quiz

private struct DraftState: Equatable { var answers: [String: String]; var current: Int }

/// Marking state for one quiz, read from the durable grade job.
private enum Marking: Equatable {
    case none, submitted, failed(String)
}

@MainActor
private struct QuizView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let resource: CloudRecord
    @State private var answers: [String: String] = [:]
    @State private var current = 0
    @State private var loadedDraftId: String?
    @State private var dirty = false
    @State private var lastSaved: Date?
    @State private var confirmSubmit = false
    @State private var submitting = false
    @State private var awaitingResult = false
    @State private var shownAttempt: String?
    @State private var confirmStartOver = false
    @State private var startingOver = false

    var body: some View {
        let data = model.data(resource)
        let questions = data["questions"].array
        let attempts = attemptsForResource()
        let marking = markingState()
        let frozen = submitting || marking != .none
        Group {
            if questions.isEmpty {
                ContentUnavailableView("No questions yet", systemImage: "questionmark.circle",
                                       description: Text("This \(ResourceKind.label(data["kind"].string).lowercased()) has no questions saved."))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        header(data, questions: questions, attempts: attempts)
                        if frozen { markingNotice(marking) }
                        let index = min(current, questions.count - 1)
                        VStack(alignment: .leading, spacing: 8) {
                            ProgressView(value: Double(index + 1), total: Double(questions.count))
                                .accessibilityHidden(true)
                            Text("Question \(index + 1) of \(questions.count)")
                                .font(.footnote).foregroundStyle(palette.text3)
                                .accessibilityIdentifier("quiz.position")
                        }
                        QuestionView(question: questions[index], answer: answerBinding(questions[index]), locked: frozen)
                        HStack(spacing: 10) {
                            Button("Previous") { move(to: index - 1, frozen: frozen) }
                                .buttonStyle(CentreQuietButtonStyle())
                                .disabled(index == 0)
                                .accessibilityIdentifier("quiz.previous")
                            if index < questions.count - 1 {
                                Button("Next") { move(to: index + 1, frozen: frozen) }
                                    .buttonStyle(CentrePrimaryButtonStyle())
                                    .accessibilityIdentifier("quiz.next")
                            } else if !frozen {
                                Button("Submit") { model.error = nil; confirmSubmit = true }
                                    .buttonStyle(CentrePrimaryButtonStyle())
                                    .accessibilityIdentifier("quiz.submit")
                            }
                        }
                        if !frozen {
                            footer(questions: questions)
                            if loadedDraftId != nil || !answers.isEmpty {
                                Button("Start over", role: .destructive) { confirmStartOver = true }
                                    .buttonStyle(.borderless)
                                    .font(.footnote)
                                    .foregroundStyle(palette.danger)
                                    .disabled(startingOver)
                                    .accessibilityIdentifier("quiz.startOver")
                            }
                        }
                    }
                    .padding(20)
                }
                .refreshable { await model.sync() }
            }
        }
        .background(palette.bg)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: loadDraft)
        .onChange(of: currentDraftId()) { _, id in
            // A successful grade tombstones the draft; start fresh for the next attempt.
            if id == nil, loadedDraftId != nil, !dirty {
                answers = [:]; current = 0; lastSaved = nil; loadedDraftId = nil
            }
        }
        .onChange(of: attempts.first?.id) { _, id in
            if awaitingResult, let id { awaitingResult = false; shownAttempt = id }
        }
        .task(id: DraftState(answers: answers, current: current)) {
            guard dirty, !frozen else { return }
            guard !Task.isCancelled, dirty, markingState() == .none, !submitting else { return }
            dirty = false
            if await model.saveDraft(resource: resource, answers: answers, currentQuestion: current) {
                lastSaved = Date()
                loadedDraftId = currentDraftId()
            } else {
                dirty = true
            }
        }
        .onDisappear {
            guard dirty,!frozen else { return }
            let savedAnswers=answers,savedPosition=current
            Task { _ = await model.saveDraft(resource:resource,answers:savedAnswers,currentQuestion:savedPosition) }
        }
        // While marking runs, check for the stored result for up to two minutes.
        .task(id: marking == .submitted) {
            guard markingState() == .submitted else { return }
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { return }
                await model.sync()
                if model.quizWaiting(resourceId:resource.id) != nil { return }
            }
        }
        .confirmationDialog("Start this quiz over?", isPresented: $confirmStartOver, titleVisibility: .visible) {
            Button("Start over", role: .destructive) { Task { await startOver() } }
                .accessibilityIdentifier("quiz.startOver.confirm")
        } message: {
            Text("Your current answers are cleared so you can answer again. Marked results stay saved.")
        }
        .confirmationDialog("Submit for marking?", isPresented: $confirmSubmit, titleVisibility: .visible) {
            Button("Submit answers") { if model.cloudAIAllowed || model.allowCloudAI(true) { Task { await submit() } } }
                .accessibilityIdentifier("quiz.submit.confirm")
        } message: {
            let unanswered = questions.filter { answers[$0["id"].string ?? ""]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true }.count
            Text((unanswered > 0 ? "\(unanswered) unanswered. " : "") + "Your saved quiz and answers go to Centre Cloud for marking. Written answers use Cloudflare's Llama 3.1. Submitting allows this service; you can turn it off in Settings. Answers lock while marking and wait here if you're offline.")
        }
        .navigationDestination(item: $shownAttempt) { id in
            if let attempt = attemptsForResource().first(where: { $0.id == id }) {
                AttemptResultView(attempt: attempt, resource: resource)
            }
        }
    }

    @ViewBuilder
    private func header(_ data: JSONValue, questions: [JSONValue], attempts: [CloudRecord]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(data["title"].string.nonEmpty ?? "Untitled").font(CentreFont.serif(.title))
                .accessibilityAddTraits(.isHeader)
            let minutes = data["durationMinutes"].int
            Text(minutes.map { "\(questions.count) questions, suggested time \($0) min" } ?? "\(questions.count) questions")
                .font(.subheadline).foregroundStyle(palette.text2)
        }
        if let latest = attempts.first {
            let result = model.data(latest)["result"]
            Button { shownAttempt = latest.id } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Latest result").font(.subheadline).foregroundStyle(palette.text2)
                        Text("\(Num.text(result["score"].uiNumber ?? 0)) of \(Num.text(result["total"].uiNumber ?? 0))")
                            .font(.headline)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote).foregroundStyle(palette.text3)
                        .accessibilityHidden(true)
                }
                .padding(14)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(palette.line))
                .accessibilityElement(children: .combine)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows marks and feedback")
            .accessibilityIdentifier("quiz.latestResult")
        }
    }

    private func markingNotice(_ marking: Marking) -> some View {
        let failed: String? = { if case .failed(let reason) = marking { return reason }; return nil }()
        let waiting=model.quizWaiting(resourceId:resource.id) ?? (!model.cloudAIAllowed ? "Marking is paused. Allow Cloudflare AI in Settings to continue.":nil)
        let text = failed ?? waiting ?? (submitting ? "Submitting your answers…"
                : "Submitted. Answers are locked until Centre Cloud returns your mark. If you're offline, they wait on this iPhone.")
        let tone = failed == nil && waiting == nil ? palette.text2 : palette.warn
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if failed == nil && waiting == nil {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                }
                Text(text).frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("quiz.markingStatus")
            if waiting != nil { Button("Check marking again") { Task { await model.sync() } } }
            if failed != nil {
                Button(startingOver ? "Starting over…" : "Start over", role: .destructive) { confirmStartOver = true }
                    .buttonStyle(CentreQuietButtonStyle(role: .destructive))
                    .disabled(startingOver)
                    .accessibilityIdentifier("quiz.startOver")
            }
        }
        .font(.subheadline)
        .foregroundStyle(tone)
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(failed == nil ? palette.line : palette.warn))
    }

    private func footer(questions: [JSONValue]) -> some View {
        let answered = questions.filter { !(answers[$0["id"].string ?? ""] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count
        let saved = lastSaved.map { "Draft saved on this iPhone at \($0.formatted(date: .omitted, time: .shortened))." } ?? "Answers save on this iPhone as you go."
        return Text("\(answered) of \(questions.count) answered. \(saved)")
            .font(.footnote).foregroundStyle(palette.text3)
            .accessibilityIdentifier("quiz.draftStatus")
    }

    private func answerBinding(_ question: JSONValue) -> Binding<String> {
        let id = question["id"].string ?? ""
        return Binding(get: { answers[id] ?? "" }, set: { answers[id] = $0; dirty = true })
    }

    private func move(to index: Int, frozen: Bool) {
        current = max(0, index)
        if !frozen { dirty = true }
    }

    private func markingState() -> Marking {
        if let failure = model.quizFailure(resourceId: resource.id) { return .failed(failure) }
        return model.isQuizSubmitted(resourceId: resource.id) ? .submitted : .none
    }

    private func currentDraftId() -> String? {
        model.items("practice.draft").first { model.data($0)["resourceId"].string == resource.id }?.id
    }

    private func attemptsForResource() -> [CloudRecord] {
        (model.items("practice.attempt") + model.items("attempt"))
            .filter { model.data($0)["resourceId"].string == resource.id }
            .sorted { (model.data($0)["createdAt"].string ?? "") > (model.data($1)["createdAt"].string ?? "") }
    }

    private func loadDraft() {
        guard loadedDraftId == nil, !dirty,
              let draft = model.items("practice.draft").first(where: { model.data($0)["resourceId"].string == resource.id }) else { return }
        let data = model.data(draft)
        if case .object(let saved) = data["answers"] { answers = saved.compactMapValues { $0.string } }
        current = max(0, data["currentQuestion"].int ?? 0)
        lastSaved = When.parse(data["updatedAt"].string)
        loadedDraftId = draft.id
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        dirty = false
        model.error = nil
        guard await model.saveDraft(resource: resource, answers: answers, currentQuestion: current) else {
            dirty = true
            return
        }
        lastSaved = Date()
        loadedDraftId = currentDraftId()
        if await model.submitQuiz(resource: resource) { awaitingResult = true }
    }

    private func startOver() async {
        startingOver = true
        defer { startingOver = false }
        model.error = nil
        guard await model.startOverQuiz(resource: resource) else { return }
        answers = [:]
        current = 0
        lastSaved = nil
        loadedDraftId = nil
        dirty = false
        awaitingResult = false
    }
}

@MainActor
private struct QuestionView: View {
    @Environment(\.centre) private var palette
    let question: JSONValue
    @Binding var answer: String
    var locked = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(question["prompt"].string ?? "").font(CentreFont.serif(.title3))
                .accessibilityIdentifier("quiz.prompt")
            if let marks = question["marks"].int, marks > 1 {
                Text("\(marks) marks").font(.footnote).foregroundStyle(palette.text3)
            }
            switch question["responseType"].string {
            case "multiple_choice":
                VStack(spacing: 8) {
                    ForEach(Array(question["choices"].array.compactMap(\.string).enumerated()), id: \.offset) { index, choice in
                        let selected = answer == choice
                        Button { answer = choice } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(selected ? palette.accent : palette.text3)
                                    .accessibilityHidden(true)
                                Text(choice).multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }
                            .padding(12)
                            .frame(minHeight: 44)
                            .background(selected ? palette.accent.opacity(0.14) : palette.surface,
                                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .stroke(selected ? palette.accent : palette.line, lineWidth: selected ? 1.5 : 1))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(locked)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier("quiz.choice.\(index)")
                    }
                }
            case "long_response":
                TextEditor(text: $answer)
                    .frame(minHeight: 200)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(palette.line))
                    .disabled(locked)
                    .accessibilityLabel("Your answer")
                    .accessibilityIdentifier("quiz.answer")
            default:
                TextField("Your answer", text: $answer, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(12)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(palette.line))
                    .disabled(locked)
                    .accessibilityIdentifier("quiz.answer")
            }
            if locked {
                Text("Answers are locked while this submission is marked.")
                    .font(.footnote).foregroundStyle(palette.text3)
            }
        }
    }
}

@MainActor
private struct AttemptResultView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let attempt: CloudRecord
    let resource: CloudRecord

    var body: some View {
        let data = model.data(attempt)
        let result = data["result"]
        let feedback = result["feedback"].array
        let questions = model.data(resource)["questions"].array
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Num.text(result["score"].uiNumber ?? 0)) of \(Num.text(result["total"].uiNumber ?? 0))")
                        .font(CentreFont.serif(.largeTitle))
                    if let date = When.parse(data["createdAt"].string) {
                        Text("Graded \(date.formatted(date: .abbreviated, time: .shortened))")
                            .font(.footnote).foregroundStyle(palette.text3)
                    }
                }
                .padding(.vertical, 6)
                .accessibilityElement(children: .combine)
            }
            .centreRow(palette)
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                let id = question["id"].string ?? ""
                let item = feedback.first { $0["questionId"].string == id }
                Section("Question \(index + 1)") {
                    Text(question["prompt"].string ?? "")
                    LabeledContent("Your answer") {
                        Text(data["answers"][id].string.nonEmpty ?? "No answer").multilineTextAlignment(.trailing)
                    }
                    if let item {
                        LabeledContent("Marks", value: "\(Num.text(item["score"].uiNumber ?? 0)) of \(Num.text(item["maxScore"].uiNumber ?? 0))")
                        if let text = item["feedback"].string.nonEmpty { Text(text).foregroundStyle(palette.text2) }
                        if item["needsReview"].uiBool == true {
                            Label("Marked for review", systemImage: "arrow.uturn.backward.circle")
                                .font(.footnote).foregroundStyle(palette.warn)
                        }
                    }
                    if let answer = question["answer"].string.nonEmpty {
                        LabeledContent("Model answer") { Text(answer).multilineTextAlignment(.trailing) }
                    }
                    if let explanation = question["explanation"].string.nonEmpty {
                        Text(explanation).font(.footnote).foregroundStyle(palette.text2)
                    }
                }
                .centreRow(palette)
            }
        }
        .centreList(palette)
        .navigationTitle("Result")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Review

@MainActor
private struct ReviewTab: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Binding var showSettings: Bool
    @State private var resolving: Set<String> = []

    var body: some View {
        let memories = model.items("reviewMemory")
            .filter { model.data($0)["resolvedAt"].uiIsNull }
            .sorted { (model.data($0)["nextReviewAt"].string ?? "") < (model.data($1)["nextReviewAt"].string ?? "") }
        let needs = model.items("practice.learningNeed")
            .filter { model.data($0)["deletedAt"].uiIsNull && (model.data($0)["needScore"].int ?? 0) > 0 }
            .sorted { (model.data($0)["needScore"].int ?? 0) > (model.data($1)["needScore"].int ?? 0) }
        NavigationStack {
            List {
                if !memories.isEmpty {
                    Section {
                        ForEach(memories) { memory in
                            memoryRow(memory)
                                .centreRow(palette)
                                .swipeActions {
                                    Button("Reviewed") { Task { await resolve(memory) } }.tint(palette.accent)
                                }
                                .accessibilityIdentifier("review.item.\(memory.id)")
                        }
                    } header: { Text("To review") } footer: {
                        Text("Questions marked for review after grading. Mark one reviewed once you've gone over it.")
                    }
                }
                if !needs.isEmpty {
                    Section {
                        ForEach(needs) { need in needRow(need).centreRow(palette) }
                    } header: { Text("Concepts to practise") } footer: {
                        Text("Scores come from your graded answers, from 0 to 10. Higher means more practice needed.")
                    }
                }
            }
            .centreList(palette)
            .overlay {
                if memories.isEmpty && needs.isEmpty {
                    ContentUnavailableView("Nothing to review", systemImage: "checkmark.circle",
                                           description: Text("Questions you miss in graded quizzes and tests appear here."))
                }
            }
            .refreshable { await model.sync() }
            .navigationTitle("Review")
            .tabChrome(showSettings: $showSettings)
        }
    }

    private func memoryRow(_ memory: CloudRecord) -> some View {
        let data = model.data(memory)
        let resourceTitle = data["resourceId"].string.flatMap { model.record(kind: "resource", id: $0) }.flatMap { model.data($0)["title"].string }
        let due = When.parse(data["nextReviewAt"].string)
        return VStack(alignment: .leading, spacing: 8) {
            Text(data["question"].string ?? "").font(CentreFont.serif(.headline))
            if let note = data["note"].string.nonEmpty { Text(note).font(.subheadline).foregroundStyle(palette.text2) }
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    if let due {
                        Text(due <= Date() ? "Due now" : "Due \(due.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))")
                            .foregroundStyle(due <= Date() ? palette.warn : palette.text3)
                    }
                    if let resourceTitle { Text("From \(resourceTitle)").foregroundStyle(palette.text3) }
                }
                .font(.footnote)
                Spacer()
                Button(resolving.contains(memory.id) ? "Saving…" : "Mark reviewed") { Task { await resolve(memory) } }
                    .buttonStyle(.borderless)
                    .font(.footnote.weight(.medium))
                    .disabled(resolving.contains(memory.id))
                    .accessibilityIdentifier("review.markReviewed.\(memory.id)")
            }
        }
        .padding(.vertical, 4)
    }

    private func needRow(_ need: CloudRecord) -> some View {
        let data = model.data(need)
        let score = data["needScore"].int ?? 0
        let subject = data["subjectId"].string.flatMap { Subjects.name(model, $0) }
        let latest = data["evidence"].array.max { ($0["recordedAt"].string ?? "") < ($1["recordedAt"].string ?? "") }
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(data["conceptLabel"].string ?? "Concept").font(.headline)
                Spacer()
                Text("\(score) of 10").font(.subheadline.monospacedDigit()).foregroundStyle(palette.text2)
            }
            ProgressView(value: Double(score), total: 10).tint(score >= 6 ? palette.warn : palette.accent)
                .accessibilityHidden(true)
            if let subject { Text(subject).font(.footnote).foregroundStyle(palette.text3) }
            if let feedback = latest?["feedback"].string.nonEmpty {
                Text(feedback).font(.footnote).foregroundStyle(palette.text2).lineLimit(3)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private func resolve(_ memory: CloudRecord) async {
        resolving.insert(memory.id)
        defer { resolving.remove(memory.id) }
        let patch: JSONValue = .object(["resolvedAt": .string(When.iso(Date()))])
        model.error = nil
        _ = await model.save(kind: "reviewMemory", id: memory.id, data: model.data(memory).merging(patch))
    }
}

// MARK: - Calendar

/// One row in the week: a Centre-owned planned session (canonical `calendarEvent`) or an Organato projection.
private struct PlanItem: Identifiable {
    let id: String
    let event: JSONValue
    let centreOwned: Bool
    var title: String { event["title"].string.nonEmpty ?? "Untitled" }
    var date: String? { event["date"].string }
    var time: String? { event["time"].string }
    var minutes: Int? { event["plannedDurationMinutes"].int ?? event["durationMinutes"].int }
    var completed: Bool { event["completedAt"].string != nil }
    /// A Centre session without an Organato link has not been confirmed by Organato yet.
    var awaitingOrganato: Bool { centreOwned && event["organatoId"].string == nil }
}

@MainActor
private struct CalendarTab: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Binding var showSettings: Bool
    @State private var weekOffset = 0
    @State private var creating = false
    @State private var editing:PlanItem?
    @State private var receipt: String?
    @State private var working: Set<String> = []

    var body: some View {
        let tz = When.zone(model.preferences)
        let cal = When.calendar(tz)
        let thisWeek = cal.dateInterval(of: .weekOfYear, for: Date())?.start ?? Date()
        let start = cal.date(byAdding: .weekOfYear, value: weekOffset, to: thisWeek) ?? thisWeek
        let days = (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: start) }
        let items = planItems()
        let assignments = model.connector["assignments"].array
        let hasSnapshot: Bool = { if case .array = model.connector["events"] { return true }; return false }()
        let connection = model.connector["connection"]
        let state = connection["state"].string
        let canPlan = hasSnapshot && (state == nil || state == "connected")
        NavigationStack {
            List {
                if let notice = connectionNotice(state: state, message: connection["message"].string) {
                    Section {
                        Label(notice, systemImage: "exclamationmark.triangle")
                            .font(.subheadline).foregroundStyle(palette.warn)
                            .accessibilityIdentifier("calendar.connection")
                    }
                    .centreRow(palette)
                }
                Section {
                    HStack {
                        Button { weekOffset -= 1 } label: { Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44) }
                            .accessibilityLabel("Previous week")
                            .accessibilityIdentifier("calendar.previousWeek")
                        Spacer()
                        Text("Week of \(When.dayTitle(start, tz))").font(CentreFont.serif(.headline))
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)
                        Spacer()
                        Button { weekOffset += 1 } label: { Image(systemName: "chevron.right").frame(minWidth: 44, minHeight: 44) }
                            .accessibilityLabel("Next week")
                            .accessibilityIdentifier("calendar.nextWeek")
                    }
                    .buttonStyle(.borderless)
                    if weekOffset != 0 {
                        Button("Back to this week") { weekOffset = 0 }.buttonStyle(.borderless).font(.footnote)
                            .accessibilityIdentifier("calendar.thisWeek")
                    }
                } footer: {
                    if let fetched = When.parse(model.connector["fetchedAt"].string) {
                        Text("Organato calendar saved \(fetched.formatted(.relative(presentation: .named))).")
                    }
                }
                .centreRow(palette)
                if let receipt {
                    Section {
                        Label(receipt, systemImage: "checkmark.circle").font(.footnote).foregroundStyle(palette.text2)
                            .accessibilityIdentifier("calendar.receipt")
                    }
                    .centreRow(palette)
                }
                if model.calendarCommands.contains(where:\.pending) {
                    Section("Calendar changes") {
                        ForEach(model.calendarCommands.filter(\.pending)) { command in
                            CalendarOperationRow(command:command)
                        }
                    }.centreRow(palette)
                }
                if hasSnapshot || !items.isEmpty {
                    ForEach(days, id: \.self) { day in
                        let ymd = When.ymd(day, tz)
                        let dayItems = items.filter { $0.date == ymd }.sorted { ($0.time ?? "") < ($1.time ?? "") }
                        let deadlines = assignments.filter {
                            if let instant=When.parse($0["dueAt"].string) { return When.ymd(instant,tz) == ymd }
                            return ($0["dueDate"].string ?? "").prefix(10) == ymd
                        }
                        Section(When.dayTitle(day, tz)) {
                            if dayItems.isEmpty && deadlines.isEmpty {
                                Text("Nothing planned").foregroundStyle(palette.text3)
                            }
                            ForEach(Array(deadlines.enumerated()), id: \.offset) { _, item in deadlineRow(item) }
                            ForEach(dayItems) { item in planRow(item, tz: tz) }
                        }
                        .centreRow(palette)
                    }
                }
            }
            .centreList(palette)
            .overlay {
                if !hasSnapshot && items.isEmpty {
                    ContentUnavailableView("Calendar hasn't synced", systemImage: "calendar.badge.exclamationmark",
                                           description: Text("Your Organato subjects, deadlines and calendar appear here after Centre Cloud syncs them. Pull to refresh."))
                }
            }
            .refreshable { await model.sync() }
            .navigationTitle("Calendar")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.error = nil; creating = true } label: { Label("Plan a session", systemImage: "plus") }
                        .disabled(!canPlan)
                        .accessibilityIdentifier("calendar.new")
                }
            }
            .sheet(isPresented: $creating) {
                NewEventView { message in receipt = message }
                    .environmentObject(model)
                    .environment(\.centre, palette)
            }
            .sheet(item:$editing) { item in
                EditEventView(event:item.event).environmentObject(model).environment(\.centre,palette)
            }
            .tabChrome(showSettings: $showSettings)
        }
    }

    private func planItems() -> [PlanItem] {
        let own = model.items("calendarEvent").map { PlanItem(id: $0.id, event: model.data($0), centreOwned: true) }
        let ownIds = Set(own.map(\.id))
        let ownLinks = Set(own.compactMap { $0.event["organatoId"].string })
        let imported = model.connector["events"].array.enumerated().compactMap { index, event -> PlanItem? in
            let id = event["id"].string ?? "organato-\(index)"
            if ownIds.contains(id) { return nil }
            if let link = event["organatoId"].string, ownLinks.contains(link) { return nil }
            return PlanItem(id: id, event: event, centreOwned: false)
        }
        let pending=model.calendarCommands.filter { $0.pending && $0.path == "/v1/organato/sessions" }.compactMap { command -> PlanItem? in
            let event=command.body["data"]
            guard let id=event["id"].string,!ownIds.contains(id) else { return nil }
            return PlanItem(id:id,event:event,centreOwned:true)
        }
        return own + pending + imported
    }

    private func connectionNotice(state: String?, message: String?) -> String? {
        switch state {
        case "unconfigured": return "Organato isn't connected to Centre Cloud. Add the connection in Settings to plan sessions here."
        case "reauth": return "Organato needs a new connection key in Settings. Showing the last saved calendar."
        case "permission": return "Organato refused access. Check the connection in Settings. Showing the last saved calendar."
        case "error": return message.nonEmpty ?? "Organato couldn't be reached. Showing the last saved calendar."
        default: return nil
        }
    }

    private func planRow(_ item: PlanItem, tz: TimeZone) -> some View {
        let subject = item.event["subjectId"].string.flatMap { Subjects.name(model, $0) }
        let details = [When.wallTime(item.time, tz), item.minutes.map { "\($0) min" }, subject].compactMap { $0 }.joined(separator: ", ")
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            if item.centreOwned {
                Button { Task { await toggle(item) } } label: {
                    if working.contains(item.id) {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: item.completed ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(item.completed ? palette.accent : palette.text3)
                    }
                }
                .buttonStyle(.borderless)
                .frame(minWidth: 44, minHeight: 44)
                .disabled(working.contains(item.id))
                .accessibilityLabel(item.completed ? "Mark \(item.title) not done" : "Mark \(item.title) done")
                .accessibilityIdentifier("calendar.complete.\(item.id)")
            } else {
                Image(systemName: "calendar").foregroundStyle(palette.text3).frame(minWidth: 44).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .strikethrough(item.completed, color: palette.text3)
                    .foregroundStyle(item.completed ? palette.text3 : palette.text)
                if !details.isEmpty { Text(details).font(.footnote).foregroundStyle(palette.text3) }
                if item.awaitingOrganato {
                    Label("Waiting for Organato to confirm", systemImage: "clock")
                        .font(.footnote).foregroundStyle(palette.warn)
                }
            }
            .accessibilityElement(children: .combine)
            if item.centreOwned,model.record(kind:"calendarEvent",id:item.id) != nil {
                Button { editing=item } label:{ Image(systemName:"ellipsis").frame(minWidth:44,minHeight:44) }
                    .buttonStyle(.borderless).accessibilityLabel("Edit \(item.title)")
                    .accessibilityIdentifier("calendar.edit.\(item.id)")
            }
        }
        .accessibilityIdentifier("calendar.item.\(item.id)")
    }

    private func toggle(_ item: PlanItem) async {
        working.insert(item.id)
        defer { working.remove(item.id) }
        model.error = nil
        if await model.calendarComplete(event: item.event, completed: !item.completed) {
            receipt = model.status.nonEmpty
        }
    }

    private func deadlineRow(_ item: JSONValue) -> some View {
        let subject = item["subjectId"].string.flatMap { Subjects.name(model, $0) }
        let due=When.parse(item["dueAt"].string).map { "Due \(When.time($0,When.zone(model.preferences)))" } ?? "Due"
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: "flag").foregroundStyle(palette.warn).frame(minWidth: 44).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(item["title"].string ?? "Untitled")
                Text([due, subject, item["status"].string.nonEmpty].compactMap { $0 }.joined(separator: ", "))
                    .font(.footnote).foregroundStyle(palette.text3)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

@MainActor
private struct NewEventView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Environment(\.dismiss) private var dismiss
    let onDone: (String?) -> Void
    @State private var title = ""
    @State private var date = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
    @State private var subjectId: String?
    @State private var minutes=60
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What will you study?", text: $title)
                        .accessibilityIdentifier("event.title")
                    DatePicker("Starts", selection: $date, displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, When.zone(model.preferences))
                        .accessibilityIdentifier("event.start")
                    SubjectPicker(subjects: Subjects.all(model), selection: $subjectId)
                    Stepper("Duration: \(minutes) minutes",value:$minutes,in:5...720,step:5)
                        .accessibilityIdentifier("event.duration")
                } footer: {
                    Text("Adds a planned session to your Organato calendar. Planned time doesn't count toward your study Log.")
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(palette.danger).accessibilityIdentifier("event.failure") }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .navigationTitle("Plan a session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Adding…" : "Add") { Task { await add() } }
                        .disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("event.add")
                }
            }
        }
    }

    private func add() async {
        saving = true
        defer { saving = false }
        failure = nil
        model.error = nil
        guard await model.calendarCreate(title: title.trimmingCharacters(in: .whitespaces), date: date, subjectId: subjectId,durationMinutes:minutes) else {
            failure = model.error ?? "The session wasn't added."
            return
        }
        onDone(model.status.nonEmpty)
        dismiss()
    }
}

@MainActor private struct CalendarOperationRow:View {
    @EnvironmentObject private var model:AppModel
    @Environment(\.centre) private var palette
    let command:ConnectorCommand
    @State private var organatoId=""
    @State private var confirmNotApplied=false
    private var state:String { command.missingOnServer == true ? "missing":command.receipt?["status"].string ?? (command.sent ? "unknown":"queued") }
    var body:some View {
        VStack(alignment:.leading,spacing:10) {
            Label(label,systemImage:state == "queued" ? "clock":"exclamationmark.triangle")
                .font(.subheadline).foregroundStyle(state == "queued" ? palette.text2:palette.warn)
            if let error=command.receipt?["error"]["message"].string { Text(error).font(.footnote).foregroundStyle(palette.text2) }
            if state == "missing" {
                Text("Centre Cloud has no receipt yet. Try the original saved change again; a late request will be recognized as the same change.").font(.footnote)
                Button("Try saved change") { Task { await model.retryMissingCalendar(command) } }.disabled(model.busy)
            }
            if state == "unknown" || state == "pending" {
                Text("Check Organato before deciding. Centre will not send this change again automatically.").font(.footnote)
                TextField("Organato item ID, if it was created",text:$organatoId).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Verify it was applied") { Task { await model.reconcileCalendar(command,applied:true,organatoId:organatoId) } }
                Button("I checked; it was not applied",role:.destructive) { confirmNotApplied=true }
            }
            if state == "failed" || state == "conflict" {
                Button("Close this change") { Task { await model.acknowledgeCalendar(command) } }
            }
        }.padding(.vertical,6)
            .confirmationDialog("Close this calendar change?",isPresented:$confirmNotApplied,titleVisibility:.visible) {
                Button("Confirm it was not applied",role:.destructive) { Task { await model.reconcileCalendar(command,applied:false,organatoId:"") } }
            } message:{ Text("Confirm only after checking Organato. Closing this change does not send it again or undo anything in Organato.") }
    }
    private var label:String {
        switch state {
        case "queued":return "Planned change saved on iPhone, waiting to sync"
        case "missing":return "Calendar change needs another try"
        case "unknown","pending":return "Calendar outcome needs confirmation"
        case "conflict":return "Session changed elsewhere. Refresh before editing again."
        default:return "Calendar change could not finish"
        }
    }
}

@MainActor private struct EditEventView:View {
    @EnvironmentObject private var model:AppModel
    @Environment(\.centre) private var palette
    @Environment(\.dismiss) private var dismiss
    let event:JSONValue
    @State private var title=""
    @State private var start=Date()
    @State private var minutes=60
    @State private var archive=false
    @State private var saving=false
    var body:some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Session title",text:$title)
                    DatePicker("Starts",selection:$start,displayedComponents:[.date,.hourAndMinute])
                        .environment(\.timeZone,TimeZone(identifier:event["timeZone"].string ?? model.timeZone) ?? .current)
                    Stepper("Duration: \(minutes) minutes",value:$minutes,in:5...720,step:5)
                }.centreRow(palette)
                Section {
                    Button("Verify existing Organato link") { Task { await model.calendarLink(event:event) } }
                    Text("For sessions created on your Mac or after reconnecting Organato. This only checks the existing item; it does not create another one.").font(.footnote).foregroundStyle(palette.text2)
                    Button("Archive session",role:.destructive) { archive=true }
                }.centreRow(palette)
                if let error=model.error { Text(error).foregroundStyle(palette.danger) }
            }.scrollContentBackground(.hidden).background(palette.bg)
                .navigationTitle("Edit session").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement:.confirmationAction) {
                        Button("Save") { saving=true;Task { if await model.calendarEdit(event:event,title:title,start:start,durationMinutes:minutes) { dismiss() };saving=false } }.disabled(saving || title.trimmingCharacters(in:.whitespaces).isEmpty)
                    }
                }.onAppear { title=event["title"].string ?? "";start=(try? Clock.date(event["startAt"].string ?? "")) ?? Date();minutes=event["plannedDurationMinutes"].int ?? 60 }
                .confirmationDialog("Archive this planned session?",isPresented:$archive,titleVisibility:.visible) {
                    Button("Archive session",role:.destructive) { Task { if await model.calendarArchive(event:event) { dismiss() } } }
                } message:{ Text("This archives the planned session in Organato. Actual study in Log stays saved.") }
        }
    }
}

// MARK: - Log

@MainActor
private struct LogTab: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Binding var showSettings: Bool
    @State private var addingManual = false
    @State private var editingGoal = false
    @State private var pendingDelete: CloudRecord?

    var body: some View {
        let tz = When.zone(model.preferences)
        let sessions = model.items("studySession")
            .filter { model.data($0)["state"]["kind"].string == "completed" && model.data($0)["deletedAt"].uiIsNull }
            .sorted { Study.start(model.data($0)) ?? .distantPast > Study.start(model.data($1)) ?? .distantPast }
        let byDay = Dictionary(grouping: sessions) { When.ymd(Study.start(model.data($0)) ?? .distantPast, tz) }
        NavigationStack {
            List {
                Section { TimerPanel() }.centreRow(palette)
                Section("This week") { goalRow }.centreRow(palette)
                ForEach(byDay.keys.sorted(by: >), id: \.self) { ymd in
                    let day = When.day(ymd, tz)
                    Section(day.map { When.dayTitle($0, tz) } ?? ymd) {
                        ForEach(byDay[ymd] ?? []) { session in
                            sessionRow(session, tz: tz)
                                .swipeActions { Button("Delete", role: .destructive) { pendingDelete = session } }
                                .accessibilityIdentifier("log.session.\(session.id)")
                                .accessibilityAction(named: "Delete") { pendingDelete = session }
                        }
                    }
                    .centreRow(palette)
                }
                if sessions.isEmpty {
                    Section {
                        Text("Completed study sessions appear here. Start the timer, or add time you've already studied.")
                            .font(.subheadline).foregroundStyle(palette.text3)
                    }
                    .centreRow(palette)
                }
            }
            .centreList(palette)
            .refreshable { await model.sync() }
            .navigationTitle("Log")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { addingManual = true } label: { Label("Add study time", systemImage: "plus") }
                        .accessibilityIdentifier("log.addManual")
                }
            }
            .sheet(isPresented: $addingManual) {
                ManualSessionView().environmentObject(model).environment(\.centre, palette)
            }
            .sheet(isPresented: $editingGoal) {
                GoalEditor(initial: model.goalMinutes).environmentObject(model).environment(\.centre, palette)
            }
            .confirmationDialog("Delete this session?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                                titleVisibility: .visible, presenting: pendingDelete) { session in
                Button("Delete session", role: .destructive) { Task { await delete(session) } }
            } message: { _ in
                Text("Its time is removed from your weekly total on all your devices.")
            }
            .tabChrome(showSettings: $showSettings)
        }
    }

    private var goalRow: some View {
        let studied = Int(model.studyMinutes.rounded(.down))
        let goal = model.goalMinutes
        return VStack(alignment: .leading, spacing: 10) {
            if goal > 0 {
                HStack(alignment: .firstTextBaseline) {
                    Text(Study.minutes(studied)).font(CentreFont.serif(.title2))
                    Text("of \(Study.minutes(goal))").foregroundStyle(palette.text2)
                }
                ProgressView(value: Double(min(studied, goal)), total: Double(goal)).accessibilityHidden(true)
            } else {
                Text(Study.minutes(studied)).font(CentreFont.serif(.title2))
                Text("No goal set for this week.").font(.subheadline).foregroundStyle(palette.text2)
            }
            Button(goal > 0 ? "Change weekly goal" : "Set a weekly goal") { editingGoal = true }
                .buttonStyle(.borderless).font(.subheadline)
                .accessibilityIdentifier("goal.edit")
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }

    private func sessionRow(_ session: CloudRecord, tz: TimeZone) -> some View {
        let data = model.data(session)
        let subject = data["subjectId"].string.flatMap { Subjects.name(model, $0) }
        let start = Study.start(data), end = Study.end(data)
        let range = [start, end].compactMap { $0 }.map { When.time($0, tz) }.joined(separator: " to ")
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(data["title"].string.nonEmpty ?? "Study session")
                Spacer()
                Text(Study.duration(Study.savedSeconds(data))).font(.subheadline.monospacedDigit()).foregroundStyle(palette.text2)
            }
            Text([range.nonEmpty, subject, data["source"].string == "manual" ? "Added manually" : nil].compactMap { $0 }.joined(separator: ", "))
                .font(.footnote).foregroundStyle(palette.text3)
        }
        .accessibilityElement(children: .combine)
    }

    private func delete(_ session: CloudRecord) async {
        let now = When.iso(Date())
        let revision = (model.data(session)["revision"].int ?? 0) + 1
        let data = model.data(session).merging(.object(["deletedAt": .string(now), "updatedAt": .string(now), "revision": .number(Double(revision))]))
        model.error = nil
        _ = await model.save(kind: "studySession", id: session.id, data: data, deleted: true)
    }
}

@MainActor
private struct TimerPanel: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @State private var title = ""
    @State private var subjectId: String?
    @State private var acting = false

    var body: some View {
        if let timer = model.activeTimer {
            active(timer)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("Timer").font(CentreFont.serif(.title3))
                TextField("What are you studying?", text: $title)
                    .accessibilityIdentifier("timer.title")
                    .padding(12)
                    .background(palette.surface2, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                SubjectPicker(subjects: Subjects.all(model), selection: $subjectId)
                Button(acting ? "Starting…" : "Start timer") {
                    run("start", id: nil, title: title.trimmingCharacters(in: .whitespaces))
                }
                .buttonStyle(CentrePrimaryButtonStyle())
                .disabled(acting || title.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("timer.start")
                Text("Time counts only while Centre is open. If iOS closes it, the timer pauses at the last saved moment.")
                    .font(.footnote).foregroundStyle(palette.text3)
            }
            .padding(.vertical, 6)
        }
    }

    private func active(_ timer: CloudRecord) -> some View {
        let data = model.data(timer)
        let state = data["state"]
        let running = state["kind"].string == "running"
        let saved = Study.savedSeconds(data)
        let since = When.parse(state["since"].string)
        let confirmed = When.parse(state["confirmedAt"].string)
        let name = data["title"].string.nonEmpty ?? "Study session"
        let subject = data["subjectId"].string.flatMap { Subjects.name(model, $0) }
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(CentreFont.serif(.title3))
                if let subject { Text(subject).font(.footnote).foregroundStyle(palette.text3) }
            }
            if running, let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(Study.clock(saved + max(0, context.date.timeIntervalSince(since))))
                        .font(.system(.largeTitle, design: .rounded).monospacedDigit())
                }
                .accessibilityLabel("Elapsed \(Study.duration(saved + max(0, Date().timeIntervalSince(since))))")
                .accessibilityIdentifier("timer.clock")
            } else {
                Text(Study.clock(saved)).font(.system(.largeTitle, design: .rounded).monospacedDigit())
                    .foregroundStyle(palette.text2)
                    .accessibilityLabel("Saved \(Study.duration(saved))")
                    .accessibilityIdentifier("timer.clock")
            }
            Text(statusText(state)).font(.footnote).foregroundStyle(running ? palette.text3 : palette.warn)
                .accessibilityIdentifier("timer.status")
            if running, let confirmed, Date().timeIntervalSince(confirmed) > 50 * 60 {
                Button("I'm still studying") { run("confirm", id: timer.id, title: name, subjectId: data["subjectId"].string) }
                    .buttonStyle(CentrePrimaryButtonStyle()).disabled(acting)
                    .accessibilityIdentifier("timer.confirm")
            }
            HStack(spacing: 10) {
                if running {
                    Button("Pause") { run("pause", id: timer.id, title: name, subjectId: data["subjectId"].string) }
                        .buttonStyle(CentreQuietButtonStyle())
                        .accessibilityIdentifier("timer.pause")
                } else {
                    Button("Resume") { run("resume", id: timer.id, title: name, subjectId: data["subjectId"].string) }
                        .buttonStyle(CentrePrimaryButtonStyle())
                        .accessibilityIdentifier("timer.resume")
                }
                Button("Stop") { run("stop", id: timer.id, title: name, subjectId: data["subjectId"].string) }
                    .buttonStyle(CentreQuietButtonStyle())
                    .accessibilityIdentifier("timer.stop")
            }
            .disabled(acting)
        }
        .padding(.vertical, 6)
    }

    private func statusText(_ state: JSONValue) -> String {
        let tz = When.zone(model.preferences)
        if state["kind"].string == "running" {
            if let checkpoint = When.parse(state["checkpointAt"].string) { return "Running. Saved up to \(When.time(checkpoint, tz))." }
            return "Running."
        }
        switch state["reason"].string {
        case "idle": return "Paused after 10 minutes without activity. Time after that isn't counted."
        case "recovery": return "Paused when Centre closed. Time while it was closed isn't counted."
        case "check-in": return "Paused for the hourly check-in. Resume when you're studying again."
        case "clock": return "Paused because the device clock changed."
        default: return "Paused."
        }
    }

    private func run(_ action: String, id: String?, title: String, subjectId: String? = nil) {
        acting = true
        let subject = id == nil ? self.subjectId : subjectId
        model.error = nil
        Task {
            let done = await model.timer(action: action, id: id, title: title, subjectId: subject)
            acting = false
            if done, action == "start" { self.title = "" }
        }
    }
}

@MainActor
private struct ManualSessionView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var subjectId: String?
    @State private var start = Date().addingTimeInterval(-3600)
    @State private var end = Date()
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        let valid = end > start && end <= Date() && !title.trimmingCharacters(in: .whitespaces).isEmpty
        NavigationStack {
            Form {
                Section {
                    TextField("What did you study?", text: $title).accessibilityIdentifier("manual.title")
                    SubjectPicker(subjects: Subjects.all(model), selection: $subjectId)
                }
                Section {
                    DatePicker("Started", selection: $start, in: ...Date(), displayedComponents: [.date, .hourAndMinute])
                        .accessibilityIdentifier("manual.start")
                    DatePicker("Ended", selection: $end, in: ...Date(), displayedComponents: [.date, .hourAndMinute])
                        .accessibilityIdentifier("manual.end")
                } footer: {
                    Text(end > start ? Study.duration(end.timeIntervalSince(start)) : "The end must be after the start.")
                        .foregroundStyle(end > start ? palette.text3 : palette.danger)
                }
                .environment(\.timeZone, When.zone(model.preferences))
                if let failure { Section { Text(failure).foregroundStyle(palette.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .navigationTitle("Add study time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await add() } }.disabled(saving || !valid).accessibilityIdentifier("manual.add")
                }
            }
        }
    }

    private func add() async {
        saving = true
        defer { saving = false }
        failure = nil
        model.error = nil
        guard await model.manualSession(title: title.trimmingCharacters(in: .whitespaces), subjectId: subjectId, start: start, end: end) else {
            failure = model.error ?? "This study time couldn't be saved."
            return
        }
        dismiss()
    }
}

@MainActor
private struct GoalEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var minutes: Int
    @State private var saving = false
    @State private var failure: String?

    init(initial: Int) { _minutes = State(initialValue: initial > 0 ? initial : 300) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper(value: $minutes, in: 30...10080, step: 30) {
                        Text(Study.minutes(minutes)).font(CentreFont.serif(.title3))
                    }
                    .accessibilityIdentifier("goal.stepper")
                } footer: {
                    Text("Counts actual study time from Monday to Sunday. Planned calendar sessions don't count.")
                }
                if let failure { Section { Text(failure).foregroundStyle(palette.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .navigationTitle("Weekly goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        failure = nil
                        model.error = nil
                        Task {
                            let saved = await model.setGoal(minutes: minutes)
                            saving = false
                            if saved { dismiss() } else { failure = model.error ?? "The goal couldn't be saved." }
                        }
                    }
                    .disabled(saving)
                    .accessibilityIdentifier("goal.save")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Settings and connection

@MainActor
private struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var confirmLogout = false

    var body: some View {
        NavigationStack {
            Form {
                if let session = model.session {
                    Section("Centre Cloud") {
                        LabeledContent("Server", value: URL(string: model.baseURL)?.host ?? model.baseURL)
                        if let expires = When.parse(session.expiresAt) {
                            LabeledContent("Signed in until", value: expires.formatted(date: .abbreviated, time: .omitted))
                        }
                        Button(model.busy ? "Syncing…" : "Sync now") { model.error = nil; Task { await model.sync() } }
                            .disabled(model.busy)
                            .accessibilityIdentifier("settings.sync")
                        if let status = model.status.nonEmpty {
                            Text(status).font(.footnote).foregroundStyle(palette.text2).accessibilityIdentifier("settings.status")
                        }
                    }
                    .centreRow(palette)
                    Section {
                        LabeledContent("Waiting to sync", value: model.pendingCount == 1 ? "1 change" : "\(model.pendingCount) changes")
                            .accessibilityIdentifier("settings.pending")
                        if let error = model.error { Text(error).foregroundStyle(palette.danger) }
                        NavigationLink("Sign in again") {
                            Form { ConnectForm() }
                                .scrollContentBackground(.hidden).background(palette.bg)
                                .navigationTitle("Sign in again")
                        }
                        .accessibilityIdentifier("settings.reauth")
                    } footer: {
                        Text("Signing in again keeps changes waiting on this iPhone.")
                    }
                    .centreRow(palette)
                } else {
                    ConnectForm()
                }
                if model.session != nil {
                    Section("Connections") {
                        NavigationLink("Organato") { OrganatoConnectionView() }
                    }.centreRow(palette)
                }

                if !model.conflicts.isEmpty {
                    Section {
                        ForEach(model.conflicts, id: \.id) { conflict in ConflictRow(conflict: conflict) }
                    } header: { Text("Needs a choice") } footer: {
                        Text("These changed here and on another device. Nothing is overwritten until you choose.")
                    }
                    .centreRow(palette)
                }

                Section {
                    Toggle("Allow Cloudflare AI",isOn:Binding(get:{model.cloudAIAllowed},set:{_ = model.allowCloudAI($0)}))
                        .disabled(model.busy)
                        .accessibilityIdentifier("settings.aiConsent")
                    LabeledContent("On iPhone") {
                        Text(model.session == nil ? "Unavailable until you connect" : "Llama 3.1 in Centre Cloud")
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("On your Mac", value: "Codex")
                } header: { Text("Assistant") } footer: {
                    Text("Messages, recent chat history and written quiz answers are sent to Cloudflare when you request AI. Turning this off pauses waiting requests. Cloud AI has a daily allowance. Your Mac's Codex sign-in does not grant cloud AI access.")
                }
                .centreRow(palette)

                Section("Appearance") {
                    Picker("Theme", selection: themeBinding) {
                        Text("Dark").tag("dark")
                        Text("Midnight").tag("midnight")
                        Text("Light").tag("light")
                        Text("Match iPhone").tag("system")
                    }
                    Picker("Reading size",selection:preferenceBinding("textSize",fallback:"standard")) {
                        Text("Small").tag("small");Text("Standard").tag("standard");Text("Large").tag("large")
                    }.accessibilityIdentifier("settings.textSize")
                    Text("Your iPhone's accessibility text size is always respected.").font(.footnote).foregroundStyle(palette.text3)
                    NavigationLink("Time zone: \(When.zone(model.preferences).identifier)") {
                        TimeZoneSettings()
                    }
                }
                .centreRow(palette)
                Section("Study") {
                    Picker("Response style",selection:preferenceBinding("responseStyle",fallback:"balanced")) {
                        Text("Concise").tag("concise");Text("Balanced").tag("balanced");Text("Detailed").tag("detailed")
                    }
                    Picker("Year level",selection:Binding(get:{model.preferences["studentYearLevel"].int ?? 9},set:{savePreference("studentYearLevel",.number(Double($0)))})) {
                        ForEach(7...12,id:\.self) { Text("Year \($0)").tag($0) }
                    }
                }.centreRow(palette)

                if model.session != nil {
                    Section {
                        Button("Sign out", role: .destructive) { confirmLogout = true }
                            .accessibilityIdentifier("settings.signOut")
                    }
                    .centreRow(palette)
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("settings.done") } }
            .confirmationDialog("Sign out of Centre?", isPresented: $confirmLogout, titleVisibility: .visible) {
                if model.pendingCount > 0 {
                    Button("Sync first") { Task { await model.sync() } }
                    Button("Discard \(model.pendingCount) unsynced changes and sign out", role: .destructive) {
                        Task { await model.logout(discard: true) }
                    }
                } else {
                    Button("Sign out", role: .destructive) { Task { await model.logout(discard: false) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(model.pendingCount > 0
                     ? "\(model.pendingCount) changes on this iPhone haven't synced. Signing out deletes them and removes Centre data from this iPhone."
                     : "Centre data is removed from this iPhone. Your synced work stays in Centre Cloud.")
            }
        }
    }

    private var themeBinding: Binding<String> {
        Binding(get: { model.preferences["theme"].string ?? "dark" }, set: { value in
            let next = model.preferences.merging(.object(["theme": .string(value)]))
            Task { _ = await model.save(kind: "preferences", id: "preferences", data: next) }
        })
    }
    private func savePreference(_ key:String,_ value:JSONValue) {
        Task { _ = await model.save(kind:"preferences",id:"preferences",data:model.preferences.merging(.object([key:value]))) }
    }
    private func preferenceBinding(_ key:String,fallback:String) -> Binding<String> {
        Binding(get:{model.preferences[key].string ?? fallback},set:{savePreference(key,.string($0))})
    }
}

@MainActor private struct TimeZoneSettings:View {
    @EnvironmentObject private var model:AppModel
    @Environment(\.centre) private var palette
    @State private var query=""
    var body:some View {
        List {
            ForEach(TimeZone.knownTimeZoneIdentifiers.filter{query.isEmpty || $0.localizedCaseInsensitiveContains(query)},id:\.self) { zone in
                Button { Task { _ = await model.save(kind:"preferences",id:"preferences",data:model.preferences.merging(.object(["timeZone":.string(zone)]))) } } label: {
                    HStack { Text(zone).foregroundStyle(palette.text);Spacer();if model.timeZone == zone { Image(systemName:"checkmark").foregroundStyle(palette.text) } }
                }.centreRow(palette)
            }
        }.centreList(palette).searchable(text:$query).navigationTitle("Time zone")
    }
}

@MainActor private struct OrganatoConnectionView:View {
    @EnvironmentObject private var model:AppModel
    @Environment(\.centre) private var palette
    @State private var address=""
    @State private var key=""
    @State private var removing=false
    @State private var saving=false
    var body:some View {
        Form {
            Section {
                LabeledContent("Connection",value:model.connector["connection"]["state"].string ?? "Not configured")
                Text("Centre Cloud reads your subjects, work and calendar directly from Organato. Your Mac can stay closed.").font(.footnote).foregroundStyle(palette.text2)
                TextField("Organato HTTPS address",text:$address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("organato.address")
                SecureField("Organato API key",text:$key).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("organato.key")
                Button(saving ? "Connecting…":"Connect Organato") {
                    saving=true;Task { let accepted=await model.configureOrganato(baseURL:address.trimmingCharacters(in:.whitespacesAndNewlines),apiKey:key);key="";saving=false;if accepted { model.error=nil } }
                }.disabled(saving || address.isEmpty || key.isEmpty).accessibilityIdentifier("organato.connect")
            } footer: { Text("The key is sent only to your Centre Cloud service, which stores it encrypted. It is never saved in the iPhone cache. The service must allow your Organato address.") }
            .centreRow(palette)
            if let error=model.error { Section { Text(error).foregroundStyle(palette.danger) }.centreRow(palette) }
            Section {
                Button("Remove cloud connection",role:.destructive) { removing=true }
            }.centreRow(palette)
        }.scrollContentBackground(.hidden).background(palette.bg).navigationTitle("Organato")
            .onAppear { address=model.connector["connection"]["baseUrl"].string ?? "" }
            .onDisappear { key="" }
            .confirmationDialog("Remove Organato from Centre Cloud?",isPresented:$removing,titleVisibility:.visible) {
                Button("Remove connection",role:.destructive) { Task { await model.removeOrganato() } }
            } message:{ Text("Removes the saved cloud credential and calendar cache from this iPhone. Existing study records stay saved.") }
    }
}

@MainActor
private struct ConflictRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    let conflict: SyncConflict
    @State private var working = false

    var body: some View {
        let local = conflict.local.data ?? .null
        let name = local["title"].string ?? local["question"].string ?? local["name"].string ?? conflict.key
        VStack(alignment: .leading, spacing: 8) {
            Text(name).font(.headline)
            Text(conflict.remote.map { $0.deleted ? "Deleted on another device." : "Edited on another device \(When.relative($0.updatedAt))." }
                 ?? "The cloud copy is missing.")
                .font(.footnote).foregroundStyle(palette.text2)
            HStack(spacing: 8) {
                Button("Keep this iPhone's") { resolve(useLocal: true) }
                    .buttonStyle(CentreQuietButtonStyle())
                    .accessibilityIdentifier("conflict.keepLocal.\(conflict.id)")
                Button("Keep cloud version") { resolve(useLocal: false) }
                    .buttonStyle(CentreQuietButtonStyle())
                    .accessibilityIdentifier("conflict.keepCloud.\(conflict.id)")
            }
            .disabled(working)
        }
        .padding(.vertical, 4)
    }

    private func resolve(useLocal: Bool) {
        working = true
        Task { await model.resolve(conflict: conflict, useLocal: useLocal); working = false }
    }
}

/// Pairing with a one-time code, or Google sign-in. Used before first sign-in and to re-authenticate
/// without discarding pending changes.
@MainActor
private struct ConnectForm: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    @State private var url = ""
    @State private var code = ""
    @State private var working = false

    var body: some View {
        Group {
            Section {
                TextField("https://", text: $url)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Centre Cloud address")
                    .accessibilityIdentifier("connect.url")
                TextField("One-time code", text: $code)
                    .textContentType(.oneTimeCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("connect.code")
                Button(working ? "Connecting…" : "Connect") {
                    run { await model.pair(baseURL: url.trimmingCharacters(in: .whitespaces), code: code.trimmingCharacters(in: .whitespaces)) }
                }
                .disabled(working || url.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("connect.pair")
            } header: { Text("Pair with a code") } footer: {
                Text("Enter your Centre Cloud address and a one-time code from a device that's already signed in. Codes expire after 5 minutes.")
            }
            .centreRow(palette)
            Section {
                Button { run { await model.googleSignIn() } } label: {
                    Label("Continue with Google", systemImage: "person.crop.circle")
                }
                .disabled(working)
                .accessibilityIdentifier("connect.google")
            } footer: {
                Text("Use the Google account linked to your Centre workspace.")
            }
            .centreRow(palette)
            if let error = model.error {
                Section { Text(error).foregroundStyle(palette.danger) }.centreRow(palette)
            }
        }
        .onAppear { if url.isEmpty { url = model.baseURL } }
    }

    private func run(_ action: @escaping @MainActor () async -> Void) {
        working = true
        model.error = nil
        Task { await action(); working = false }
    }
}

@MainActor
private struct ConnectScreen: View {
    @Environment(\.centre) private var palette

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Centre").font(CentreFont.serif(.largeTitle))
                    Text("Read saved resources, practise quizzes and keep your study Log, even offline.")
                        .foregroundStyle(palette.text2)
                }
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
            }
            ConnectForm()
        }
        .scrollContentBackground(.hidden)
        .background(palette.bg)
        .navigationTitle("Connect")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Shared pieces

private struct Subject: Identifiable, Hashable { let id: String; let name: String }

private enum Subjects {
    @MainActor static func all(_ model: AppModel) -> [Subject] {
        model.connector["subjects"].array.compactMap { item in
            guard let id = item["id"].string else { return nil }
            return Subject(id: id, name: item["name"].string.nonEmpty ?? item["shortName"].string.nonEmpty ?? "Untitled subject")
        }
    }
    @MainActor static func name(_ model: AppModel, _ id: String) -> String? {
        all(model).first { $0.id == id }?.name
    }
}

private struct SubjectPicker: View {
    let subjects: [Subject]
    @Binding var selection: String?

    var body: some View {
        Picker("Subject", selection: $selection) {
            Text("None").tag(String?.none)
            ForEach(subjects) { subject in Text(subject.name).tag(Optional(subject.id)) }
        }
    }
}

private enum Markdown {
    static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

private enum Num {
    static func text(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }
}

/// Study-log v1 helpers. Durations come only from stored UTC segments.
private enum Study {
    static func segments(_ data: JSONValue) -> [(Date, Date)] {
        data["segments"].array.compactMap { item in
            guard let a = When.parse(item["start"].string), let b = When.parse(item["end"].string), b > a else { return nil }
            return (a, b)
        }
    }
    static func savedSeconds(_ data: JSONValue) -> Double {
        segments(data).reduce(0) { $0 + $1.1.timeIntervalSince($1.0) }
    }
    static func start(_ data: JSONValue) -> Date? { segments(data).first?.0 }
    static func end(_ data: JSONValue) -> Date? { segments(data).last?.1 }
    static func clock(_ seconds: Double) -> String {
        Duration.seconds(Int(seconds)).formatted(.time(pattern: .hourMinuteSecond))
    }
    static func duration(_ seconds: Double) -> String {
        Duration.seconds(Int(seconds / 60) * 60).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated))
    }
    static func minutes(_ minutes: Int) -> String { duration(Double(minutes * 60)) }
}

/// Dates are stored as UTC ISO instants; calendar days are YYYY-MM-DD in the preferences time zone.
private enum When {
    // Views read these on the main actor only; options are never mutated after creation.
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let whole = ISO8601DateFormatter()

    static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return fractional.date(from: text) ?? whole.date(from: text)
    }
    static func iso(_ date: Date) -> String { fractional.string(from: date) }
    static func zone(_ preferences: JSONValue) -> TimeZone {
        preferences["timeZone"].string.flatMap(TimeZone.init(identifier:)) ?? .current
    }
    static func calendar(_ tz: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tz
        calendar.firstWeekday = 2
        return calendar
    }
    private static func dayFormatter(_ tz: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = tz
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }
    static func ymd(_ date: Date, _ tz: TimeZone) -> String { dayFormatter(tz).string(from: date) }
    static func day(_ ymd: String, _ tz: TimeZone) -> Date? { dayFormatter(tz).date(from: ymd) }
    static func dayTitle(_ date: Date, _ tz: TimeZone) -> String {
        var style = Date.FormatStyle().weekday(.wide).day().month(.abbreviated)
        style.timeZone = tz
        return date.formatted(style)
    }
    static func time(_ date: Date, _ tz: TimeZone) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = tz
        return date.formatted(style)
    }
    /// Formats a stored "HH:mm" wall time; nil means an all-day item.
    static func wallTime(_ hhmm: String?, _ tz: TimeZone) -> String {
        guard let hhmm else { return "All day" }
        let parts = hhmm.split(separator: ":").prefix(2).compactMap { Int($0) }
        guard parts.count == 2, let date = calendar(tz).date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()) else { return hhmm }
        return time(date, tz)
    }
    static func relative(_ iso: String) -> String {
        parse(iso).map { $0.formatted(.relative(presentation: .named)) } ?? "recently"
    }
}

private extension JSONValue {
    var uiNumber: Double? { if case .number(let value) = self { return value }; return nil }
    var uiBool: Bool? { if case .bool(let value) = self { return value }; return nil }
    var uiIsNull: Bool { if case .null = self { return true }; return false }
    static func optional(_ text: String?) -> JSONValue { text.map(JSONValue.string) ?? .null }
}

private extension Optional where Wrapped == String {
    /// nil for missing or blank strings.
    var nonEmpty: String? {
        guard let self, !self.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return self
    }
}

private extension String {
    var nonEmpty: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
