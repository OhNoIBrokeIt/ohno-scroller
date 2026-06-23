# Oh No Scroller

Experimental GNOME Shell tiler for a terminal-heavy workflow.

The target model is niri-style scrolling columns:

- each workspace and monitor owns an independent set of columns
- each column stacks one or more windows vertically
- the active column is kept visible by scrolling the logical workspace
- fullscreen and non-resizable windows are ignored

This is a scaffold for iteration, not a finished replacement for Hyprland or niri.

Open the preferences UI with:

```bash
gnome-extensions prefs ohno-scroller@ohnoibrokeit.dev
```
