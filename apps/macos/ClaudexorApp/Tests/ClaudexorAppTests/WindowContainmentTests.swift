import AppKit
import CoreGraphics
import Testing
@testable import ClaudexorApp

@Suite struct WindowContainmentTests {
    @Test func ordinaryMoveIsNotClampedBeforeCrossDisplayOwnershipChanges() {
        #expect(!WindowContainment.clampWindowNotifications.contains(
            NSWindow.didMoveNotification
        ))
        #expect(WindowContainment.clampWindowNotifications.contains(
            NSWindow.didChangeScreenNotification
        ))
    }

    @Test func oversizedWindowShrinksIntoVisibleFrame() {
        let visible = CGRect(x: 300, y: 40, width: 1024, height: 728)
        let result = WindowContainment.clampedFrame(
            CGRect(x: 300, y: 30, width: 1178, height: 820), within: visible
        )
        #expect(visible.contains(result))
        #expect(result == visible)
    }

    @Test func ordinaryWindowKeepsItsSizeAndMovesOnlyAsNeeded() {
        let visible = CGRect(x: -1440, y: 25, width: 1440, height: 875)
        let original = CGRect(x: -200, y: 100, width: 800, height: 600)
        let result = WindowContainment.clampedFrame(original, within: visible)
        #expect(result.size == original.size)
        #expect(visible.contains(result))
        #expect(result.maxX == visible.maxX)
    }

    @Test func popoverMaximumHeightTracksTheActiveVisibleFrame() {
        #expect(ComposerOptionsLayout.maximumHeight(visibleFrameHeight: 728) == 600)
        #expect(ComposerOptionsLayout.maximumHeight(visibleFrameHeight: 1200) == 1072)
        #expect(ComposerOptionsLayout.maximumHeight(visibleFrameHeight: 360) == 232)
    }
}
