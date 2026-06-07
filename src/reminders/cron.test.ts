import { describe, expect, test } from "bun:test";
import { cronNext, parseCron } from "./cron.ts";

describe("parseCron", () => {
  test("accepts well-formed expressions", () => {
    for (const expr of ["0 9 * * *", "*/15 * * * *", "30 8 * * 1-5", "0 0 1,15 * *", "0 0 * * 0"]) {
      expect(parseCron(expr)).not.toBeNull();
    }
  });

  test("rejects malformed expressions", () => {
    for (const expr of [
      "0 9 * *", // too few fields
      "0 9 * * * *", // too many
      "60 * * * *", // minute out of range
      "0 24 * * *", // hour out of range
      "0 9 * * 8", // day-of-week out of range
      "0 9 0 * *", // day-of-month below 1
      "0 9 */0 * *", // zero step
      "0 9 5-2 * *", // inverted range
      "abc * * * *", // non-numeric
      "", // empty
    ]) {
      expect(parseCron(expr)).toBeNull();
    }
  });

  test("normalizes day-of-week 7 to 0 (Sunday)", () => {
    const fields = parseCron("0 0 * * 7");
    expect(fields?.dow.has(0)).toBe(true);
    expect(fields?.dow.has(7)).toBe(false);
  });
});

describe("cronNext", () => {
  test("daily: next 9am is today if before, tomorrow if after", () => {
    expect(cronNext("0 9 * * *", new Date(2026, 0, 1, 8, 0))).toEqual(new Date(2026, 0, 1, 9, 0));
    expect(cronNext("0 9 * * *", new Date(2026, 0, 1, 10, 0))).toEqual(new Date(2026, 0, 2, 9, 0));
  });

  test("every 15 minutes lands on the next quarter", () => {
    expect(cronNext("*/15 * * * *", new Date(2026, 0, 1, 10, 7))).toEqual(new Date(2026, 0, 1, 10, 15));
    expect(cronNext("*/15 * * * *", new Date(2026, 0, 1, 10, 15))).toEqual(new Date(2026, 0, 1, 10, 30));
  });

  test("weekly: always the right weekday and time, in the future", () => {
    const base = new Date(2026, 0, 1, 12, 0); // a Thursday
    const next = cronNext("0 8 * * 1", base); // Mondays 08:00
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(1);
    expect(next!.getHours()).toBe(8);
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getTime()).toBeGreaterThan(base.getTime());
  });

  test("weekday range only fires Mon–Fri", () => {
    const next = cronNext("30 8 * * 1-5", new Date(2026, 0, 3, 12, 0)); // Jan 3 2026 is a Saturday
    expect(next!.getDay()).toBeGreaterThanOrEqual(1);
    expect(next!.getDay()).toBeLessThanOrEqual(5);
    expect(next!.getHours()).toBe(8);
    expect(next!.getMinutes()).toBe(30);
  });

  test("day-of-month OR day-of-week (Vixie rule): matches via the weekday", () => {
    // "1st of month OR Monday, at midnight". From Fri Jan 2 2026, the next Monday
    // (Jan 5) comes before the next 1st (Feb 1), so dow drives the match.
    expect(cronNext("0 0 1 * 1", new Date(2026, 0, 2, 0, 0))).toEqual(new Date(2026, 0, 5, 0, 0));
  });

  test("day-of-month OR day-of-week: matches via the day-of-month", () => {
    // From Sat Jan 31 2026, the next 1st (Sun Feb 1) comes before the next Monday
    // (Feb 2), so dom drives the match — proving it's OR, not AND.
    expect(cronNext("0 0 1 * 1", new Date(2026, 0, 31, 12, 0))).toEqual(new Date(2026, 1, 1, 0, 0));
  });

  test("returns null for an invalid expression", () => {
    expect(cronNext("not a cron", new Date(2026, 0, 1))).toBeNull();
  });

  test("returns null for an impossible expression (no occurrence in range)", () => {
    expect(cronNext("0 0 30 2 *", new Date(2026, 0, 1))).toBeNull(); // Feb 30 never happens
  });
});
