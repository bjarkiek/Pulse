/**
 * One way of writing a date across Pulse: "10 Jul 2026", and with a time "10 Jul 2026, 14:05" in the reader's own time zone.
 * The shape is the one the server already uses for a request's submitted date, so a row never shows two formats side by side;
 * month names stay English in both languages for the same reason.
 */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function parse(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "10 Jul 2026". A value that is not a date is returned as it came, so nothing is hidden from the reader. */
export function formatDate(value: string | number | Date | null | undefined) {
  const date = parse(value);
  if (!date) return value ? String(value) : "";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "10 Jul 2026, 14:05", on the 24-hour clock. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
) {
  const date = parse(value);
  if (!date) return value ? String(value) : "";
  const two = (part: number) => String(part).padStart(2, "0");
  return `${formatDate(date)}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}
