/**
 * A small, dependency-free cron evaluator — just enough for recurring reminders
 * ("every day at 9", "every weekday at 8:30", "every 15 minutes").
 *
 * Standard 5-field cron: `minute hour day-of-month month day-of-week`, each field
 * a star, number, list `1,2,3`, range `1-5`, or step (star-slash-15, `1-5/2`). Day-of-week
 * is 0-6 (0 or 7 = Sunday). Day-of-month + day-of-week follow the Vixie rule: if
 * both are restricted, a time matches when EITHER does.
 *
 * `cronNext` finds the next matching minute by scanning forward in LOCAL time
 * (so it lines up with the user's clock). Dumb but obviously correct, and fast
 * for real schedules (a daily/weekly match is found within minutes to a week).
 */

export interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  /** Whether the day-of-month field was something other than `*` (Vixie OR rule). */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/** Cap the forward scan so an impossible expression (e.g. Feb 31) returns null. */
const MAX_SCAN_MINUTES = 366 * 4 * 24 * 60;

/** Strict non-negative integer parse; rejects "", "-1", "1.5", etc. */
function int(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** Parse one cron field into the set of values it allows, or null if malformed. */
function parseField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    if (part === "") return null;

    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      const parsed = int(part.slice(slash + 1));
      if (parsed === null || parsed <= 0) return null;
      step = parsed;
      range = part.slice(0, slash);
    }

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2) return null;
      const a = int(bounds[0] ?? "");
      const b = int(bounds[1] ?? "");
      if (a === null || b === null) return null;
      lo = a;
      hi = b;
    } else {
      const value = int(range);
      if (value === null) return null;
      lo = value;
      hi = slash >= 0 ? max : value; // "a/n" spreads a..max; bare "a" is just a
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** Parse a 5-field cron expression, or null if it's invalid. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, domSpec, monSpec, dowSpec] = parts as [string, string, string, string, string];

  const minute = parseField(m, 0, 59);
  const hour = parseField(h, 0, 23);
  const dom = parseField(domSpec, 1, 31);
  const month = parseField(monSpec, 1, 12);
  const dow = parseField(dowSpec, 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;

  if (dow.has(7)) {
    dow.add(0); // normalize Sunday
    dow.delete(7);
  }
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: domSpec !== "*",
    dowRestricted: dowSpec !== "*",
  };
}

/** Whether a given local time satisfies the cron fields. */
function matches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false;
  if (!fields.hour.has(date.getHours())) return false;
  if (!fields.month.has(date.getMonth() + 1)) return false;

  const domOk = fields.dom.has(date.getDate());
  const dowOk = fields.dow.has(date.getDay());
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
}

/**
 * The next time (strictly after `after`) the expression fires, or null if the
 * expression is invalid or has no occurrence within the scan window.
 */
export function cronNext(expr: string, after: Date): Date | null {
  const fields = parseCron(expr);
  if (!fields) return null;

  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (matches(fields, cursor)) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
