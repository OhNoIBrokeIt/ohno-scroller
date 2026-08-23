import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'ohno-scroller@ohnoibrokeit.dev';

export const METRICS = {};

function check(condition, message, failures) {
    if (!condition)
        failures.push(message);
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
    await verifyTilingOffReleasesActors(extension, failures);

    if (failures.length > 0)
        throw new Error(`Oh No Scroller regression failures:\n- ${failures.join('\n- ')}`);
}
