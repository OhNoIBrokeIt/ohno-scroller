# Oh No Scroller

Experimental GNOME Shell tiler for a terminal-heavy workflow. Each
workspace runs in one of two layout modes, toggled at runtime:

- **Split tiles (BSP)** — Hyprland-dwindle-style bounded splits. Each new
  window splits the active tile along its longest axis; edge drags fold
  into the split ratios.
- **Scrolling columns** — niri/PaperWM-style horizontal strip. Windows
  live in columns that scroll left/right; the focused column is always
  centered. Columns hold vertical stacks. Scrolls animate (respecting
  the system animations setting); off-screen windows use real positions,
  with fully-off-screen columns parked at the work-area edge and hidden
  (Mutter refuses fully-off-screen frames).

Every (workspace, monitor) pair owns an independent split tree or strip.
The default mode for new workspaces is a preference; toggling a workspace
converts spatially (BSP leaves become columns left-to-right; columns feed
back into splits) and discards the other mode's state.

## Keybindings

| Binding | BSP | Scrolling |
|---|---|---|
| Super+Y | tiling on/off | tiling on/off |
| Super+Ctrl+Y | switch workspace to scrolling | switch workspace to BSP |
| Super+H / L | focus tile left/right | focus column left/right (re-centers) |
| Super+J / K | focus tile below/above | focus within stack (stops at ends) |
| Super+Shift+H / L | move window left/right | move column left/right |
| Super+Shift+J / K | move window down/up | restack window within column |
| Super+Shift+Return | move window to new tile | expel window to its own column (right) |
| Super+, / Super+. | — | stack window into left/right neighbor column |
| Super+R | — | cycle column width 33 → 50 → 66 → 100 |
| Super+= | reset splits to 50/50 | equalize stack heights |
| Super+Shift+Y | retile workspace | re-center and reassert the strip |

## Behavior notes

- New windows: BSP splits the focused tile; scrolling opens a new column
  immediately right of the focused one (default width is a preference).
  Stacking is always explicit (Super+, / Super+.).
- Edge drags fold into the layout in both modes: split ratios in BSP;
  column width and stack height weights in scrolling.
- Maximize in scrolling mode = column width 100% (the window itself is
  un-maximized on the retile); hitting maximize again restores the
  previous column width.
- Dialogs/transients float; fullscreen overlays and returns to its slot.
- A window that fights its tile is snapped back at most 3 times, then
  left alone until the layout changes (Super+Shift+Y overrules).
- The extension declares `session-modes: [user, unlock-dialog]`, so
  layouts survive the lock screen instead of rebuilding in MRU order.

## Development

Preferences: `gnome-extensions prefs ohno-scroller@ohnoibrokeit.dev`

Headless verification (never touches the live session):

```bash
bash tests/strip-harness.sh
```

Design notes for the scrolling mode live in
`docs/scroller-scrolling-mode-design.md` at the repo root.
