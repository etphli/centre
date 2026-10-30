import SwiftUI
import UIKit

/// Key commands apply to hardware keyboards only. Software Return remains multiline editing.
struct MessageComposer: UIViewRepresentable {
    @Binding var text: String
    let sendKey: String
    let color: UIColor
    let canSend: Bool
    let send: () -> Void
    @Environment(\.dynamicTypeSize) private var textSize

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.isScrollEnabled = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityLabel = "Message Centre"
        view.accessibilityIdentifier = "chat.composer"
        view.adjustsFontForContentSizeCategory = true
        let accessory = UIToolbar()
        accessory.sizeToFit()
        let done = UIBarButtonItem(title: "Done", style: .done, target: view, action: #selector(ComposerTextView.dismissKeyboard))
        done.accessibilityIdentifier = "chat.dismissKeyboard"
        accessory.items = [UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil), done]
        view.inputAccessoryView = accessory
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.textColor = color
        view.font = UIFont.preferredFont(forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: textSize.uiCategory))
        view.sendKey = sendKey
        view.sendAction = { if canSend { send() } }
        view.canSend = canSend
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 240
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = uiView.font?.lineHeight ?? 22
        let height = min(line * 6, max(line, fitting.height))
        uiView.isScrollEnabled = fitting.height > height
        return CGSize(width: width, height: height)
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MessageComposer
        init(_ parent: MessageComposer) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) { parent.text = textView.text }
    }
}

final class ComposerTextView: UITextView {
    var sendKey = "enter"
    var canSend = false
    var sendAction: (() -> Void)?
    override var keyCommands: [UIKeyCommand]? {
        guard markedTextRange == nil else { return super.keyCommands }
        let modifiers: [UIKeyModifierFlags] = sendKey == "modifier-enter" ? [.command, .control] : [[]]
        return (super.keyCommands ?? []) + modifiers.map {
            let command = UIKeyCommand(input: "\r", modifierFlags: $0, action: #selector(sendMessage))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
    }
    @objc func dismissKeyboard() { resignFirstResponder() }
    @objc private func sendMessage() {
        guard markedTextRange == nil, canSend else { return }
        sendAction?()
    }
}

private extension DynamicTypeSize {
    var uiCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}
