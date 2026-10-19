/**
 * MS-DOS packed date/time (ZIP headers, InstallShield and CAB file records):
 * date = (year-1980)<<9 | month<<5 | day, time = hour<<11 | minute<<5 | second/2.
 * The format carries no zone; we read and write it as UTC, so a stamp survives a
 * write/read round trip exactly and an installer's local build time stays on its day.
 */

/** Unix seconds, or undefined for the "no date" stamp (date 0) or an impossible one. */
export function dosDateTimeToUnix(date: number, time: number): number | undefined {
    const day = date & 0x1f, month = (date >> 5) & 0xf, year = 1980 + (date >> 9);
    const hour = time >> 11, minute = (time >> 5) & 0x3f, second = (time & 0x1f) * 2;
    if (!day || !month || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
    return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/** `date << 16 | time`, or 0 for an instant DOS cannot represent (before 1980 / after 2107). */
export function unixToDosDateTime(seconds: number): number {
    const d = new Date(Math.floor(seconds) * 1000);
    const year = d.getUTCFullYear();
    if (!Number.isFinite(seconds) || year < 1980 || year > 2107) return 0;
    const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    return ((date << 16) | time) >>> 0;
}
