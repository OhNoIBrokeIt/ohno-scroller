# BSP animation regression — v9

The v8 lifecycle tests verified completion and cleanup but did not inspect
the motion between those endpoints. A rendered-frame trace reproduced the
reported BSP jank: a window snapped to its new position on the first repaint,
waited about 250 ms, jumped back, and then replayed the slide.

## Causes

1. The animation compared the actor's buffer position with a frame rectangle.
   Client shadows made those coordinates differ (14 px horizontally and
   12 px vertically in the test fixture). The expected position never matched,
   so the animation waited for its 250 ms fallback.
2. BSP resizing is asynchronous. Reading the buffer rectangle immediately
   after requesting a resize can still return the old allocation. Changing
   only the rectangle API eliminated scrolling delay but still let BSP snap.
3. An app's minimum size can change the accepted position. The fixture's
   constrained tile requested actor y=538 but landed at y=508. Exact matching
   still failed, and corrective placement could interrupt the pending move.

Mutter documents the distinction between
[frame bounds](https://mutter.gnome.org/meta/method.Window.get_frame_rect.html)
and [buffer bounds](https://mutter.gnome.org/meta/method.Window.get_buffer_rect.html).

## Fix

Capture the buffer-to-frame offset before placement. Keep the animation's
visible position in stage coordinates, independent of actor allocation.
On each position notification, compensate actor translation immediately;
start motion as soon as the actual allocation arrives, even when it differs
from the requested destination. A Clutter actor-bound timeline drives the
same 220 ms cubic ease-out. Late allocations rebase from the current visible
position using the remaining duration. New commands continue from the
currently rendered position. Drift correction waits while animation is active.

The 250 ms fallback remains only to clean up a requested move that never
produces a position notification. It no longer delays normal movement or
replays a move from its stale starting point.

## Regression coverage

`make test-animation` checks actual rendered MetaWindow positions, including
client shadows and asynchronous, minimum-size-constrained BSP swaps. It also
checks vertical swaps, keyboard resizing, scrolling, and repeated 70 ms
direction reversals. A controlled Clutter actor verifies separate-axis and
mid-animation allocation changes without depending on client scheduling.
The existing full suite retains animation completion/cancellation, reduced
motion, fullscreen, floating, and disable cleanup checks.

In the 60 Hz headless fixture, ordinary BSP motion began around 34 ms after
the command with no destination jump or rewind. This measures position
continuity in the isolated compositor, not frame pacing on physical displays.
