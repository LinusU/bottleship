/**
 * MCIWnd is a window that owns one MCI device: window messages in, MCI commands out.
 * The application never sees the device, so what it polls (MCIWNDM_GETMODE) and what it
 * sends (MCI_PLAY, MCI_STOP) has to reach the device the window opened — and only that one.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import {
    MCIWND_CLASS_NAME, clearMciWndState, handleMciWndMessage, openMciWndFile,
} from "../../src/worker/modules/msvfw32-mciwnd";

const WS_CHILD = 0x40000000;
const WS_BORDER = 0x00800000;
const MCIWNDF_NOAUTOSIZEWINDOW = 0x0001;
const MCI_CLOSE = 0x0804;
const MCI_PLAY = 0x0806;
const MCI_STOP = 0x0808;
const MCIWNDM_GETMODEA = 0x0400 + 106;
const MCI_MODE_NOT_READY = 524;
const MCI_MODE_STOP = 525;
const MCI_MODE_PLAY = 526;

const HWND = 0x10042;
const mem = new Uint8Array(0x1000);
const ctx = {} as never;

let commands: string[];
let mode: string;
let resized: number[] | null;
let openError: number;

const system = System.getInstance() as unknown as { process: unknown };
const realProcess = system.process;
afterAll(() => { system.process = realProcess; });

beforeEach(() => {
    commands = [];
    mode = "stopped";
    resized = null;
    openError = 0;
    const mci = {
        executeString(command: string) {
            commands.push(command);
            const verb = command.split(" ")[0];
            if (verb === "open") return { error: openError, value: "" };
            if (verb === "where") return { error: 0, value: "0 0 320 240" };
            if (verb === "status") return { error: 0, value: mode };
            if (verb === "play") mode = "playing";
            if (verb === "stop") mode = "stopped";
            return { error: 0, value: "" };
        },
        deviceIdOf: () => 7,
    };
    system.process = {
        getModule: (name: string) => name === "winmm"
            ? { getMci: () => mci }
            : { exports: { SetWindowPos: (_c: unknown, _m: unknown, args: number[]) => { resized = args; return 1; } } },
    };
    clearMciWndState(HWND);
    windows.clear();
});

function makeWindow(style: number): void {
    windows.set(HWND, {
        handle: HWND, title: "", style, x: 0, y: 0, width: 300, height: 0, children: [],
        visible: true, wndProc: 0, nativeClassName: MCIWND_CLASS_NAME,
    } as WindowInfo);
}

describe("MCIWnd", () => {
    test("opening a file aims the device at the window, sized around the movie", () => {
        makeWindow(WS_CHILD | WS_BORDER);
        expect(openMciWndFile(ctx, mem, HWND, "logos.avi")).toBe(0);
        expect(commands[0]).toBe(`open "logos.avi" alias mciwnd${HWND}`);
        expect(commands).toContain(`window mciwnd${HWND} handle ${HWND}`);
        // A one-pixel border on each side of a 320x240 picture, which sits inside it.
        expect(resized?.slice(4, 6)).toEqual([322, 242]);
        expect(commands).toContain(`put mciwnd${HWND} destination at 1 1 320 240`);
    });

    test("MCIWNDF_NOAUTOSIZEWINDOW leaves the window alone", () => {
        makeWindow(WS_CHILD | WS_BORDER | MCIWNDF_NOAUTOSIZEWINDOW);
        expect(openMciWndFile(ctx, mem, HWND, "logos.avi")).toBe(0);
        expect(resized).toBeNull();
    });

    test("play, mode and stop reach the opened device", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_STOP);
        expect(handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem)).toBe(0);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_PLAY);
        expect(handleMciWndMessage(ctx, HWND, MCI_STOP, 0, 0, mem)).toBe(0);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_STOP);
    });

    test("GETMODE copies the mode name into the caller's buffer", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem);
        handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 16, 0x200, mem);
        expect(String.fromCharCode(...mem.subarray(0x200, 0x207))).toBe("playing");
    });

    test("a window with no device is not ready, and play is an error rather than a success", () => {
        makeWindow(WS_CHILD);
        openError = 275;
        expect(openMciWndFile(ctx, mem, HWND, "missing.avi")).toBe(275);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_NOT_READY);
        expect(handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem)).not.toBe(0);
    });

    test("MCI_CLOSE and destroying the window both close the device, once", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        expect(handleMciWndMessage(ctx, HWND, MCI_CLOSE, 0, 0, mem)).toBe(0);
        clearMciWndState(HWND);
        expect(commands.filter((c) => c.startsWith("close"))).toEqual([`close mciwnd${HWND}`]);
    });

    test("messages for any other window class are not ours", () => {
        makeWindow(WS_CHILD);
        windows.get(HWND)!.nativeClassName = "Button";
        expect(handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem)).toBeNull();
    });
});
