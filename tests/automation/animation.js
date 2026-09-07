import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};

function sample(window, start) {
    const actor = window.get_compositor_private();
    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    return {
        ms: Math.round((GLib.get_monotonic_time() - start) / 1000),
        x: actor.x + actor.translation_x,
        y: actor.y + actor.translation_y,
        actorX: actor.x, actorY: actor.y,
        frameX: frame.x, frameY: frame.y,
        bufferX: buffer.x, bufferY: buffer.y,
        visible: actor.visible,
    };
}

async function trace(window, action) {
    const start = GLib.get_monotonic_time();
    const samples = [sample(window, start)];
    const id = global.stage.connect('after-paint', () => samples.push(sample(window, start)));
    try {
        await action();
        await Scripting.sleep(650);
    } finally {
        global.stage.disconnect(id);
    }
    samples.push(sample(window, start));
    return samples;
}

function checkMotion(samples, label, failures) {
    const first = samples[0];
    const last = samples.at(-1);
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 100) {
        failures.push(`${label}: fixture did not move far enough`);
        return;
    }
    let previous = 0;
    let firstMotion = null;
    for (const s of samples) {
        const progress = ((s.x - first.x) * dx + (s.y - first.y) * dy) / distanceSquared;
        if (progress > 0.01 && firstMotion === null)
            firstMotion = s.ms;
        if (progress < previous - 0.02) {
            failures.push(`${label}: reversed from ${(previous * 100).toFixed(0)}% to ${(progress * 100).toFixed(0)}% at ${s.ms} ms`);
            break;
        }
        if (s.ms < 50 && progress > 0.85) {
            failures.push(`${label}: jumped straight to the destination at ${s.ms} ms`);
            break;
        }
        previous = progress;
    }
    if (firstMotion === null || firstMotion > 100)
        failures.push(`${label}: motion only started after ${firstMotion} ms`);
}

function checkContinuousSteps(samples, distance, label, failures) {
    for (let index = 1; index < samples.length; index++) {
        const before = samples[index - 1];
        const after = samples[index];
        const step = Math.hypot(after.x - before.x, after.y - before.y);
        // A cubic ease-out's maximum speed is 3 * distance / duration.
        // Allow one frame of timing slack, but reject destination-sized jumps.
        const bound = distance * Math.min(1, 3 * (after.ms - before.ms + 17) / 220) + 2;
        if (step > bound) {
            failures.push(`${label}: jumped ${step.toFixed(0)} pixels between ${before.ms} and ${after.ms} ms`);
            return;
        }
    }
}

async function checkLateAllocation(extension, failures) {
    // Use a real actor/frame clock with controlled asynchronous allocation;
    // real MetaWindow motion is checked in the rendered traces below.
    const actor = new Clutter.Actor({x: 200, y: 200, width: 60, height: 40});
    Main.uiGroup.add_child(actor);
    const window = {get_compositor_private: () => actor};
    try {
        extension._animateWindow(window, {x: 200, y: 200}, {x: 500, y: 350});
        actor.x = 500;
        actor.y = 320;
        if (actor.x + actor.translation_x !== 200 || actor.y + actor.translation_y !== 200)
            failures.push('Separate-axis allocation changed the visible starting position');
        await Scripting.sleep(70);
        const before = {x: actor.x + actor.translation_x, y: actor.y + actor.translation_y};
        actor.x = 470;
        actor.y = 300;
        if (Math.abs(actor.x + actor.translation_x - before.x) > 0.01 ||
            Math.abs(actor.y + actor.translation_y - before.y) > 0.01)
            failures.push('Late allocation jumped instead of rebasing the running animation');
        await Scripting.sleep(250);
        if (actor.translation_x !== 0 || actor.translation_y !== 0 || extension._stripAnimations.has(window))
            failures.push('Late allocation did not finish at the accepted destination');
    } finally {
        extension._stopStripAnimation(window, true);
        actor.destroy();
    }
}

export async function run() {
    const extension = Main.extensionManager.lookup('ohno-scroller@ohnoibrokeit.dev').stateObj;
    const workspace = global.workspace_manager.get_active_workspace();
    extension._settings.set_int('animation-duration', 220);
    extension._workspaceModes.set(workspace, 'scrolling');
    extension._settings.set_string('scrolling-focus-mode', 'center');
    for (let index = 0; index < 5; index++)
        await Scripting.createTestWindow({width: 300, height: 200});
    await Scripting.waitTestWindows();
    Main.overview.hide();
    await Scripting.sleep(800);
    const state = extension._stateFor(workspace, 0);
    const windows = extension._stripWindows(state.strip);
    extension._focusStripWindow(state, windows[1]);
    await Scripting.sleep(650);
    const traces = {};
    traces.scroll = await trace(windows[1], async () => extension._focusStripWindow(state, windows[2]));
    traces.reverse = await trace(windows[1], async () => {
        extension._focusStripWindow(state, windows[1]);
        await Scripting.sleep(70);
        extension._focusStripWindow(state, windows[2]);
    });
    extension._focusStripWindow(state, windows[4]);
    await Scripting.sleep(650);
    extension._toggleLayoutMode();
    await Scripting.sleep(650);
    const bspWindow = global.display.focus_window;
    const axis = extension._spatialNeighbor(state, workspace, 0, bspWindow, 'x', -1) ? 'x' : 'y';
    traces.bspSwap = await trace(bspWindow, async () => extension._moveFocusedWindow(axis, -1));
    traces.bspReturn = await trace(bspWindow, async () => extension._moveFocusedWindow(axis, 1));
    traces.bspReverse = await trace(bspWindow, async () => {
        for (const direction of [-1, 1, -1, 1]) {
            extension._moveFocusedWindow(axis, direction);
            await Scripting.sleep(70);
        }
    });
    traces.bspResize = await trace(bspWindow, async () => extension._resizeFocusedWindow('x', 1));
    const verticalDirection = extension._spatialNeighbor(state, workspace, 0, bspWindow, 'y', -1) ? -1 : 1;
    traces.bspVertical = await trace(bspWindow, async () => extension._moveFocusedWindow('y', verticalDirection));

    if (GLib.getenv('OHNO_ANIMATION_TRACE'))
        console.log(`[ANIMATION-TRACE] ${JSON.stringify(traces)}`);
    await Scripting.destroyTestWindows();
    const failures = [];
    checkMotion(traces.scroll, 'Scrolling', failures);
    checkMotion(traces.bspSwap, 'BSP swap', failures);
    checkMotion(traces.bspReturn, 'BSP return to constrained tile', failures);
    checkMotion(traces.bspResize, 'BSP keyboard resize', failures);
    checkMotion(traces.bspVertical, 'BSP vertical swap', failures);
    const first = traces.bspSwap[0];
    const last = traces.bspSwap.at(-1);
    const distance = Math.hypot(last.x - first.x, last.y - first.y);
    checkContinuousSteps(traces.bspReverse, distance, 'Rapid BSP reversals', failures);
    const scrollDistance = Math.abs(traces.scroll.at(-1).x - traces.scroll[0].x);
    checkContinuousSteps(traces.reverse, scrollDistance, 'Rapid scrolling reversal', failures);
    await checkLateAllocation(extension, failures);
    if (failures.length)
        throw new Error(`Animation continuity failures:\n${failures.join('\n')}`);
    console.log('Oh No Scroller: rendered-frame animation continuity checks passed');
}
