import { describe, expect, it } from "vitest";
import {
	ATTACHMENT_RETENTION_GRACE_DAYS,
	DEFAULT_ATTACHMENT_RETENTION_DAYS,
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
	parseRetentionDaysInput,
	sanitizeRetentionDays,
} from "../attachment";

describe("attachment retention constants", () => {
	it("pins the approved policy values", () => {
		expect(DEFAULT_ATTACHMENT_RETENTION_DAYS).toBe(90);
		expect(MIN_ATTACHMENT_RETENTION_DAYS).toBe(30);
		expect(MAX_ATTACHMENT_RETENTION_DAYS).toBe(3650);
		expect(ATTACHMENT_RETENTION_GRACE_DAYS).toBe(7);
	});
});

describe("sanitizeRetentionDays", () => {
	it("returns null for absent values", () => {
		expect(sanitizeRetentionDays(null)).toBeNull();
		expect(sanitizeRetentionDays(undefined)).toBeNull();
	});

	it("REJECTS out-of-range values to null rather than clamping", () => {
		// Clamping would make the scan-bound proof in the design spec
		// unprovable: the minimum is taken over raw stored values while the
		// filter uses sanitized ones, so the two must agree on which values
		// are usable at all. Rejecting keeps the image of `sanitize` equal to
		// {usable stored values} union {server default}.
		for (const raw of [0, -5, 29, 3651, 36500]) {
			expect(sanitizeRetentionDays(raw)).toBeNull();
		}
	});

	it("returns null for non-integer and non-finite values", () => {
		for (const raw of [0.5, 90.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(sanitizeRetentionDays(raw)).toBeNull();
		}
	});

	it("passes usable values through unchanged", () => {
		expect(sanitizeRetentionDays(30)).toBe(30);
		expect(sanitizeRetentionDays(90)).toBe(90);
		expect(sanitizeRetentionDays(3650)).toBe(3650);
	});
});

describe("parseRetentionDaysInput", () => {
	it("maps blank and whitespace to null — the inherit signal", () => {
		expect(parseRetentionDaysInput("")).toBeNull();
		expect(parseRetentionDaysInput("   ")).toBeNull();
	});

	it("returns undefined for anything that cannot survive JSON", () => {
		// THE point of the function. `null` on this wire means "clear the
		// override", and JSON.stringify turns BOTH NaN and Infinity into null —
		// so returning a non-finite number here would silently wipe a configured
		// window and re-arm the grace floor. `undefined` forces the caller to
		// refuse. "1e400" overflows to Infinity, which a Number.isNaN guard
		// (the obvious first attempt) does NOT catch.
		for (const raw of ["abc", "-", "e", "1e400", "-1e400", "NaN", "--5"]) {
			expect(parseRetentionDaysInput(raw)).toBeUndefined();
		}
	});

	it("does not clamp, round, or reject out-of-range values", () => {
		// The server is the single validation authority for range and
		// integer-ness; a browser that rewrote these would disagree with the
		// other settings form. This helper only keeps unserializable values off
		// the wire.
		expect(parseRetentionDaysInput("10")).toBe(10);
		expect(parseRetentionDaysInput("30.5")).toBe(30.5);
		expect(parseRetentionDaysInput("99999")).toBe(99999);
	});

	it("passes ordinary entries through", () => {
		expect(parseRetentionDaysInput("90")).toBe(90);
		expect(parseRetentionDaysInput(" 365 ")).toBe(365);
	});

	it("refuses an entry the browser itself could not parse, blank though it reads", () => {
		// The hole staging found. `<input type="number">` reports `value === ""`
		// for an entry it cannot parse, while STILL DISPLAYING the typed text —
		// measured in Chrome, "1e400" shows in the box with `value === ""` and
		// `validity.badInput === true`. Blank otherwise means "inherit" and maps
		// to null, and null on this wire CLEARS the override, so without this
		// flag an unparseable entry is indistinguishable from a deliberate
		// clear: the user sees a number on screen and the app deletes their
		// configured window, re-arming the grace floor as it goes.
		//
		// No amount of inspecting the text can recover this — by the time the
		// value reaches here the entry is already gone. It has to be passed in.
		expect(parseRetentionDaysInput("", { badInput: true })).toBeUndefined();
		expect(
			parseRetentionDaysInput("   ", { badInput: true }),
		).toBeUndefined();
		// Refused regardless of what the text says: badInput means the element's
		// value cannot be trusted to represent the entry at all.
		expect(
			parseRetentionDaysInput("365", { badInput: true }),
		).toBeUndefined();
	});

	it("is unchanged when the browser parsed the entry cleanly", () => {
		// The negative half. If `badInput: false` also refused, the assertions
		// above would pass against an implementation that simply never returns
		// a value, and blanking the field to inherit would be broken instead.
		expect(parseRetentionDaysInput("", { badInput: false })).toBeNull();
		expect(parseRetentionDaysInput("90", { badInput: false })).toBe(90);
		// Omitting the options entirely must behave exactly as before.
		expect(parseRetentionDaysInput("")).toBeNull();
		expect(parseRetentionDaysInput("90")).toBe(90);
	});
});
