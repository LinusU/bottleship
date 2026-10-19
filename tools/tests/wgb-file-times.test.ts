/**
 * A bundle carries each file's write time from the packed directory to the guest: the
 * writer stamps the source mtime, the runtime ZIP reader returns it, and `wgb.ts`
 * rebuilds keep it. A title may refuse a data file whose date is not the one it shipped.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferSource, ZipArchive, dosDateTimeToUnix, unixToDosDateTime } from "@bottleship/formats/zip";
import { ZipStoreWriter } from "../internal/zip-store-writer";

/** 2001-10-05 12:07:22 UTC — even seconds, which is all DOS time can hold. */
const SHIPPED = 1002283642;

describe("DOS date/time", () => {
    test("round-trips an even-second instant through the packed stamp", () => {
        const stamp = unixToDosDateTime(SHIPPED);
        expect(stamp >>> 16).toBe(0x2b45);
        expect(stamp & 0xffff).toBe(0x60eb);
        expect(dosDateTimeToUnix(stamp >>> 16, stamp & 0xffff)).toBe(SHIPPED);
    });

    test("a zero date is no date, and pre-1980 instants have no stamp", () => {
        expect(dosDateTimeToUnix(0, 0)).toBeUndefined();
        expect(unixToDosDateTime(0)).toBe(0);
    });
});

describe("bundle file times", () => {
    test("make-wgb's writer stamps the source mtime and the runtime reader returns it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "wgb-times-"));
        const src = join(dir, "mp_castle.map");
        writeFileSync(src, "map");
        utimesSync(src, SHIPPED, SHIPPED);
        const out = join(dir, "t.wgb");
        const w = new ZipStoreWriter(out);
        w.addBuffer("manifest.json", Buffer.from("{}"));
        w.addFile("rom/mp_castle.map", src);
        w.finish();

        const zip = new ZipArchive(new BufferSource(new Uint8Array(readFileSync(out))));
        await zip.init();
        expect(zip.getEntry("rom/mp_castle.map")?.modified).toBe(SHIPPED);
        expect(zip.getEntry("manifest.json")?.modified).toBeUndefined();
    });
});
