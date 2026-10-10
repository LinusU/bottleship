/**
 * A thunk that has to call the guest several times, each call depending on the last one's
 * result, written as a generator: `yield` a guest call, receive its EAX, `return` the
 * thunk's own result. COM handlers that are handed a guest-implemented interface (a
 * stream to read, a loader to resolve references through) are the main users.
 *
 * Every hop resumes exactly where this thunk's own `RET N` would have, so a routine may
 * be entered again from inside one of its own guest calls (a loader that loads another
 * object from within GetObject) without the two sharing any frame.
 */
import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import type { ThunkResult, X86Context } from "./thunk-dispatcher";

export interface GuestCall {
    /** Address of the stdcall guest function. */
    fn: number;
    args: number[];
    tag: string;
}

export type GuestRoutine = Generator<GuestCall, number, number>;

/**
 * Run `routine` and answer the current thunk with its return value. `stackCleanup` is
 * the number of argument bytes the thunk's `RET N` pops. A call the callback manager
 * refuses, or to a null function, yields E_FAIL to the routine instead of running.
 */
export function runGuestRoutine(
    ctx: X86Context, mem: Uint8Array, routine: GuestRoutine, stackCleanup: number, tag: string,
): number | ThunkResult {
    const E_FAIL = 0x80004005;
    const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const returnAddr = view.getUint32(ctx.esp, true) >>> 0;
    const postEsp = (ctx.esp + 4 + stackCleanup) >>> 0;

    let firstCallbackId = 0;
    const advance = (input: number): number | null => {
        for (;;) {
            let step: IteratorResult<GuestCall, number>;
            try {
                step = routine.next(input >>> 0);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `${tag}: routine threw: ${e}`);
                return E_FAIL;
            }
            if (step.done) return step.value >>> 0;

            const call = step.value;
            if (!call.fn || !callbackManager) {
                input = E_FAIL;
                continue;
            }
            const invoked = callbackManager.invokeCallback(
                call.fn, call.args, 0, undefined, false, call.tag, undefined,
                { directThunkReturn: { returnAddr, postEsp, complete: (ret: number): number | null => advance(ret) } },
            );
            if (invoked.callbackId === 0) {
                input = E_FAIL;
                continue;
            }
            if (!firstCallbackId) firstCallbackId = invoked.callbackId;
            return null;
        }
    };

    const immediate = advance(0);
    if (immediate !== null) return immediate;
    return {
        value: 0,
        suspendedForCallback: true,
        callbackId: firstCallbackId,
        stackCleanup,
        skipStackCheck: true,
        preserveCallbackReturnAddress: true,
    };
}
