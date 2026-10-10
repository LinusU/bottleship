/**
 * IDirect3DDevice3/7::DrawPrimitiveStrided and DrawIndexedPrimitiveStrided.
 *
 * D3DDRAWPRIMITIVESTRIDEDDATA (d3dtypes.h) gives every vertex component its own array:
 *   D3DDP_PTRSTRIDE { LPVOID lpvData; DWORD dwStride; }
 *   position, normal, diffuse, specular, textureCoords[D3DDP_MAXTEXCOORD = 8]
 * The FVF alone decides which members are read and how wide an element is; a member the
 * FVF does not name is never dereferenced, whatever it holds.
 *
 * Everything downstream consumes ONE interleaved array in the FVF's own layout, so the
 * streams are gathered into that layout and drawn from there.
 */

import { isValidAddress } from "../../../core/memory/address-guard";
import { toPlainGuestMemory } from "../../../core/memory/guest-memory";
import { fvfLayout } from "./process-vertices";

const MEMBER_BYTES = 8;
const MEMBER_POSITION = 0;
const MEMBER_NORMAL = 1;
const MEMBER_DIFFUSE = 2;
const MEMBER_SPECULAR = 3;
const MEMBER_TEXCOORD0 = 4;
const MAX_TEXCOORD = 8;

export const STRIDED_DATA_BYTES = (MEMBER_TEXCOORD0 + MAX_TEXCOORD) * MEMBER_BYTES;

/** Marks a destination range no stream feeds (the FVF's reserved DWORD). */
const NO_SOURCE = -1;

export interface StridedPlan {
    /** Interleaved vertex size. */
    stride: number;
    /** Triples: byte offset of the D3DDP_PTRSTRIDE member (or NO_SOURCE), offset in the vertex, byte length. */
    copies: Int32Array;
}

const plans = new Map<number, StridedPlan | null>();

/** How an FVF's interleaved vertex is assembled from the strided members; null for an FVF we cannot lay out. */
export function stridedPlan(fvf: number): StridedPlan | null {
    let plan = plans.get(fvf);
    if (plan !== undefined) return plan;

    const layout = fvfLayout(fvf);
    if (!layout || layout.texOffsets.length > MAX_TEXCOORD) {
        plans.set(fvf, null);
        return null;
    }
    const copies: number[] = [];
    // Blend weights of an XYZBn vertex travel in the position stream, as they do interleaved.
    copies.push(MEMBER_POSITION * MEMBER_BYTES, layout.posOffset, layout.positionBytes);
    let covered = layout.positionBytes;
    const add = (member: number, offset: number, bytes: number) => {
        if (offset > covered) copies.push(NO_SOURCE, covered, offset - covered);
        copies.push(member * MEMBER_BYTES, offset, bytes);
        covered = offset + bytes;
    };
    if (layout.normalOffset >= 0) add(MEMBER_NORMAL, layout.normalOffset, 12);
    if (layout.diffuseOffset >= 0) add(MEMBER_DIFFUSE, layout.diffuseOffset, 4);
    if (layout.specularOffset >= 0) add(MEMBER_SPECULAR, layout.specularOffset, 4);
    for (let s = 0; s < layout.texOffsets.length; s++) {
        add(MEMBER_TEXCOORD0 + s, layout.texOffsets[s]!, layout.texComponents[s]! * 4);
    }
    if (layout.stride > covered) copies.push(NO_SOURCE, covered, layout.stride - covered);

    plan = { stride: layout.stride, copies: Int32Array.from(copies) };
    plans.set(fvf, plan);
    return plan;
}

/**
 * Gather `vertexCount` vertices described by the D3DDRAWPRIMITIVESTRIDEDDATA at `lpStrided`
 * into interleaved vertices at `dstAddr`. Returns false, having written nothing, when the
 * descriptor or any stream the FVF names is not readable guest memory.
 */
export function packStridedVertices(
    mem: Uint8Array,
    lpStrided: number,
    plan: StridedPlan,
    vertexCount: number,
    dstAddr: number,
): boolean {
    if (!lpStrided || !isValidAddress(mem, lpStrided, STRIDED_DATA_BYTES, "r")) return false;
    // Per-byte access through the thunk's guest view costs a Proxy trap each way.
    const plain = toPlainGuestMemory(mem);
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const { copies, stride } = plan;

    for (let c = 0; c < copies.length; c += 3) {
        const member = copies[c]!;
        if (member === NO_SOURCE) continue;
        const src = view.getUint32(lpStrided + member, true);
        const srcStride = view.getUint32(lpStrided + member + 4, true);
        if (!src || !isValidAddress(mem, src, (vertexCount - 1) * srcStride + copies[c + 2]!, "r")) return false;
    }

    for (let c = 0; c < copies.length; c += 3) {
        const member = copies[c]!;
        const bytes = copies[c + 2]!;
        let dst = dstAddr + copies[c + 1]!;
        if (member === NO_SOURCE) {
            for (let v = 0; v < vertexCount; v++, dst += stride) plain.fill(0, dst, dst + bytes);
            continue;
        }
        let src = view.getUint32(lpStrided + member, true);
        const srcStride = view.getUint32(lpStrided + member + 4, true);
        for (let v = 0; v < vertexCount; v++, src += srcStride, dst += stride) {
            for (let b = 0; b < bytes; b++) plain[dst + b] = plain[src + b]!;
        }
    }
    return true;
}

interface GuestAllocator {
    alloc(size: number): number;
    free(address: number): void;
}

/** The guest block the gathered vertices live in between the gather and the draw that reads them. */
export class StridedScratch {
    private address = 0;
    private capacity = 0;

    /** Guest address of a block of at least `bytes`, or 0 when the guest heap is exhausted. */
    reserve(memory: GuestAllocator, bytes: number): number {
        if (bytes <= this.capacity) return this.address;
        let capacity = Math.max(this.capacity, 64 * 1024);
        while (capacity < bytes) capacity *= 2;
        const address = memory.alloc(capacity);
        if (!address) return 0;
        if (this.address) memory.free(this.address);
        this.address = address;
        this.capacity = capacity;
        return address;
    }
}
