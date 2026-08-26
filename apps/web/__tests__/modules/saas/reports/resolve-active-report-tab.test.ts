import { resolveActiveReportTab } from "@saas/reports/lib/resolve-active-report-tab";
import { describe, expect, it } from "vitest";

describe("resolveActiveReportTab", () => {
	it("returns history for ?tab=history (failure-notification deep link)", () => {
		expect(resolveActiveReportTab("history")).toBe("history");
	});

	it("returns overview when the tab param is absent (success link / same-route reset)", () => {
		// The Codex-flagged case: navigating from `?tab=history` to a no-tab
		// success link on the same instance must return to overview, not stay
		// stranded on Execution History.
		expect(resolveActiveReportTab(null)).toBe("overview");
		expect(resolveActiveReportTab(undefined)).toBe("overview");
	});

	it("returns overview for any other / invalid tab value", () => {
		expect(resolveActiveReportTab("overview")).toBe("overview");
		expect(resolveActiveReportTab("bogus")).toBe("overview");
	});
});
