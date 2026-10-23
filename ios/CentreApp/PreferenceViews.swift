import SwiftUI
import CentreCore

@MainActor
struct ReadingSettings: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    var body: some View {
        Form {
            PreferenceSaveStatus()
            Section("Reading") {
                choice("Reading font", "readingFont", [("Default", "default"), ("Sans serif", "sans"), ("Serif", "serif")])
                choice("Line spacing", "lineSpacing", [("Standard", "standard"), ("Relaxed", "relaxed")])
                Text("A little practice every day makes a difficult topic easier to understand.")
                    .modifier(ReadingStyle(preferences: model.preferences))
                    .accessibilityIdentifier("settings.readingSample")
            }.centreRow(palette)
            Section("Accessibility") {
                choice("Contrast", "contrast", [("Standard", "standard"), ("More", "more")])
                choice("Motion", "reducedMotion", [("Match iPhone", "system"), ("Reduce", "reduce")])
                Text("iPhone accessibility text sizes, increased contrast and reduced motion are always respected.")
                    .font(.footnote).foregroundStyle(palette.text2)
            }.centreRow(palette)
            Section {
                choice("Reading width", "readingWidth", [("Standard", "standard"), ("Narrow", "narrow"), ("Wide", "wide")])
                choice("Response activity", "activityVisibility", [("Collapsed", "collapsed"), ("Expanded", "expanded")])
                choice("Greeting", "greetingStyle", [("Rotating", "rotating"), ("Simple", "simple")])
                choice("Spacing", "density", [("Compact", "compact"), ("Comfortable", "comfortable")])
            } header: { Text("On your Mac") } footer: {
                Text("These choices sync to your Mac. iPhone uses the available screen width and native control spacing. It has no home greeting or response activity disclosure yet.")
            }.centreRow(palette)
        }
        .disabled(model.session == nil)
        .centreList(palette).navigationTitle("Reading and accessibility")
    }
    private func choice(_ title: String, _ key: String, _ options: [(String, String)]) -> some View {
        PreferenceChoice(title: title, key: key, options: options)
    }
}

@MainActor
struct PreferenceChoice: View {
    @EnvironmentObject private var model: AppModel
    let title: String
    let key: String
    let options: [(String, String)]
    var body: some View {
        Picker(title, selection: Binding(get: {
            model.preferences[key].string ?? StudyPreferences.defaults[key].string ?? ""
        }, set: { value in Task { await model.savePreferences(.object([key: .string(value)])) } })) {
            ForEach(options, id: \.1) { option in Text(option.0).tag(option.1) }
        }.accessibilityIdentifier("settings.\(key)")
    }
}

@MainActor
struct StudyDefaultSettings: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    var body: some View {
        Form {
            PreferenceSaveStatus()
            Section {
                PreferenceChoice(title: "Difficulty", key: "defaultDifficulty", options: [("Gentle", "gentle"), ("Standard", "standard"), ("Challenging", "challenging")])
            } footer: { Text("Defaults sync to your Mac for new resources. Resource creation is not available on iPhone yet. Saved quizzes, tests and flashcards stay unchanged.") }.centreRow(palette)
            Section("Quizzes") {
                number("Questions", "defaultQuizQuestions", 1...30)
                responseTypes("defaultQuizQuestionTypes")
            }.centreRow(palette)
            Section("Tests") {
                PreferenceChoice(title: "Length", key: "defaultTestLengthMode", options: [("Time", "time"), ("Questions", "questions")])
                number("Minutes", "defaultTestMinutes", 5...180)
                number("Questions", "defaultTestQuestions", 1...30)
                responseTypes("defaultTestQuestionTypes")
            }.centreRow(palette)
            Section("Flashcards") {
                PreferenceChoice(title: "Count", key: "defaultFlashcardCountMode", options: [("Automatic", "auto"), ("Choose count", "fixed")])
                number("Cards when choosing a count", "defaultFlashcardCount", 1...30)
            }.centreRow(palette)
        }
        .disabled(model.session == nil)
        .centreList(palette).navigationTitle("Resource defaults")
    }
    private func number(_ title: String, _ key: String, _ range: ClosedRange<Int>) -> some View {
        Picker(title, selection: Binding(get: { model.preferences[key].int ?? StudyPreferences.defaults[key].int ?? range.lowerBound }, set: { value in
            Task { await model.savePreferences(.object([key: .number(Double(value))])) }
        })) {
            ForEach(range, id: \.self) { Text("\($0)").tag($0) }
        }.accessibilityIdentifier("settings.\(key)")
    }
    private func responseTypes(_ key: String) -> some View {
        ForEach(Array(zip(StudyPreferences.responseTypes, ["Multiple choice", "Short response", "Long response"])), id: \.0) { type, title in
            Toggle(title, isOn: Binding(get: { model.preferences[key].array.contains(.string(type)) }, set: { enabled in
                Task { await model.setResponseType(key: key, type: type, enabled: enabled) }
            }))
            .disabled(model.preferences[key].array == [.string(type)])
            .accessibilityIdentifier("settings.\(key).\(type)")
        }
    }
}

@MainActor
struct NicknameSetting: View {
    @EnvironmentObject private var model: AppModel
    @State private var draft = ""
    @State private var saving = false
    var body: some View {
        VStack(alignment: .leading) {
            TextField("Nickname", text: $draft).textContentType(.nickname)
                .accessibilityIdentifier("settings.nickname")
            if draft != (model.preferences["nickname"].string ?? "") {
                Button(saving ? "Saving…" : "Save nickname") {
                    saving = true
                    Task {
                        if await model.savePreferences(.object(["nickname": .string(draft)])) {
                            draft = model.preferences["nickname"].string ?? ""
                        }
                        saving = false
                    }
                }.disabled(saving).accessibilityIdentifier("settings.nicknameSave")
            }
        }.onAppear { draft = model.preferences["nickname"].string ?? "" }
    }
}

@MainActor
struct PreferenceSaveStatus: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.centre) private var palette
    var body: some View {
        if let error = model.error {
            Section {
                Text(error).foregroundStyle(palette.danger)
                Button("Dismiss problem") { model.error = nil }
            }.centreRow(palette)
        }
        if !model.status.isEmpty {
            Section { Text(model.status).font(.footnote).foregroundStyle(palette.text2) }.centreRow(palette)
        }
    }
}
