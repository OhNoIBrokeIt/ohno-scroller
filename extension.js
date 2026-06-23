import Gio from 'gi://Gio';
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

export default class OhNoScrollerExtension extends ExtensionBase {
    enable() {
        this._settings = this.getSettings();
        this._signals = [];
        this._states = new Map();

        this._addKeybindings();
        this._connectSignals();
        this._retileActiveWorkspace();
    }

    disable() {
        for (const name of KEYBINDINGS)
            Main.wm.removeKeybinding(name);

        for (const [object, id] of this._signals)
            object.disconnect(id);

        this._signals = [];
        this._states.clear();
        this._settings = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _connectSignals() {
        this._connect(global.display, 'window-created', () => {
            this._queueRetile();
        });
        this._connect(global.display, 'notify::focus-window', () => {
            this._syncActiveColumnToFocus();
        });
        this._connect(global.workspace_manager, 'active-workspace-changed', () => {
            this._retileActiveWorkspace();
        });
        this._connect(this._settings, 'changed', () => {
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
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                handlers[name]
            );
        }
    }

    _toggleTiling() {
        this._settings.set_boolean('tiling-enabled', !this._settings.get_boolean('tiling-enabled'));
    }

    _queueRetile() {
        if (this._retileQueued)
            return;

        this._retileQueued = true;
        Promise.resolve().then(() => {
            this._retileQueued = false;
            this._retileActiveWorkspace();
        });
    }

    _activeWorkspace() {
        return global.workspace_manager.get_active_workspace();
    }

    _workspaceKey(workspace, monitor) {
        return `${workspace.index()}:${monitor}`;
    }

    _stateFor(workspace, monitor) {
        const key = this._workspaceKey(workspace, monitor);

        if (!this._states.has(key))
            this._states.set(key, {columns: [[]], activeColumn: 0});

        return this._states.get(key);
    }

    _syncActiveColumnToFocus() {
        const window = global.display.focus_window;

        if (!window || !this._isTileable(window))
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);

        for (let index = 0; index < state.columns.length; index++) {
            if (state.columns[index].includes(window)) {
                state.activeColumn = index;
                this._layout(workspace, monitor, state);
                return;
            }
        }
    }

    _tileableWindows(workspace, monitor) {
        return global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, workspace)
            .filter(window => window.get_monitor() === monitor)
            .filter(window => this._isTileable(window));
    }

    _isTileable(window) {
        if (!window || window.minimized)
            return false;

        if (!NORMAL_WINDOW_TYPES.has(window.get_window_type()))
            return false;

        if (window.is_fullscreen && window.is_fullscreen())
            return false;

        return window.allows_resize() && !window.skip_taskbar;
    }

    _retileActiveWorkspace() {
        if (!this._settings.get_boolean('tiling-enabled'))
            return;

        const workspace = this._activeWorkspace();
        const monitorCount = global.display.get_n_monitors();

        for (let monitor = 0; monitor < monitorCount; monitor++) {
            const windows = this._tileableWindows(workspace, monitor);
            const state = this._stateFor(workspace, monitor);
            this._syncWindows(state, windows);
            this._layout(workspace, monitor, state);
        }
    }

    _syncWindows(state, windows) {
        const windowSet = new Set(windows);

        state.columns = state.columns
            .map(column => column.filter(window => windowSet.has(window)))
            .filter(column => column.length > 0);

        const assigned = new Set(state.columns.flat());
        const newWindows = windows.filter(window => !assigned.has(window));

        if (state.columns.length === 0)
            state.columns.push([]);

        for (const window of newWindows)
            state.columns[Math.min(state.activeColumn, state.columns.length - 1)].push(window);

        state.activeColumn = Math.max(0, Math.min(state.activeColumn, state.columns.length - 1));
    }

    _layout(workspace, monitor, state) {
        if (state.columns.length === 0)
            return;

        const workArea = workspace.get_work_area_for_monitor(monitor);
        const gap = this._settings.get_int('gap-size');
        const columnWidth = Math.max(
            1,
            Math.floor(workArea.width * this._settings.get_int('column-width-percent') / 100)
        );

        const activeCenter = state.activeColumn * (columnWidth + gap) + columnWidth / 2;
        const targetCenter = workArea.width / 2;
        const scrollX = Math.max(0, Math.floor(activeCenter - targetCenter));

        for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex++) {
            const column = state.columns[columnIndex];
            const x = workArea.x + columnIndex * (columnWidth + gap) - scrollX;

            for (let row = 0; row < column.length; row++) {
                const window = column[row];
                const availableHeight = workArea.height - gap * (column.length + 1);
                const windowHeight = Math.max(1, Math.floor(availableHeight / column.length));
                const y = workArea.y + gap + row * (windowHeight + gap);

                window.move_resize_frame(
                    false,
                    Math.floor(x),
                    Math.floor(y),
                    Math.max(1, columnWidth),
                    Math.max(1, windowHeight)
                );
            }
        }
    }

    _focusColumn(direction) {
        const window = global.display.focus_window;
        if (!window)
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);

        state.activeColumn = Math.max(0, Math.min(state.activeColumn + direction, state.columns.length - 1));

        const nextWindow = state.columns[state.activeColumn]?.[0];
        if (nextWindow)
            nextWindow.activate(global.get_current_time());

        this._layout(workspace, monitor, state);
    }

    _moveFocusedWindow(direction) {
        const window = global.display.focus_window;
        if (!window || !this._isTileable(window))
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const currentColumn = state.columns.findIndex(column => column.includes(window));

        if (currentColumn < 0)
            return;

        const targetColumn = Math.max(0, Math.min(currentColumn + direction, state.columns.length - 1));
        if (targetColumn === currentColumn)
            return;

        state.columns[currentColumn] = state.columns[currentColumn].filter(item => item !== window);
        state.columns[targetColumn].push(window);
        state.columns = state.columns.filter(column => column.length > 0);
        state.activeColumn = Math.max(0, Math.min(targetColumn, state.columns.length - 1));

        this._layout(workspace, monitor, state);
        window.activate(global.get_current_time());
    }

    _moveFocusedWindowToNewColumn() {
        const window = global.display.focus_window;
        if (!window || !this._isTileable(window))
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const state = this._stateFor(workspace, monitor);
        const currentColumn = state.columns.findIndex(column => column.includes(window));

        if (currentColumn >= 0)
            state.columns[currentColumn] = state.columns[currentColumn].filter(item => item !== window);

        state.columns.splice(currentColumn + 1, 0, [window]);
        state.columns = state.columns.filter(column => column.length > 0);
        state.activeColumn = Math.max(0, currentColumn + 1);

        this._layout(workspace, monitor, state);
        window.activate(global.get_current_time());
    }
}
