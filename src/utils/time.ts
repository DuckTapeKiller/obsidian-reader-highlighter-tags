export type DateFormat = "YYYY-MM-DD HH:mm" | "YYYYMMDD-HHmmss";

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

/**
 * Formats the given date (default: now) in local time. Produces the same
 * strings the previous `moment().format(...)` calls did, without depending on
 * moment's typings.
 */
export function formatDate(fmt: DateFormat, date: Date = new Date()): string {
    const Y = date.getFullYear();
    const M = pad2(date.getMonth() + 1);
    const D = pad2(date.getDate());
    const h = pad2(date.getHours());
    const m = pad2(date.getMinutes());
    const s = pad2(date.getSeconds());
    return fmt === "YYYYMMDD-HHmmss" ? `${Y}${M}${D}-${h}${m}${s}` : `${Y}-${M}-${D} ${h}:${m}`;
}
