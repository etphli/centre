import SwiftUI
import CentreCore

@main struct CentreApp: App {
    @StateObject private var model=AppModel()
    @Environment(\.scenePhase) private var phase
    var body:some Scene {
        WindowGroup {
            CentreRootView().environmentObject(model)
                .onOpenURL { model.receive($0) }
                .simultaneousGesture(DragGesture(minimumDistance:0).onEnded { _ in model.touch() })
                .task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for:.seconds(15))
                        if phase == .active { await model.heartbeat() }
                    }
                }
                .sheet(item:$model.pairingInvitation) { invitation in
                    NavigationStack {
                        VStack(alignment:.leading,spacing:24) {
                            Text("Connect your Centre account").font(.title2)
                            Text("This one-time code grants access to the account that created it. Connect only if you requested this code.")
                            Text(invitation.baseURL.absoluteString).font(.callout).textSelection(.enabled)
                            Button("Connect account") { Task { await model.pair(baseURL:invitation.baseURL.absoluteString,code:invitation.code) } }.buttonStyle(.borderedProminent).disabled(model.busy)
                            if let error=model.error { Text(error).foregroundStyle(.red).accessibilityLabel("Connection error: \(error)") }
                            Spacer()
                        }.padding().navigationTitle("Account pairing").navigationBarTitleDisplayMode(.inline)
                            .toolbar { ToolbarItem(placement:.cancellationAction) { Button("Cancel") { model.pairingInvitation=nil } } }
                    }.presentationDetents([.medium,.large])
                }
                .onChange(of:phase) { _,newValue in
                    Task {
                        if newValue == .active { await model.sync() }
                        else { await model.background() }
                    }
                }
        }
    }
}
