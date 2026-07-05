#!/usr/bin/env bash
# Headless gnome-shell harness for ohno-scroller scrolling-mode verification.
# Runs a private dbus session + scratch XDG dirs; never touches the live session.
set -u

TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="${TMPDIR:-/tmp}/ohno-scroller-harness"
BASE="$SCRATCH/shell-test"
UUID="ohno-scroller@ohnoibrokeit.dev"
SRC="$(cd "$TESTS/.." && pwd)"
mkdir -p "$SCRATCH"

rm -rf "$BASE"
mkdir -p "$BASE/data/gnome-shell/extensions/$UUID" "$BASE/config" "$BASE/cache"
cp -r "$SRC"/* "$BASE/data/gnome-shell/extensions/$UUID/"
rm -rf "$BASE/data/gnome-shell/extensions/$UUID/tests"
glib-compile-schemas "$BASE/data/gnome-shell/extensions/$UUID/schemas"

export XDG_DATA_HOME="$BASE/data"
export XDG_CONFIG_HOME="$BASE/config"
export XDG_CACHE_HOME="$BASE/cache"

exec dbus-run-session -- bash -c '
set -u
SCRATCH="'"$SCRATCH"'"
TESTS="'"$TESTS"'"
UUID="'"$UUID"'"

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "[\"$UUID\"]"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "999.0" 2>/dev/null

gnome-shell --headless --wayland-display=wayland-ohno --virtual-monitor 1920x1080 --unsafe-mode >"$SCRATCH/shell.log" 2>&1 &
SHELL_PID=$!

ready=0
for _ in $(seq 1 60); do
    if gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "1" >/dev/null 2>&1; then
        ready=1; break
    fi
    sleep 0.5
done
if [ "$ready" != 1 ]; then
    echo "FATAL: shell never became ready"; tail -20 "$SCRATCH/shell.log"; kill $SHELL_PID 2>/dev/null; exit 1
fi
echo "== shell ready"

ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1
}

echo "== extension state (1=ACTIVE):"
ev "Main.extensionManager.lookup(\"$UUID\")?.state"
ev "Main.overview.hide()" >/dev/null
sleep 1

spawn() {
    TEST_TITLE="$1" WAYLAND_DISPLAY=wayland-ohno gjs "$TESTS/spawn-window.js" >/dev/null 2>&1 &
    sleep 1.5
}
spawn ALPHA
spawn BRAVO
spawn CHARLIE

ev "Main.overview.hide()" >/dev/null
sleep 1.5
ev "Main.overview.hide()" >/dev/null
sleep 1
ACTIVATE="(t) => { const w = global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_title()===t); w?.activate(global.get_current_time()); return w?.get_title() ?? null; }"
echo "== activate CHARLIE:"
ev "($ACTIVATE)(\"CHARLIE\")"
sleep 1
echo "== overview visible / focus now:"
ev "JSON.stringify([Main.overview.visible, global.display.focus_window?.get_title() ?? null])"

FRAMES="JSON.stringify({focus: global.display.focus_window?.get_title() ?? null, overview: Main.overview.visible, frames: global.get_window_actors().filter(a=>a.meta_window.get_title()).map(a=>{const w=a.meta_window;const f=w.get_frame_rect();return {t:w.get_title(),x:f.x,y:f.y,w:f.width,h:f.height,vis:a.visible};})})"
STRIP="(()=>{const e=Main.extensionManager.lookup(\"$UUID\").stateObj;const ws=global.workspace_manager.get_active_workspace();const st=e._stateFor(ws,0);return JSON.stringify({mode:e._workspaceMode(ws),strip:st.strip?st.strip.columns.map(c=>({ws:c.windows.map(w=>w.get_title()),wf:Number(c.widthFraction.toFixed(3)),sw:c.savedWidthFraction,hw:c.heightWeights.map(h=>Number(h.toFixed(3))),fi:c.focusIndex})):null,focusCol:st.strip?st.strip.focusColumn:null});})()"
FIND="(t) => global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_title()===t)"

echo "== BSP frames:"; ev "$FRAMES"
echo "== toggle to scrolling:"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._toggleLayoutMode()"
sleep 1
echo "== strip state:"; ev "$STRIP"
echo "== scrolling frames (CHARLIE focused+centered expected):"; ev "$FRAMES"

echo "== focus column left:"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._focusNeighbor(\"x\",-1)"
sleep 1
echo "== frames after focus-left (BRAVO centered expected):"; ev "$FRAMES"
echo "== strip state:"; ev "$STRIP"

echo "== stack BRAVO into left column (ALPHA):"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._stackFocusedWindow(-1)"
sleep 1
echo "== strip state (ALPHA+BRAVO one column expected):"; ev "$STRIP"
echo "== frames after stacking:"; ev "$FRAMES"

echo "== focus up within stack:"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._focusNeighbor(\"y\",-1)"
sleep 1
echo "== strip state:"; ev "$STRIP"

echo "== cycle width preset (0.5 -> 0.667):"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._cycleColumnWidth()"
sleep 1
ev "$STRIP"
echo "== cycle width preset (0.667 -> 1.0; CHARLIE should park, vis=false):"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._cycleColumnWidth()"
sleep 1
ev "$STRIP"
ev "$FRAMES"
echo "== cycle width preset (1.0 -> 0.333 wrap):"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._cycleColumnWidth()"
sleep 1
ev "$STRIP"

echo "== fold width drag (+300px on focused column right edge):"
ev "(()=>{const e=Main.extensionManager.lookup(\"$UUID\").stateObj;const w=($FIND)(\"ALPHA\");const ws=global.workspace_manager.get_active_workspace();const a=e._appliedRects.get(w);e._foldStripResize(w,ws,{right:true},a,{x:a.x,y:a.y,width:a.width+300,height:a.height});e._retileActiveWorkspace();return JSON.stringify(a);})()"
sleep 1
ev "$STRIP"
ev "$FRAMES"

echo "== fold stack heights (+150px on ALPHA bottom edge; weights shift to ALPHA):"
ev "(()=>{const e=Main.extensionManager.lookup(\"$UUID\").stateObj;const w=($FIND)(\"ALPHA\");const ws=global.workspace_manager.get_active_workspace();const a=e._appliedRects.get(w);e._foldStripResize(w,ws,{bottom:true},a,{x:a.x,y:a.y,width:a.width,height:a.height+150});e._retileActiveWorkspace();return 0;})()"
sleep 1
ev "$STRIP"
ev "$FRAMES"

echo "== equalize resets stack weights:"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._equalizeRatios()"
sleep 1
ev "$STRIP"

TRANSLATIONS="JSON.stringify(global.get_window_actors().filter(a=>a.meta_window.get_title()).map(a=>({t:a.meta_window.get_title(),tx:Math.round(a.translation_x),easing:a.get_transition(\"translation-x\")!==null})))"
echo "== animations enabled in this shell:"
ev "imports.gi.St.Settings.get().enable_animations"
echo "== scroll right (focus CHARLIE); mid-flight probe (informational, racy):"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._focusNeighbor(\"x\",1)"
ev "$TRANSLATIONS"
sleep 1
echo "== translations settled (all tx=0, easing=false expected):"
ev "$TRANSLATIONS"
echo "== frames after animated scroll (CHARLIE centered expected):"
ev "$FRAMES"

echo "== maximize CHARLIE: column -> 1.0, sw saved, window un-maximized on the spot:"
ev "(()=>{($FIND)(\"CHARLIE\").maximize();return 0;})()"
sleep 1
ev "$STRIP"
ev "(()=>{const w=($FIND)(\"CHARLIE\");return JSON.stringify([w.maximized_horizontally,w.maximized_vertically]);})()"
echo "== maximize CHARLIE again: width restored, sw cleared:"
ev "(()=>{($FIND)(\"CHARLIE\").maximize();return 0;})()"
sleep 1
ev "$STRIP"

echo "== toggle back to bsp:"
ev "Main.extensionManager.lookup(\"$UUID\").stateObj._toggleLayoutMode()"
sleep 1
echo "== strip state:"; ev "$STRIP"
echo "== BSP frames again (non-overlapping expected):"; ev "$FRAMES"

echo "== JS errors mentioning scroller:"
grep -c "ohno-scroller" "$SCRATCH/shell.log" || true
grep -iE "JS ERROR|Unhandled" "$SCRATCH/shell.log" | head -10 || true

kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null
echo "== done"
'
