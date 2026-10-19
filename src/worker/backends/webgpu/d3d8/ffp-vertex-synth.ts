/**
 * Fixed-function vertex processing expressed as vs_1_1 bytecode.
 *
 * D3D8 lets a draw pair a declaration-only vertex shader (fixed-function vertex
 * processing) with a programmable pixel shader. The programmable link needs a vertex
 * stage, so this module writes the one the fixed-function pipeline would run for the
 * current state — transform, vertex colours, and per-stage texture coordinate
 * processing (D3DTSS_TEXCOORDINDEX passthrough / D3DTSS_TCI_CAMERASPACE* generation,
 * then the D3DTS_TEXTUREn matrix per D3DTSS_TEXTURETRANSFORMFLAGS) — and the constant
 * bank that drives it. The program then links against the guest's pixel shader exactly
 * like a guest-supplied vs_1_1.
 *
 * Lighting is outside this module's scope: a lit draw has no synthesized vertex stage.
 */
import { RegType, Op } from "../d3d9/shader/sm-enums";
import type { RawVertexElement } from "../d3d9/shader";
import { writeMvpWithPixelCenter } from "../pixel-center";

/** D3DVSDE_* input registers, which on a declaration-only shader carry FFP semantics. */
const VSDE_POSITION = 0;
const VSDE_NORMAL = 3;
const VSDE_DIFFUSE = 5;
const VSDE_SPECULAR = 6;
const VSDE_TEXCOORD0 = 7;

const TCI_PASSTHRU = 0;
const TCI_CAMERASPACENORMAL = 1;
const TCI_CAMERASPACEPOSITION = 2;

const TTFF_COUNT_MASK = 0xff;
const TTFF_PROJECTED = 0x100;

/** D3DDECLTYPE component counts for the types a D3D8 declaration can produce. */
const DECLTYPE_COMPONENTS: Readonly<Record<number, number>> = {
    0: 1, 1: 2, 2: 3, 3: 4, // FLOAT1..FLOAT4
    4: 4,                   // D3DCOLOR
    5: 4,                   // UBYTE4
    6: 2, 7: 4,             // SHORT2, SHORT4
};

/** Constant bank layout: c0-3 MVP ROWS with the pixel centre folded in (the exact bits the
 *  fixed-function path uploads), c4 = (1, 0, MinZ, MaxZ), c5-8 world×view columns,
 *  c9+4n .. c12+4n the D3DTS_TEXTUREn columns. */
const C_MVP = 0;
const C_UNIT = 4;
const C_WORLDVIEW = 5;
const C_TEXMATRIX = 9;
/** The linker's fixedFunctionPosition slots for this bank (position input is v0). */
export const FFP_SYNTH_POSITION = { inputRegister: VSDE_POSITION, matrixSlot: C_MVP, depthRangeSlot: C_UNIT } as const;
export const FFP_SYNTH_MAX_TEXCOORDS = 8;
export const FFP_SYNTH_CONSTANT_COUNT = C_TEXMATRIX + FFP_SYNTH_MAX_TEXCOORDS * 4;

export interface FfpTexcoordSpec {
    /** Output texcoord register n (= texture stage n). */
    output: number;
    /** D3DTSS_TCI_* mode (high word of D3DTSS_TEXCOORDINDEX). */
    mode: number;
    /** Vertex UV set (low word of D3DTSS_TEXCOORDINDEX). */
    set: number;
    /** D3DTSS_TEXTURETRANSFORMFLAGS. */
    transformFlags: number;
}

export interface FfpVertexSpec {
    hasDiffuse: boolean;
    hasSpecular: boolean;
    /** Component count of each texcoord set present in the declaration (index = set). */
    texcoordComponents: (number | undefined)[];
    hasNormal: boolean;
    normalizeNormals: boolean;
    texcoords: FfpTexcoordSpec[];
}

/** What the declaration provides, keyed by D3DVSDE register. */
export function describeDeclInputs(decl: readonly RawVertexElement[]): {
    hasPosition: boolean; hasNormal: boolean; hasDiffuse: boolean; hasSpecular: boolean;
    texcoordComponents: (number | undefined)[];
} {
    const out = {
        hasPosition: false, hasNormal: false, hasDiffuse: false, hasSpecular: false,
        texcoordComponents: [] as (number | undefined)[],
    };
    for (const e of decl) {
        const reg = e.reg;
        if (reg === undefined) continue;
        if (reg === VSDE_POSITION) out.hasPosition = true;
        else if (reg === VSDE_NORMAL) out.hasNormal = true;
        else if (reg === VSDE_DIFFUSE) out.hasDiffuse = true;
        else if (reg === VSDE_SPECULAR) out.hasSpecular = true;
        else if (reg >= VSDE_TEXCOORD0 && reg < VSDE_TEXCOORD0 + 8) {
            out.texcoordComponents[reg - VSDE_TEXCOORD0] = DECLTYPE_COMPONENTS[e.type] ?? 4;
        }
    }
    return out;
}

/** Whether the fixed-function vertex stage for this spec can be expressed here. */
export function isFfpVertexSpecSupported(spec: FfpVertexSpec): boolean {
    for (const t of spec.texcoords) {
        if (t.output < 0 || t.output >= FFP_SYNTH_MAX_TEXCOORDS) return false;
        if (t.mode === TCI_CAMERASPACENORMAL && !spec.hasNormal) return false;
        if (t.mode !== TCI_PASSTHRU && t.mode !== TCI_CAMERASPACENORMAL
            && t.mode !== TCI_CAMERASPACEPOSITION) return false;
        const count = t.transformFlags & TTFF_COUNT_MASK;
        if (count > 4) return false;
    }
    return true;
}

export function ffpVertexSpecKey(spec: FfpVertexSpec): string {
    const tc = spec.texcoords
        .map(t => `${t.output}.${t.mode}.${t.set}.${t.transformFlags}`)
        .join(",");
    const comps = spec.texcoordComponents.map(c => c ?? "-").join("");
    return `d${+spec.hasDiffuse}s${+spec.hasSpecular}n${+spec.hasNormal}${+spec.normalizeNormals}`
        + `c${comps}t${tc}`;
}

// ── vs_1_1 token encoding ────────────────────────────────────────────────────

const SWZ_XYZW = 0xe4;
const SWZ_XXXX = 0x00;
const SWZ_YYYY = 0x55;
const SWZ_ZZZZ = 0xaa;

function reg(type: number, num: number): number {
    return (0x80000000 | ((type & 0x7) << 28) | (((type >>> 3) & 0x3) << 11) | (num & 0x7ff)) >>> 0;
}
function dst(type: number, num: number, mask = 0xf): number {
    return (reg(type, num) | (mask << 16)) >>> 0;
}
function src(type: number, num: number, swizzle = SWZ_XYZW): number {
    return (reg(type, num) | (swizzle << 16)) >>> 0;
}

const MASK_X = 0x1, MASK_Y = 0x2, MASK_Z = 0x4, MASK_W = 0x8;
const COMPONENT_MASKS = [MASK_X, MASK_Y, MASK_Z, MASK_W] as const;

const R_CAMPOS = 0;
const R_CAMNORMAL = 1;
const R_SCRATCH = 2;
const R_SOURCE = 3;

/**
 * Assemble the fixed-function vertex stage for `spec`. Output registers follow D3D's
 * fixed-function results: oPos, oD0 (diffuse or opaque white), oD1 (specular or zero)
 * and oTn for every requested texcoord.
 */
export function synthesizeFfpVertexShader(spec: FfpVertexSpec): Uint32Array {
    const t: number[] = [0xfffe0101];
    const emit = (op: number, ...params: number[]): void => { t.push(op, ...params); };
    const unit = (swz: number): number => src(RegType.CONST, C_UNIT, swz);

    // v × M over the row bank. The link replaces this oPos with d3dTransformPosition on the
    // same rows (FFP_SYNTH_POSITION); computing it here keeps the program complete and keeps
    // c0-c4 inside the bank the linker sizes from the instructions.
    const position = (swz: number): number => src(RegType.INPUT, VSDE_POSITION, swz);
    emit(Op.MUL, dst(RegType.TEMP, R_SCRATCH), position(SWZ_XXXX), src(RegType.CONST, C_MVP));
    emit(Op.MAD, dst(RegType.TEMP, R_SCRATCH), position(SWZ_YYYY), src(RegType.CONST, C_MVP + 1), src(RegType.TEMP, R_SCRATCH));
    emit(Op.MAD, dst(RegType.TEMP, R_SCRATCH), position(SWZ_ZZZZ), src(RegType.CONST, C_MVP + 2), src(RegType.TEMP, R_SCRATCH));
    emit(Op.ADD, dst(RegType.TEMP, R_SCRATCH), src(RegType.TEMP, R_SCRATCH), src(RegType.CONST, C_MVP + 3));
    emit(Op.MUL, dst(RegType.RASTOUT, 0), src(RegType.TEMP, R_SCRATCH), unit(SWZ_XXXX));
    emit(Op.MOV, dst(RegType.ATTROUT, 0),
        spec.hasDiffuse ? src(RegType.INPUT, VSDE_DIFFUSE) : unit(SWZ_XXXX));
    emit(Op.MOV, dst(RegType.ATTROUT, 1),
        spec.hasSpecular ? src(RegType.INPUT, VSDE_SPECULAR) : unit(SWZ_YYYY));

    const needsCamPos = spec.texcoords.some(x => x.mode === TCI_CAMERASPACEPOSITION);
    const needsCamNormal = spec.texcoords.some(x => x.mode === TCI_CAMERASPACENORMAL);
    if (needsCamPos) {
        for (let i = 0; i < 3; i++) {
            emit(Op.DP4, dst(RegType.TEMP, R_CAMPOS, COMPONENT_MASKS[i]),
                src(RegType.INPUT, VSDE_POSITION), src(RegType.CONST, C_WORLDVIEW + i));
        }
        emit(Op.MOV, dst(RegType.TEMP, R_CAMPOS, MASK_W), unit(SWZ_XXXX));
    }
    if (needsCamNormal) {
        for (let i = 0; i < 3; i++) {
            emit(Op.DP3, dst(RegType.TEMP, R_CAMNORMAL, COMPONENT_MASKS[i]),
                src(RegType.INPUT, VSDE_NORMAL), src(RegType.CONST, C_WORLDVIEW + i));
        }
        if (spec.normalizeNormals) {
            emit(Op.DP3, dst(RegType.TEMP, R_SCRATCH, MASK_X),
                src(RegType.TEMP, R_CAMNORMAL), src(RegType.TEMP, R_CAMNORMAL));
            emit(Op.RSQ, dst(RegType.TEMP, R_SCRATCH, MASK_X), src(RegType.TEMP, R_SCRATCH, SWZ_XXXX));
            emit(Op.MUL, dst(RegType.TEMP, R_CAMNORMAL, MASK_X | MASK_Y | MASK_Z),
                src(RegType.TEMP, R_CAMNORMAL), src(RegType.TEMP, R_SCRATCH, SWZ_XXXX));
        }
        emit(Op.MOV, dst(RegType.TEMP, R_CAMNORMAL, MASK_W), unit(SWZ_XXXX));
    }

    for (const tc of spec.texcoords) {
        const out = dst(RegType.TEXCRDOUT, tc.output);
        const count = tc.transformFlags & TTFF_COUNT_MASK;
        let source: number;
        if (tc.mode === TCI_CAMERASPACEPOSITION) {
            source = src(RegType.TEMP, R_CAMPOS);
        } else if (tc.mode === TCI_CAMERASPACENORMAL) {
            source = src(RegType.TEMP, R_CAMNORMAL);
        } else {
            const components = spec.texcoordComponents[tc.set];
            if (components === undefined) {
                // A stage reading a set the declaration does not supply sees zeros.
                emit(Op.MOV, out, unit(SWZ_YYYY));
                continue;
            }
            source = src(RegType.INPUT, VSDE_TEXCOORD0 + tc.set);
            if (count !== 0 && components < 4) {
                // A texture matrix sees an n-component coordinate padded with a 1 right
                // after its last component and zeros beyond it, so a 2D coordinate's
                // translation lives in the matrix's third row.
                emit(Op.MOV, dst(RegType.TEMP, R_SOURCE), source);
                for (let c = components; c < 4; c++) {
                    emit(Op.MOV, dst(RegType.TEMP, R_SOURCE, COMPONENT_MASKS[c]),
                        unit(c === components ? SWZ_XXXX : SWZ_YYYY));
                }
                source = src(RegType.TEMP, R_SOURCE);
            }
        }
        if (count === 0) {
            emit(Op.MOV, out, source);
            continue;
        }
        const matrix = C_TEXMATRIX + tc.output * 4;
        const projected = (tc.transformFlags & TTFF_PROJECTED) !== 0;
        for (let i = 0; i < 4; i++) {
            // The linker's projective fetch divides by .w; D3D divides by the last counted
            // component, so that column feeds .w.
            const column = projected && i === 3 ? count - 1 : i;
            emit(Op.DP4, dst(RegType.TEXCRDOUT, tc.output, COMPONENT_MASKS[i]),
                source, src(RegType.CONST, matrix + column));
        }
    }
    t.push(Op.END);
    return Uint32Array.from(t, v => v >>> 0);
}

/** Write a row-major D3D matrix's columns into four consecutive vec4 constants. */
function writeColumns(out: Float32Array, register: number, m: Float32Array | null): void {
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            out[(register + col) * 4 + row] = m ? m[row * 4 + col]! : (row === col ? 1 : 0);
        }
    }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Fill the constant bank `synthesizeFfpVertexShader` reads. `viewport` is the sanitized
 *  viewport the fixed-function path rasterizes against (its pixel centre and depth range). */
export function writeFfpVertexConstants(
    out: Float32Array,
    mvp: Float32Array | null,
    worldView: Float32Array | null,
    textureMatrix: (stage: number) => Float32Array | null,
    viewport: { width: number; height: number; minZ: number; maxZ: number },
): void {
    // The fixed-function uniform writer folds the pixel centre into a real MVP only and
    // uploads a missing one as plain identity; the bits must match it either way.
    if (mvp) writeMvpWithPixelCenter(out, C_MVP * 4, mvp, viewport.width, viewport.height);
    else out.set(IDENTITY, C_MVP * 4);
    writeColumns(out, C_WORLDVIEW, worldView);
    out[C_UNIT * 4 + 0] = 1;
    out[C_UNIT * 4 + 1] = 0;
    out[C_UNIT * 4 + 2] = viewport.minZ;
    out[C_UNIT * 4 + 3] = viewport.maxZ;
    for (let stage = 0; stage < FFP_SYNTH_MAX_TEXCOORDS; stage++) {
        writeColumns(out, C_TEXMATRIX + stage * 4, textureMatrix(stage));
    }
}
