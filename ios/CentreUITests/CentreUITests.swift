import XCTest

final class CentreUITests: XCTestCase {
    private var app:XCUIApplication!
    override func setUp() { continueAfterFailure=false;app=XCUIApplication();app.launchArguments=["-ui-testing","-reset-fixture"];app.launch() }
    private func capture(_ name:String) {
        let evidence=XCTAttachment(screenshot:app.screenshot());evidence.name=name;evidence.lifetime = .keepAlways;add(evidence)
    }
    private func tab(_ name:String) { let button=app.tabBars.buttons[name];XCTAssertTrue(button.waitForExistence(timeout:15));button.tap() }
    private func waitText(_ text:String) { XCTAssertTrue(app.staticTexts.containing(NSPredicate(format:"label CONTAINS %@",text)).firstMatch.waitForExistence(timeout:10),text) }
    private func restart() { app.terminate();app.launchArguments=["-ui-testing"];app.launch();XCTAssertTrue(app.tabBars.buttons["Resources"].waitForExistence(timeout:15)) }

    func testOfflineNotesQuizAndTimerSurviveRestart() {
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout:15))
        capture("01-chat-dark-offline")
        tab("Resources")
        app.buttons["New note"].tap()
        let title=app.textFields["Title"];XCTAssertTrue(title.waitForExistence(timeout:5));title.tap();title.typeText("Offline cell summary")
        let body=app.textViews["Note"];body.tap();body.typeText("Mitochondria supply ATP for cell activity.")
        app.navigationBars.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Offline cell summary"].waitForExistence(timeout:10))
        capture("02-saved-offline-note")
        restart();tab("Resources")
        XCTAssertTrue(app.staticTexts["Offline cell summary"].waitForExistence(timeout:5))
        app.staticTexts["Cell biology practice"].tap()
        let choice=app.buttons.containing(NSPredicate(format:"label CONTAINS %@","Mitochondria")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout:5));choice.tap()
        waitText("Draft saved")
        capture("03-offline-quiz-draft")
        restart();tab("Resources");app.staticTexts["Cell biology practice"].tap()
        let restored=app.buttons.containing(NSPredicate(format:"label CONTAINS %@","Mitochondria")).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout:5))
        XCTAssertTrue(restored.isSelected || String(describing:restored.value ?? "").localizedCaseInsensitiveContains("selected"),"Selected answer must restore from the real persisted draft")
        tab("Log")
        let timerTitle=app.textFields["What are you studying?"]
        XCTAssertTrue(timerTitle.waitForExistence(timeout:5));timerTitle.tap();timerTitle.typeText("Cell biology reading")
        app.buttons["Start timer"].tap()
        XCTAssertTrue(app.buttons["Pause"].waitForExistence(timeout:5))
        restart();tab("Log")
        XCTAssertTrue(app.buttons["Resume"].waitForExistence(timeout:5),"Terminated timer must recover paused")
        XCTAssertFalse(app.buttons["Pause"].exists)
        capture("04-log-recovered-paused")
        app.buttons["Stop"].tap()
        XCTAssertTrue(app.buttons["Start timer"].waitForExistence(timeout:5))
        app.buttons["Set a weekly goal"].tap()
        XCTAssertTrue(app.navigationBars.buttons["Save"].waitForExistence(timeout:5));app.navigationBars.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Change weekly goal"].waitForExistence(timeout:5))
        capture("05-log-weekly-goal")
        tab("Review")
        capture("06-review")
        tab("Calendar")
        capture("07-offline-calendar-empty-state")
        app.buttons["Settings"].tap()
        capture("08-settings-pending-and-provider")
    }

    func testLargeTextAndHonestUnconfiguredAccount() {
        app.terminate();app.launchArguments=["-ui-testing","-reset-fixture","-UIPreferredContentSizeCategoryName","UICTContentSizeCategoryAccessibilityXXXL"];app.launch()
        tab("Log");capture("09-accessibility-large-log")
        XCTAssertTrue(app.buttons["Start timer"].exists)
        app.buttons["Settings"].tap();capture("10-accessibility-large-settings")
    }
}
