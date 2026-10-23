import XCTest

final class CentreUITests: XCTestCase {
    private var app: XCUIApplication!
    private let quizId = "55dcb531-b6a9-497e-aa7b-955767275ec9"

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-reset-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 15))
        let frame = app.windows.firstMatch.frame
        XCTAssertGreaterThanOrEqual(frame.width, 375, "iPhone app entered legacy compatibility layout. Check generated UILaunchScreen metadata.")
        XCTAssertGreaterThanOrEqual(frame.height, 667, "iPhone app entered legacy compatibility layout. Check generated UILaunchScreen metadata.")
    }
    override func tearDown() { capture("final-\(name)") }
    private func capture(_ name: String) {
        let evidence = XCTAttachment(screenshot: app.screenshot())
        evidence.name = name; evidence.lifetime = .keepAlways; add(evidence)
    }
    private func tab(_ name: String) {
        let button = app.tabBars.buttons[name]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        let selected = expectation(for: NSPredicate(format: "selected == true"), evaluatedWith: button)
        wait(for: [selected], timeout: 10)
    }
    private func scrollContainer() -> XCUIElement {
        if app.collectionViews.firstMatch.exists { return app.collectionViews.firstMatch }
        if app.tables.firstMatch.exists { return app.tables.firstMatch }
        if app.scrollViews.firstMatch.exists { return app.scrollViews.firstMatch }
        return app
    }
    private func reveal(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<7 {
            if element.exists && element.isHittable { return }
            scrollContainer().swipeUp()
        }
        XCTAssertTrue(element.exists && element.isHittable, "Element must be reachable by scrolling: \(element)", file: file, line: line)
    }
    private func tap(_ id: String) {
        let button = app.buttons[id]
        if !button.waitForExistence(timeout: 5) || !button.isHittable { reveal(button) }
        XCTAssertTrue(button.isEnabled, "Disabled button \(id)")
        button.tap()
    }
    private func waitText(_ text: String) {
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.waitForExistence(timeout: 10), text)
    }
    private func waitLabel(_ element: XCUIElement, _ label: String) {
        let changed = expectation(for: NSPredicate(format: "label == %@", label), evaluatedWith: element)
        wait(for: [changed], timeout: 5)
    }
    private func restart() {
        app.terminate(); app.launchArguments = ["-ui-testing"]; app.launch()
        XCTAssertTrue(app.tabBars.buttons["Resources"].waitForExistence(timeout: 15))
    }
    private func openQuiz() {
        tab("Resources")
        let row = app.buttons["resources.row.\(quizId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        XCTAssertTrue(app.staticTexts["quiz.prompt"].waitForExistence(timeout: 5))
    }
    private func launchPracticeHistoryFixture() {
        app.terminate()
        app.launchArguments = ["-ui-testing", "-reset-fixture", "-ui-testing-attempt-history"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 15))
    }
    private func choosePickerOption(_ pickerId: String, containing optionText: String, fromBottom: Bool = false) {
        let picker = app.descendants(matching: .any).matching(identifier: pickerId).firstMatch
        if fromBottom {
            for _ in 0..<10 {
                if picker.exists && picker.isHittable { break }
                scrollContainer().swipeDown()
            }
        }
        reveal(picker)
        XCTAssertTrue(picker.isHittable, "Attempt picker must be reachable: \(pickerId)")
        picker.tap()
        let predicate = optionText.hasPrefix("Attempt ")
            ? NSPredicate(format: "label BEGINSWITH %@", optionText)
            : NSPredicate(format: "label == %@", optionText)
        let option = app.buttons.matching(predicate).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5), "Missing attempt option: \(optionText)")
        option.tap()
    }

    func testOfflineNoteBodySurvivesRestart() {
        capture("01-chat-dark-offline")
        tab("Resources"); tap("resources.newNote")
        let title = app.textFields["note.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5)); title.tap(); title.typeText("Offline cell summary")
        let body = app.textViews["note.body"]
        reveal(body); body.tap(); body.typeText("Mitochondria supply ATP for cell activity.")
        tap("note.save")
        XCTAssertTrue(app.staticTexts["Offline cell summary"].waitForExistence(timeout: 10))
        restart(); tab("Resources")
        let saved = app.staticTexts["Offline cell summary"]
        XCTAssertTrue(saved.waitForExistence(timeout: 5)); saved.tap()
        waitText("Mitochondria supply ATP for cell activity.")
        XCTAssertTrue(app.buttons["note.edit"].exists)
        capture("02-note-body-restored-from-disk")
    }

    func testOfflineQuizAnswerSurvivesRestartWithoutInventedGrade() {
        openQuiz(); tap("quiz.choice.0")
        let draft = app.staticTexts["quiz.draftStatus"]
        reveal(draft)
        let saved = expectation(for: NSPredicate(format: "label CONTAINS %@", "Draft saved"), evaluatedWith: draft)
        wait(for: [saved], timeout: 10)
        capture("03-offline-quiz-draft")
        restart(); openQuiz()
        let restored = app.buttons["quiz.choice.0"]
        reveal(restored)
        XCTAssertTrue(restored.isSelected, "Answer selection must restore from the persisted draft")
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "quiz.latestResult").firstMatch.exists, "A saved draft is not a grade")
        capture("04-quiz-answer-restored")
    }

    func testQuizAnswerSavesWhenLeavingImmediatelyWithNativeBack() {
        openQuiz()
        let choice = app.buttons["quiz.choice.0"]
        reveal(choice); choice.tap()
        // Leave immediately, without waiting for the draft-saved footer or an explicit save action.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let row = app.buttons["resources.row.\(quizId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        let restored = app.buttons["quiz.choice.0"]
        reveal(restored)
        XCTAssertTrue(restored.isSelected, "Native Back must flush the latest answer before the quiz view disappears")
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "quiz.latestResult").firstMatch.exists, "Saving on Back must not invent a grade")
        capture("14-quiz-answer-after-immediate-native-back")
    }

    func testTimerRecoversPausedAndCompletedLogAndGoalPersist() {
        tab("Log")
        let duration = app.staticTexts["timer.duration.value"]
        XCTAssertTrue(duration.waitForExistence(timeout: 5))
        XCTAssertEqual(duration.label, "30 minutes")
        tap("timer.duration.increase")
        XCTAssertEqual(duration.label, "35 minutes")
        tap("timer.duration.decrease")
        XCTAssertEqual(duration.label, "30 minutes")
        let title = app.textFields["timer.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5)); title.tap(); title.typeText("Cell biology reading\n")
        tap("timer.start")
        XCTAssertTrue(app.buttons["timer.pause"].waitForExistence(timeout: 5))
        let countdown = app.descendants(matching: .any).matching(identifier: "timer.clock").firstMatch
        XCTAssertTrue(countdown.waitForExistence(timeout: 5))
        XCTAssertTrue(countdown.label.contains("remaining"), "A target timer must read down instead of up")
        restart(); tab("Log")
        XCTAssertTrue(app.buttons["timer.resume"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["timer.pause"].exists)
        waitText("Time while it was closed isn't counted.")
        waitText("Cell biology reading")
        capture("05-timer-recovered-paused")
        tap("timer.stop")
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 5))
        tap("goal.edit"); tap("goal.save")
        let goal = app.buttons["goal.edit"]
        reveal(goal); XCTAssertEqual(goal.label, "Change weekly goal")
        restart(); tab("Log")
        reveal(app.buttons["goal.edit"])
        XCTAssertEqual(app.buttons["goal.edit"].label, "Change weekly goal")
        let completed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "log.session.", "Cell biology reading")).firstMatch
        reveal(completed)
        capture("06-completed-log-and-goal-restored")
    }

    func testTimerStartsWithoutMetadataUsingDefaultTitleAndDuration() {
        tab("Log")
        XCTAssertEqual(app.staticTexts["timer.duration.value"].label, "30 minutes")
        tap("timer.start")
        XCTAssertTrue(app.buttons["timer.pause"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Study session"].waitForExistence(timeout: 5))
        let countdown = app.descendants(matching: .any).matching(identifier: "timer.clock").firstMatch
        XCTAssertTrue(countdown.waitForExistence(timeout: 5))
        XCTAssertTrue(countdown.label.contains("remaining"))
        capture("23-default-countdown-without-study-metadata")
    }

    func testReviewCalendarAndSettingsReportOfflineState() {
        tab("Review")
        let review = app.descendants(matching: .any).matching(identifier: "review.item.28a04f7b-70e9-44f2-925a-5c7559791aa4").firstMatch
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        capture("07-review-saved-memory")
        tab("Calendar")
        XCTAssertTrue(app.buttons["calendar.nextWeek"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "calendar.offline").firstMatch.exists)
        tap("calendar.nextWeek"); tap("calendar.previousWeek")
        capture("08-offline-calendar")
        tap("settings.open")
        let pending = app.descendants(matching: .any).matching(identifier: "settings.pending").firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 5))
        let waiting = pending.label + " " + String(describing: pending.value ?? "")
        XCTAssertTrue(waiting.range(of: "[1-9][0-9]* changes?", options: .regularExpression) != nil, "Offline pending edits must remain visible")
        waitText("All changes stay on this simulator.")
        let provider = app.descendants(matching: .any).matching(identifier: "settings.aiProvider").firstMatch
        reveal(provider)
        XCTAssertTrue((provider.label + " " + String(describing: provider.value ?? "")).contains("Llama 3.1"))
        XCTAssertTrue(app.switches["settings.aiConsent"].exists)
        capture("09-settings-pending-and-provider")
        tap("settings.done")
        XCTAssertTrue(app.buttons["settings.open"].waitForExistence(timeout: 5))
    }

    func testLargeTextLogControlsRemainReachable() {
        app.terminate()
        app.launchArguments = ["-ui-testing", "-reset-fixture", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch(); tab("Log")
        let title = app.textFields["timer.title"]
        reveal(title); title.tap(); title.typeText("Large text revision\n")
        tap("timer.start")
        reveal(app.buttons["timer.pause"])
        XCTAssertGreaterThanOrEqual(app.buttons["timer.pause"].frame.width, 250, "Accessibility actions must stack instead of breaking words into narrow columns")
        capture("10-accessibility-large-log")
        tap("settings.open")
        XCTAssertTrue(app.buttons["settings.done"].waitForExistence(timeout: 5))
        let pending = app.descendants(matching: .any).matching(identifier: "settings.pending").firstMatch
        reveal(pending)
        capture("11-accessibility-large-settings")
    }

    func testReadingSettingsPersistAndStandardResets() {
        tap("settings.open")
        let size = app.descendants(matching: .any).matching(identifier: "settings.textSize").firstMatch
        reveal(size); size.tap()
        XCTAssertTrue(app.buttons["Extra large"].waitForExistence(timeout: 5)); app.buttons["Extra large"].tap()
        let larger = expectation(for: NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", "Extra large", "Extra large"), evaluatedWith: size)
        wait(for: [larger], timeout: 5)
        capture("settings-extra-large")
        size.tap(); app.buttons["Standard"].tap()
        let standard = expectation(for: NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", "Standard", "Standard"), evaluatedWith: size)
        wait(for: [standard], timeout: 5)
        let reading = app.buttons["Reading and accessibility"]
        reveal(reading); reading.tap()
        let sample = app.staticTexts["settings.readingSample"]
        XCTAssertTrue(sample.waitForExistence(timeout: 5))
        let spacing = app.descendants(matching: .any).matching(identifier: "settings.lineSpacing").firstMatch
        spacing.tap(); app.buttons["Relaxed"].tap()
        capture("settings-reading-relaxed-preview")
        restart(); tap("settings.open")
        let restored = app.descendants(matching: .any).matching(identifier: "settings.textSize").firstMatch
        reveal(restored)
        XCTAssertTrue((restored.label + " " + String(describing: restored.value ?? "")).contains("Standard"))
    }

    func testReviewResolutionAndLightThemeSurviveRestart() {
        tab("Review")
        let mark = app.buttons["review.markReviewed.28a04f7b-70e9-44f2-925a-5c7559791aa4"]
        XCTAssertTrue(mark.waitForExistence(timeout:5))
        XCTAssertGreaterThanOrEqual(mark.frame.height,44)
        tap("review.markReviewed.28a04f7b-70e9-44f2-925a-5c7559791aa4")
        waitText("Nothing to review")
        restart(); tab("Review")
        waitText("Nothing to review")
        capture("17-offline-review-resolution-restored")
        tap("settings.open")
        let theme = app.descendants(matching: .any).matching(identifier: "settings.theme").firstMatch
        reveal(theme); theme.tap()
        let light = app.buttons["Light"]
        XCTAssertTrue(light.waitForExistence(timeout: 5)); light.tap()
        let changed = expectation(for: NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", "Light", "Light"), evaluatedWith: theme)
        wait(for: [changed], timeout: 5)
        capture("18-light-settings")
        tap("settings.done")
        restart(); tab("Log")
        XCTAssertTrue(app.textFields["timer.title"].waitForExistence(timeout: 5))
        capture("19-light-log-after-restart")
        tap("settings.open")
        let restored = app.descendants(matching: .any).matching(identifier: "settings.theme").firstMatch
        reveal(restored)
        XCTAssertTrue((restored.label + " " + String(describing: restored.value ?? "")).contains("Light"))
    }

    func testTimerConflictChoicePreservesLocalLeaseAndRecoversCloudLease() {
        app.terminate()
        app.launchArguments=["-ui-testing","-reset-fixture","-ui-testing-timer-conflict"]
        app.launch();tab("Log")
        XCTAssertTrue(app.buttons["timer.pause"].waitForExistence(timeout:5))
        tap("settings.open")
        tap("conflict.keepLocal.studySession/f3bfad1e-27c4-4c5c-b4cd-431fe759e43b")
        tap("settings.done");tab("Log")
        XCTAssertTrue(app.buttons["timer.pause"].waitForExistence(timeout:5),"Keep iPhone must preserve its running timer")
        capture("20-keep-local-timer-still-running")
        restart();tab("Log")
        XCTAssertTrue(app.buttons["timer.resume"].waitForExistence(timeout:5),"Normal restart must still pause at checkpoint")
        capture("21-local-timer-paused-on-restart")
        app.terminate()
        app.launchArguments=["-ui-testing","-reset-fixture","-ui-testing-timer-conflict","-ui-testing-cloud-running"]
        app.launch();tab("Log")
        XCTAssertTrue(app.buttons["timer.pause"].waitForExistence(timeout:5))
        tap("settings.open")
        tap("conflict.keepCloud.studySession/f3bfad1e-27c4-4c5c-b4cd-431fe759e43b")
        tap("settings.done");tab("Log")
        XCTAssertTrue(app.buttons["timer.resume"].waitForExistence(timeout:5),"Cloud choice must recover the imported running timer")
        XCTAssertFalse(app.buttons["timer.pause"].exists)
        capture("22-keep-cloud-timer-imported-paused")
    }

    func testUnconfiguredAccountRequiresConnectionAndRejectsCredentialURL() {
        app.terminate(); app.launchArguments = ["-ui-testing-unconfigured"]; app.launch()
        let address = app.textFields["connect.url"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        XCTAssertFalse(app.tabBars.buttons["Chat"].exists)
        XCTAssertFalse(app.buttons["connect.pair"].isEnabled)
        XCTAssertTrue(app.buttons["connect.google"].exists)
        address.tap(); address.typeText("https://user:password@cloud.invalid")
        let code = app.textFields["connect.code"]
        code.tap(); code.typeText(String(repeating: "x", count: 43) + "\n")
        tap("connect.pair")
        let error = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "without a path or credentials")).firstMatch
        reveal(error)
        XCTAssertFalse(app.tabBars.buttons["Chat"].exists, "Invalid address must not fabricate a connected account")
        capture("12-unconfigured-account-rejects-credential-url")
    }


    func testOfflineChatConsentAndMessageSurviveRestart() {
        tab("Chat");tap("chat.row.07cc79cc-af72-4768-b211-94b365c50a64")
        let composer=app.textViews["chat.composer"].exists ? app.textViews["chat.composer"]:app.textFields["chat.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout:5));composer.tap();composer.typeText("Explain ATP in one sentence.")
        tap("chat.send")
        XCTAssertTrue(app.buttons["chat.allowAI"].waitForExistence(timeout:5))
        capture("15-cloud-ai-consent-before-send")
        app.buttons["Cancel"].tap()
        XCTAssertEqual(composer.value as? String,"Explain ATP in one sentence.")
        tap("chat.send");tap("chat.allowAI")
        waitText("Explain ATP in one sentence.")
        restart();tab("Chat");tap("chat.row.07cc79cc-af72-4768-b211-94b365c50a64")
        waitText("Explain ATP in one sentence.")
        capture("16-offline-message-restored-no-fixture-inference")
    }

    func testComposerDraftSurvivesSwitchingAppTabsAndReturning() {
        let chatId="07cc79cc-af72-4768-b211-94b365c50a64",text=String(repeating:"x",count:500)
        tab("Chat");tap("chat.row.\(chatId)")
        let composer=app.textViews["chat.composer"].exists ? app.textViews["chat.composer"]:app.textFields["chat.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout:5));composer.tap();composer.typeText(text)
        tab("Resources");tab("Chat")
        XCTAssertEqual(composer.value as? String,text,"Returning to the Chat tab after rapid input must restore the latest unsent text.")
        capture("24-composer-draft-after-tab-return")
    }

    func testComposerDraftsStayWithTheirChatsAcrossRestartAndSendClearsOnlyItsOwn() {
        let chatId="07cc79cc-af72-4768-b211-94b365c50a64"
        let firstText="Draft belongs to the existing chat."
        let secondText="Draft belongs to the new chat."
        tab("Chat");tap("chat.row.\(chatId)")
        var composer=app.textViews["chat.composer"].exists ? app.textViews["chat.composer"]:app.textFields["chat.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout:5));composer.tap();composer.typeText(firstText)
        app.navigationBars.buttons.element(boundBy:0).tap()

        tap("chat.new")
        composer=app.textViews["chat.composer"].exists ? app.textViews["chat.composer"]:app.textFields["chat.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout:5));composer.tap();composer.typeText(secondText)
        app.navigationBars.buttons.element(boundBy:0).tap()
        restart();tab("Chat")

        let unsent=app.buttons.matching(NSPredicate(format:"identifier BEGINSWITH %@","chat.unsent.")).firstMatch
        XCTAssertTrue(unsent.waitForExistence(timeout:5),"A new-chat prompt must remain reopenable after restart.")
        let secondChatId=String(unsent.identifier.dropFirst("chat.unsent.".count))
        unsent.tap()
        composer=app.textViews["chat.composer"].exists ? app.textViews["chat.composer"]:app.textFields["chat.composer"]
        XCTAssertEqual(composer.value as? String,secondText,"A local new-chat draft must keep its own identity.")
        app.navigationBars.buttons.element(boundBy:0).tap()
        tap("chat.row.\(chatId)")
        composer=app.textViews["chat.composer"].exists ? app.textViews["chat.composer"]:app.textFields["chat.composer"]
        XCTAssertEqual(composer.value as? String,firstText,"The existing chat must restore its own prompt, not the new chat's.")

        tap("chat.send");tap("chat.allowAI")
        waitText(firstText)
        let cleared=expectation(for:NSPredicate(format:"value == %@ OR value == %@","","Message Centre"),evaluatedWith:composer)
        wait(for:[cleared],timeout:5)
        app.navigationBars.buttons.element(boundBy:0).tap()
        let stillUnsent=app.buttons["chat.unsent.\(secondChatId)"]
        XCTAssertTrue(stillUnsent.waitForExistence(timeout:5),"Sending in one chat must preserve other chats' drafts.")
        stillUnsent.tap()
        composer=app.textViews["chat.composer"].exists ? app.textViews["chat.composer"]:app.textFields["chat.composer"]
        XCTAssertEqual(composer.value as? String,secondText)
        capture("25-composer-drafts-isolated-and-send-clears-one")
    }

    func testCachedAttachmentOpensWithoutDesktopOrNetwork() {
        tab("Chat")
        tap("chat.row.07cc79cc-af72-4768-b211-94b365c50a64")
        tap("attachment.open.45c6ec2f-2aa0-40a4-b5ba-fd6b301f1594")
        XCTAssertTrue(app.navigationBars["Offline reading.txt"].waitForExistence(timeout:10))
        XCTAssertTrue(app.buttons["Done"].exists)
        capture("14-cached-attachment-quick-look")
    }

    func testSavedDiagramCancelsExternalNavigation() {
        tab("Resources")
        let row = app.buttons["resources.row.fdd186b8-aea0-4d85-9538-390f076f0379"]
        reveal(row); row.tap()
        let drawing = app.webViews.firstMatch
        XCTAssertTrue(drawing.waitForExistence(timeout: 10))
        let localText = drawing.staticTexts["Saved drawing stays here"]
        XCTAssertTrue(localText.waitForExistence(timeout: 10))
        let externalLink = drawing.links["Attempt external navigation"]
        XCTAssertTrue(externalLink.exists); externalLink.tap()
        let blocked = app.staticTexts["diagram.blockedNavigationCount"]
        XCTAssertTrue(blocked.waitForExistence(timeout: 10))
        let cancelled = expectation(for: NSPredicate(format: "label == %@", "1 navigation blocked"), evaluatedWith: blocked)
        wait(for: [cancelled], timeout: 10)
        XCTAssertTrue(localText.exists)
        XCTAssertEqual(app.state, .runningForeground)
        capture("13-saved-diagram-navigation-cancelled")
    }

    func testNativeLogEntryAndEarlierLaterAttemptPickersUpdateComparison() {
        launchPracticeHistoryFixture()
        tab("Log")
        tap("log.quizHistory")

        let activeResource = app.buttons["practiceHistory.resource.\(quizId)"]
        let deletedResource = app.buttons["practiceHistory.resource.deleted-resource"]
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "practiceHistory.subjectFilter").firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "practiceHistory.resourceFilter").firstMatch.exists)
        choosePickerOption("practiceHistory.subjectFilter", containing: "Biology")
        XCTAssertTrue(activeResource.exists)
        XCTAssertFalse(deletedResource.exists)
        choosePickerOption("practiceHistory.subjectFilter", containing: "Subject unavailable")
        XCTAssertFalse(activeResource.exists)
        XCTAssertTrue(deletedResource.exists)
        choosePickerOption("practiceHistory.subjectFilter", containing: "All subjects")
        choosePickerOption("practiceHistory.resourceFilter", containing: "Cell biology practice")
        XCTAssertTrue(activeResource.exists)
        XCTAssertFalse(deletedResource.exists)
        choosePickerOption("practiceHistory.resourceFilter", containing: "All resources")
        tap("practiceHistory.resource.\(quizId)")
        waitText("original question text and marking model were not saved")

        let change = app.staticTexts["practiceHistory.change.q1"]
        reveal(change)
        XCTAssertTrue(change.waitForExistence(timeout: 10))
        XCTAssertEqual(change.label, "Repeated mistake", "Default comparison should use the oldest and latest saved attempts.")
        XCTAssertEqual(app.staticTexts["practiceHistory.earlier.q1.outcome"].label, "Partial")
        XCTAssertEqual(app.staticTexts["practiceHistory.later.q1.outcome"].label, "Partial")
        XCTAssertEqual(app.staticTexts["practiceHistory.earlier.q1.answer"].label, "First saved response")
        XCTAssertEqual(app.staticTexts["practiceHistory.earlier.q1.feedback"].label, "First saved feedback.")
        XCTAssertEqual(app.staticTexts["practiceHistory.later.q1.answer"].label, "Latest saved response")
        XCTAssertEqual(app.staticTexts["practiceHistory.later.q1.feedback"].label, "Latest saved feedback.")
        XCTAssertTrue(app.staticTexts["Current prompt"].exists)

        choosePickerOption("practiceHistory.earlierAttempt", containing: "Attempt 2", fromBottom: true)
        reveal(change)
        waitLabel(change, "Lower mark")
        XCTAssertEqual(app.staticTexts["practiceHistory.earlier.q1.outcome"].label, "Partial")
        XCTAssertEqual(app.staticTexts["practiceHistory.earlier.q1.answer"].label, "Second saved response")
        choosePickerOption("practiceHistory.earlierAttempt", containing: "Attempt 1", fromBottom: true)
        choosePickerOption("practiceHistory.laterAttempt", containing: "Attempt 2")
        reveal(change)
        waitLabel(change, "Improved")
        XCTAssertEqual(app.staticTexts["practiceHistory.later.q1.answer"].label, "Second saved response")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "practiceHistory.repeatedMistake.q1").firstMatch.exists,
                      "A partial improvement can still be below full marks in both attempts.")
        choosePickerOption("practiceHistory.laterAttempt", containing: "Attempt 4", fromBottom: true)
        reveal(change)
        waitLabel(change, "Repeated mistake")
        XCTAssertEqual(app.staticTexts["practiceHistory.later.q1.answer"].label, "Latest saved response")
        capture("23-native-log-practice-attempt-comparison")
    }

    func testDeletedResourceHistoryUsesSavedQuestionIdsWithoutCurrentContent() {
        launchPracticeHistoryFixture()
        tab("Log")
        tap("log.quizHistory")
        tap("practiceHistory.resource.deleted-resource")

        waitText("This resource is deleted or unavailable")
        reveal(app.staticTexts["Saved deleted-resource answer"])
        XCTAssertTrue(app.staticTexts["Saved deleted-resource answer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Saved deleted-resource feedback."].exists)
        XCTAssertFalse(app.staticTexts["Current prompt"].exists, "Deleted resources must not supply current prompt text.")
        capture("24-deleted-resource-attempt-history")
    }

}
