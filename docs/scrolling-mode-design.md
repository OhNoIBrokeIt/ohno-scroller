# ohno-scroller: scrolling-columns mode — design

Status: agreed 2026-07-04 (design discussion, William + Claude). Not yet built.

## Decisions

| Axis | Decision |
|---|---|
| Off-screen strategy | **Real window positions** (PaperWM-style). No clones, no minimize-virtualization. |
| Mode scope | **Per-workspace**: each workspace is BSP or scrolling; every (workspace, monitor) pair owns one strip or one split tree. |
| Stacks | **Yes, from v1.** Columns hold vertical stacks of windows. |
| Animation | **Yes, from v1.** Actors ease during a scroll; real geometry commits once at animation end. Respects GNOME `enable-animations`. |
| New windows | New column immediately **right of the focused column**; focus and scroll to it. Stacking is always explicit. |
| Column width | New columns default to **50%** of work-area width. Per-column presets cycle 33 → 50 → 66 → 100. Edge drags fold into the column width (same philosophy as BSP ratio folding). |
| Viewport | **Always center** the focused column (niri center-focused feel). |
| Mode switch | Spatial conversion. BSP → strip: leaves ordered by tile center (x, then y), one column each. Strip → BSP: insert left-to-right, top-to-bottom. The other mode's state is discarded, not maintained in parallel. |
| Lock/unlock | Extension gains `session-modes: [user, unlock-dialog]` so strips and BSP trees survive the lock screen instead of rebuilding in MRU order. |

## Model

Per (workspace, monitor) state becomes `{mode, root, strip}` where `strip`:

```
strip = {
  columns: [ { windows: [MetaWindow…], widthFraction, heightWeights: [Number…] } ],
  focusColumn: index,
  focusWindow: index within column,
}
```

Column x-positions derive from cumulative widths plus gaps; the strip origin is
chosen so the focused column's center sits at the work-area center (clamped so
a lone narrow strip still centers sensibly). Windows within a column share its
width; heights split by `heightWeights` (default equal), drag-folded like BSP
ratios, reset by equalize.

## Invariants

1. The focused column is always fully visible and centered; enforced from the
   focus handler (covers overview activation, app self-activation, keybinds).
2. Every placement flows through `_appliedRects`. Drift correction stays active
   in scrolling mode — Mutter or an app yanking an off-screen window back
   on-screen is snapped back, bounded, and logged — except for windows in an
   in-flight scroll animation (tracked in an animation registry, the per-window
   analog of `_inLayout`).
3. No placement while a grab is live or a monitor is fullscreen (existing
   defers apply unchanged).
4. **Mutter placement rules (measured empirically, Mutter 50 headless):**
   `user_op=false` placement forces frames fully on-screen; `user_op=true`
   allows partial off-screen but insists on ≥75px visible. Nothing can be
   placed fully off-screen. Strip placement therefore uses `user_op=true`,
   and columns whose ideal spot is fully outside the work area are **parked**
   at the legal 75px edge position with their actor hidden (same visual
   semantics as minimized windows — overview previews still render from the
   window texture). Every applied rect is exactly where the frame really
   lands, so drift correction never fights a Mutter clamp.

Why this won't repeat the old crashes: the original attempt predates the
first-frame pipeline, applied-rect bookkeeping, bounded drift correction,
grab/fullscreen defers, and monitors-changed rebuilds — and it fought the
(previously unmeasured) placement clamp head-on. Every known fragile moment
now has a guard, and the failure mode is a logged bounded correction rather
than a fight loop.

## Keybindings in scrolling mode

Existing bindings reinterpret; two new ones (†) get schema keys:

| Binding | BSP meaning | Scrolling meaning |
|---|---|---|
| Super+H / L | focus tile left/right | focus column left/right (centers) |
| Super+J / K | focus tile below/above | focus within stack (stops at ends) |
| Super+Shift+H / L | move window left/right | move **column** left/right |
| Super+Shift+J / K | move window down/up | restack window within column |
| Super+Shift+Return | move to new column | expel window → own column, right |
| Super+= | equalize ratios | equalize stack heights (all columns) |
| Super+Shift+Y | retile workspace | re-center + reassert strip |
| Super+Y | tiling on/off | unchanged |
| † Super+R | — | cycle focused column width preset |
| † Super+Ctrl+Y | — | toggle workspace layout BSP ↔ scrolling |
| † Super+, / Super+. | — | stack window into left/right neighbor column |

Design correction during build: consume-into-neighbor (`stack-window-left/
right`) cannot be deferred — without it stacks can never form (Shift+J/K only
reorders windows already stacked). `column-width-percent` is repurposed as
the new-column default (100 → 50 default change, prefs row).

**Animation approach (slice 4):** frames jump to their final positions
immediately (input follows reality); actors ease `translation_x` from the old
visual position to 0. Translation is compositor-side, so Mutter's placement
constraints never see it; parked windows fade/slide at the edges.

## Edge cases

- **Maximize** in scrolling mode = column width 100% (previous width restored
  on unmaximize); app self-maximization folds into the same path.
- **Fullscreen**: window overlays as today; its column keeps its slot and the
  window returns to it on exit.
- **Close**: empty columns collapse; focus moves to the previous column and
  re-centers.
- **Drag-drop**: on grab-op-end, the dropped window becomes its own column at
  the nearest column boundary of the target monitor's strip (stack-insertion
  by drop deferred).
- **Monitors changed**: strips rebuilt from present windows (columns in MRU
  order), same as BSP state today.
- **Transients/dialogs** float (existing filter). New-window-while-animating
  settles the animation, inserts, re-centers.

## Build plan (slices; the arc ships as one release)

1. **Mode plumbing + conversion**: per-workspace mode map, mode-toggle
   keybinding, prefs default, BSP↔strip spatial conversion. Instant placement.
2. **Strip engine**: placement math, center invariant, new-column-right,
   width presets + drag folds.
3. **Stacks**: J/K navigation, Shift+J/K restacking, height weights, expel.
4. **Animation**: actor easing + commit, in-flight drift suppression,
   `enable-animations` respect.
5. **Session-modes** unlock survival + polish (maximize→100%, logging, README,
   prefs).

Each slice is verified in a **headless shell** (`dbus-run-session --
gnome-shell --headless --virtual-monitor 1920x1080 --unsafe-mode` with
scratch XDG dirs, driven over `org.gnome.Shell.Eval`) before touching the
live session, so iteration does not burn logout/login cycles; the live
session picks up finished batches at the next login.

Status 2026-07-05: ARC COMPLETE (v6). All five slices built and verified
headless: mode toggle + both conversions, centered strip placement with
park-and-hide, stacking, navigation, drop re-slotting, monitor clips,
width presets + drag folds, scroll animation (translation_x easing,
clips translation-aware), session-modes [user, unlock-dialog], maximize
fold with width restore. Build finding: a maximized window fails
allows_resize(), so the maximize fold un-maximizes on the spot rather
than waiting for placement (Mutter 50 unmaximize() takes no flags).
