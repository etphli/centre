import SwiftUI
import UIKit

/// Observes window activity without joining the view's hit-testing hierarchy.
@MainActor
struct ActivityObserver: UIViewRepresentable {
    var onActivity: () -> Void

    func makeUIView(context: Context) -> Probe {
        let view = Probe()
        view.gesture.onActivity = onActivity
        return view
    }

    func updateUIView(_ view: Probe, context: Context) {
        view.gesture.onActivity = onActivity
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: Probe, context: Context) -> CGSize? { .zero }

    static func dismantleUIView(_ view: Probe, coordinator: Void) {
        view.detach()
        view.gesture.onActivity = {}
    }

    final class Probe: UIView {
        let gesture = ActivityGesture(target: nil, action: nil)
        private weak var observedWindow: UIWindow?

        init() {
            super.init(frame: .zero)
            backgroundColor = .clear
            isUserInteractionEnabled = false
            gesture.cancelsTouchesInView = false
            gesture.delaysTouchesBegan = false
            gesture.delaysTouchesEnded = false
            gesture.delegate = gesture
        }

        required init?(coder: NSCoder) { return nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard observedWindow !== window else { return }
            detach()
            observedWindow = window
            window?.addGestureRecognizer(gesture)
        }

        func detach() {
            observedWindow?.removeGestureRecognizer(gesture)
            observedWindow = nil
        }
    }

    final class ActivityGesture: UIGestureRecognizer, UIGestureRecognizerDelegate {
        var onActivity: () -> Void = {}

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            onActivity()
            state = .failed
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
