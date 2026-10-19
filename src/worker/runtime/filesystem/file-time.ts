/**
 * File times every VFS surface reports (WIN32_FIND_DATA, GetFileTime,
 * BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, the CRT's _stat/_finddata), for creation,
 * access and write alike, so the Win32 and CRT views of a file cannot disagree.
 *
 * A ROM file reports the write time its bundle entry records: the installer's own date,
 * which some titles verify. Anything without one reports VFS_FILE_TIME_UNIX_SECONDS. It must
 * never be zero: NTFS does not report a zero FILETIME, and the CRT maps one to time_t -1,
 * which localtime() answers with NULL.
 */
export const VFS_FILE_TIME_UNIX_SECONDS = 1577836800; // 2020-01-01T00:00:00Z

const FILETIME_UNIX_EPOCH_SECONDS = 11644473600n;

/** FILETIME: 100 ns ticks since 1601-01-01 UTC. */
export const VFS_FILETIME = (BigInt(VFS_FILE_TIME_UNIX_SECONDS) + FILETIME_UNIX_EPOCH_SECONDS) * 10_000_000n;

/** The time to report for an entry, as Unix seconds. */
export function unixTimeOf(entry: { modified?: number } | null | undefined): number {
    return entry?.modified ?? VFS_FILE_TIME_UNIX_SECONDS;
}

/** The time to report for an entry, as a FILETIME. */
export function fileTimeOf(entry: { modified?: number } | null | undefined): bigint {
    return entry?.modified === undefined ? VFS_FILETIME
        : (BigInt(Math.floor(entry.modified)) + FILETIME_UNIX_EPOCH_SECONDS) * 10_000_000n;
}
