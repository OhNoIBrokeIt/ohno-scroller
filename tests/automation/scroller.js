import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'ohno-scroller@ohnoibrokeit.dev';

export const METRICS = {};

function check(condition, message, failures) {
    if (!condition)
        failures.push(message);
}

function snapshotRect(rect) {
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

async function extensionInstance() {
    for (let attempt = 0; attempt < 50; attempt++) {
        const instance = Main.extensionManager.lookup(UUID)?.stateObj;
        if (instance)
            return instance;

        await Scripting.sleep(100);
    }

    throw new Error(`${UUID} did not expose an enabled extension instance`);
}

function verifyChangedOnlyPlacement(extension, failures) {
    const frame = {x: 10, y: 10, width: 800, height: 600};
    let commits = 0;
    const window = {
        maximized_horizontally: false,
        maximized_vertically: false,
        get_frame_rect: () => ({...frame}),
        move_resize_frame: (_userOp, x, y, width, height) => {
            commits++;
            Object.assign(frame, {x, y, width, height});
        },
    };
    const placement = {window, rect: {...frame}};
    const workArea = {x: 0, y: 0, width: 1280, height: 720};
    const oldCanPlace = extension._canPlace;

    extension._canPlace = () => true;
    try {
        extension._applyPlacements([placement], workArea, false);
        extension._applyPlacements([placement], workArea, false);
    } finally {
        extension._canPlace = oldCanPlace;
    }

    check(commits === 1,
        `unchanged placement committed ${commits} times instead of once`, failures);

    extension._forcePlacementWindows.add(window);
    extension._canPlace = () => true;
    try {
        extension._applyPlacements([placement], workArea, false);
    } finally {
        extension._canPlace = oldCanPlace;
        extension._appliedRects.delete(window);
        extension._forcePlacementWindows.delete(window);
        extension._floatingRects.delete(window);
    }

    check(commits === 2,
        'explicit geometry correction did not re-assert an unchanged target', failures);
}

async function verifyRetileCoalescing(extension, failures) {
    const oldRetile = extension._retileActiveWorkspace;
    let passes = 0;
    let receivedReasons = null;

    extension._cancelQueuedRetile();
    extension._retileActiveWorkspace = reasons => {
        passes++;
        receivedReasons = reasons;
    };

    try {
        for (let index = 0; index < 25; index++)
            extension._queueRetile(`burst-${index}`);
        await Scripting.sleep(100);
    } finally {
        extension._retileActiveWorkspace = oldRetile;
        extension._cancelQueuedRetile();
    }

    check(passes === 1,
        `same-frame retile burst produced ${passes} transactions`, failures);
    check(receivedReasons?.size === 25,
        'coalesced retile transaction lost one or more causes', failures);
}

async function verifyClipBatching(extension, failures) {
    const window = {};
    const oldRefresh = extension._refreshStripClip;
    let refreshes = 0;

    extension._stripClips.set(window, {actor: {}});
    extension._refreshStripClip = () => refreshes++;
    try {
        for (let index = 0; index < 25; index++)
            extension._queueStripClipRefresh(window);
        await Scripting.sleep(100);
    } finally {
        extension._refreshStripClip = oldRefresh;
        extension._stripClips.delete(window);
        extension._dirtyStripClips.delete(window);
    }

    check(refreshes === 1,
        `same-frame actor notifications produced ${refreshes} clip updates`, failures);
}

function verifyWorkspaceRelease(extension, failures) {
    const removedWorkspace = {index: () => -1};
    extension._states.set(removedWorkspace, new Map());
    extension._workspaceModes.set(removedWorkspace, 'bsp');

    extension._pruneStaleWorkspaces();

    check(!extension._states.has(removedWorkspace),
        'removed workspace retained layout state', failures);
    check(!extension._workspaceModes.has(removedWorkspace),
        'removed workspace retained layout mode', failures);
}

function verifyStripFocusSurvivesRemoval(extension, failures) {
    const [a, b, c, d] = [{}, {}, {}, {}];
    const state = {root: null, strip: extension._newStrip(), activeWindow: c};
    state.strip.columns = [a, b, c, d].map(window => extension._newColumn([window], 0.5));
    state.strip.focusColumn = 2;
    extension._removeFromStrip(state, a);
    check(extension._stripFocusedWindow(state.strip) === c && state.activeWindow === c,
        'closing a column before focus selected a different window', failures);

    state.strip.columns = [extension._newColumn([a, b, c], 0.5), extension._newColumn([d], 0.5)];
    state.strip.columns[0].focusIndex = 1;
    state.strip.focusColumn = 1;
    extension._syncStrip(state, [b, c, d]);
    check(state.strip.columns[0].windows[state.strip.columns[0].focusIndex] === b,
        'pruning an unfocused stack forgot its previously focused window', failures);
    check(extension._stripFocusedWindow(state.strip) === d,
        'pruning another stack changed the active column', failures);
}

function verifyViewportPolicies(extension, failures) {
    const settings = extension._settings;
    const original = settings.get_string('scrolling-focus-mode');
    const strip = extension._newStrip();
    const inner = {x: 110, y: 10, width: 1000, height: 700};
    const widths = [400, 400, 400];
    const offsets = [0, 410, 820];
    try {
        settings.set_string('scrolling-focus-mode', 'fit');
        strip.focusColumn = 0;
        const start = extension._stripOrigin(strip, inner, offsets, widths, 10);
        strip.focusColumn = 1;
        check(extension._stripOrigin(strip, inner, offsets, widths, 10) === start,
            'fit moved the viewport for an already visible column', failures);
        strip.focusColumn = 2;
        check(extension._stripOrigin(strip, inner, offsets, widths, 10) === -110,
            'fit did not reveal the last column with the smallest scroll', failures);
        strip.focusColumn = 1;
        check(extension._stripOrigin(strip, inner, offsets, widths, 10) === -110,
            'fit moved a visible column after scrolling', failures);
        strip.focusColumn = 0;
        check(extension._stripOrigin(strip, inner, [0], [400], 10) === 110,
            'closing columns retained empty space at the end of the tape', failures);

        settings.set_string('scrolling-focus-mode', 'center');
        strip.focusColumn = 1;
        const centered = extension._stripOrigin(strip, inner, offsets, widths, 10);
        check(centered + offsets[1] + widths[1] / 2 === inner.x + inner.width / 2,
            'center policy did not center the focused column', failures);
    } finally {
        settings.set_string('scrolling-focus-mode', original);
    }
}

function verifyDirectionalNavigation(extension, failures) {
    const current = {x: 600, y: 400, width: 600, height: 300};
    const beside = {id: 'beside', rect: {x: 0, y: 0, width: 590, height: 700}};
    const above = {id: 'above', rect: {x: 600, y: 0, width: 600, height: 390}};
    check(extension._directionalCandidate(current, [beside, above], 'y', -1) === above,
        'up navigation picked the tall tile beside the stack', failures);
    check(extension._directionalCandidate(current, [beside, above], 'x', -1) === beside,
        'left navigation did not select the adjacent tile', failures);
    check(extension._directionalCandidate(current, [beside, above], 'y', 1) === null,
        'navigation at the bottom edge selected an unrelated tile', failures);

    const monitor = {x: -1920, y: 0, width: 1920, height: 1080};
    const right = {rect: {x: 0, y: 100, width: 2560, height: 1440}};
    const diagonal = {rect: {x: 0, y: -1200, width: 1920, height: 1080}};
    check(extension._directionalCandidate(monitor, [diagonal, right], 'x', 1) === right,
        'monitor navigation preferred a diagonal display over the shared edge', failures);
}

async function verifyWindowControls(extension, workspace, failures) {
    const settings = extension._settings;
    const state = extension._stateFor(workspace, 0);
    const windows = extension._stripWindows(state.strip);
    const window = windows[2];
    if (!window) {
        failures.push('window-control setup did not create enough windows');
        return;
    }

    window.activate(global.get_current_time());
    await Scripting.sleep(400);
    extension._stackFocusedWindow(-1);
    await Scripting.sleep(400);
    const column = state.strip.columns[extension._findInStrip(state.strip, window).column];
    check(column.windows.length === 2, 'stack command did not merge the window', failures);

    const oldWidth = column.widthFraction;
    extension._resizeFocusedWindow('x', 1);
    await Scripting.sleep(400);
    check(column.widthFraction > oldWidth, 'keyboard resize did not grow the column', failures);
    const oldHeight = extension._appliedRects.get(window).height;
    extension._resizeFocusedWindow('y', 1);
    await Scripting.sleep(400);
    check(extension._appliedRects.get(window).height > oldHeight,
        'keyboard resize did not grow the last window in a stack', failures);

    const widthBeforeMaximize = column.widthFraction;
    window.maximize();
    await Scripting.sleep(400);
    check(column.widthFraction === 1 && !window.maximized_horizontally,
        'scrolling maximize did not fold into full column width', failures);
    window.maximize();
    await Scripting.sleep(400);
    check(column.widthFraction === widthBeforeMaximize,
        'scrolling maximize toggle did not restore the original width', failures);

    const beforeFullscreen = extension._stripWindows(state.strip);
    const beforeWeights = [...column.heightWeights];
    window.make_fullscreen();
    await Scripting.sleep(400);
    const commits = extension._placementCommitCount;
    extension._retileActiveWorkspace(new Set(['fullscreen-regression']));
    check(extension._placementCommitCount === commits,
        'fullscreen monitor still committed tiling placements', failures);
    check(extension._stripWindows(state.strip).every((item, index) => item === beforeFullscreen[index]) &&
        extension._stripWindows(state.strip).length === beforeFullscreen.length,
    'fullscreen removed a window from its strip slot', failures);
    check(!extension._stripClips.has(window) && !extension._parkedWindows.has(window),
        'fullscreen retained a strip clip or hidden actor', failures);
    window.unmake_fullscreen();
    await Scripting.sleep(600);
    check(state.strip.columns.includes(column) && column.windows.includes(window) &&
        column.heightWeights.every((weight, index) => weight === beforeWeights[index]),
    'fullscreen return lost the original column or stack weights', failures);

    extension._toggleFloating();
    await Scripting.sleep(400);
    check(extension._floatingWindows.has(window) && !extension._findInStrip(state.strip, window),
        'floating toggle left the window tiled', failures);
    check(!extension._stripClips.has(window) && !extension._parkedWindows.has(window) &&
        window.get_compositor_private().visible,
    'floating toggle did not release scrolling presentation', failures);
    const floatingRect = snapshotRect(window.get_frame_rect());
    window.maximize();
    await Scripting.sleep(300);
    check(window.maximized_horizontally && extension._floatingWindows.has(window),
        'maximizing a floating window incorrectly folded it into the strip', failures);
    window.unmaximize();
    await Scripting.sleep(400);
    extension._toggleFloating();
    await Scripting.sleep(400);
    check(!extension._floatingWindows.has(window) && extension._findInStrip(state.strip, window),
        'tiled toggle did not re-admit a floating window', failures);
    extension._toggleFloating();
    await Scripting.sleep(400);
    check(extension._rectsEqual(window.get_frame_rect(), floatingRect),
        'floating toggle did not restore the last floating geometry', failures);
    extension._toggleFloating();
    await Scripting.sleep(400);

    const originalWrap = settings.get_boolean('wrap-focus');
    settings.set_boolean('wrap-focus', true);
    const lastColumn = state.strip.columns.at(-1);
    extension._focusStripWindow(state, lastColumn.windows[lastColumn.focusIndex]);
    await Scripting.sleep(400);
    extension._focusNeighbor('x', 1);
    await Scripting.sleep(400);
    check(state.strip.focusColumn === 0, 'horizontal focus did not wrap at the end', failures);
    settings.set_boolean('wrap-focus', false);
    extension._focusNeighbor('x', -1);
    await Scripting.sleep(300);
    check(state.strip.focusColumn === 0, 'disabled focus wrapping still wrapped', failures);
    settings.set_boolean('wrap-focus', originalWrap);

    window.activate(global.get_current_time());
    await Scripting.sleep(300);
    extension._toggleLayoutMode();
    await Scripting.sleep(400);
    check(extension._workspaceMode(workspace) === 'bsp' &&
        extension._leafWindows(state.root).length === windows.length,
    'scrolling-to-BSP conversion lost windows', failures);
    const parent = extension._pathToLeaf(state.root, window)?.at(-1)?.split;
    const previousAxis = parent?.axis;
    extension._toggleSplit();
    await Scripting.sleep(400);
    check(parent && parent.axis !== previousAxis, 'split toggle did not change its orientation', failures);
    const widthBefore = extension._appliedRects.get(window).width;
    extension._resizeFocusedWindow('x', 1);
    await Scripting.sleep(400);
    check(extension._appliedRects.get(window).width > widthBefore,
        'BSP keyboard resize did not grow the focused tile', failures);

    const leaves = extension._leafWindows(state.root);
    window.make_fullscreen();
    await Scripting.sleep(400);
    extension._retileActiveWorkspace(new Set(['fullscreen-bsp-regression']));
    check(extension._leafWindows(state.root).length === leaves.length &&
        extension._leafWindows(state.root).every((item, index) => item === leaves[index]),
    'fullscreen pruned the BSP tree', failures);
    window.unmake_fullscreen();
    await Scripting.sleep(500);

    const originalGap = settings.get_int('gap-size');
    const oldRect = snapshotRect(window.get_frame_rect());
    const beforeGrab = extension._placementCommitCount;
    extension._grabbedWindow = window;
    try {
        settings.set_int('gap-size', originalGap + 1);
        await Scripting.sleep(200);
        extension._retileActiveWorkspace(new Set(['manual-retile']));
        check(extension._placementCommitCount === beforeGrab &&
            extension._rectsEqual(window.get_frame_rect(), oldRect),
        'a layout update moved windows during a live grab', failures);
    } finally {
        settings.set_int('gap-size', originalGap);
        extension._grabbedWindow = null;
        extension._queueRetile('grab-end');
    }
    await Scripting.sleep(400);
    check(extension._placementCommitCount > beforeGrab,
        'grab end did not apply a deferred manual retile', failures);

    extension._toggleFloating();
    await Scripting.sleep(300);
    check(!extension._containsWindow(state.root, window), 'BSP floating toggle retained its tile', failures);
    window.maximize();
    await Scripting.sleep(300);
    extension._toggleFloating();
    await Scripting.sleep(300);
    check(extension._containsWindow(state.root, window) && !window.maximized_horizontally,
        'BSP floating toggle did not restore tiling from a maximized floating window', failures);
    extension._toggleLayoutMode();
    await Scripting.sleep(400);
    check(extension._stripWindows(state.strip).length === windows.length,
        'BSP-to-scrolling conversion lost windows', failures);
}

async function verifySingleColumnWidth(extension, workspace, failures) {
    const state = extension._stateFor(workspace, 0);
    const window = extension._stripWindows(state.strip)[0];
    const column = extension._newColumn([window], 0.5);
    const isolated = {strip: extension._newStrip()};
    isolated.strip.columns = [column];
    isolated.strip.focusColumn = 0;
    const gap = extension._settings.get_int('gap-size');
    const area = workspace.get_work_area_for_monitor(0);
    extension._layoutStrip(isolated, area, gap, 0);
    check(extension._appliedRects.get(window).width === area.width - 2 * gap &&
        column.widthFraction === 0.5,
    'a lone column did not expand while preserving its chosen width', failures);
    isolated.strip.columns.push(extension._newColumn([extension._stripWindows(state.strip)[1]], 0.5));
    extension._layoutStrip(isolated, area, gap, 0);
    check(extension._appliedRects.get(window).width === Math.floor((area.width - 2 * gap) / 2),
        'opening a second column did not restore the chosen width', failures);
    extension._retileActiveWorkspace(new Set(['manual-retile']));
    await Scripting.sleep(400);
}

async function verifyAnimationCleanup(extension, failures) {
    const settings = extension._settings;
    const duration = settings.get_int('animation-duration');
    const window = global.display.focus_window;
    const actor = window.get_compositor_private();
    extension._stopStripAnimation(window, true);
    settings.set_int('animation-duration', 120);
    try {
        extension._animateWindow(window, {x: actor.x - 80, y: actor.y - 40}, {x: actor.x, y: actor.y});
        check(actor.translation_x !== 0 && actor.translation_y !== 0,
            'layout animation did not animate both coordinates', failures);
        await Scripting.sleep(250);
        check(!extension._stripAnimations.has(window) && actor.translation_x === 0 && actor.translation_y === 0,
            'completed movement left an animation entry or actor translation', failures);

        extension._animateWindow(window, {x: actor.x - 80, y: actor.y - 40}, {x: actor.x, y: actor.y});
        settings.set_int('animation-duration', 0);
        check(!extension._animationsEnabled() && !extension._stripAnimations.has(window) &&
            actor.translation_x === 0 && actor.translation_y === 0,
        'disabling movement animations did not immediately settle the actor', failures);

        settings.set_int('animation-duration', 120);
        // Force the asynchronous-position branch, then cancel it before the
        // compositor reaches the target. No late callback may revive it.
        extension._animateWindow(window, {x: actor.x - 80, y: actor.y - 40}, {x: actor.x + 100, y: actor.y + 100});
        extension._stopStripAnimation(window, true);
        await Scripting.sleep(300);
        check(!extension._stripAnimations.has(window) && actor.translation_x === 0 && actor.translation_y === 0,
            'cancelled movement animation resumed from a stale callback', failures);
    } finally {
        extension._stopStripAnimation(window, true);
        settings.set_int('animation-duration', duration);
    }
}

async function verifyTilingOffReleasesActors(extension, failures) {
    const settings = extension._settings;
    const workspace = global.workspace_manager.get_active_workspace();

    settings.set_boolean('tiling-enabled', true);
    extension._workspaceModes.set(workspace, 'scrolling');

    // More than a monitor-width of columns guarantees at least one fully
    // off-screen actor regardless of which test window receives focus.
    for (let index = 0; index < 6; index++)
        await Scripting.createTestWindow({width: 700, height: 500});

    await Scripting.waitTestWindows();
    Main.overview.hide();
    await Scripting.sleep(600);
    extension._retileActiveWorkspace(new Set(['automation-test']));
    await Scripting.sleep(400);

    check(extension._parkedWindows.size > 0,
        'automation setup did not produce a parked scrolling window', failures);

    await verifyWindowControls(extension, workspace, failures);
    await verifySingleColumnWidth(extension, workspace, failures);
    await verifyAnimationCleanup(extension, failures);

    settings.set_boolean('tiling-enabled', false);
    await Scripting.sleep(400);

    check(extension._parkedWindows.size === 0,
        'tiling off retained parked windows', failures);
    check(extension._stripClips.size === 0,
        'tiling off retained strip clips', failures);
    check(extension._stripAnimations.size === 0,
        'tiling off retained strip animations', failures);

    for (const actor of global.get_window_actors()) {
        const window = actor.meta_window;
        if (window?.get_workspace() === workspace)
            check(actor.visible, 'tiling off left a workspace window hidden', failures);
    }

    await Scripting.destroyTestWindows();
    await Scripting.sleep(300);
}

export async function run() {
    const failures = [];
    const extension = await extensionInstance();

    verifyChangedOnlyPlacement(extension, failures);
    await verifyRetileCoalescing(extension, failures);
    await verifyClipBatching(extension, failures);
    verifyWorkspaceRelease(extension, failures);
    verifyStripFocusSurvivesRemoval(extension, failures);
    verifyViewportPolicies(extension, failures);
    verifyDirectionalNavigation(extension, failures);
    await verifyTilingOffReleasesActors(extension, failures);

    if (failures.length > 0)
        throw new Error(`Oh No Scroller regression failures:\n- ${failures.join('\n- ')}`);
    console.log('Oh No Scroller: all layout, lifecycle, navigation, animation, and scheduling checks passed');
}
