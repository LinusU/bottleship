/**
 * Crimson Skies trial: boot to the first campaign mission and fly.
 *
 * Judges what a screenshot of "a hangar that renders" does not:
 *  - the Flight Check clipboard shows the mission objectives as ink on its note, which
 *    needs the game's own fonts, DrawTextEx's line accounting and the text texture's
 *    power-of-two upload all working,
 *  - the view answers keyboard input in flight: rolling moves the scene well beyond what
 *    level flight does,
 *  - nothing on the way is answered by an unimplemented export or a ddraw stub.
 *
 * Use a dedicated BS_TAB and a disposable browser origin/profile. This scenario never
 * deletes a container or accepts a licence: the trial shows its licence before the video
 * device dialog, so handle it separately once and rerun. The game draws its own cursor
 * from DirectInput deltas, so the menus are driven by relative moves from where it parks
 * the cursor on each screen. Continue on the campaign screen starts a pilot under the
 * default name, or resumes the saved one.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";
import { decodePng } from "../../png-diff";

const wgb = process.env.WGB;
if (!wgb) throw new Error("Set WGB to a lawfully obtained Crimson Skies trial bundle");
if (!process.env.BS_TAB) throw new Error("BS_TAB must identify a dedicated regression tab");
const out = resolve("logs", process.env.BS_TAB, "crimson-skies-demo");
mkdirSync(out, { recursive: true });

const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;

type Chain = ReturnType<typeof harness>;
interface Report {
    crash: unknown;
    stubs: Array<{ api: string }>;
    silentStubs: Array<{ api: string; count: number }>;
    gpuErrors: { total: number };
}

function moves(h: Chain, dx: number, dy: number, n: number): Chain {
    for (let i = 0; i < n; i++) h = h.moveRelative(dx, dy).sleep(50);
    return h;
}

async function step(label: string, h: Chain): Promise<void> {
    const r = await h.run();
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error)}`);
}

/** The screen as the user sees it, saved as evidence. */
async function capture(label: string): Promise<ReturnType<typeof decodePng>> {
    const r = await harness().shot().run();
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error)}`);
    const bytes = Buffer.from((r.named.shot as { base64: string }).base64, "base64");
    await Bun.write(resolve(out, `${label}.png`), bytes);
    return decodePng(new Uint8Array(bytes));
}

/** Share of dark pixels in a rect given as fractions of the screen. */
function ink(png: ReturnType<typeof decodePng>, x0: number, y0: number, x1: number, y1: number): number {
    let dark = 0, n = 0;
    for (let y = Math.floor(y0 * png.height); y < y1 * png.height; y++) {
        for (let x = Math.floor(x0 * png.width); x < x1 * png.width; x++) {
            const i = (y * png.width + x) * 4;
            if (0.3 * png.data[i]! + 0.59 * png.data[i + 1]! + 0.11 * png.data[i + 2]! < 64) dark++;
            n++;
        }
    }
    return dark / n;
}

/** The objectives note on the right of the Flight Check clipboard: written lines over blank parchment. */
function objectives(png: ReturnType<typeof decodePng>): { written: number; blank: number } {
    return { written: ink(png, 0.69, 0.19, 0.95, 0.42), blank: ink(png, 0.69, 0.45, 0.95, 0.8) };
}

async function motion(h: Chain = harness()): Promise<number> {
    const r = await h.call("sceneProbe").run();
    if (!r.ok) throw new Error(`sceneProbe: ${JSON.stringify(r.error)}`);
    return (r.named.sceneProbe as { motion: number }).motion;
}

async function videoDeviceDialogShown(): Promise<boolean> {
    const r = await harness().state(["windows"]).run();
    if (!r.ok) throw new Error(`state: ${JSON.stringify(r.error)}`);
    const windows = (r.named.state as { windows: Array<{ title: string; visible: boolean }> }).windows;
    return windows.some(w => w.visible && w.title === "Select Video Device");
}

try {
    await step("boot", harness().reload().sleep(1500).openWgb(wgb).sleep(8000));
    const deadline = Date.now() + 90_000;
    while (!await videoDeviceDialogShown()) {
        if (Date.now() > deadline) {
            await capture("no-video-dialog");
            throw new Error("the video device dialog never appeared; if the licence is showing, handle it separately and rerun");
        }
        await harness().sleep(1000).run();
    }
    await step("pick the video device", harness().click("OK").sleep(25_000));

    // Campaign, then Continue: the intro plays into the hangar.
    await step("campaign", moves(harness(), 12, 9, 4).sleep(300).clickHere(150).sleep(6000));
    await step("continue", moves(moves(harness(), 12, 0, 9), 0, 12, 2).sleep(400).clickHere(150).sleep(45_000));
    await capture("hangar");

    // Next Mission opens the voiced briefing; Go To Flight Check answers once it may.
    await step("next mission", moves(harness(), -16, 10, 16).sleep(400).clickHere(150).sleep(20_000));
    await step("aim at flight check", moves(harness(), 15, 2, 26).moveRelative(0, 4).sleep(400));
    let note = { written: 0, blank: 1 };
    for (let waited = 0; ; waited += 10_000) {
        await step("go to flight check", harness().clickHere(150).sleep(10_000));
        note = objectives(await capture("flight-check"));
        if (note.written > 0.08 && note.blank < 0.01) break;
        if (waited >= 180_000) {
            throw new Error(`no objectives on the Flight Check note after 3 min of briefing ` +
                `(ink ${note.written.toFixed(3)} written / ${note.blank.toFixed(3)} blank)`);
        }
    }

    // Fly Mission sits left of where the cursor is parked on the clipboard.
    await step("fly mission", moves(harness(), -14, 1, 4).sleep(400).clickHere(150));
    let level = 0;
    for (let waited = 0; level < 5; waited += 2000) {
        if (waited > 120_000) throw new Error("flight never started presenting a moving view");
        await harness().sleep(2000).run();
        level = await motion();
    }
    await harness().sleep(3000).run();
    level = await motion();
    let rolling = 0;
    for (const vk of [VK_LEFT, VK_RIGHT]) {
        rolling = await motion(harness().key(vk, { down: true }).sleep(1000));
        await step("release", harness().key(vk, { up: true }));
        if (rolling > level * 1.5) break;
    }
    await capture("flight");

    const done = await harness().call("report").run();
    if (!done.ok) throw new Error(`report: ${JSON.stringify(done.error)}`);
    const report = done.named.report as Report;
    await Bun.write(resolve(out, "report.json"), JSON.stringify(report, null, 2));
    if (report.crash) throw new Error(`guest crash: ${JSON.stringify(report.crash).slice(0, 400)}`);
    if (report.stubs.length) throw new Error(`unimplemented API: ${report.stubs.map(s => s.api).join(", ")}`);
    const stubbedDraws = report.silentStubs.filter(s => s.api.startsWith("ddraw:"));
    if (stubbedDraws.length) {
        throw new Error(`ddraw calls answered by a stub: ${stubbedDraws.map(s => `${s.api} x${s.count}`).join(", ")}`);
    }
    if (report.gpuErrors.total) throw new Error(`${report.gpuErrors.total} GPU error(s)`);
    if (rolling <= level * 1.5) {
        throw new Error(`the view did not answer the roll keys (motion ${rolling.toFixed(1)} rolling, ${level.toFixed(1)} level)`);
    }

    console.log(`OK — Crimson Skies trial showed its objectives on the Flight Check note ` +
        `(ink ${note.written.toFixed(2)}) and flew (motion ${level.toFixed(1)} level, ${rolling.toFixed(1)} rolling); ` +
        `evidence: ${out}`);
} finally {
    try {
        await harness().key(VK_LEFT, { up: true }).key(VK_RIGHT, { up: true }).pause().run();
    } finally {
        closeHarnessConnection();
    }
}
