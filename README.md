# Oh No Scroller

Experimental GNOME Shell tiler for a terminal-heavy workflow.

The current target model is Hyprland-dwindle-style bounded splits:

- each workspace and monitor owns an independent split tree
- each new window splits the active tile along the tile's longest axis
- dragging a window edge folds the resize into the split ratio, so the
  layout keeps the size you chose (a plain move snaps back)
- focus and move shortcuts act on the spatially nearest tile in that
  direction, in all four directions (Super+H/J/K/L by default)
- Super+= resets every split on the workspace back to 50/50
- every tiled window is clamped inside the monitor work area
- fullscreen and non-resizable windows are ignored

This is a scaffold for iteration, not a finished replacement for Hyprland or niri. The earlier niri-style scrolling layout was removed because off-screen window placement was too crash-prone under Mutter.

Open the preferences UI with:

```bash
gnome-extensions prefs ohno-scroller@ohnoibrokeit.dev
```
