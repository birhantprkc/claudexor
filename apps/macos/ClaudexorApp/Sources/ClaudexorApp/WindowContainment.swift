import AppKit

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

enum ComposerOptionsLayout {
    static func maximumHeight(visibleFrameHeight: CGFloat) -> CGFloat {
        max(0, visibleFrameHeight - 128)
    }

    @MainActor static var currentMaximumHeight: CGFloat {
        let screen = NSApp.keyWindow?.screen ?? NSScreen.main
        return maximumHeight(visibleFrameHeight: screen?.visibleFrame.height ?? 728)
    }
}
