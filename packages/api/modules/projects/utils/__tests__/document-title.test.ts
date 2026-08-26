import { describe, expect, it } from "vitest";
import { buildDocumentTitle } from "../document-title";

const AT_9AM_UTC = new Date("2026-06-12T09:00:00.000Z");

describe("buildDocumentTitle", () => {
	it("formats a default BUSINESS_CASE title as 'Business Case — {name} — {YYYY-MM-DD}'", () => {
		expect(
			buildDocumentTitle(
				"BUSINESS_CASE",
				"Acme Portal",
				"Business Case",
				{ now: AT_9AM_UTC },
			),
		).toBe("Business Case — Acme Portal — 2026-06-12");
	});

	it("formats an empty BUSINESS_CASE title", () => {
		expect(
			buildDocumentTitle("BUSINESS_CASE", "Acme Portal", "", {
				now: AT_9AM_UTC,
			}),
		).toBe("Business Case — Acme Portal — 2026-06-12");
	});

	it("preserves a user-customized BUSINESS_CASE title", () => {
		expect(
			buildDocumentTitle(
				"BUSINESS_CASE",
				"Acme Portal",
				"Q3 Funding Case",
				{ now: AT_9AM_UTC },
			),
		).toBe("Q3 Funding Case");
	});

	it("renders the date in the caller timeZone (local day, not UTC)", () => {
		// 15:00Z Jun 12 is 01:00 Jun 13 in Sydney (UTC+10)
		expect(
			buildDocumentTitle("BUSINESS_CASE", "Acme", "", {
				now: new Date("2026-06-12T15:00:00.000Z"),
				timeZone: "Australia/Sydney",
			}),
		).toBe("Business Case — Acme — 2026-06-13");
	});

	it("falls back to UTC when no timeZone is given", () => {
		expect(
			buildDocumentTitle("BUSINESS_CASE", "Acme", "", {
				now: new Date("2026-06-12T15:00:00.000Z"),
			}),
		).toBe("Business Case — Acme — 2026-06-12");
	});

	it("returns the provided title unchanged for non-BUSINESS_CASE types", () => {
		expect(
			buildDocumentTitle(
				"PRD",
				"Acme Portal",
				"Product Requirements Document",
				{ now: AT_9AM_UTC },
			),
		).toBe("Product Requirements Document");
	});

	it("falls back to the type's catalog label for a blank title", () => {
		// Reachable: the procedure's schema requires a non-empty string, which
		// a single space satisfies, so a direct API caller reaches this branch
		// even though the dialog's own guard would not let it through.
		expect(buildDocumentTitle("TEST_PLAN", "Any Project", "")).toBe(
			"Test Plan",
		);
		expect(buildDocumentTitle("TEST_PLAN", "Any Project", "   ")).toBe(
			"Test Plan",
		);
		expect(buildDocumentTitle("ARCHITECTURE", "Any Project", "")).toBe(
			"Technical Architecture",
		);
	});
});
