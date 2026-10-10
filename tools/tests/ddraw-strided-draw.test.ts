/**
 * IDirect3DDevice3/7::DrawPrimitiveStrided + DrawIndexedPrimitiveStrided.
 *
 * D3DDRAWPRIMITIVESTRIDEDDATA hands the device one array per vertex component; the FVF
 * decides which are read. The draw path wants the FVF's interleaved layout, so the test
 * pins the gather: element order and widths, strides wider than the element, a stride of 0
 * (one value for every vertex), and that a member the FVF does not name is never touched.
 */
import { describe, expect, test } from "bun:test";
import { createDeviceExports } from "../../src/worker/modules/ddraw/d3d/device-impl";
import {
    packStridedVertices,
    stridedPlan,
    StridedScratch,
    STRIDED_DATA_BYTES,
} from "../../src/worker/modules/ddraw/d3d/strided-draw";

const D3DFVF_XYZ = 0x002;
const D3DFVF_XYZRHW = 0x004;
const D3DFVF_NORMAL = 0x010;
const D3DFVF_RESERVED1 = 0x020;
const D3DFVF_DIFFUSE = 0x040;
const D3DFVF_SPECULAR = 0x080;
const D3DFVF_TEX1 = 0x100;
const D3DFVF_TEX2 = 0x200;
/** D3DFVF_TEXCOORDSIZE3(stage). */
const texCoordSize3 = (stage: number) => 1 << (16 + stage * 2);

const D3D_OK = 0;
const DDERR_INVALIDPARAMS = 0x80070057;
const DDERR_OUTOFMEMORY = 0x8007000e;
const D3DPT_TRIANGLELIST = 4;

const POSITION = 0, NORMAL = 8, DIFFUSE = 16, SPECULAR = 24;
const texCoord = (stage: number) => 32 + stage * 8;

const STRIDED = 0x100;
const UNMAPPED = 0xdead0000;

function guest() {
    const mem = new Uint8Array(0x8000);
    const view = new DataView(mem.buffer);
    /** Point every member at an address that must never be dereferenced. */
    for (let m = 0; m < STRIDED_DATA_BYTES; m += 8) {
        view.setUint32(STRIDED + m, UNMAPPED, true);
        view.setUint32(STRIDED + m + 4, 0x7fffffff, true);
    }
    const stream = (member: number, addr: number, stride: number) => {
        view.setUint32(STRIDED + member, addr, true);
        view.setUint32(STRIDED + member + 4, stride, true);
    };
    const floats = (addr: number, values: number[]) => values.forEach((v, i) => view.setFloat32(addr + i * 4, v, true));
    const readFloats = (addr: number, n: number) => Array.from({ length: n }, (_, i) => view.getFloat32(addr + i * 4, true));
    return { mem, view, stream, floats, readFloats };
}

describe("stridedPlan", () => {
    test("is the FVF's interleaved layout", () => {
        const fvf = D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_SPECULAR | D3DFVF_TEX2 | texCoordSize3(1);
        const plan = stridedPlan(fvf)!;
        expect(plan.stride).toBe(12 + 12 + 4 + 4 + 8 + 12);
        expect(Array.from(plan.copies)).toEqual([
            POSITION, 0, 12,
            NORMAL, 12, 12,
            DIFFUSE, 24, 4,
            SPECULAR, 28, 4,
            texCoord(0), 32, 8,
            texCoord(1), 40, 12,
        ]);
    });

    test("a transformed position is four floats", () => {
        const plan = stridedPlan(D3DFVF_XYZRHW | D3DFVF_DIFFUSE)!;
        expect(Array.from(plan.copies)).toEqual([POSITION, 0, 16, DIFFUSE, 16, 4]);
    });

    test("the reserved DWORD of an LVERTEX has no stream", () => {
        const plan = stridedPlan(D3DFVF_XYZ | D3DFVF_RESERVED1 | D3DFVF_DIFFUSE | D3DFVF_SPECULAR | D3DFVF_TEX1)!;
        expect(plan.stride).toBe(32);
        expect(Array.from(plan.copies)).toEqual([
            POSITION, 0, 12,
            -1, 12, 4,
            DIFFUSE, 16, 4,
            SPECULAR, 20, 4,
            texCoord(0), 24, 8,
        ]);
    });

    test("an FVF with no position cannot be drawn", () => {
        expect(stridedPlan(D3DFVF_DIFFUSE)).toBeNull();
    });
});

describe("packStridedVertices", () => {
    test("gathers each component at its own stride", () => {
        const g = guest();
        const fvf = D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_TEX1;
        // Positions packed tight, normals inside a 20-byte record, one colour for every vertex.
        g.stream(POSITION, 0x1000, 12);
        g.stream(NORMAL, 0x2004, 20);
        g.stream(DIFFUSE, 0x3000, 0);
        g.stream(texCoord(0), 0x4000, 8);
        for (let v = 0; v < 3; v++) {
            g.floats(0x1000 + v * 12, [v + 0.1, v + 0.2, v + 0.3]);
            g.floats(0x2004 + v * 20, [10 + v, 20 + v, 30 + v]);
            g.floats(0x4000 + v * 8, [v / 4, v / 8]);
        }
        g.view.setUint32(0x3000, 0xff8040c0, true);

        const dst = 0x6000;
        g.mem.fill(0xee, dst, dst + 0x200);
        const plan = stridedPlan(fvf)!;
        expect(plan.stride).toBe(36);
        expect(packStridedVertices(g.mem, STRIDED, plan, 3, dst)).toBe(true);

        for (let v = 0; v < 3; v++) {
            const at = dst + v * 36;
            expect(g.readFloats(at, 3)).toEqual([v + 0.1, v + 0.2, v + 0.3].map(Math.fround));
            expect(g.readFloats(at + 12, 3)).toEqual([10 + v, 20 + v, 30 + v]);
            expect(g.view.getUint32(at + 24, true)).toBe(0xff8040c0);
            expect(g.readFloats(at + 28, 2)).toEqual([v / 4, v / 8]);
        }
        // Exactly three vertices were written.
        expect(g.mem[dst + 3 * 36]).toBe(0xee);
    });

    test("zeroes the reserved DWORD instead of leaving the previous draw's bytes", () => {
        const g = guest();
        const fvf = D3DFVF_XYZ | D3DFVF_RESERVED1 | D3DFVF_DIFFUSE;
        g.stream(POSITION, 0x1000, 12);
        g.stream(DIFFUSE, 0x3000, 4);
        const dst = 0x6000;
        g.mem.fill(0xee, dst, dst + 64);
        expect(packStridedVertices(g.mem, STRIDED, stridedPlan(fvf)!, 2, dst)).toBe(true);
        expect(g.view.getUint32(dst + 12, true)).toBe(0);
        expect(g.view.getUint32(dst + 20 + 12, true)).toBe(0);
    });

    test("refuses a NULL descriptor or a NULL stream the FVF names, writing nothing", () => {
        const g = guest();
        const plan = stridedPlan(D3DFVF_XYZ | D3DFVF_DIFFUSE)!;
        const dst = 0x6000;
        g.mem.fill(0xee, dst, dst + 64);
        expect(packStridedVertices(g.mem, 0, plan, 2, dst)).toBe(false);

        g.stream(POSITION, 0x1000, 12);
        g.stream(DIFFUSE, 0, 4);
        expect(packStridedVertices(g.mem, STRIDED, plan, 2, dst)).toBe(false);
        expect(Array.from(g.mem.subarray(dst, dst + 32)).every(b => b === 0xee)).toBe(true);
    });
});

describe("StridedScratch", () => {
    test("reuses its block and replaces it only to grow", () => {
        const log: string[] = [];
        let next = 0x100000;
        const memory = {
            alloc: (size: number) => { const a = next; next += size; log.push(`alloc ${size}`); return a; },
            free: (addr: number) => { log.push(`free 0x${addr.toString(16)}`); },
        };
        const scratch = new StridedScratch();
        const first = scratch.reserve(memory, 100);
        expect(scratch.reserve(memory, 60000)).toBe(first);
        const grown = scratch.reserve(memory, 200000);
        expect(grown).not.toBe(first);
        expect(scratch.reserve(memory, 150000)).toBe(grown);
        expect(log).toEqual(["alloc 65536", "alloc 262144", "free 0x100000"]);
    });

    test("keeps its block when the guest heap cannot supply a larger one", () => {
        let fail = false;
        const freed: number[] = [];
        const memory = { alloc: () => (fail ? 0 : 0x200000), free: (a: number) => { freed.push(a); } };
        const scratch = new StridedScratch();
        expect(scratch.reserve(memory, 10)).toBe(0x200000);
        fail = true;
        expect(scratch.reserve(memory, 1 << 20)).toBe(0);
        expect(freed).toEqual([]);
        expect(scratch.reserve(memory, 10)).toBe(0x200000);
    });
});

describe("the device exports draw the gathered vertices", () => {
    const DEVICE = 0x5fb00d90;
    const SCRATCH = 0x7000;

    function device(alloc: () => number = () => SCRATCH) {
        const draws: unknown[][] = [];
        const drawHandler = { handleDrawPrimitive: (...a: unknown[]) => { draws.push(a); } };
        const context = {
            resourceProvider: { getComObjectByAddress: () => null },
            process: { memory: { alloc, free: () => undefined } },
        };
        const exports = createDeviceExports(context as never, {} as never, drawHandler as never);
        return { exports, draws };
    }

    const FVF = D3DFVF_XYZ | D3DFVF_DIFFUSE;

    function scene() {
        const g = guest();
        g.stream(POSITION, 0x1000, 16);
        g.stream(DIFFUSE, 0x3000, 4);
        for (let v = 0; v < 4; v++) {
            g.floats(0x1000 + v * 16, [v, v * 2, v * 3]);
            g.view.setUint32(0x3000 + v * 4, 0xff000000 | v, true);
        }
        return g;
    }

    for (const iface of ["IDirect3DDevice7", "IDirect3DDevice3"]) {
        test(`${iface}_DrawPrimitiveStrided`, () => {
            const g = scene();
            const { exports, draws } = device();
            const hr = exports[`${iface}_DrawPrimitiveStrided`]!({} as never, g.mem, [DEVICE, D3DPT_TRIANGLELIST, FVF, STRIDED, 3, 0]);
            expect(hr).toBe(D3D_OK);
            expect(draws).toEqual([[DEVICE, D3DPT_TRIANGLELIST, FVF, SCRATCH, 3, g.mem, false, 0, 0]]);
            expect(g.readFloats(SCRATCH + 16, 3)).toEqual([1, 2, 3]);
            expect(g.view.getUint32(SCRATCH + 16 + 12, true)).toBe(0xff000001);
        });

        test(`${iface}_DrawIndexedPrimitiveStrided`, () => {
            const g = scene();
            const { exports, draws } = device();
            const INDICES = 0x5000;
            const hr = exports[`${iface}_DrawIndexedPrimitiveStrided`]!({} as never, g.mem, [DEVICE, D3DPT_TRIANGLELIST, FVF, STRIDED, 4, INDICES, 6, 0]);
            expect(hr).toBe(D3D_OK);
            expect(draws).toEqual([[DEVICE, D3DPT_TRIANGLELIST, FVF, SCRATCH, 4, g.mem, true, INDICES, 6]]);
            expect(g.readFloats(SCRATCH + 3 * 16, 3)).toEqual([3, 6, 9]);
        });
    }

    test("an empty draw succeeds without reading the descriptor", () => {
        const g = guest();
        const { exports, draws } = device();
        expect(exports["IDirect3DDevice7_DrawPrimitiveStrided"]!({} as never, g.mem, [DEVICE, D3DPT_TRIANGLELIST, FVF, 0, 0, 0])).toBe(D3D_OK);
        expect(exports["IDirect3DDevice7_DrawIndexedPrimitiveStrided"]!({} as never, g.mem, [DEVICE, D3DPT_TRIANGLELIST, FVF, 0, 4, 0x5000, 0, 0])).toBe(D3D_OK);
        expect(draws).toEqual([]);
    });

    test("bad arguments fail with DDERR_INVALIDPARAMS and draw nothing", () => {
        const g = scene();
        const { exports, draws } = device();
        const call = (fvf: number, lpStrided: number) =>
            exports["IDirect3DDevice7_DrawPrimitiveStrided"]!({} as never, g.mem, [DEVICE, D3DPT_TRIANGLELIST, fvf, lpStrided, 3, 0]);
        expect(call(FVF, 0)).toBe(DDERR_INVALIDPARAMS);
        expect(call(D3DFVF_DIFFUSE, STRIDED)).toBe(DDERR_INVALIDPARAMS);
        expect(draws).toEqual([]);
    });

    test("an exhausted guest heap fails with DDERR_OUTOFMEMORY", () => {
        const g = scene();
        const { exports, draws } = device(() => 0);
        expect(exports["IDirect3DDevice7_DrawPrimitiveStrided"]!({} as never, g.mem, [DEVICE, D3DPT_TRIANGLELIST, FVF, STRIDED, 3, 0])).toBe(DDERR_OUTOFMEMORY);
        expect(draws).toEqual([]);
    });
});
