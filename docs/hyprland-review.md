# Hyprland behavior review — 2026-09-07

Reviewed the v7 implementation (`f06f7df`) as a whole against the requested
goal: improve both dwindle and scrolling behavior, including navigation,
sizing, and animations. The starting worktree was clean.

## Correctness findings fixed

- **Fullscreen discarded layout membership.** The eligibility filter excluded
  fullscreen windows before tree/strip reconciliation. Retiles now pause the
  affected monitor before reconciliation and placement, preserving the slot,
  widths, stack weights, and split ratios. The fullscreen actor immediately
  releases strip clipping and parked visibility.
- **Live grabs did not defer layout work.** Geometry drift detection ignored
  the grabbed window, but other events could still place it during a drag.
  Retile transactions now wait until grab end and retain their reasons,
  including forced manual placement. Direct placement also guards the grab.
- **Closing an earlier column changed focus.** Numeric focus indices were
  clamped after removal, selecting a different surviving column or stack
  member. Surviving focus is now preserved by window identity. Bulk admission
  and workspace activation also reconcile model focus with actual focus.
- **Directional navigation compared centers only.** A tall tile beside a
  stack could win an up/down comparison. Navigation now requires a candidate
  beyond the requested edge and prefers overlap along the other axis.

## Behavior added

| Area | v8 behavior |
|---|---|
| Both layouts | Per-window floating toggle, remembering floating geometry |
| Both layouts | Repeating keyboard width/height resizing using existing drag-fold rules |
| Both layouts | Horizontal and vertical movement animations with configurable duration |
| Both layouts | Directional focus fallback to adjacent monitors |
| BSP | Toggle the nearest split between horizontal and vertical |
| Scrolling | Fit-to-view default, optional always-center policy |
| Scrolling | Full-width lone column with its chosen width preserved |
| Scrolling | Independently configurable focus and column-movement wrapping |

The scrolling defaults are grounded in the official
[scrolling layout documentation](https://wiki.hypr.land/Configuring/Layouts/Scrolling-Layout/).
The split toggle follows the documented
[dwindle layout operation](https://wiki.hypr.land/Configuring/Layouts/Dwindle-Layout/).
These are selected behavior matches; this extension does not reproduce
Hyprland's compositor or configuration API.

## Validation

`make test` packages the extension and runs GNOME Shell 50's automation tool
with scratch XDG directories and a private D-Bus session. Coverage includes
the findings above, viewport math, direction selection with unequal tiles
and offset monitors, real-window floating geometry restoration, scrolling
maximize/restore, stack resizing, BSP resizing and split rotation, mode
conversion, animation completion/cancellation, and actor release when tiling
is turned off. Existing coalescing and unchanged-placement checks remain.

Static verification: JavaScript syntax checks, strict schema compilation,
and `git diff --check`.

## Remaining differences and validation limits

- The standard automation display is one virtual monitor. Direction selection
  is tested with monitor geometries; physical multi-monitor focus, scaled
  displays, clipping, and hotplug require interactive verification.
- Fullscreen remains a Mutter overlay. Tape-integrated fullscreen, vertical
  scrolling, gesture scrolling, and configurable insertion direction are
  not implemented.
- BSP still chooses the longest axis for insertion. Pointer-directed splits,
  preselection, pseudotiling, and Hyprland-style window rules are absent.
- Cross-monitor window movement uses GNOME shortcuts or pointer dragging;
  the extension's move shortcuts reorder tiles/columns on their current monitor.
- Movement animates actor translation; resize geometry commits immediately.
  Hyprland's border effects, blur, spring/Bezier configuration, and workspace
  animation system remain outside this extension.
- Mutter still constrains off-screen frames. Parking and monitor clipping
  remain the existing workaround, with its existing input/rendering limits.
