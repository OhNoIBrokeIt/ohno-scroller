import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
const UUID = 'ohno-scroller@ohnoibrokeit.dev';

function check(condition, message, failures) {
    if (!condition)
        failures.push(message);
}

function memberships(extension, workspace, window) {
    const result = [];
    for (let monitor = 0; monitor < global.display.get_n_monitors(); monitor++) {
        const state = extension._stateFor(workspace, monitor);
        for (const [columnIndex, column] of (state.strip?.columns ?? []).entries()) {
            for (const [windowIndex, candidate] of column.windows.entries()) {
                if (candidate === window)
                    result.push({monitor, columnIndex, windowIndex, column});
            }
        }
    }
    return result;
}

function ownershipSnapshot(extension, workspace) {
    return JSON.stringify(Array.from({length: global.display.get_n_monitors()}, (_, monitor) => {
        const strip = extension._stateFor(workspace, monitor).strip;
        return (strip?.columns ?? []).map(column => ({
            windows: column.windows.map(window => window.get_stable_sequence()),
            width: column.widthFraction,
            weights: [...column.heightWeights],
        }));
    }));
}

async function assertTransfer(extension, workspace, window, target, label, failures) {
    await Scripting.sleep(550);
    // A transfer must survive the next normal reconciliation, not just paint
    // on another monitor while still belonging to the original strip.
    extension._retileActiveWorkspace(new Set(['monitor-transfer-regression']));
    await Scripting.sleep(300);
    const owned = memberships(extension, workspace, window);
    check(window.get_monitor() === target,
        `${label}: real window monitor ${window.get_monitor()}, expected ${target}`, failures);
    check(owned.length === 1 && owned[0].monitor === target,
        `${label}: strip owners [${owned.map(item => item.monitor)}], expected exactly [${target}]`, failures);
    if (!window.is_fullscreen()) {
        const area = workspace.get_work_area_for_monitor(target);
        const frame = window.get_frame_rect();
        const centerX = frame.x + frame.width / 2;
        const centerY = frame.y + frame.height / 2;
        check(centerX >= area.x && centerX < area.x + area.width &&
            centerY >= area.y && centerY < area.y + area.height,
        `${label}: actual frame center lies outside the destination work area`, failures);
        check(!extension._parkedWindows.has(window) && window.get_compositor_private().visible,
            `${label}: focused transferred window remained parked or hidden`, failures);
    }
}

export async function run() {
    const failures = [];
    const extension = Main.extensionManager.lookup(UUID)?.stateObj;
    if (!extension)
        throw new Error(`${UUID} is not active`);
    const monitors = Main.layoutManager.monitors;
    if (monitors.length !== 2 || monitors[0].x === monitors[1].x)
        throw new Error('Monitor-transfer fixture requires two horizontally separated logical monitors');
    const workspace = global.workspace_manager.get_active_workspace();
    extension._settings.set_int('animation-duration', 0);
    extension._settings.set_int('column-width-percent', 50);
    // Keep the native public move reversible across the primary monitor's
    // smaller panel work area. Mutter constrains an expanded 1260x700
    // secondary-monitor frame back onto that secondary even with Scroller
    // disabled; this fixture targets extension ownership, not that native
    // oversized-frame behavior.
    extension._settings.set_boolean('single-column-full-width', false);
    extension._workspaceModes.set(workspace, 'scrolling');
    const moveEvents = [];
    let phase = 'setup';
    const sizeId = global.window_manager.connect('size-change', (_wm, actor, reason) => {
        if (reason === Meta.SizeChange.MONITOR_MOVE)
            moveEvents.push({phase, window: actor.meta_window});
    });
    let transferredWindow = null;
    try {
        for (let index = 0; index < 5; index++)
            await Scripting.createTestWindow({width: 700, height: 500});
        await Scripting.waitTestWindows();
        Main.overview.hide();
        await Scripting.sleep(800);
        transferredWindow = global.display.focus_window;
        const initial = memberships(extension, workspace, transferredWindow);
        if (initial.length !== 1)
            throw new Error('Fixture focused window is not in exactly one strip');
        const source = initial[0].monitor;
        const destination = source === 0 ? 1 : 0;
        const sourceState = extension._stateFor(workspace, source);
        const windows = extension._stripWindows(sourceState.strip);
        if (windows.length !== 5)
            throw new Error(`Fixture expected five windows in one strip, got ${windows.length}`);

        // Exercise actual tape geometry and park/reveal, not a mocked monitor
        // signal. No compositor MONITOR_MOVE intent accompanies ordinary tiles.
        phase = 'ordinary-scroll';
        const originalOwnership = ownershipSnapshot(extension, workspace);
        let sawParked = false;
        for (const window of [windows[0], windows.at(-1), windows[1], transferredWindow]) {
            extension._focusStripWindow(sourceState, window);
            await Scripting.sleep(180);
            sawParked ||= extension._parkedWindows.size > 0;
            check(ownershipSnapshot(extension, workspace) === originalOwnership,
                'ordinary scrolling changed strip membership, width or stack weights', failures);
        }
        check(sawParked, 'ordinary scrolling fixture never parked an off-screen column', failures);
        check(!moveEvents.some(event => event.phase === 'ordinary-scroll'),
            'ordinary scrolling unexpectedly produced native monitor-transfer intent', failures);

        phase = 'forward';
        transferredWindow.move_to_monitor(destination);
        await assertTransfer(extension, workspace, transferredWindow, destination, phase, failures);
        check(moveEvents.some(event => event.phase === phase && event.window === transferredWindow),
            'forward: fixture did not exercise native MONITOR_MOVE', failures);

        phase = 'back';
        transferredWindow.move_to_monitor(source);
        await assertTransfer(extension, workspace, transferredWindow, source, phase, failures);

        phase = 'same-monitor';
        const beforeNoop = ownershipSnapshot(extension, workspace);
        transferredWindow.move_to_monitor(source);
        await assertTransfer(extension, workspace, transferredWindow, source, phase, failures);
        check(ownershipSnapshot(extension, workspace) === beforeNoop,
            'same-monitor: no-op changed strip membership or dimensions', failures);
        check(!moveEvents.some(event => event.phase === phase),
            'same-monitor: no-op unexpectedly emitted native MONITOR_MOVE', failures);

        phase = 'intent-expiry';
        const beforeExpiry = transferredWindow.get_frame_rect();
        const beforeExpiryPresentation = {
            parked: extension._parkedWindows.has(transferredWindow),
            visible: transferredWindow.get_compositor_private().visible,
            clipped: extension._stripClips.has(transferredWindow),
        };
        extension._recordMonitorTransferIntent(transferredWindow);
        extension._forcePlacementWindows.add(transferredWindow);
        extension._retileActiveWorkspace(new Set(['pending-intent-regression']));
        const duringExpiry = transferredWindow.get_frame_rect();
        check(beforeExpiry.x === duringExpiry.x && beforeExpiry.y === duringExpiry.y &&
            beforeExpiry.width === duringExpiry.width && beforeExpiry.height === duringExpiry.height,
        'pending transfer allowed old-strip geometry placement', failures);
        check(beforeExpiryPresentation.parked === extension._parkedWindows.has(transferredWindow) &&
            beforeExpiryPresentation.visible === transferredWindow.get_compositor_private().visible &&
            beforeExpiryPresentation.clipped === extension._stripClips.has(transferredWindow),
        'pending transfer changed park/visibility/clip presentation', failures);
        await Scripting.sleep(1100);
        check(!extension._pendingMonitorTransfers.has(transferredWindow),
            'refused transfer intent did not expire', failures);

        phase = 'fullscreen';
        transferredWindow.make_fullscreen();
        await Scripting.sleep(400);
        check(memberships(extension, workspace, transferredWindow).length === 1,
            'fullscreen: original strip slot was discarded before transfer', failures);
        transferredWindow.move_to_monitor(destination);
        await assertTransfer(extension, workspace, transferredWindow, destination, phase, failures);
        const fullscreenSlot = memberships(extension, workspace, transferredWindow)[0];
        check(transferredWindow.is_fullscreen() && !extension._stripClips.has(transferredWindow) &&
            !extension._parkedWindows.has(transferredWindow),
        'fullscreen: transfer lost fullscreen or kept clipped/parked presentation', failures);
        transferredWindow.unmake_fullscreen();
        await Scripting.sleep(400);
        await assertTransfer(extension, workspace, transferredWindow, destination, 'fullscreen-return', failures);
        const restoredSlot = memberships(extension, workspace, transferredWindow)[0];
        check(fullscreenSlot?.monitor === destination && restoredSlot?.column === fullscreenSlot?.column,
            'fullscreen-return: destination strip slot was not preserved', failures);

        phase = 'rapid';
        // Each call uses the real Mutter move operation. The final result must
        // consume the latest intent once, without duplicate/lost membership.
        for (const target of [source, destination, source, destination]) {
            transferredWindow.move_to_monitor(target);
            await Scripting.sleep(20);
        }
        await assertTransfer(extension, workspace, transferredWindow, destination, phase, failures);
        for (const window of windows.filter(window => window !== transferredWindow)) {
            const owned = memberships(extension, workspace, window);
            check(owned.length === 1 && owned[0].monitor === source,
                'transfer moved or duplicated an unrelated window in the source strip', failures);
        }
    } finally {
        if (transferredWindow?.is_fullscreen())
            transferredWindow.unmake_fullscreen();
        global.window_manager.disconnect(sizeId);
        await Scripting.destroyTestWindows();
    }
    if (failures.length)
        throw new Error(`Monitor-transfer regression failures:\n- ${failures.join('\n- ')}`);
    console.log('Oh No Scroller: real two-monitor transfer, scrolling ownership and fullscreen slot checks passed');
}
