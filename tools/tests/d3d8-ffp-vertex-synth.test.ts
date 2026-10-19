/**
 * A declaration-only D3D8 vertex shader paired with a pixel shader runs fixed-function
 * vertex processing into the programmable pixel stage (Unreal Engine 2's terrain:
 * camera-space texgen + texture matrices feeding a ps_1_1 layer blend). The synthesized
 * vs_1_1 must reproduce that processing; it is executed here by a small reference
 * interpreter and compared against the fixed-function math directly.
 */
import { describe, expect, test } from "bun:test";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import { compilePixelShader, compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import type { RawVertexElement } from "../../src/worker/backends/webgpu/d3d9/shader";
import {
    describeDeclInputs,
    FFP_SYNTH_CONSTANT_COUNT,
    FFP_SYNTH_POSITION,
    synthesizeFfpVertexShader,
    writeFfpVertexConstants,
    type FfpVertexSpec,
} from "../../src/worker/backends/webgpu/d3d8/ffp-vertex-synth";
import { probeOfflineWgslValidator, validateWgslOffline } from "../d3d9-parity/wgsl-validator";
import { generateMegaBatchShaderCode, generateShaderCode } from "../../src/worker/backends/webgpu/ddraw/shader-generator";
import { DEFAULT_DEBUG_FLAGS } from "../../src/worker/backends/webgpu/ddraw/types";
import { D3D_TRANSFORM_POSITION_WGSL } from "../../src/worker/backends/webgpu/shared/d3d-position";
import { writeMvpWithPixelCenter } from "../../src/worker/backends/webgpu/pixel-center";

type Vec4 = [number, number, number, number];

/** Executes the instruction subset the synthesizer emits (vs_1_1 MOV/ADD/MUL/MAD/RSQ/DP3/DP4). */
function runVs(tokens: Uint32Array, inputs: Map<number, Vec4>, constants: Float32Array) {
    const temps = new Map<number, Vec4>();
    const outputs = new Map<string, Vec4>();
    const regType = (t: number) => ((t >>> 28) & 0x7) | (((t >>> 11) & 0x3) << 3);
    const read = (t: number): Vec4 => {
        const type = regType(t), num = t & 0x7ff;
        const v: Vec4 = type === RegType.INPUT ? (inputs.get(num) ?? [0, 0, 0, 1])
            : type === RegType.CONST ? [0, 1, 2, 3].map(i => constants[num * 4 + i]!) as Vec4
            : (temps.get(num) ?? [0, 0, 0, 0]);
        const swz = (t >>> 16) & 0xff;
        return [0, 1, 2, 3].map(i => v[(swz >>> (i * 2)) & 3]!) as Vec4;
    };
    const write = (t: number, value: Vec4): void => {
        const type = regType(t), num = t & 0x7ff, mask = (t >>> 16) & 0xf;
        const key = `${type}:${num}`;
        const prev = type === RegType.TEMP ? (temps.get(num) ?? [0, 0, 0, 0]) : (outputs.get(key) ?? [0, 0, 0, 0]);
        const next = prev.map((p, i) => (mask >> i) & 1 ? value[i]! : p) as Vec4;
        if (type === RegType.TEMP) temps.set(num, next); else outputs.set(key, next);
    };
    const dot = (a: Vec4, b: Vec4, n: number) => a.slice(0, n).reduce((s, x, i) => s + x * b[i]!, 0);
    let i = 1;
    while (i < tokens.length) {
        const op = tokens[i++]! & 0xffff;
        if (op === Op.END) break;
        const d = tokens[i++]!;
        const a = read(tokens[i++]!);
        if (op === Op.MOV) { write(d, a); continue; }
        if (op === Op.RSQ) { const r = 1 / Math.sqrt(a[0]); write(d, [r, r, r, r]); continue; }
        const b = read(tokens[i++]!);
        if (op === Op.MAD) { const c = read(tokens[i++]!); write(d, a.map((x, k) => x * b[k]! + c[k]!) as Vec4); continue; }
        if (op === Op.MUL) write(d, a.map((x, k) => x * b[k]!) as Vec4);
        else if (op === Op.ADD) write(d, a.map((x, k) => x + b[k]!) as Vec4);
        else if (op === Op.DP3) { const r = dot(a, b, 3); write(d, [r, r, r, r]); }
        else if (op === Op.DP4) { const r = dot(a, b, 4); write(d, [r, r, r, r]); }
        else throw new Error(`unexpected opcode ${op}`);
    }
    return {
        pos: outputs.get(`${RegType.RASTOUT}:0`),
        d0: outputs.get(`${RegType.ATTROUT}:0`),
        d1: outputs.get(`${RegType.ATTROUT}:1`),
        t: (n: number) => outputs.get(`${RegType.TEXCRDOUT}:${n}`),
    };
}

/** Row-vector product v × M against a row-major D3D matrix. */
function mulRow(v: Vec4, m: number[]): Vec4 {
    return [0, 1, 2, 3].map(c => v[0] * m[c]! + v[1] * m[4 + c]! + v[2] * m[8 + c]! + v[3] * m[12 + c]!) as Vec4;
}

const WORLD_VIEW = [
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
    10, -20, 300, 1,
];
const MVP = [
    0.5, 0, 0, 0,
    0, 0.75, 0, 0,
    0, 0, 1.001, 1,
    3, 4, -1, 0,
];
const LAYER_MATRIX = [
    1 / 256, 0, 0, 0,
    0, 1 / 512, 0, 0,
    0.25, 0, 0, 0,
    0.125, 0.5, 0, 1,
];

function closeTo(actual: Vec4 | undefined, expected: Vec4): void {
    expect(actual).toBeDefined();
    for (let i = 0; i < 4; i++) expect(actual![i]!).toBeCloseTo(expected[i]!, 4);
}

// Unreal Engine 2 D3DDrv's terrain blend (its source ships as text inside D3DDrv.dll).
function terrainPs11(): Uint32Array {
    const reg = (type: number, num: number) => (0x80000000 | ((type & 7) << 28) | (((type >> 3) & 3) << 11) | num) >>> 0;
    const dst = (type: number, num: number, shift = 0) => (reg(type, num) | (0xf << 16) | (shift << 24)) >>> 0;
    const src = (type: number, num: number) => (reg(type, num) | (0xe4 << 16)) >>> 0;
    const f = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]!;
    const T = RegType.TEXTURE, R = RegType.TEMP, C = RegType.CONST, V = RegType.INPUT;
    return new Uint32Array([
        0xffff0101,
        Op.DEF, dst(C, 0), f(1), f(0), f(0), f(0),
        Op.DEF, dst(C, 1), f(0), f(1), f(0), f(0),
        Op.DEF, dst(C, 2), f(0), f(0), f(1), f(0),
        Op.TEX, dst(T, 0), Op.TEX, dst(T, 1), Op.TEX, dst(T, 2), Op.TEX, dst(T, 3),
        Op.DP3, dst(R, 1), src(T, 0), src(C, 0),
        Op.MUL, dst(R, 0), src(T, 1), src(R, 1),
        Op.DP3, dst(R, 1), src(T, 0), src(C, 1),
        Op.MAD, dst(R, 0), src(T, 2), src(R, 1), src(R, 0),
        Op.DP3, dst(R, 1), src(T, 0), src(C, 2),
        Op.MAD, dst(R, 0), src(T, 3), src(R, 1), src(R, 0),
        Op.MUL, dst(R, 0, 1), src(R, 0), src(V, 0),
        Op.END,
    ].map(v => v >>> 0));
}

// The terrain declaration UE2 creates: position+normal, diffuse and UV on three streams.
const TERRAIN_DECL: RawVertexElement[] = [
    { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0, reg: 0 },
    { stream: 0, offset: 12, type: 2, usage: 3, usageIndex: 0, reg: 3 },
    { stream: 1, offset: 0, type: 4, usage: 10, usageIndex: 0, reg: 5 },
    { stream: 2, offset: 0, type: 1, usage: 5, usageIndex: 0, reg: 7 },
];

function terrainSpec(): FfpVertexSpec {
    const inputs = describeDeclInputs(TERRAIN_DECL);
    return {
        hasDiffuse: inputs.hasDiffuse,
        hasSpecular: inputs.hasSpecular,
        hasNormal: inputs.hasNormal,
        normalizeNormals: false,
        texcoordComponents: inputs.texcoordComponents,
        texcoords: [
            { output: 0, mode: 0, set: 0, transformFlags: 0 },
            { output: 1, mode: 2, set: 0, transformFlags: 2 },
            { output: 2, mode: 2, set: 0, transformFlags: 2 },
            { output: 3, mode: 2, set: 0, transformFlags: 2 },
        ],
    };
}

// A zero-size viewport folds no pixel centre, so c0-c3 hold the MVP rows unchanged.
const NO_PIXEL_CENTRE = { width: 0, height: 0, minZ: 0, maxZ: 1 };

function constantsFor(
    texMatrix: (stage: number) => number[] | null,
    viewport: { width: number; height: number; minZ: number; maxZ: number } = NO_PIXEL_CENTRE,
): Float32Array {
    const bank = new Float32Array(FFP_SYNTH_CONSTANT_COUNT * 4);
    writeFfpVertexConstants(bank, new Float32Array(MVP), new Float32Array(WORLD_VIEW),
        stage => { const m = texMatrix(stage); return m ? new Float32Array(m) : null; }, viewport);
    return bank;
}

describe("D3D8 fixed-function vertex stage synthesis", () => {
    test("transforms position, passes colours and generates camera-space texcoords", () => {
        const tokens = synthesizeFfpVertexShader(terrainSpec());
        const pos: Vec4 = [100, 200, -50, 1];
        const diffuse: Vec4 = [0.2, 0.4, 0.6, 1];
        const uv: Vec4 = [0.25, 0.75, 0, 1];
        const out = runVs(tokens, new Map([[0, pos], [5, diffuse], [7, uv]]),
            constantsFor(stage => (stage >= 1 && stage <= 3 ? LAYER_MATRIX : null)));

        closeTo(out.pos, mulRow(pos, MVP));
        closeTo(out.d0, diffuse);
        closeTo(out.d1, [0, 0, 0, 0]);
        closeTo(out.t(0), uv);
        const camera = mulRow(pos, WORLD_VIEW);
        const expected = mulRow([camera[0], camera[1], camera[2], 1], LAYER_MATRIX);
        for (const stage of [1, 2, 3]) closeTo(out.t(stage), expected);
    });

    test("a missing vertex colour is opaque white, as fixed-function supplies it", () => {
        const spec = terrainSpec();
        spec.hasDiffuse = false;
        const out = runVs(synthesizeFfpVertexShader(spec), new Map([[0, [0, 0, 0, 1] as Vec4]]), constantsFor(() => null));
        closeTo(out.d0, [1, 1, 1, 1]);
    });

    test("a transformed 2D coordinate is padded so the third matrix row translates it", () => {
        const spec = terrainSpec();
        spec.texcoords = [{ output: 0, mode: 0, set: 0, transformFlags: 2 }];
        const uv: Vec4 = [0.5, 0.25, 0, 1];
        const out = runVs(synthesizeFfpVertexShader(spec), new Map([[0, [0, 0, 0, 1] as Vec4], [7, uv]]),
            constantsFor(stage => (stage === 0 ? LAYER_MATRIX : null)));
        closeTo(out.t(0), mulRow([0.5, 0.25, 1, 0], LAYER_MATRIX));
    });

    test("links against UE2's terrain ps_1_1 into a module with both stages", () => {
        const vs = compileVertexShader(synthesizeFfpVertexShader(terrainSpec()));
        const ps = compilePixelShader(terrainPs11());
        const link = linkProgram({
            vs, ps, declElements: TERRAIN_DECL, streamStride: 24, streamStrides: [24, 4, 8],
            fixedFunctionPosition: FFP_SYNTH_POSITION,
        });
        expect(link.refused).toBeNull();
        expect(link.interpolantBudgetExceeded).toBe(false);
        expect(link.wgsl).toContain("fn vs_main");
        expect(link.wgsl).toContain("fn fs_main");
        expect(link.vertexBuffers.filter(Boolean).length).toBe(3);
        expect(link.wgsl).toContain("@builtin(position) @invariant");
        const validator = probeOfflineWgslValidator();
        if (validator.available) {
            const result = validateWgslOffline(link.wgsl, validator);
            expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
        }
    });

    test("the position bank holds the bits the fixed-function uniform carries", () => {
        const viewport = { width: 800, height: 600, minZ: 0.25, maxZ: 0.75 };
        const bank = constantsFor(() => null, viewport);
        const ffpUniform = new Float32Array(16);
        writeMvpWithPixelCenter(ffpUniform, 0, new Float32Array(MVP), viewport.width, viewport.height);
        const rows = bank.subarray(FFP_SYNTH_POSITION.matrixSlot * 4, FFP_SYNTH_POSITION.matrixSlot * 4 + 16);
        expect(Array.from(rows)).toEqual(Array.from(ffpUniform));
        const range = FFP_SYNTH_POSITION.depthRangeSlot * 4;
        expect([bank[range + 2], bank[range + 3]]).toEqual([0.25, 0.75]);
    });

    test("fixed-function and synthesized passes share one invariant transform", () => {
        const config = {
            sampledMask: 1, stageCount: 1, flatShading: false, alphaTestEnabled: false,
            alphaFunc: 8, shouldEnableBlending: false, missingTexture: false,
            colorKeyEnabled: false, colorKey: null, debugFlags: DEFAULT_DEBUG_FLAGS, needsUVFlip: false,
        };
        const ffp = [generateShaderCode(config), generateMegaBatchShaderCode(config)];
        const link = linkProgram({
            vs: compileVertexShader(synthesizeFfpVertexShader(terrainSpec())),
            ps: compilePixelShader(terrainPs11()),
            declElements: TERRAIN_DECL, streamStride: 24, streamStrides: [24, 4, 8],
            fixedFunctionPosition: FFP_SYNTH_POSITION,
        });
        for (const wgsl of [...ffp, link.wgsl]) {
            expect(wgsl).toContain(D3D_TRANSFORM_POSITION_WGSL.trim());
            expect(wgsl).toMatch(/@builtin\(position\) @invariant/);
            expect(wgsl).toMatch(/= d3dTransformPosition\(/);
            const validator = probeOfflineWgslValidator();
            if (validator.available) {
                const result = validateWgslOffline(wgsl, validator);
                expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
            }
        }
    });
});
