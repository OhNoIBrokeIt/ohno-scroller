import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension as ExtensionBase} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const KEYBINDINGS = [
    'toggle-tiling',
    'toggle-layout-mode',
    'retile-workspace',
    'equalize-ratios',
    'focus-column-left',
    'focus-column-right',
    'focus-up',
    'focus-down',
    'move-window-left',
    'move-window-right',
    'move-window-up',
    'move-window-down',
    'move-window-new-column',
    'stack-window-left',
    'stack-window-right',
    'cycle-column-width',
];

const LAYOUT_MODES = new Set(['bsp', 'scrolling']);

const NORMAL_WINDOW_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

const MIN_TILE_SIZE = 32;
// Bounds for user-adjusted split ratios so no tile can be dragged into
// oblivion.
const RATIO_MIN = 0.1;
const RATIO_MAX = 0.9;
// An edge must move at least this many pixels before it counts as resized;
// smaller drifts are apps settling (e.g. terminals snapping to cells).
const RESIZE_EDGE_THRESHOLD = 2;
// App-driven drift beyond these tolerances is snapped back by a retile.
// Size gets slack for client-side snapping (terminal cell grids); position
// has no such excuse and only tolerates rounding.
const DRIFT_POSITION_TOLERANCE = 2;
const DRIFT_SIZE_TOLERANCE = 32;
// How many times a window is snapped back onto the same tile rect before we
// stop fighting it. Any layout change (new target rect) or a manual
// retile-workspace resets the count.
const DRIFT_CORRECTION_LIMIT = 3;
// Bounds for a scrolling column's width as a fraction of the work area.
const COLUMN_WIDTH_MIN = 0.2;
const COLUMN_WIDTH_MAX = 1.0;
// Width presets the cycle keybinding steps a scrolling column through; from
// a drag-adjusted width the cycle resumes at the next-larger preset.
const COLUMN_WIDTH_PRESETS = [1 / 3, 0.5, 2 / 3, 1.0];
// How long a scroll eases actors to their new positions.
const SCROLL_ANIMATION_MS = 220;
// Work-area notifications arrive in short bursts while panels and monitors
// settle. Wait for the final geometry instead of rebuilding the same layout
// once per intermediate notification.
const WORKAREA_SETTLE_MS = 100;
// Mutter refuses to place a frame with less than this many pixels visible
// (measured empirically on Mutter 50: user-op placement clamps to exactly
// 75px on-screen; non-user-op placement forces the window fully on-screen).
// Strip columns that should sit fully off-screen are therefore "parked" at
// this legal edge position with their actor hidden.
const MUTTER_MIN_ONSCREEN = 75;
// Which window edges each pointer resize op drags. Moves and keyboard resizes
// are absent on purpose: they get no ratio fold and simply snap back on the
// retile that follows the grab.
const GRAB_OP_EDGES = new Map([
    [Meta.GrabOp.RESIZING_N, {top: true}],
    [Meta.GrabOp.RESIZING_S, {bottom: true}],
    [Meta.GrabOp.RESIZING_E, {right: true}],
    [Meta.GrabOp.RESIZING_W, {left: true}],
    [Meta.GrabOp.RESIZING_NE, {top: true, right: true}],
    [Meta.GrabOp.RESIZING_NW, {top: true, left: true}],
    [Meta.GrabOp.RESIZING_SE, {bottom: true, right: true}],
    [Meta.GrabOp.RESIZING_SW, {bottom: true, left: true}],
]);

export default class OhNoScrollerExtension extends ExtensionBase {
    enable() {
        this._settings = this.getSettings();
        this._signals = [];
        this._windowSignals = new Map();
        this._pendingRetileSignals = new Map();
        this._closingWindows = new Set();
        this._closingWindowSourceIds = new Map();
        this._states = new Map();
        this._workspaceModes = new Map();
        this._stripClips = new Map();
        this._dirtyStripClips = new Set();
        this._stripAnimations = new Map();
        this._parkedWindows = new Set();
        this._appliedRects = new Map();
        this._correctionHistory = new Map();
        this._forcePlacementWindows = new Set();
        this._grabbedWindow = null;
        this._inLayout = false;
        this._retileSourceId = 0;
        this._retileLaterId = 0;
        this._stripClipLaterId = 0;
        this._pendingRetileReasons = new Set();
        this._lastWorkAreaSignature = this._workAreaSignature();
        this._retilePassCount = 0;
        this._placementCommitCount = 0;
        this._placementSkipCount = 0;

        this._addKeybindings();
        this._connectSignals();
        this._trackExistingWindows();
        this._retileActiveWorkspace(new Set(['enable']));
    }

    disable() {
        for (const name of KEYBINDINGS)
            Main.wm.removeKeybinding(name);

        for (const [object, id] of this._signals)
            object.disconnect(id);

        for (const window of [...this._windowSignals.keys()])
            this._disconnectWindowSignals(window);

        for (const window of [...this._pendingRetileSignals.keys()])
            this._clearPendingWindowRetile(window);

        for (const sourceId of this._closingWindowSourceIds.values())
            GLib.source_remove(sourceId);

        this._releaseTilingPresentation();

        this._signals = [];
        this._windowSignals.clear();
        this._pendingRetileSignals.clear();
        this._closingWindows.clear();
        this._closingWindowSourceIds.clear();
        this._states.clear();
        this._workspaceModes.clear();
        this._stripClips.clear();
        this._dirtyStripClips.clear();
        this._stripAnimations.clear();
        this._parkedWindows.clear();
        this._appliedRects.clear();
        this._correctionHistory.clear();
        this._forcePlacementWindows.clear();
        this._pendingRetileReasons.clear();
        this._grabbedWindow = null;
        this._inLayout = false;
        this._settings = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _connectSignals() {
        this._connect(global.display, 'window-created', (_display, window) => {
            this._trackWindow(window);
            if (this._tilingEnabled())
                this._queueRetileAfterWindowReady(window);
        });
        this._connect(global.display, 'notify::focus-window', () => {
            this._syncActiveWindowToFocus();
        });
        this._connect(global.display, 'workareas-changed', () => {
            const signature = this._workAreaSignature();
            if (signature === this._lastWorkAreaSignature)
                return;

            this._lastWorkAreaSignature = signature;
            this._queueRetile('workareas-changed', WORKAREA_SETTLE_MS);
        });
        this._connect(global.workspace_manager, 'active-workspace-changed', () => {
            this._queueRetile('active-workspace-changed');
        });
        this._connect(global.workspace_manager, 'workspace-removed', () => {
            this._pruneStaleWorkspaces();
        });
        // Monitor indices reshuffle when displays are added, removed, or
        // rearranged, so per-index layout state cannot be trusted across a
        // change; rebuild the trees from the windows present afterwards.
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._releaseTilingPresentation();
            this._states.clear();
            this._lastWorkAreaSignature = this._workAreaSignature();
            this._queueRetile('monitors-changed');
        });
        // User moves/resizes happen under a grab. A resize is folded back
        // into the split ratios so the layout keeps the user's chosen size;
        // a plain move retiles the window back into its slot. The grabbed
        // window is tracked so drift correction never fights a live drag.
        this._connect(global.display, 'grab-op-begin', (_display, window, _op) => {
            this._grabbedWindow = window;
        });
        this._connect(global.display, 'grab-op-end', (_display, window, op) => {
            this._grabbedWindow = null;

            // In scrolling mode a drag-drop re-slots the window as its own
            // column at the nearest boundary (possibly on another monitor).
            if (op === Meta.GrabOp.MOVING && this._handleStripDrop(window)) {
                this._forcePlacementWindows.add(window);
                this._queueRetile('grab-drop');
                return;
            }

            this._applyGrabbedGeometry(window, op);
            // Position changes during the grab were intentionally ignored by
            // drift detection. Force the grabbed window even when its logical
            // target stayed unchanged (the ordinary BSP move/snap-back case).
            this._forcePlacementWindows.add(window);
            this._queueRetile('grab-end');
        });
        // Overview previews render through the live actors, so monitor clips
        // must lift while the overview is visible.
        this._connect(Main.overview, 'showing', () => {
            for (const {actor} of this._stripClips.values())
                actor.remove_clip();
        });
        this._connect(Main.overview, 'hidden', () => {
            for (const window of this._stripClips.keys())
                this._queueStripClipRefresh(window);
        });
        this._connect(this._settings, 'changed', (_settings, key) => {
            if (key === 'tiling-enabled') {
                if (this._tilingEnabled())
                    this._queueRetile('tiling-enabled');
                else
                    this._releaseTilingPresentation();
            } else if (key === 'gap-size') {
                this._queueRetile('gap-size');
            }
        });
    }

    _addKeybindings() {
        const handlers = {
            'toggle-tiling': () => this._toggleTiling(),
            'toggle-layout-mode': () => this._toggleLayoutMode(),
            'retile-workspace': () => {
                // An explicit retile is the user overruling any window that
                // was left alone after fighting its tile; give those windows
                // a fresh correction budget.
                this._correctionHistory.clear();
                this._retileActiveWorkspace(new Set(['manual-retile']));
            },
            'equalize-ratios': () => this._equalizeRatios(),
            'focus-column-left': () => this._focusNeighbor('x', -1),
            'focus-column-right': () => this._focusNeighbor('x', 1),
            'focus-up': () => this._focusNeighbor('y', -1),
            'focus-down': () => this._focusNeighbor('y', 1),
            'move-window-left': () => this._moveFocusedWindow('x', -1),
            'move-window-right': () => this._moveFocusedWindow('x', 1),
            'move-window-up': () => this._moveFocusedWindow('y', -1),
            'move-window-down': () => this._moveFocusedWindow('y', 1),
            'move-window-new-column': () => this._moveFocusedWindowToNewColumn(),
            'stack-window-left': () => this._stackFocusedWindow(-1),
            'stack-window-right': () => this._stackFocusedWindow(1),
            'cycle-column-width': () => this._cycleColumnWidth(),
        };

        for (const name of KEYBINDINGS) {
            // Focus bindings may repeat while held; everything else acts once
            // per press so a held key cannot churn the tree.
            const flags = name.startsWith('focus-')
                ? Meta.KeyBindingFlags.NONE
                : Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;

            const action = Main.wm.addKeybinding(
                name,
                this._settings,
                flags,
                Shell.ActionMode.NORMAL,
                handlers[name]
            );

            if (action === Meta.KeyBindingAction.NONE)
                console.warn(`[ohno-scroller] keybinding '${name}' was not added (accelerator already in use?)`);
        }
    }

    _toggleTiling() {
        this._settings.set_boolean('tiling-enabled', !this._settings.get_boolean('tiling-enabled'));
    }

    // A workspace's layout mode is decided lazily from the default and then
    // sticks to the workspace object for the session, so changing the default
    // never yanks the layout out from under an existing workspace.
    _workspaceMode(workspace) {
        let mode = this._workspaceModes.get(workspace);
        if (!mode) {
            mode = this._settings.get_string('default-layout-mode');
            if (!LAYOUT_MODES.has(mode))
                mode = 'bsp';
            this._workspaceModes.set(workspace, mode);
        }

        return mode;
    }

    _toggleLayoutMode() {
        if (!this._tilingEnabled())
            return;

        const workspace = this._activeWorkspace();
        const next = this._workspaceMode(workspace) === 'scrolling' ? 'bsp' : 'scrolling';
        this._workspaceModes.set(workspace, next);

        const gap = this._settings.get_int('gap-size');
        for (let monitor = 0; monitor < global.display.get_n_monitors(); monitor++) {
            const state = this._stateFor(workspace, monitor);
            const workArea = workspace.get_work_area_for_monitor(monitor);

            if (next === 'scrolling')
                this._convertTreeToStrip(state, workArea, gap);
            else
                this._convertStripToTree(state, workArea, gap);
        }

        this._log(`workspace ${workspace.index()} layout mode -> ${next}`);
        this._correctionHistory.clear();
        this._retileActiveWorkspace();
    }

    // BSP -> strip keeps the on-screen spatial order: leaves become columns
    // sorted by tile center. Strip -> BSP feeds windows left-to-right,
    // top-to-bottom through the ordinary insertion path. Per the design, the
    // abandoned mode's state is discarded, not maintained in parallel.
    _convertTreeToStrip(state, workArea, gap) {
        const rects = this._layoutRects(state.root, this._insetRect(workArea, gap), gap);
        rects.sort((a, b) => {
            const ax = a.rect.x + a.rect.width / 2;
            const bx = b.rect.x + b.rect.width / 2;
            if (ax !== bx)
                return ax - bx;

            return (a.rect.y + a.rect.height / 2) - (b.rect.y + b.rect.height / 2);
        });

        const width = this._defaultColumnWidth();
        const strip = this._newStrip();
        strip.columns = rects.map(({window}) => this._newColumn([window], width));

        const focused = strip.columns.findIndex(column => column.windows.includes(state.activeWindow));
        strip.focusColumn = focused >= 0 ? focused : (strip.columns.length > 0 ? 0 : -1);

        state.strip = strip;
        state.root = null;
    }

    _convertStripToTree(state, workArea, gap) {
        const windows = this._stripWindows(state.strip);
        const focused = this._stripFocusedWindow(state.strip);

        for (const window of windows) {
            this._unclipStripWindow(window);
            this._unparkStripWindow(window);
        }

        state.strip = null;
        state.root = null;
        for (const window of windows)
            this._insertWindow(state, window, workArea, gap);

        if (focused)
            state.activeWindow = focused;
    }

    // Reset every split on the active workspace back to 50/50 (BSP) or every
    // stack back to equal heights (scrolling) — the undo for accumulated
    // resize adjustments.
    _equalizeRatios() {
        if (!this._tilingEnabled())
            return;

        const perMonitor = this._states.get(this._activeWorkspace());
        if (!perMonitor)
            return;

        for (const state of perMonitor.values()) {
            this._resetRatios(state.root);

            for (const column of state.strip?.columns ?? [])
                column.heightWeights = column.windows.map(() => 1);
        }

        this._retileActiveWorkspace();
    }

    _resetRatios(node) {
        if (!node || node.type === 'leaf')
            return;

        node.ratio = 0.5;
        this._resetRatios(node.first);
        this._resetRatios(node.second);
    }

    _queueRetile(reason = 'unspecified', delayMs = 0) {
        // Keep compatibility with the old private call shape while every
        // internal caller migrates to reason-tagged requests.
        if (typeof reason === 'number') {
            delayMs = reason;
            reason = 'unspecified';
        }

        this._pendingRetileReasons.add(reason);

        // An immediate transaction already queued for this repaint subsumes
        // delayed requests. Their reasons remain attached to that transaction.
        if (this._retileLaterId)
            return;

        if (delayMs > 0) {
            // Delayed requests use trailing debounce: a settling burst creates
            // one transaction after the final notification.
            if (this._retileSourceId)
                GLib.source_remove(this._retileSourceId);

            this._retileSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                this._retileSourceId = 0;
                this._scheduleRetileBeforeRedraw();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (this._retileSourceId) {
            GLib.source_remove(this._retileSourceId);
            this._retileSourceId = 0;
        }

        this._scheduleRetileBeforeRedraw();
    }

    _scheduleRetileBeforeRedraw() {
        if (this._retileLaterId)
            return;

        // Lay out right before the next repaint instead of from an idle
        // source, so windows never paint a frame in a pre-tile position.
        this._retileLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._retileLaterId = 0;
            const reasons = this._consumeRetileReasons();
            if (this._settings)
                this._retileActiveWorkspace(reasons);
            return GLib.SOURCE_REMOVE;
        });
    }

    _consumeRetileReasons() {
        const reasons = this._pendingRetileReasons;
        this._pendingRetileReasons = new Set();
        return reasons;
    }

    _cancelQueuedRetile() {
        if (this._retileSourceId) {
            GLib.source_remove(this._retileSourceId);
            this._retileSourceId = 0;
        }

        if (this._retileLaterId) {
            global.compositor.get_laters().remove(this._retileLaterId);
            this._retileLaterId = 0;
        }

        this._pendingRetileReasons.clear();
    }

    _workAreaSignature(workspace = this._activeWorkspace()) {
        if (!workspace)
            return '';

        const rects = [];
        const monitorCount = global.display.get_n_monitors();
        for (let monitor = 0; monitor < monitorCount; monitor++) {
            try {
                const rect = workspace.get_work_area_for_monitor(monitor);
                rects.push(`${rect.x},${rect.y},${rect.width},${rect.height}`);
            } catch (_error) {
                rects.push('unavailable');
            }
        }

        return rects.join('|');
    }

    _releaseTilingPresentation() {
        this._cancelQueuedRetile();
        this._cancelQueuedStripClipRefresh();

        for (const window of [...this._stripAnimations.keys()])
            this._stopStripAnimation(window, true);

        for (const window of [...this._stripClips.keys()])
            this._unclipStripWindow(window);

        for (const window of [...this._parkedWindows])
            this._unparkStripWindow(window);

        this._appliedRects.clear();
        this._correctionHistory.clear();
        this._forcePlacementWindows.clear();
    }

    _tilingEnabled() {
        return this._settings?.get_boolean('tiling-enabled') ?? false;
    }

    _activeWorkspace() {
        return global.workspace_manager.get_active_workspace();
    }

    _stateFor(workspace, monitor) {
        // Key by the workspace object, not workspace.index(): GNOME's dynamic
        // workspaces renumber on removal, so an index key would silently rebind
        // saved layout state to a different workspace.
        let perMonitor = this._states.get(workspace);
        if (!perMonitor) {
            perMonitor = new Map();
            this._states.set(workspace, perMonitor);
        }

        if (!perMonitor.has(monitor))
            perMonitor.set(monitor, {root: null, strip: null, activeWindow: null});

        return perMonitor.get(monitor);
    }

    _pruneStaleWorkspaces() {
        const manager = global.workspace_manager;
        const live = new Set();
        for (let index = 0; index < manager.get_n_workspaces(); index++)
            live.add(manager.get_workspace_by_index(index));

        const remembered = new Set([
            ...this._states.keys(),
            ...this._workspaceModes.keys(),
        ]);

        for (const workspace of remembered) {
            if (live.has(workspace))
                continue;

            const perMonitor = this._states.get(workspace);
            for (const state of perMonitor?.values() ?? []) {
                const windows = new Set([
                    ...this._leafWindows(state.root),
                    ...this._stripWindows(state.strip),
                ]);
                for (const window of windows) {
                    this._stopStripAnimation(window, true);
                    this._unclipStripWindow(window);
                    this._unparkStripWindow(window);
                    this._appliedRects.delete(window);
                    this._correctionHistory.delete(window);
                    this._forcePlacementWindows.delete(window);
                }
            }

            this._states.delete(workspace);
            this._workspaceModes.delete(workspace);
            this._log('pruned layout state and presentation for a removed workspace');
        }
    }

    _syncActiveWindowToFocus() {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;

        if (!window || !this._isTileable(window))
            return;

        const workspace = window.get_workspace();

        if (this._workspaceMode(workspace) === 'scrolling') {
            const located = this._locateInStrips(workspace, window);

            if (located) {
                const {state, at} = located;
                const strip = state.strip;
                const column = strip.columns[at.column];
                const moved = strip.focusColumn !== at.column || column.focusIndex !== at.index;

                strip.focusColumn = at.column;
                column.focusIndex = at.index;
                state.activeWindow = window;

                // The focused column must always be centered; any focus that
                // arrives from outside our own handlers (click, alt-tab,
                // overview) scrolls the strip.
                if (moved && workspace === this._activeWorkspace())
                    this._queueRetile();
            } else if (this._tilingEnabled() && workspace === this._activeWorkspace()) {
                this._log(`focused window '${window.get_title() ?? '?'}' missing from strip; re-admitting`);
                this._queueRetile();
            }

            return;
        }

        const state = this._stateFor(workspace, window.get_monitor());

        if (this._containsWindow(state.root, window)) {
            state.activeWindow = window;
        } else if (this._tilingEnabled() && workspace === this._activeWorkspace()) {
            // Some windows only become tileable after their initial retile
            // (allows_resize flips late, skip-taskbar drops, transient hint
            // clears). Focus is the reliable moment to admit the stragglers.
            this._log(`focused window '${window.get_title() ?? '?'}' missing from layout; re-admitting`);
            this._queueRetile();
        }
    }

    // Find the (state, position) of a window in any of the workspace's
    // strips. Strips are monitor-sticky, so all monitors are searched rather
    // than trusting get_monitor() for scrolled-out windows.
    _locateInStrips(workspace, window) {
        for (let monitor = 0; monitor < global.display.get_n_monitors(); monitor++) {
            const state = this._stateFor(workspace, monitor);
            const at = this._findInStrip(state.strip, window);
            if (at)
                return {state, monitor, at};
        }

        return null;
    }

    _tileableWindows(workspace, monitor) {
        const windows = global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, workspace)
            .filter(window => window.get_monitor() === monitor)
            .filter(window => !this._closingWindows.has(window))
            .filter(window => this._isTileable(window));

        for (const window of windows)
            this._trackWindow(window);

        return windows;
    }

    _isTileable(window) {
        if (!window || window.minimized)
            return false;

        if (!window.get_workspace())
            return false;

        if (!NORMAL_WINDOW_TYPES.has(window.get_window_type()))
            return false;

        // Float transient windows (e.g. dialogs, file choosers, tool palettes)
        // over their parent instead of tiling them.
        if (window.get_transient_for())
            return false;

        if (window.is_fullscreen && window.is_fullscreen())
            return false;

        return window.allows_resize() && !window.skip_taskbar;
    }

    _canPlace(window) {
        return this._isTileable(window) &&
            !this._closingWindows.has(window) &&
            window.get_compositor_private() !== null;
    }

    _trackWindow(window) {
        if (!window || this._windowSignals.has(window))
            return;

        // State toggles that change whether the window participates in tiling
        // are tracked, and so is its geometry: apps that restore their own
        // size/position after being placed used to stay wherever they put
        // themselves, overlapping their neighbors. Our own placements echo
        // back inside the applied-rect tolerance (or during _inLayout), so
        // only real app-driven drift reaches the corrective retile — and
        // _onWindowGeometryChanged caps corrections per target rect so a
        // window that refuses its tile cannot ping-pong forever.
        const queueUnlessLayout = () => {
            if (!this._inLayout && this._tilingEnabled())
                this._queueRetile();
        };
        const releaseAfterWorkspaceChange = () => {
            if (this._inLayout)
                return;

            // A window leaving an active scrolling workspace must not carry a
            // monitor clip, compositor translation, or parked visibility into
            // its new workspace. Its new owner will establish fresh state.
            this._stopStripAnimation(window, true);
            this._unclipStripWindow(window);
            this._unparkStripWindow(window);
            this._appliedRects.delete(window);
            this._correctionHistory.delete(window);
            this._forcePlacementWindows.delete(window);
            if (this._tilingEnabled())
                this._queueRetile('window-workspace-changed');
        };

        const signalIds = [
            window.connect('workspace-changed', releaseAfterWorkspaceChange),
            window.connect('notify::minimized', queueUnlessLayout),
            window.connect('notify::fullscreen', queueUnlessLayout),
            window.connect('notify::maximized-horizontally', () => this._onWindowMaximizedChanged(window)),
            window.connect('notify::maximized-vertically', () => this._onWindowMaximizedChanged(window)),
            window.connect('size-changed', () => this._onWindowGeometryChanged(window)),
            window.connect('position-changed', () => this._onWindowGeometryChanged(window)),
            window.connect('unmanaged', () => {
                this._clearPendingWindowRetile(window);
                this._disconnectWindowSignals(window);
                this._stopStripAnimation(window);
                this._unclipStripWindow(window);
                this._parkedWindows.delete(window);
                this._correctionHistory.delete(window);
                this._forcePlacementWindows.delete(window);
                const wasPlaced = this._appliedRects.delete(window);
                const wasInLayout = this._removeWindowFromStates(window);

                // Menus, tooltips and other never-tiled windows come and go
                // constantly; only a window that actually held a tile
                // warrants the closing dance and a follow-up retile.
                if (wasPlaced || wasInLayout) {
                    this._markWindowClosing(window);
                    this._queueRetile(250);
                }
            }),
        ];

        this._windowSignals.set(window, signalIds);
    }

    _disconnectWindowSignals(window) {
        const signalIds = this._windowSignals.get(window);
        if (!signalIds)
            return;

        this._windowSignals.delete(window);

        for (const signalId of signalIds) {
            try {
                window.disconnect(signalId);
            } catch (_error) {
                // The window may already be unmanaged while signals are being cleaned up.
            }
        }
    }

    _markWindowClosing(window) {
        if (!window)
            return;

        this._closingWindows.add(window);

        const previousSourceId = this._closingWindowSourceIds.get(window);
        if (previousSourceId)
            GLib.source_remove(previousSourceId);

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._closingWindowSourceIds.delete(window);
            this._closingWindows.delete(window);
            this._queueRetile();
            return GLib.SOURCE_REMOVE;
        });

        this._closingWindowSourceIds.set(window, sourceId);
    }

    _removeWindowFromStates(window) {
        let removed = false;

        for (const perMonitor of this._states.values()) {
            for (const state of perMonitor.values()) {
                if (this._findInStrip(state.strip, window)) {
                    removed = true;
                    this._removeFromStrip(state, window);
                }

                const previous = this._leafWindows(state.root);
                const remaining = previous
                    .filter(item => item !== window);

                if (remaining.length === previous.length)
                    continue;

                removed = true;
                state.root = this._pruneTree(state.root, new Set(remaining));

                if (state.activeWindow === window)
                    state.activeWindow = this._lastWindow(state.root);
            }
        }

        return removed;
    }

    // Closing a window collapses its column if empty; focus falls back to
    // the previous column (per the design) and the follow-up retile
    // re-centers on it.
    _removeFromStrip(state, window) {
        const strip = state.strip;
        const at = this._findInStrip(strip, window);
        if (!at)
            return;

        const wasFocused = this._stripFocusedWindow(strip) === window;
        const column = strip.columns[at.column];
        column.windows.splice(at.index, 1);
        column.heightWeights.splice(at.index, 1);
        column.focusIndex = Math.max(0, Math.min(column.focusIndex, column.windows.length - 1));

        if (column.windows.length === 0) {
            strip.columns.splice(at.column, 1);
            if (wasFocused)
                strip.focusColumn = at.column - 1;
        }

        strip.focusColumn = Math.max(0, Math.min(strip.focusColumn, strip.columns.length - 1));
        if (strip.columns.length === 0)
            strip.focusColumn = -1;

        state.activeWindow = this._stripFocusedWindow(strip);
    }

    // Maximize in scrolling mode folds into the column: the column takes the
    // full work-area width and the window itself is un-maximized on the
    // spot. Hitting maximize again restores the remembered width, so the
    // maximize key toggles full-width for the column. Explicit width changes
    // (preset cycle, edge drag) discard the remembered width. BSP keeps the
    // old behavior (a maximized window floats above the tiles until
    // unmaximized, because it stops being resizable).
    _onWindowMaximizedChanged(window) {
        if (this._inLayout || !this._settings || !this._tilingEnabled())
            return;

        if (window.maximized_horizontally || window.maximized_vertically) {
            const workspace = window.get_workspace();

            if (workspace && this._workspaceMode(workspace) === 'scrolling' &&
                NORMAL_WINDOW_TYPES.has(window.get_window_type()) &&
                !window.get_transient_for()) {
                const located = this._locateInStrips(workspace, window);

                if (located) {
                    const column = located.state.strip.columns[located.at.column];

                    if (column.savedWidthFraction !== null && column.widthFraction >= COLUMN_WIDTH_MAX) {
                        column.widthFraction = column.savedWidthFraction;
                        column.savedWidthFraction = null;
                        this._log('maximize toggle: column width restored');
                    } else if (column.widthFraction < COLUMN_WIDTH_MAX) {
                        column.savedWidthFraction = column.widthFraction;
                        column.widthFraction = COLUMN_WIDTH_MAX;
                        this._log('maximize: column width -> 100%');
                    }
                }

                // Un-maximize right away rather than during placement: a
                // maximized window reports allows_resize() false, so leaving
                // it maximized until the retile would drop it from the strip
                // instead of folding it. Covers app self-maximization too.
                window.unmaximize();
            }
        }

        this._forcePlacementWindows.add(window);
        this._queueRetile('maximized-changed');
    }

    // App-driven geometry changes (session restore, late self-resize) used to
    // stick, leaving the window on top of its neighbors. Snap the layout back
    // when a placed window drifts off its applied rect, with a per-target cap
    // so a window that refuses its tile cannot loop.
    _onWindowGeometryChanged(window) {
        if (this._inLayout || !this._settings || !this._tilingEnabled())
            return;

        if (this._grabbedWindow === window)
            return;

        const applied = this._appliedRects.get(window);
        if (!applied || !this._isTileable(window))
            return;

        if (window.get_workspace() !== this._activeWorkspace())
            return;

        // Multiple geometry notifications for one drift must consume only one
        // correction. A queued general transaction is not enough by itself:
        // changed-only placement needs this explicit force marker.
        if (this._forcePlacementWindows.has(window))
            return;

        let frame;
        try {
            frame = window.get_frame_rect();
        } catch (_error) {
            return;
        }

        if (!frame)
            return;

        const drifted =
            Math.abs(frame.x - applied.x) > DRIFT_POSITION_TOLERANCE ||
            Math.abs(frame.y - applied.y) > DRIFT_POSITION_TOLERANCE ||
            Math.abs(frame.width - applied.width) > DRIFT_SIZE_TOLERANCE ||
            Math.abs(frame.height - applied.height) > DRIFT_SIZE_TOLERANCE;

        if (!drifted)
            return;

        const targetKey = `${applied.x},${applied.y},${applied.width},${applied.height}`;
        let corrections = this._correctionHistory.get(window);
        if (!corrections || corrections.targetKey !== targetKey) {
            corrections = {targetKey, count: 0, warned: false};
            this._correctionHistory.set(window, corrections);
        }

        if (corrections.count >= DRIFT_CORRECTION_LIMIT) {
            if (!corrections.warned) {
                corrections.warned = true;
                console.warn(`[ohno-scroller] '${window.get_title() ?? '?'}' refuses its tile after ${DRIFT_CORRECTION_LIMIT} corrections; leaving it alone until the layout changes`);
            }
            return;
        }

        corrections.count++;
        this._log(`geometry drift on '${window.get_title() ?? '?'}'; re-asserting layout (${corrections.count}/${DRIFT_CORRECTION_LIMIT})`);
        this._forcePlacementWindows.add(window);
        this._queueRetile('geometry-drift');
    }

    _queueRetileAfterWindowReady(window) {
        if (!window) {
            this._queueRetile();
            return;
        }

        if (this._pendingRetileSignals.has(window))
            return;

        const actor = typeof window.get_compositor_private === 'function'
            ? window.get_compositor_private()
            : null;

        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._clearPendingWindowRetile(window, false);
            this._queueRetile();
            return GLib.SOURCE_REMOVE;
        });

        if (!actor || typeof actor.connect !== 'function') {
            this._pendingRetileSignals.set(window, {actor: null, signalId: 0, destroyId: 0, timeoutId});
            return;
        }

        const signalId = actor.connect('first-frame', () => {
            this._clearPendingWindowRetile(window);
            this._queueRetile();
        });

        // Short-lived windows (menus, tooltips) can be destroyed before the
        // fallback timeout fires. Retire the pending entry together with the
        // actor so nothing touches the actor after it is disposed; the
        // unmanaged handler decides whether a retile is warranted.
        const destroyId = actor.connect('destroy', () => {
            const pending = this._pendingRetileSignals.get(window);
            if (!pending)
                return;

            this._pendingRetileSignals.delete(window);
            if (pending.timeoutId)
                GLib.source_remove(pending.timeoutId);
        });

        this._pendingRetileSignals.set(window, {actor, signalId, destroyId, timeoutId});
    }

    _clearPendingWindowRetile(window, removeTimeout = true) {
        const pending = this._pendingRetileSignals.get(window);
        if (!pending)
            return;

        this._pendingRetileSignals.delete(window);

        if (pending.actor) {
            try {
                if (pending.signalId)
                    pending.actor.disconnect(pending.signalId);
                if (pending.destroyId)
                    pending.actor.disconnect(pending.destroyId);
            } catch (_error) {
                // The actor may already be gone while its window is unmanaging.
            }
        }

        if (removeTimeout && pending.timeoutId)
            GLib.source_remove(pending.timeoutId);
    }

    _retileActiveWorkspace(reasons = new Set(['direct'])) {
        if (!this._tilingEnabled())
            return;

        const workspace = this._activeWorkspace();
        const mode = this._workspaceMode(workspace);
        const monitorCount = global.display.get_n_monitors();
        const gap = this._settings.get_int('gap-size');
        const forceAll = reasons.has('manual-retile');
        const stats = this._newPlacementStats();

        this._retilePassCount++;

        if (mode === 'scrolling') {
            this._mergePlacementStats(
                stats,
                this._retileStrips(workspace, monitorCount, gap, forceAll)
            );
            this._recordRetileStats(workspace, mode, reasons, stats);
            return;
        }

        for (let monitor = 0; monitor < monitorCount; monitor++) {
            const windows = this._tileableWindows(workspace, monitor);
            const state = this._stateFor(workspace, monitor);
            const workArea = workspace.get_work_area_for_monitor(monitor);

            this._syncWindows(state, windows, workArea, gap);
            this._mergePlacementStats(stats, this._layout(workArea, gap, state, forceAll));
        }

        this._recordRetileStats(workspace, mode, reasons, stats);
    }

    // Strip membership must be sticky: a scrolled-out column sits at
    // coordinates that spatially belong to a neighboring monitor, so
    // get_monitor() cannot be trusted for windows a strip already owns.
    // Only windows no strip has claimed are assigned by monitor.
    _retileStrips(workspace, monitorCount, gap, forceAll = false) {
        const workspaceWindows = global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, workspace)
            .filter(window => !this._closingWindows.has(window))
            .filter(window => this._isTileable(window));

        for (const window of workspaceWindows)
            this._trackWindow(window);

        const claimed = new Map();
        for (let monitor = 0; monitor < monitorCount; monitor++) {
            const state = this._stateFor(workspace, monitor);
            for (const window of this._stripWindows(state.strip))
                claimed.set(window, monitor);
        }

        const perMonitor = Array.from({length: monitorCount}, () => []);
        for (const window of workspaceWindows) {
            const monitor = claimed.get(window) ?? window.get_monitor();
            if (monitor >= 0 && monitor < monitorCount)
                perMonitor[monitor].push(window);
        }

        const placed = new Set();
        const stats = this._newPlacementStats();
        for (let monitor = 0; monitor < monitorCount; monitor++) {
            const state = this._stateFor(workspace, monitor);
            const workArea = workspace.get_work_area_for_monitor(monitor);

            this._syncStrip(state, perMonitor[monitor]);
            this._mergePlacementStats(
                stats,
                this._layoutStrip(state, workArea, gap, monitor, forceAll)
            );

            for (const window of this._stripWindows(state.strip))
                placed.add(window);
        }

        // Windows that left every strip this pass (closed, floated, mode
        // change elsewhere) must not keep a stale monitor clip or stay
        // parked-invisible.
        for (const window of [...this._stripClips.keys()]) {
            if (!placed.has(window) && window.get_workspace() === workspace)
                this._unclipStripWindow(window);
        }
        for (const window of [...this._parkedWindows]) {
            if (!placed.has(window) && window.get_workspace() === workspace)
                this._unparkStripWindow(window);
        }

        return stats;
    }

    _syncWindows(state, windows, workArea, gap) {
        const windowSet = new Set(windows);

        state.root = this._pruneTree(state.root, windowSet);

        const assigned = new Set(this._leafWindows(state.root));
        const newWindows = windows.filter(window => !assigned.has(window));

        for (const window of newWindows)
            this._insertWindow(state, window, workArea, gap);

        if (!this._containsWindow(state.root, state.activeWindow))
            state.activeWindow = this._lastWindow(state.root);
    }

    _layout(workArea, gap, state, forceAll = false) {
        if (!state.root)
            return this._newPlacementStats();

        const placements = this._layoutRects(state.root, this._insetRect(workArea, gap), gap);
        return this._applyPlacements(placements, workArea, false, forceAll);
    }

    _applyPlacements(placements, workArea, stripPlacement, forceAll = false) {
        // Mark our own placement pass so the geometry signals it provokes do not
        // bounce back in as fresh retile requests.
        const stats = this._newPlacementStats();
        this._inLayout = true;
        try {
            for (const {window, rect} of placements) {
                if (!this._canPlace(window)) {
                    this._log('placement skipped: window is not currently placeable');
                    continue;
                }

                const safeRect = stripPlacement
                    ? this._safeStripRect(rect, workArea)
                    : this._safeRect(rect, workArea);

                if (!safeRect) {
                    this._log('placement skipped: computed rect was degenerate/non-finite');
                    continue;
                }

                if (safeRect.clamped)
                    this._log(`tile below minimum size; clamped to ${safeRect.width}x${safeRect.height}`);

                const target = {
                    x: safeRect.x,
                    y: safeRect.y,
                    width: safeRect.width,
                    height: safeRect.height,
                };
                const previous = this._appliedRects.get(window);
                const targetChanged = !this._rectsEqual(previous, target);
                const forced = forceAll || this._forcePlacementWindows.has(window);

                if (!targetChanged && !forced) {
                    stats.skipped++;
                    continue;
                }

                // Tiled windows must not stay maximized or they cover the rest of
                // the layout; drop maximization before applying the tile rect.
                // (Mutter 50 dropped the flags argument: unmaximize() is total.)
                if (window.maximized_horizontally || window.maximized_vertically)
                    window.unmaximize();

                // Strip placement must be a user op: Mutter forces non-user
                // placements fully on-screen, which would fold the whole
                // strip onto the monitor.
                try {
                    window.move_resize_frame(
                        stripPlacement,
                        target.x,
                        target.y,
                        target.width,
                        target.height
                    );
                } catch (error) {
                    console.warn(`[ohno-scroller] placement failed: ${error.message}`);
                    continue;
                }

                this._appliedRects.set(window, target);
                this._forcePlacementWindows.delete(window);
                if (targetChanged)
                    this._correctionHistory.delete(window);
                stats.committed++;
                stats.committedWindows.add(window);
            }
        } finally {
            this._inLayout = false;
        }

        return stats;
    }

    _rectsEqual(first, second) {
        return Boolean(first && second &&
            first.x === second.x &&
            first.y === second.y &&
            first.width === second.width &&
            first.height === second.height);
    }

    _newPlacementStats() {
        return {committed: 0, skipped: 0, committedWindows: new Set()};
    }

    _mergePlacementStats(target, source) {
        if (!source)
            return target;

        target.committed += source.committed;
        target.skipped += source.skipped;
        for (const window of source.committedWindows)
            target.committedWindows.add(window);
        return target;
    }

    _recordRetileStats(workspace, mode, reasons, stats) {
        this._placementCommitCount += stats.committed;
        this._placementSkipCount += stats.skipped;
        const reasonText = [...reasons].sort().join(',') || 'unspecified';
        this._log(`retile #${this._retilePassCount} ws=${workspace.index()} mode=${mode} reasons=${reasonText} committed=${stats.committed} unchanged=${stats.skipped}`);
    }

    // The strip variant of _safeRect: vertical bounds and sizes clamp to the
    // work area exactly like BSP tiles, but horizontal position roams — only
    // clamped into the band Mutter will actually honor (at least
    // MUTTER_MIN_ONSCREEN pixels visible), so the recorded applied rect is
    // always exactly where the frame lands and drift correction stays honest.
    _safeStripRect(rect, bounds) {
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
            return null;

        let width = Math.floor(rect.width);
        let height = Math.floor(rect.height);
        let clamped = false;

        if (width < MIN_TILE_SIZE) {
            width = Math.min(MIN_TILE_SIZE, bounds.width);
            clamped = true;
        }
        if (width > bounds.width) {
            width = bounds.width;
            clamped = true;
        }
        if (height < MIN_TILE_SIZE) {
            height = Math.min(MIN_TILE_SIZE, bounds.height);
            clamped = true;
        }
        if (height > bounds.height) {
            height = bounds.height;
            clamped = true;
        }

        const y = Math.max(bounds.y, Math.min(Math.floor(rect.y), bounds.y + bounds.height - height));
        const x = Math.max(bounds.x + MUTTER_MIN_ONSCREEN - width,
            Math.min(Math.floor(rect.x), bounds.x + bounds.width - MUTTER_MIN_ONSCREEN));

        return {x, y, width, height, clamped};
    }

    // Pick the tile nearest to `window` whose center lies in `direction`
    // (-1 left/up, +1 right/down) along `axis`. Distance along the axis
    // dominates; the cross-axis distance breaks ties so stacked tiles
    // resolve to the row/column the window actually sits in.
    _spatialNeighbor(state, workspace, monitor, window, axis, direction) {
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const gap = this._settings.get_int('gap-size');
        const rects = this._layoutRects(state.root, this._insetRect(workArea, gap), gap);
        const current = rects.find(item => item.window === window);

        if (!current)
            return null;

        const currentCenter = this._rectCenter(current.rect);
        let best = null;
        let bestDistance = Infinity;

        for (const {window: candidate, rect} of rects) {
            if (candidate === window)
                continue;

            const center = this._rectCenter(rect);
            const primary = axis === 'x'
                ? center.x - currentCenter.x
                : center.y - currentCenter.y;
            const secondary = axis === 'x'
                ? Math.abs(center.y - currentCenter.y)
                : Math.abs(center.x - currentCenter.x);

            if (direction < 0 ? primary >= 0 : primary <= 0)
                continue;

            const distance = Math.abs(primary) * 4 + secondary;

            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
            }
        }

        return best;
    }

    _rectCenter(rect) {
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    }

    _focusNeighbor(axis, direction) {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();

        if (this._workspaceMode(workspace) === 'scrolling') {
            const located = this._locateInStrips(workspace, window);
            if (!located)
                return;

            const target = this._stripNeighbor(located.state.strip, located.at, axis, direction);
            if (target)
                this._focusStripWindow(located.state, target);

            return;
        }

        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const neighbor = this._spatialNeighbor(state, workspace, monitor, window, axis, direction);

        if (neighbor) {
            state.activeWindow = neighbor;
            neighbor.activate(global.get_current_time());
        }
    }

    // x steps between columns (landing on the target column's remembered
    // window); y steps within the focused column's stack, stopping at the
    // ends.
    _stripNeighbor(strip, at, axis, direction) {
        if (axis === 'y') {
            const column = strip.columns[at.column];
            return column.windows[at.index + direction] ?? null;
        }

        const column = strip.columns[at.column + direction];
        if (!column)
            return null;

        return column.windows[Math.min(column.focusIndex, column.windows.length - 1)] ?? null;
    }

    _focusStripWindow(state, window) {
        const at = this._findInStrip(state.strip, window);
        if (!at)
            return;

        state.strip.focusColumn = at.column;
        state.strip.columns[at.column].focusIndex = at.index;
        state.activeWindow = window;
        window.activate(global.get_current_time());
        this._queueRetile();
    }

    _moveFocusedWindow(axis, direction) {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();

        if (this._workspaceMode(workspace) === 'scrolling') {
            const located = this._locateInStrips(workspace, window);
            if (located)
                this._moveInStrip(located.state, window, located.at, axis, direction);

            return;
        }

        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const neighbor = this._spatialNeighbor(state, workspace, monitor, window, axis, direction);

        if (!neighbor)
            return;

        this._swapLeafWindows(state.root, window, neighbor);
        state.activeWindow = window;

        this._layout(
            workspace.get_work_area_for_monitor(monitor),
            this._settings.get_int('gap-size'),
            state
        );
        window.activate(global.get_current_time());
    }

    // x reorders whole columns; y reorders within the stack. Height weights
    // stay with the slots so a user-sized layout keeps its shape as windows
    // move through it.
    _moveInStrip(state, window, at, axis, direction) {
        const strip = state.strip;

        if (axis === 'x') {
            const target = at.column + direction;
            if (target < 0 || target >= strip.columns.length)
                return;

            const [column] = strip.columns.splice(at.column, 1);
            strip.columns.splice(target, 0, column);
            strip.focusColumn = target;
        } else {
            const column = strip.columns[at.column];
            const target = at.index + direction;
            if (target < 0 || target >= column.windows.length)
                return;

            [column.windows[at.index], column.windows[target]] =
                [column.windows[target], column.windows[at.index]];
            column.focusIndex = target;
        }

        state.activeWindow = window;
        window.activate(global.get_current_time());
        this._queueRetile();
    }

    // Merge the focused window into the neighboring column's stack — the way
    // stacks are built. At the strip's edge there is no neighbor; expel
    // (move-window-new-column) is the tool for splitting back out.
    _stackFocusedWindow(direction) {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();
        if (this._workspaceMode(workspace) !== 'scrolling')
            return;

        const located = this._locateInStrips(workspace, window);
        if (!located)
            return;

        const {state, at} = located;
        const strip = state.strip;
        const target = strip.columns[at.column + direction];
        if (!target)
            return;

        const source = strip.columns[at.column];
        source.windows.splice(at.index, 1);
        source.heightWeights.splice(at.index, 1);
        source.focusIndex = Math.max(0, Math.min(source.focusIndex, source.windows.length - 1));

        target.windows.push(window);
        target.heightWeights.push(1);
        target.focusIndex = target.windows.length - 1;

        if (source.windows.length === 0)
            strip.columns.splice(strip.columns.indexOf(source), 1);

        strip.focusColumn = strip.columns.indexOf(target);
        state.activeWindow = window;
        window.activate(global.get_current_time());
        this._queueRetile();
    }

    _moveFocusedWindowToNewColumn() {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();

        if (this._workspaceMode(workspace) === 'scrolling') {
            const located = this._locateInStrips(workspace, window);
            if (!located)
                return;

            const {state, at} = located;
            const strip = state.strip;
            const column = strip.columns[at.column];
            if (column.windows.length < 2)
                return; // already its own column

            column.windows.splice(at.index, 1);
            column.heightWeights.splice(at.index, 1);
            column.focusIndex = Math.max(0, Math.min(column.focusIndex, column.windows.length - 1));

            strip.columns.splice(at.column + 1, 0, this._newColumn([window], this._defaultColumnWidth()));
            strip.focusColumn = at.column + 1;
            state.activeWindow = window;
            window.activate(global.get_current_time());
            this._queueRetile();
            return;
        }

        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const gap = this._settings.get_int('gap-size');
        const previousLeaves = this._leafWindows(state.root);
        const previousIndex = previousLeaves.indexOf(window);

        const remainingWindowSet = new Set(this._leafWindows(state.root)
            .filter(item => item !== window));

        state.root = this._pruneTree(state.root, remainingWindowSet);
        const remainingLeaves = this._leafWindows(state.root);
        const nextActiveIndex = Math.min(previousIndex, remainingLeaves.length - 1);

        state.activeWindow = remainingLeaves[nextActiveIndex] ?? this._lastWindow(state.root);

        this._insertWindow(state, window, workArea, gap);
        state.activeWindow = window;

        this._layout(workArea, gap, state);
        window.activate(global.get_current_time());
    }

    _leaf(window) {
        return {type: 'leaf', window};
    }

    _split(axis, first, second) {
        return {type: 'split', axis, ratio: 0.5, first, second};
    }

    _leafWindows(node, windows = []) {
        if (!node)
            return windows;

        if (node.type === 'leaf') {
            windows.push(node.window);
            return windows;
        }

        this._leafWindows(node.first, windows);
        this._leafWindows(node.second, windows);
        return windows;
    }

    _lastWindow(node) {
        const windows = this._leafWindows(node);
        return windows.length > 0 ? windows[windows.length - 1] : null;
    }

    _containsWindow(node, window) {
        if (!node || !window)
            return false;

        if (node.type === 'leaf')
            return node.window === window;

        return this._containsWindow(node.first, window) || this._containsWindow(node.second, window);
    }

    _pruneTree(node, windowSet) {
        if (!node)
            return null;

        if (node.type === 'leaf')
            return windowSet.has(node.window) ? node : null;

        const first = this._pruneTree(node.first, windowSet);
        const second = this._pruneTree(node.second, windowSet);

        if (first && second)
            return {...node, first, second};

        return first ?? second;
    }

    _insertWindow(state, window, workArea, gap) {
        if (!state.root) {
            state.root = this._leaf(window);
            state.activeWindow = window;
            return;
        }

        const activeWindow = this._containsWindow(state.root, state.activeWindow)
            ? state.activeWindow
            : this._lastWindow(state.root);
        const activeRect = this._layoutRects(state.root, this._insetRect(workArea, gap), gap)
            .find(({window: leafWindow}) => leafWindow === activeWindow)?.rect ?? workArea;
        const axis = activeRect.width >= activeRect.height ? 'x' : 'y';

        state.root = this._replaceLeaf(
            state.root,
            activeWindow,
            leaf => this._split(axis, leaf, this._leaf(window))
        );
        state.activeWindow = window;
    }

    _replaceLeaf(node, targetWindow, replacement) {
        if (!node)
            return null;

        if (node.type === 'leaf')
            return node.window === targetWindow ? replacement(node) : node;

        return {
            ...node,
            first: this._replaceLeaf(node.first, targetWindow, replacement),
            second: this._replaceLeaf(node.second, targetWindow, replacement),
        };
    }

    _swapLeafWindows(node, firstWindow, secondWindow) {
        if (!node || firstWindow === secondWindow)
            return;

        if (node.type === 'leaf') {
            if (node.window === firstWindow)
                node.window = secondWindow;
            else if (node.window === secondWindow)
                node.window = firstWindow;

            return;
        }

        this._swapLeafWindows(node.first, firstWindow, secondWindow);
        this._swapLeafWindows(node.second, firstWindow, secondWindow);
    }

    _newStrip() {
        return {columns: [], focusColumn: -1};
    }

    _newColumn(windows, widthFraction) {
        return {
            windows,
            widthFraction,
            savedWidthFraction: null,
            heightWeights: windows.map(() => 1),
            focusIndex: 0,
        };
    }

    // Cycle the focused column 33 -> 50 -> 66 -> 100 and around. Any explicit
    // width choice discards a remembered pre-maximize width.
    _cycleColumnWidth() {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();
        if (this._workspaceMode(workspace) !== 'scrolling')
            return;

        const located = this._locateInStrips(workspace, window);
        if (!located)
            return;

        const column = located.state.strip.columns[located.at.column];
        column.savedWidthFraction = null;
        column.widthFraction =
            COLUMN_WIDTH_PRESETS.find(preset => preset > column.widthFraction + 0.01) ??
            COLUMN_WIDTH_PRESETS[0];
        this._log(`column width preset -> ${column.widthFraction.toFixed(3)}`);
        this._queueRetile();
    }

    _defaultColumnWidth() {
        const percent = this._settings.get_int('column-width-percent');
        return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, percent / 100));
    }

    _stripWindows(strip) {
        return strip ? strip.columns.flatMap(column => column.windows) : [];
    }

    _findInStrip(strip, window) {
        if (!strip || !window)
            return null;

        for (let column = 0; column < strip.columns.length; column++) {
            const index = strip.columns[column].windows.indexOf(window);
            if (index >= 0)
                return {column, index};
        }

        return null;
    }

    _stripFocusedWindow(strip) {
        const column = strip?.columns[strip.focusColumn];
        if (!column)
            return null;

        return column.windows[Math.min(column.focusIndex, column.windows.length - 1)] ?? null;
    }

    _syncStrip(state, windows) {
        if (!state.strip)
            state.strip = this._newStrip();

        const strip = state.strip;
        const windowSet = new Set(windows);
        const focusedBefore = this._stripFocusedWindow(strip);

        // Drop windows that left (closed, minimized, floated, re-slotted),
        // collapsing empty columns and keeping weights aligned to survivors.
        for (const column of strip.columns) {
            const kept = [];
            const weights = [];
            column.windows.forEach((window, index) => {
                if (!windowSet.has(window))
                    return;

                kept.push(window);
                weights.push(column.heightWeights[index] ?? 1);
            });
            column.windows = kept;
            column.heightWeights = weights;
            column.focusIndex = Math.max(0, Math.min(column.focusIndex, kept.length - 1));
        }
        strip.columns = strip.columns.filter(column => column.windows.length > 0);

        const stayColumn = focusedBefore
            ? strip.columns.findIndex(column => column.windows.includes(focusedBefore))
            : -1;
        strip.focusColumn = stayColumn >= 0
            ? stayColumn
            : Math.max(0, Math.min(strip.focusColumn, strip.columns.length - 1));

        // Admit newcomers: each becomes its own column immediately right of
        // the focused one and takes focus (the design's new-window rule).
        const assigned = new Set(this._stripWindows(strip));
        const fresh = windows.filter(window => !assigned.has(window));

        if (strip.columns.length === 0 && fresh.length > 1) {
            // Bulk admission (mode default at login, first retile of a
            // workspace): order by current position so the strip matches
            // what is already on screen.
            fresh.sort((a, b) => {
                const fa = a.get_frame_rect();
                const fb = b.get_frame_rect();
                const ax = fa.x + fa.width / 2;
                const bx = fb.x + fb.width / 2;
                if (ax !== bx)
                    return ax - bx;

                return (fa.y + fa.height / 2) - (fb.y + fb.height / 2);
            });
        }

        const width = this._defaultColumnWidth();
        for (const window of fresh) {
            const at = strip.columns.length === 0 ? 0 : strip.focusColumn + 1;
            strip.columns.splice(at, 0, this._newColumn([window], width));
            strip.focusColumn = at;
        }

        if (strip.columns.length === 0)
            strip.focusColumn = -1;

        state.activeWindow = this._stripFocusedWindow(strip);
    }

    _layoutStrip(state, workArea, gap, monitor, forceAll = false) {
        const strip = state.strip;
        if (!strip || strip.columns.length === 0)
            return this._newPlacementStats();

        const inner = this._insetRect(workArea, gap);
        const widths = strip.columns.map(column =>
            Math.max(MIN_TILE_SIZE, Math.floor(inner.width * column.widthFraction)));

        const offsets = [];
        let cursor = 0;
        for (const width of widths) {
            offsets.push(cursor);
            cursor += width + gap;
        }

        // Always-center policy: the focused column's center sits at the
        // work-area center; everything else falls where the strip puts it.
        strip.focusColumn = Math.max(0, Math.min(strip.focusColumn, strip.columns.length - 1));
        const focusedCenter = offsets[strip.focusColumn] + widths[strip.focusColumn] / 2;
        const origin = Math.round(inner.x + inner.width / 2 - focusedCenter);

        const placements = [];
        strip.columns.forEach((column, index) => {
            const x = origin + offsets[index];
            const columnRect = {
                x,
                y: inner.y,
                width: widths[index],
                height: inner.height,
            };
            // Parked = the column's ideal spot shares no pixels with the work
            // area. Mutter cannot represent that as a real frame position, so
            // the frame sits at the legal edge and the actor hides instead.
            const parked = x + widths[index] <= workArea.x ||
                x >= workArea.x + workArea.width;

            for (const placement of this._stackRects(column, columnRect, gap))
                placements.push({...placement, parked});
        });

        // Captured before any frame moves: where each already-placed window
        // visually sits right now (actor position plus any in-flight scroll
        // translation), so a pass that lands mid-animation continues smoothly
        // from the current on-screen position. Fresh windows just appear.
        const fromVisual = new Map();
        if (this._animationsEnabled()) {
            for (const {window} of placements) {
                const actor = window.get_compositor_private?.();
                if (actor && this._appliedRects.has(window))
                    fromVisual.set(window, actor.x + actor.translation_x);
            }
        }

        const stats = this._applyPlacements(placements, workArea, true, forceAll);

        for (const {window, parked} of placements) {
            if (parked) {
                this._parkStripWindow(window);
            } else {
                this._unparkStripWindow(window);
                this._clipStripWindow(window, monitor);

                const applied = this._appliedRects.get(window);
                const from = fromVisual.get(window);
                if (stats.committedWindows.has(window) && applied && from !== undefined)
                    this._animateStripWindow(window, from, applied.x);
            }
        }

        return stats;
    }

    _animationsEnabled() {
        return St.Settings.get().enable_animations && !Main.overview.visible;
    }

    // Scroll animation: frames jump to their final rects during placement
    // (input follows reality); the actor then eases a compositor-side
    // translation_x from its old visual position back to zero, so Mutter's
    // placement constraints never see an intermediate position.
    _animateStripWindow(window, fromVisualX, targetX) {
        const actor = window.get_compositor_private?.();
        if (!actor || typeof actor.connect !== 'function')
            return;

        this._stopStripAnimation(window);

        const settle = () => {
            const delta = fromVisualX - actor.x;

            if (Math.abs(delta) < 1) {
                actor.translation_x = 0;
                this._stripAnimations.delete(window);
                return;
            }

            actor.translation_x = delta;
            this._stripAnimations.set(window, {actor, notifyId: 0, destroyId: 0, timeoutId: 0});
            actor.ease({
                translation_x: 0,
                duration: SCROLL_ANIMATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => this._stripAnimations.delete(window),
            });
        };

        if (actor.x === targetX) {
            settle();
            return;
        }

        // The compositor moves the actor to its new frame position
        // asynchronously; pin the current visual position until it lands (or
        // a fallback fires, e.g. when the move was absorbed) and ease then.
        actor.translation_x = fromVisualX - actor.x;

        const entry = {actor, notifyId: 0, destroyId: 0, timeoutId: 0};
        const fire = () => {
            this._stripAnimations.delete(window);
            this._clearStripAnimationEntry(entry);
            settle();
        };

        entry.notifyId = actor.connect('notify::x', fire);
        entry.destroyId = actor.connect('destroy', () => {
            entry.destroyId = 0;
            this._stripAnimations.delete(window);
            this._clearStripAnimationEntry(entry);
        });
        entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            entry.timeoutId = 0;
            fire();
            return GLib.SOURCE_REMOVE;
        });
        this._stripAnimations.set(window, entry);
    }

    _clearStripAnimationEntry(entry) {
        try {
            if (entry.notifyId)
                entry.actor.disconnect(entry.notifyId);
            if (entry.destroyId)
                entry.actor.disconnect(entry.destroyId);
        } catch (_error) {
            // The actor may already be disposed.
        }

        entry.notifyId = 0;
        entry.destroyId = 0;

        if (entry.timeoutId) {
            GLib.source_remove(entry.timeoutId);
            entry.timeoutId = 0;
        }
    }

    // Stop any pending or in-flight scroll animation. With resetTranslation
    // the actor also snaps to its real position (park, disable).
    _stopStripAnimation(window, resetTranslation = false) {
        const entry = this._stripAnimations.get(window);
        if (entry) {
            this._stripAnimations.delete(window);
            this._clearStripAnimationEntry(entry);
        }

        const actor = window.get_compositor_private?.();
        if (!actor)
            return;

        try {
            actor.remove_transition('translation-x');
            if (resetTranslation)
                actor.translation_x = 0;
        } catch (_error) {
            // Disposed actor; nothing to stop.
        }
    }

    _parkStripWindow(window) {
        const actor = window.get_compositor_private?.();
        if (!actor)
            return;

        this._stopStripAnimation(window, true);
        this._parkedWindows.add(window);
        this._unclipStripWindow(window);
        actor.hide();
    }

    _unparkStripWindow(window) {
        if (!this._parkedWindows.delete(window))
            return;

        const actor = window.get_compositor_private?.();
        if (actor)
            actor.show();
    }

    _stackRects(column, rect, gap) {
        const count = column.windows.length;
        if (count === 0)
            return [];

        const totalWeight = column.heightWeights.reduce((sum, weight) => sum + weight, 0) || count;
        const available = Math.max(0, rect.height - gap * (count - 1));
        const rects = [];
        let y = rect.y;

        column.windows.forEach((window, index) => {
            const height = index === count - 1
                ? Math.max(0, rect.y + rect.height - y) // remainder absorbs rounding
                : Math.floor(available * ((column.heightWeights[index] ?? 1) / totalWeight));

            rects.push({window, rect: {x: rect.x, y, width: rect.width, height}});
            y += height + gap;
        });

        return rects;
    }

    // A completed move-drag in scrolling mode re-slots the window as its own
    // column at the boundary nearest the drop, on whichever monitor it was
    // dropped. Returns false when the window is not strip-managed so the
    // ordinary grab handling can run.
    _handleStripDrop(window) {
        if (!this._tilingEnabled() || !window)
            return false;

        const workspace = window.get_workspace();
        if (!workspace || this._workspaceMode(workspace) !== 'scrolling')
            return false;

        if (!this._isTileable(window))
            return false;

        const located = this._locateInStrips(workspace, window);
        if (!located)
            return false;

        const monitorCount = global.display.get_n_monitors();
        let targetMonitor = window.get_monitor();
        if (targetMonitor < 0 || targetMonitor >= monitorCount)
            targetMonitor = located.monitor;

        const frame = window.get_frame_rect();
        const dropCenter = frame.x + frame.width / 2;

        const {state: oldState, at} = located;
        const oldStrip = oldState.strip;
        const oldColumn = oldStrip.columns[at.column];
        oldColumn.windows.splice(at.index, 1);
        oldColumn.heightWeights.splice(at.index, 1);
        oldColumn.focusIndex = Math.max(0, Math.min(oldColumn.focusIndex, oldColumn.windows.length - 1));
        if (oldColumn.windows.length === 0)
            oldStrip.columns.splice(oldStrip.columns.indexOf(oldColumn), 1);
        oldStrip.focusColumn = Math.max(0, Math.min(oldStrip.focusColumn, oldStrip.columns.length - 1));
        if (oldStrip.columns.length === 0)
            oldStrip.focusColumn = -1;

        const targetState = this._stateFor(workspace, targetMonitor);
        if (!targetState.strip)
            targetState.strip = this._newStrip();

        const strip = targetState.strip;
        let insertAt = strip.columns.length;
        for (let index = 0; index < strip.columns.length; index++) {
            const first = strip.columns[index].windows[0];
            const applied = first ? this._appliedRects.get(first) : null;
            if (applied && dropCenter < applied.x + applied.width / 2) {
                insertAt = index;
                break;
            }
        }

        strip.columns.splice(insertAt, 0, this._newColumn([window], this._defaultColumnWidth()));
        strip.focusColumn = insertAt;
        targetState.activeWindow = window;
        this._log(`drop: window re-slotted as column ${insertAt} on monitor ${targetMonitor}`);
        return true;
    }

    // Off-screen strip columns spatially overlap neighboring monitors, so
    // every strip window's actor is clipped to its own monitor. Clips follow
    // the actor (positions settle asynchronously on Wayland) and lift while
    // the overview is visible because previews paint through the live actor.
    _clipStripWindow(window, monitor) {
        const actor = window.get_compositor_private?.();
        if (!actor || typeof actor.connect !== 'function')
            return;

        let entry = this._stripClips.get(window);
        if (entry && entry.actor !== actor) {
            this._unclipStripWindow(window);
            entry = null;
        }

        if (!entry) {
            entry = {
                actor,
                monitor,
                xId: actor.connect('notify::x', () => this._queueStripClipRefresh(window)),
                yId: actor.connect('notify::y', () => this._queueStripClipRefresh(window)),
                // The scroll animation moves the actor by translation, so the
                // clip must re-anchor during animation too. Property changes
                // are batched into one clip update per compositor frame.
                translationId: actor.connect('notify::translation-x', () => this._queueStripClipRefresh(window)),
                destroyId: actor.connect('destroy', () => {
                    this._stripClips.delete(window);
                    this._dirtyStripClips.delete(window);
                }),
            };
            this._stripClips.set(window, entry);
        }

        entry.monitor = monitor;
        this._queueStripClipRefresh(window);
    }

    _queueStripClipRefresh(window) {
        if (!this._stripClips.has(window))
            return;

        this._dirtyStripClips.add(window);
        if (this._stripClipLaterId)
            return;

        this._stripClipLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._stripClipLaterId = 0;
            const dirty = this._dirtyStripClips;
            this._dirtyStripClips = new Set();
            for (const dirtyWindow of dirty)
                this._refreshStripClip(dirtyWindow);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelQueuedStripClipRefresh() {
        if (this._stripClipLaterId) {
            global.compositor.get_laters().remove(this._stripClipLaterId);
            this._stripClipLaterId = 0;
        }

        this._dirtyStripClips.clear();
    }

    _refreshStripClip(window) {
        const entry = this._stripClips.get(window);
        if (!entry)
            return;

        const monitorRect = Main.layoutManager.monitors[entry.monitor];
        if (!monitorRect || Main.overview.visible) {
            entry.actor.remove_clip();
            return;
        }

        // The clip rect lives in actor coordinates and travels with the
        // actor's transform, so the in-flight scroll translation has to be
        // backed out for the crop to stay glued to the monitor edge.
        entry.actor.set_clip(
            monitorRect.x - entry.actor.x - entry.actor.translation_x,
            monitorRect.y - entry.actor.y,
            monitorRect.width,
            monitorRect.height
        );
    }

    _unclipStripWindow(window) {
        const entry = this._stripClips.get(window);
        if (!entry)
            return;

        this._stripClips.delete(window);
        this._dirtyStripClips.delete(window);

        try {
            entry.actor.disconnect(entry.xId);
            entry.actor.disconnect(entry.yId);
            entry.actor.disconnect(entry.translationId);
            entry.actor.disconnect(entry.destroyId);
            entry.actor.remove_clip();
        } catch (_error) {
            // The actor may already be gone; its handlers died with it.
        }
    }

    _layoutRects(node, rect, gap, placements = []) {
        if (!node)
            return placements;

        if (node.type === 'leaf') {
            placements.push({window: node.window, rect});
            return placements;
        }

        const [firstRect, secondRect] = this._splitRect(rect, node.axis, node.ratio, gap);
        this._layoutRects(node.first, firstRect, gap, placements);
        this._layoutRects(node.second, secondRect, gap, placements);
        return placements;
    }

    _splitRect(rect, axis, ratio, gap) {
        if (axis === 'x') {
            const availableWidth = Math.max(0, rect.width - gap);
            const firstWidth = Math.floor(availableWidth * ratio);
            const secondWidth = availableWidth - firstWidth;

            return [
                {...rect, width: firstWidth},
                {
                    x: rect.x + firstWidth + gap,
                    y: rect.y,
                    width: secondWidth,
                    height: rect.height,
                },
            ];
        }

        const availableHeight = Math.max(0, rect.height - gap);
        const firstHeight = Math.floor(availableHeight * ratio);
        const secondHeight = availableHeight - firstHeight;

        return [
            {...rect, height: firstHeight},
            {
                x: rect.x,
                y: rect.y + firstHeight + gap,
                width: rect.width,
                height: secondHeight,
            },
        ];
    }

    _insetRect(rect, gap) {
        return {
            x: rect.x + gap,
            y: rect.y + gap,
            width: Math.max(0, rect.width - gap * 2),
            height: Math.max(0, rect.height - gap * 2),
        };
    }

    _safeRect(rect, bounds) {
        let x = Math.max(bounds.x, Math.floor(rect.x));
        let y = Math.max(bounds.y, Math.floor(rect.y));
        const right = Math.min(bounds.x + bounds.width, Math.floor(rect.x + rect.width));
        const bottom = Math.min(bounds.y + bounds.height, Math.floor(rect.y + rect.height));
        let width = right - x;
        let height = bottom - y;

        if (![x, y, width, height].every(Number.isFinite))
            return null;

        // A sub-minimum tile used to be dropped, which left the window wherever
        // it happened to be (usually overlapping siblings). Instead clamp it to
        // the minimum size inside the work area so placement stays deterministic,
        // and flag it so the caller can log the crowding.
        let clamped = false;

        if (width < MIN_TILE_SIZE) {
            width = Math.min(MIN_TILE_SIZE, bounds.width);
            x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width));
            clamped = true;
        }

        if (height < MIN_TILE_SIZE) {
            height = Math.min(MIN_TILE_SIZE, bounds.height);
            y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height));
            clamped = true;
        }

        return {x, y, width, height, clamped};
    }

    // Returns the split ancestry of `window` as [{split, childKey}, ...]
    // from the root down, or null if the window is not in the tree.
    _pathToLeaf(node, window, path = []) {
        if (!node)
            return null;

        if (node.type === 'leaf')
            return node.window === window ? path : null;

        return this._pathToLeaf(node.first, window, [...path, {split: node, childKey: 'first'}]) ??
            this._pathToLeaf(node.second, window, [...path, {split: node, childKey: 'second'}]);
    }

    _applyGrabbedGeometry(window, op) {
        const edges = GRAB_OP_EDGES.get(op);
        if (!edges || !this._tilingEnabled() || !window || !this._canPlace(window))
            return;

        const applied = this._appliedRects.get(window);
        if (!applied)
            return;

        let frame;
        try {
            frame = window.get_frame_rect();
        } catch (_error) {
            return;
        }

        if (!frame)
            return;

        const workspace = window.get_workspace();

        if (this._workspaceMode(workspace) === 'scrolling') {
            this._foldStripResize(window, workspace, edges, applied, frame);
            return;
        }

        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const path = this._pathToLeaf(state.root, window);

        if (!path)
            return;

        // Fold the resize back into the split ratios so the retile that
        // follows keeps the user's chosen size instead of snapping back.
        // Each dragged edge is the divider of the nearest ancestor split on
        // that axis: the right/bottom edge belongs to a split where this
        // window sits in the first subtree, the left/top edge to one where
        // it sits in the second.
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const gap = this._settings.get_int('gap-size');
        const adjustments = [
            {active: edges.right, axis: 'x', childKey: 'first', delta: (frame.x + frame.width) - (applied.x + applied.width)},
            {active: edges.left, axis: 'x', childKey: 'second', delta: frame.x - applied.x},
            {active: edges.bottom, axis: 'y', childKey: 'first', delta: (frame.y + frame.height) - (applied.y + applied.height)},
            {active: edges.top, axis: 'y', childKey: 'second', delta: frame.y - applied.y},
        ];

        for (const {active, axis, childKey, delta} of adjustments) {
            if (active && Math.abs(delta) > RESIZE_EDGE_THRESHOLD)
                this._resizeDivider(workArea, gap, path, axis, childKey, delta);
        }
    }

    // The strip analog of ratio folding: a horizontal edge drag becomes the
    // column's width fraction; a vertical edge drag shifts height weight
    // between the window and the stack neighbor across the dragged edge, so
    // the retile that follows the grab keeps the user's chosen sizes.
    _foldStripResize(window, workspace, edges, applied, frame) {
        const located = this._locateInStrips(workspace, window);
        if (!located)
            return;

        const {state, monitor, at} = located;
        const column = state.strip.columns[at.column];
        const gap = this._settings.get_int('gap-size');

        if ((edges.left || edges.right) && Math.abs(frame.width - applied.width) > RESIZE_EDGE_THRESHOLD) {
            const inner = this._insetRect(workspace.get_work_area_for_monitor(monitor), gap);

            if (inner.width > 0) {
                column.savedWidthFraction = null;
                column.widthFraction = Math.min(COLUMN_WIDTH_MAX,
                    Math.max(COLUMN_WIDTH_MIN, frame.width / inner.width));
                this._log(`column width folded to ${column.widthFraction.toFixed(3)}`);
            }
        }

        if ((edges.top || edges.bottom) && Math.abs(frame.height - applied.height) > RESIZE_EDGE_THRESHOLD) {
            const neighborIndex = edges.bottom ? at.index + 1 : at.index - 1;
            const neighborApplied = this._appliedRects.get(column.windows[neighborIndex]);

            // Weight moves between the dragged-edge pair only, so the rest of
            // the stack keeps its shape; both windows keep a minimum tile.
            if (neighborApplied && applied.height > 0 && neighborApplied.height > 0) {
                const pairPixels = applied.height + neighborApplied.height;
                const mine = Math.min(pairPixels - MIN_TILE_SIZE,
                    Math.max(MIN_TILE_SIZE, frame.height));
                const weights = column.heightWeights;
                const pairWeight = (weights[at.index] ?? 1) + (weights[neighborIndex] ?? 1);

                weights[at.index] = pairWeight * (mine / pairPixels);
                weights[neighborIndex] = pairWeight * (1 - mine / pairPixels);
                this._log(`stack heights folded between ${at.index} and ${neighborIndex}`);
            }
        }
    }

    // Move the divider of the nearest ancestor split matching (axis,
    // childKey) by `delta` pixels, expressed as a ratio change. The divider
    // displacement always grows/shrinks the first subtree, regardless of
    // which side the window is on.
    _resizeDivider(workArea, gap, path, axis, childKey, delta) {
        let targetIndex = -1;
        for (let index = path.length - 1; index >= 0; index--) {
            if (path[index].split.axis === axis && path[index].childKey === childKey) {
                targetIndex = index;
                break;
            }
        }

        if (targetIndex < 0)
            return;

        let rect = this._insetRect(workArea, gap);
        for (let index = 0; index < targetIndex; index++) {
            const {split, childKey: step} = path[index];
            const [firstRect, secondRect] = this._splitRect(rect, split.axis, split.ratio, gap);
            rect = step === 'first' ? firstRect : secondRect;
        }

        const split = path[targetIndex].split;
        const available = Math.max(1, (axis === 'x' ? rect.width : rect.height) - gap);
        const firstSize = Math.floor(available * split.ratio);
        const newRatio = (firstSize + delta) / available;

        split.ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, newRatio));
        this._log(`divider adjusted: axis=${axis} ratio=${split.ratio.toFixed(3)}`);
    }

    _trackExistingWindows() {
        // Track every managed window now, including minimized ones and windows
        // on inactive workspaces. Otherwise a window minimized at enable time
        // would have no signal handlers, so unminimizing it would never retile.
        const manager = global.workspace_manager;
        for (let index = 0; index < manager.get_n_workspaces(); index++) {
            const workspace = manager.get_workspace_by_index(index);
            for (const window of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace))
                this._trackWindow(window);
        }
    }

    _log(message) {
        if (this._settings?.get_boolean('debug-logging'))
            console.log(`[ohno-scroller] ${message}`);
    }
}
