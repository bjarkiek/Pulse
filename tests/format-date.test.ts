import test from "node:test";
import assert from "node:assert/strict";
import { formatDate, formatDateTime } from "../lib/format-date";

// Dates are built from local parts, so the expectations hold in any time zone the tests run in.
test("formatDate writes a date the way the server writes a request's submitted date", () => {
  assert.equal(formatDate(new Date(2026, 6, 10)), "10 Jul 2026");
  assert.equal(formatDate(new Date(2026, 0, 3)), "3 Jan 2026");
});

test("formatDateTime adds the time on the 24-hour clock", () => {
  assert.equal(formatDateTime(new Date(2026, 6, 10, 14, 5)), "10 Jul 2026, 14:05");
  assert.equal(formatDateTime(new Date(2026, 11, 31, 0, 0)), "31 Dec 2026, 00:00");
});

test("a value that is not a date is shown as it came, and nothing is shown for nothing", () => {
  assert.equal(formatDate("not a date"), "not a date");
  assert.equal(formatDateTime("pending"), "pending");
  assert.equal(formatDate(""), "");
  assert.equal(formatDate(null), "");
  assert.equal(formatDateTime(undefined), "");
});

test("an ISO string is read as a date", () => {
  const iso = new Date(2026, 6, 10, 9, 30).toISOString();
  assert.equal(formatDateTime(iso), "10 Jul 2026, 09:30");
});
