import AppKit

@MainActor
final class WindowContainmentSettlement {
    typealias Schedule = (@escaping @MainActor () -> Void) -> Void

    private let schedule: Schedule
    private var scheduled = false
    private var applying = false

    init(schedule: @escaping Schedule = { work in
        RunLoop.main.perform {
            MainActor.assumeIsolated { work() }
        }
    }) {
        self.schedule = schedule
    }

    /// Resize notifications can arrive inside SwiftUI's own inspector layout
    /// pass. Settle once on the next run-loop turn, and ignore the resize emitted
    /// by our own `setFrame`, instead of re-entering AppKit constraints.
    func request(_ apply: @escaping @MainActor () -> Void) {
        guard !scheduled, !applying else { return }
        scheduled = true
        schedule { [weak self] in
            guard let self else { return }
            self.scheduled = false
            guard !self.applying else { return }
            self.applying = true
            apply()
            self.applying = false
        }
    }
}

enum WindowContainment {
    /// A plain didMove clamp can pin a dragged window to the old screen before
    /// AppKit changes its majority-owned `window.screen`. Resize/layout events
    /// and the actual screen transition are safe containment boundaries.
    static let clampWindowNotifications: [Notification.Name] = [
        NSWindow.didResizeNotification,
        NSWindow.didEndLiveResizeNotification,
        NSWindow.didChangeScreenNotification,
        NSWindow.didExitFullScreenNotification,
    ]

    static func clampedFrame(_ frame: CGRect, within visibleFrame: CGRect) -> CGRect {
        guard visibleFrame.width > 0, visibleFrame.height > 0 else { return frame }
        let width = min(max(frame.width, 1), visibleFrame.width)
        let height = min(max(frame.height, 1), visibleFrame.height)
        let x = min(max(frame.minX, visibleFrame.minX), visibleFrame.maxX - width)
        let y = min(max(frame.minY, visibleFrame.minY), visibleFrame.maxY - height)
        return CGRect(x: x, y: y, width: width, height: height)
    }
}

enum ThreadWorkspaceLayout {
    static let closedConversationMinimumWidth: CGFloat = 420

    /// The native inspector already owns its own minimum. Keeping the chat's
    /// independent 420-point floor while it is open makes a 1024-point display
    /// unsatisfiable before either pane's content is measured.
    static func conversationMinimumWidth(inspectorPresented: Bool) -> CGFloat? {
        inspectorPresented ? nil : closedConversationMinimumWidth
    }
}

enum PopoverLayout {
    static func maximumHeight(visibleFrameHeight: CGFloat) -> CGFloat {
        max(0, visibleFrameHeight - 128)
    }

    @MainActor static var currentMaximumHeight: CGFloat {
        let screen = NSApp.keyWindow?.screen ?? NSScreen.main
        return maximumHeight(visibleFrameHeight: screen?.visibleFrame.height ?? 728)
    }
}

enum ComposerOptionsLayout {
    static func maximumHeight(visibleFrameHeight: CGFloat) -> CGFloat {
        PopoverLayout.maximumHeight(visibleFrameHeight: visibleFrameHeight)
    }

    @MainActor static var currentMaximumHeight: CGFloat {
        PopoverLayout.currentMaximumHeight
    }
}
