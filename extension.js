import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension as ExtensionBase} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const KEYBINDINGS = [
    'toggle-tiling',
    'retile-workspace',
    'focus-column-left',
    'focus-column-right',
    'move-window-left',
    'move-window-right',
    'move-window-new-column',
];

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
        this._appliedRects = new Map();
        this._inLayout = false;
        this._retileSourceId = 0;
        this._retileLaterId = 0;

        this._addKeybindings();
        this._connectSignals();
        this._trackExistingWindows();
        this._retileActiveWorkspace();
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

        this._cancelQueuedRetile();

        this._signals = [];
        this._windowSignals.clear();
        this._pendingRetileSignals.clear();
        this._closingWindows.clear();
        this._closingWindowSourceIds.clear();
        this._states.clear();
        this._appliedRects.clear();
        this._inLayout = false;
        this._settings = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _connectSignals() {
        this._connect(global.display, 'window-created', (_display, window) => {
            this._trackWindow(window);
            this._queueRetileAfterWindowReady(window);
        });
        this._connect(global.display, 'notify::focus-window', () => {
            this._syncActiveWindowToFocus();
        });
        this._connect(global.display, 'workareas-changed', () => {
            this._queueRetile();
        });
        this._connect(global.workspace_manager, 'active-workspace-changed', () => {
            this._retileActiveWorkspace();
        });
        this._connect(global.workspace_manager, 'workspace-removed', () => {
            this._pruneStaleWorkspaces();
        });
        // Monitor indices reshuffle when displays are added, removed, or
        // rearranged, so per-index layout state cannot be trusted across a
        // change; rebuild the trees from the windows present afterwards.
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._states.clear();
            this._appliedRects.clear();
            this._queueRetile();
        });
        // User moves/resizes happen under a grab. A resize is folded back
        // into the split ratios so the layout keeps the user's chosen size;
        // a plain move retiles the window back into its slot.
        this._connect(global.display, 'grab-op-end', (_display, window, op) => {
            this._applyGrabbedGeometry(window, op);
            this._queueRetile();
        });
        this._connect(this._settings, 'changed', (_settings, key) => {
            if (key === 'tiling-enabled' || key === 'gap-size')
                this._retileActiveWorkspace();
        });
    }

    _addKeybindings() {
        const handlers = {
            'toggle-tiling': () => this._toggleTiling(),
            'retile-workspace': () => this._retileActiveWorkspace(),
            'focus-column-left': () => this._focusColumn(-1),
            'focus-column-right': () => this._focusColumn(1),
            'move-window-left': () => this._moveFocusedWindow(-1),
            'move-window-right': () => this._moveFocusedWindow(1),
            'move-window-new-column': () => this._moveFocusedWindowToNewColumn(),
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

    _queueRetile(delayMs = 0) {
        this._cancelQueuedRetile();

        if (delayMs > 0) {
            this._retileSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                this._retileSourceId = 0;
                if (this._settings)
                    this._retileActiveWorkspace();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        // Lay out right before the next repaint instead of from an idle
        // source, so windows never paint a frame in a pre-tile position.
        this._retileLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._retileLaterId = 0;
            if (this._settings)
                this._retileActiveWorkspace();
            return GLib.SOURCE_REMOVE;
        });
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
            perMonitor.set(monitor, {root: null, activeWindow: null});

        return perMonitor.get(monitor);
    }

    _pruneStaleWorkspaces() {
        const manager = global.workspace_manager;
        const live = new Set();
        for (let index = 0; index < manager.get_n_workspaces(); index++)
            live.add(manager.get_workspace_by_index(index));

        for (const workspace of [...this._states.keys()]) {
            if (!live.has(workspace)) {
                this._states.delete(workspace);
                this._log('pruned layout state for a removed workspace');
            }
        }
    }

    _syncActiveWindowToFocus() {
        const window = global.display.focus_window;

        if (!window || !this._isTileable(window))
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);

        if (this._containsWindow(state.root, window))
            state.activeWindow = window;
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

        // Only state toggles that change whether the window participates in
        // tiling are tracked. Geometry signals are deliberately not: user
        // moves/resizes always happen under a grab (handled at grab-op-end),
        // and app-driven geometry changes should not fight the layout. The
        // _inLayout guard skips echoes from our own unmaximize during layout.
        const queueUnlessLayout = () => {
            if (!this._inLayout)
                this._queueRetile();
        };

        const signalIds = [
            window.connect('workspace-changed', queueUnlessLayout),
            window.connect('notify::minimized', queueUnlessLayout),
            window.connect('notify::fullscreen', queueUnlessLayout),
            window.connect('notify::maximized-horizontally', queueUnlessLayout),
            window.connect('notify::maximized-vertically', queueUnlessLayout),
            window.connect('unmanaged', () => {
                this._clearPendingWindowRetile(window);
                this._disconnectWindowSignals(window);
                this._markWindowClosing(window);
                this._removeWindowFromStates(window);
                this._appliedRects.delete(window);
                this._queueRetile(250);
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
        for (const perMonitor of this._states.values()) {
            for (const state of perMonitor.values()) {
                const previous = this._leafWindows(state.root);
                const remaining = previous
                    .filter(item => item !== window);

                if (remaining.length === previous.length)
                    continue;

                state.root = this._pruneTree(state.root, new Set(remaining));

                if (state.activeWindow === window)
                    state.activeWindow = this._lastWindow(state.root);
            }
        }
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

        if (!actor || typeof actor.connect !== 'function') {
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._clearPendingWindowRetile(window, false);
                this._queueRetile();
                return GLib.SOURCE_REMOVE;
            });

            this._pendingRetileSignals.set(window, {actor: null, signalId: 0, timeoutId});
            return;
        }

        let signalId = 0;
        let timeoutId = 0;

        signalId = actor.connect('first-frame', () => {
            this._clearPendingWindowRetile(window);
            this._queueRetile();
        });

        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._clearPendingWindowRetile(window, false);
            this._queueRetile();
            return GLib.SOURCE_REMOVE;
        });

        this._pendingRetileSignals.set(window, {actor, signalId, timeoutId});
    }

    _clearPendingWindowRetile(window, removeTimeout = true) {
        const pending = this._pendingRetileSignals.get(window);
        if (!pending)
            return;

        this._pendingRetileSignals.delete(window);

        if (pending.actor && pending.signalId) {
            try {
                pending.actor.disconnect(pending.signalId);
            } catch (_error) {
                // The actor may already be gone while its window is unmanaging.
            }
        }

        if (removeTimeout && pending.timeoutId)
            GLib.source_remove(pending.timeoutId);
    }

    _retileActiveWorkspace() {
        if (!this._tilingEnabled())
            return;

        const workspace = this._activeWorkspace();
        const monitorCount = global.display.get_n_monitors();
        const gap = this._settings.get_int('gap-size');

        for (let monitor = 0; monitor < monitorCount; monitor++) {
            const windows = this._tileableWindows(workspace, monitor);
            const state = this._stateFor(workspace, monitor);
            const workArea = workspace.get_work_area_for_monitor(monitor);

            this._log(`retile ws=${workspace.index()} monitor=${monitor} tileable=${windows.length}`);

            this._syncWindows(state, windows, workArea, gap);
            this._layout(workArea, gap, state);
        }
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

    _layout(workArea, gap, state) {
        if (!state.root)
            return;

        // Mark our own placement pass so the geometry signals it provokes do not
        // bounce back in as fresh retile requests.
        this._inLayout = true;
        try {
            for (const {window, rect} of this._layoutRects(state.root, this._insetRect(workArea, gap), gap)) {
                if (!this._canPlace(window)) {
                    this._log('placement skipped: window is not currently placeable');
                    continue;
                }

                const safeRect = this._safeRect(rect, workArea);

                if (!safeRect) {
                    this._log('placement skipped: computed rect was degenerate/non-finite');
                    continue;
                }

                if (safeRect.clamped)
                    this._log(`tile below minimum size; clamped to ${safeRect.width}x${safeRect.height}`);

                // Tiled windows must not stay maximized or they cover the rest of
                // the layout; drop maximization before applying the tile rect.
                if (window.maximized_horizontally || window.maximized_vertically)
                    window.unmaximize(Meta.MaximizeFlags.BOTH);

                this._appliedRects.set(window, {
                    x: safeRect.x,
                    y: safeRect.y,
                    width: safeRect.width,
                    height: safeRect.height,
                });

                window.move_resize_frame(
                    false,
                    safeRect.x,
                    safeRect.y,
                    safeRect.width,
                    safeRect.height
                );
            }
        } finally {
            this._inLayout = false;
        }
    }

    // Pick the tile nearest to `window` whose center lies in `direction`
    // (-1 left, +1 right). Horizontal distance dominates; vertical distance
    // breaks ties so stacked tiles resolve to the row the window sits in.
    _spatialNeighbor(state, workspace, monitor, window, direction) {
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
            const dx = center.x - currentCenter.x;

            if (direction < 0 ? dx >= 0 : dx <= 0)
                continue;

            const distance = Math.abs(dx) * 4 + Math.abs(center.y - currentCenter.y);

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

    _focusColumn(direction) {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const neighbor = this._spatialNeighbor(state, workspace, monitor, window, direction);

        if (neighbor) {
            state.activeWindow = neighbor;
            neighbor.activate(global.get_current_time());
        }
    }

    _moveFocusedWindow(direction) {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const neighbor = this._spatialNeighbor(state, workspace, monitor, window, direction);

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

    _moveFocusedWindowToNewColumn() {
        if (!this._tilingEnabled())
            return;

        const window = global.display.focus_window;
        if (!window || !this._canPlace(window))
            return;

        const workspace = window.get_workspace();
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

    _leafWindows(node) {
        if (!node)
            return [];

        if (node.type === 'leaf')
            return [node.window];

        return [...this._leafWindows(node.first), ...this._leafWindows(node.second)];
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

    _layoutRects(node, rect, gap) {
        if (!node)
            return [];

        if (node.type === 'leaf')
            return [{window: node.window, rect}];

        const [firstRect, secondRect] = this._splitRect(rect, node.axis, node.ratio, gap);

        return [
            ...this._layoutRects(node.first, firstRect, gap),
            ...this._layoutRects(node.second, secondRect, gap),
        ];
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

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const path = this._pathToLeaf(state.root, window);

        if (!path)
            return;

        let frame;
        try {
            frame = window.get_frame_rect();
        } catch (_error) {
            return;
        }

        if (!frame)
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
