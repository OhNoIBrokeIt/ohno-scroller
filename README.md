# Oh No Scroller

Version 10 adds shared Performance Mode feedback and native monitor-transfer
recovery, including fullscreen moves and cleanup of cancelled transfers. The
GNOME Shell 50 suite covers actual two-monitor moves, animation continuity,
standalone preferences, and operation with Oh No Bar absent.

GNOME Shell 50 tiler with Hyprland-inspired controls for a terminal-heavy workflow. Each
workspace runs in one of two layout modes, toggled at runtime:

- **Split tiles (BSP)** — Hyprland-dwindle-style bounded splits. Each new
  window splits the active tile along its longest axis; edge drags fold
  into the split ratios.
- **Scrolling columns** — a horizontal strip with vertical stacks.
  By default, focus scrolls only enough to reveal its column, and a lone
  column fills the work area without forgetting its preferred width.
  Always-center behavior remains available in preferences.
  Off-screen windows use real positions,
  with fully-off-screen columns parked at the work-area edge and hidden
  (Mutter refuses fully-off-screen frames).

Every (workspace, monitor) pair owns an independent split tree or strip.
The default mode for new workspaces is a preference; toggling a workspace
converts spatially (BSP leaves become columns left-to-right; columns feed
back into splits) and discards the other mode's state.

Horizontal and vertical moves animate in both layouts, including BSP swaps
and stack rearrangements. Movement duration is configurable (220 ms by
default); zero or disabling system animations turns them off. Window sizes
commit immediately.

Version 9 fixes BSP movement jumping to its destination and then replaying
the slide. Animations account for client shadows, follow the position Mutter
actually accepts, and preserve visual position through late resize updates
and rapid direction changes.

## Keybindings

| Binding | BSP | Scrolling |
|---|---|---|
| Super+Y | tiling on/off | tiling on/off |
| Super+Ctrl+Y | switch workspace to scrolling | switch workspace to BSP |
| Super+H / L | focus tile left/right | focus column left/right |
| Super+J / K | focus tile below/above | focus within stack (stops at ends) |
| Super+Shift+H / L | move window left/right | move column left/right |
| Super+Shift+J / K | move window down/up | restack window within column |
| Super+Shift+Return | move window to new tile | expel window to its own column (right) |
| Super+, / Super+. | — | stack window into left/right neighbor column |
| Super+R | — | cycle column width 33 → 50 → 66 → 100 |
| Super+= | reset splits to 50/50 | equalize stack heights |
| Super+Shift+Y | retile workspace | reveal focus and reassert the strip |
| Super+Shift+V | toggle focused window floating/tiled | same |
| Super+W | toggle current split horizontal/vertical | — |
| Super+Ctrl+H / L | shrink/grow tile width | shrink/grow column width |
| Super+Ctrl+K / J | shrink/grow tile height | shrink/grow window in stack |

Focus crosses to an adjacent monitor when there is no tile in the requested
direction. Scrolling focus and column movement wrap at the horizontal ends
by default; each can be disabled independently in preferences. Adjacent
monitor focus takes priority over wrapping. Focus and resize shortcuts
repeat while held; other shortcuts act once per press.

## Behavior notes

- New windows: BSP splits the focused tile; scrolling opens a new column
  immediately right of the focused one (default width is a preference).
  Stacking is always explicit (Super+, / Super+.).
- Edge drags fold into the layout in both modes: split ratios in BSP;
  column width and stack height weights in scrolling.
- Maximize in scrolling mode = column width 100% (the window itself is
  un-maximized on the retile); hitting maximize again restores the
  previous column width.
- Floating toggle restores the window's previous floating rectangle. Floating
  windows can be moved, resized, and maximized normally; toggling back inserts
  them at the active tile/column. Floating status lasts for the session.
- Dialogs/transients float; fullscreen overlays and returns to its original
  slot, including stack weights and BSP split ratios. Layout updates pause
  on that monitor while fullscreen is active. Other monitors keep tiling.
- A live move/resize grab defers layout updates until release, preserving
  queued manual retile requests.
- A window that fights its tile is snapped back at most 3 times, then
  left alone until the layout changes (Super+Shift+Y overrules).
- The extension declares `session-modes: [user, unlock-dialog]`, so
  layouts survive the lock screen instead of rebuilding in MRU order.

The default scrolling options follow the documented Hyprland behavior for
[focus fitting, lone-column width, and wrapping](https://wiki.hypr.land/Configuring/Layouts/Scrolling-Layout/).
Split rotation corresponds to Hyprland's
[togglesplit](https://wiki.hypr.land/Configuring/Layouts/Dwindle-Layout/).
To restore the earlier scrolling feel, select **Center focused column** and
disable **Expand a lone column**, **Wrap horizontal focus**, and **Wrap column
movement** in preferences.

This is a GNOME extension, so Mutter still owns rendering, input, workspaces,
and fullscreen. It does not implement Hyprland's Lua configuration, window
rules, gestures, decorations, pseudotiling, or fullscreen windows that scroll
as part of the tape. Fullscreen is an overlay; scrolling remains horizontal.
Moving windows between monitors uses GNOME's controls or a pointer drag.

## Development

Preferences: `gnome-extensions prefs ohno-scroller@ohnoibrokeit.dev`

Headless verification (never touches the live session):

```bash
make test
```

The compatibility command `bash tests/strip-harness.sh` runs the same
assertion-based GNOME Shell 50 automation suite.

The suite checks focus identity, viewport policies, directional geometry,
and real-window stacking, resizing, maximize, fullscreen return, floating,
mode conversion, deferred layout, animations, and disable cleanup. The
standard headless run uses one virtual monitor; physical multi-monitor
placement and hotplug still need interactive validation.

`make test-animation` runs the focused smoothness suite. It samples rendered
frames for BSP swaps, constrained tile sizes, vertical moves, keyboard
resizing, scrolling, and rapid reversals. It rejects startup stalls, instant
jumps, and unintended direction changes. To log sampled positions, run:

```bash
OHNO_ANIMATION_TRACE=1 make test-animation
```

After testing, install the package:

```bash
gnome-extensions install --force ohno-scroller@ohnoibrokeit.dev.shell-extension.zip
```

Log out and back in to load updated extension code on Wayland.

Design notes for the scrolling mode live in
`docs/scrolling-mode-design.md`.

This repo is the canonical source. The `bluefin-gaming-dx` image repo
carries a vendored copy of the runtime files (synced by its
`extensions/sync-ohno-scroller.sh`) that gets baked into the image —
edit here, then re-sync there.
