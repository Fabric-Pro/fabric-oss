/**
 * `getCurrentDateContext()` must stay date-only (no hour/minute/AM-PM/
 * timezone) so its output is byte-identical for a whole calendar day —
 * provider prompt caching (OpenAI automatic caching, Anthropic
 * cache_control, Databricks-hosted models) is a byte-level prefix match, and
 * a value that changes every ≤60 seconds at the front of a system prompt
 * invalidates the cached prefix on essentially every call.
 *
 * TZ is pinned to UTC for the exact-string assertion so the test doesn't
 * depend on the local/CI machine's timezone — Node re-reads `process.env.TZ`
 * per `Intl`/`Date.prototype.toLocaleDateString` call, so this is safe to
 * flip for the duration of the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentDateContext } from "../prompts";

describe("getCurrentDateContext", () => {
	const originalTz = process.env.TZ;

	beforeEach(() => {
		vi.useFakeTimers();
		process.env.TZ = "UTC";
	});

	afterEach(() => {
		vi.useRealTimers();
		process.env.TZ = originalTz;
	});

	it("renders date-only, with no clock time, AM/PM, or timezone abbreviation", () => {
		vi.setSystemTime(new Date("2026-02-05T14:37:00Z"));

		const result = getCurrentDateContext();

		expect(result).toBe("Today is Thursday, February 5, 2026.");
		expect(result).not.toMatch(/\d{1,2}:\d{2}/); // no HH:MM clock time
		expect(result).not.toMatch(/\bAM\b|\bPM\b/); // no meridiem
		expect(result).not.toMatch(/\b[A-Z]{2,5}\b/); // no tz abbreviation (EST, UTC, ...)
	});

	it("stays byte-identical across calls at opposite ends of the same calendar day", () => {
		vi.setSystemTime(new Date("2026-02-05T00:00:01Z"));
		const morning = getCurrentDateContext();

		vi.setSystemTime(new Date("2026-02-05T23:59:59Z"));
		const night = getCurrentDateContext();

		expect(night).toBe(morning);
	});

	it("only changes at the calendar-day boundary", () => {
		vi.setSystemTime(new Date("2026-02-05T23:59:59Z"));
		const dayFive = getCurrentDateContext();

		vi.setSystemTime(new Date("2026-02-06T00:00:01Z"));
		const daySix = getCurrentDateContext();

		expect(daySix).not.toBe(dayFive);
	});
});
