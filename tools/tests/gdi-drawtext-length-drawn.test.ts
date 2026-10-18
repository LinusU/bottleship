/**
 * DRAWTEXTPARAMS.uiLengthDrawn: the characters of the caller's string that the lines laid
 * out consume, each line's break included. A caller that draws long text one line-high
 * rect at a time advances its string pointer by it; left at 0, only the first line of a
 * message ever shows.
 */
import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { drawText } from "../../src/worker/modules/gdi32/gdi-text";
import { registerWindowDrawingExports } from "../../src/worker/modules/user32/window-drawing";

const DT_WORDBREAK = 0x10, DT_EXPANDTABS = 0x40, DT_NOCLIP = 0x100;
const CHAR_WIDTH = 6, LINE = 12;

/** Every character is 6px wide and a line advances 12px. */
function fakeGdi() {
    const ctx = {
        canvas: {}, font: "", fillStyle: "", textBaseline: "top", textAlign: "left",
        measureText: (text: string) => ({ width: text.length * CHAR_WIDTH, fontBoundingBoxAscent: 9, fontBoundingBoxDescent: 3 }),
        fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {},
    };
    const state = {
        font: "12px x", appliedFont: "", fontQuality: 0, fontSize: 12, textColorValue: 0, textColor: "#000",
        appliedFillStyle: "", bkMode: 1, bkColor: "#fff", hBitmap: 0,
    };
    return {
        contexts: new Map([[1, ctx]]), hdcStates: new Map([[1, state]]), overlayCtx: null,
        setOverlayDirty() {}, markDirty() {}, invalidateImageDataCache() {},
        beginClipOn() { return false; }, clipCopyRect() { return null; },
    } as never;
}

/** A rect `lines` lines tall (bottom inclusive of the last pixel row, as callers build it). */
const rect = (chars: number, lines: number) => ({ left: 0, top: 0, right: chars * CHAR_WIDTH, bottom: lines * LINE - 1 });
const lengthDrawn = (text: string, r: ReturnType<typeof rect>, format: number) => drawText(fakeGdi(), 1, text, r, format)!.lengthDrawn;

afterEach(() => { (System as unknown as { instance: unknown }).instance = undefined; });

test("a wrapped line consumes the space it breaks at", () => {
    expect(lengthDrawn("aaaa bbbb cccc", rect(10, 1), DT_WORDBREAK)).toBe(10);
    expect(lengthDrawn("aaaa bbbb cccc", rect(10, 2), DT_WORDBREAK)).toBe(14);
});

test("a line consumes its CR/LF, hidden & prefixes and the tabs it expanded", () => {
    expect(lengthDrawn("ab\r\ncd", rect(20, 1), 0)).toBe(4);
    expect(lengthDrawn("ab\r\ncd", rect(20, 2), 0)).toBe(6);
    expect(lengthDrawn("&File\nx", rect(20, 1), 0)).toBe(6);
    expect(lengthDrawn("a\tb\nc", rect(40, 1), DT_EXPANDTABS)).toBe(4);
});

test("DT_NOCLIP lays out every line, whatever the rect", () => {
    expect(lengthDrawn("aaaa bbbb cccc", rect(10, 1), DT_WORDBREAK | DT_NOCLIP)).toBe(14);
});

test("DrawTextEx writes uiLengthDrawn, and fails a DRAWTEXTPARAMS of another size", () => {
    const gdi = fakeGdi();
    (System as unknown as { instance: unknown }).instance = {
        gdiContext: { drawText: (hdc: number, text: string, r: never, f: number) => drawText(gdi, hdc, text, r, f) },
    };
    const exports: Record<string, (ctx: never, mem: Uint8Array, args: number[]) => unknown> = {};
    registerWindowDrawingExports(exports as never);
    const mem = new Uint8Array(0x200);
    const view = new DataView(mem.buffer);
    const TEXT = 0x10, RECT = 0x80, PARAMS = 0xa0;
    mem.set(new TextEncoder().encode("aaaa bbbb cccc\0"), TEXT);
    for (const [i, v] of [0, 0, 10 * CHAR_WIDTH, LINE - 1].entries()) view.setInt32(RECT + i * 4, v, true);

    view.setUint32(PARAMS, 20, true);
    exports["DrawTextExA"]!(null as never, mem, [1, TEXT, -1, RECT, DT_WORDBREAK, PARAMS]);
    expect(view.getUint32(PARAMS + 16, true)).toBe(10);

    view.setUint32(PARAMS, 24, true);
    expect(exports["DrawTextExA"]!(null as never, mem, [1, TEXT, -1, RECT, DT_WORDBREAK, PARAMS])).toBe(0);
});
