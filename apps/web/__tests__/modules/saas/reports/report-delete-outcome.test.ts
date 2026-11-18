import {
	reportDeleteFailure,
	withoutReport,
} from "@saas/reports/lib/report-delete-outcome";
import { describe, expect, it } from "vitest";

describe("reportDeleteFailure", () => {
	it("names a missing permission only for a refusal", () => {
		expect(reportDeleteFailure({ code: "FORBIDDEN" })).toEqual({
			kind: "forbidden",
			message: "You don't have permission to delete this report.",
		});
	});

	it("treats a report that no longer exists as deleted, not as a refusal", () => {
		const failure = reportDeleteFailure({
			code: "NOT_FOUND",
			message: "Template instance not found or access denied",
		});

		expect(failure.kind).toBe("gone");
		expect(failure.message).not.toMatch(/permission|access/i);
	});

	it.each([
		{ code: "INTERNAL_SERVER_ERROR" },
		new Error("fetch failed"),
		undefined,
	])("asks to try again after a passing failure (%o)", (error) => {
		const failure = reportDeleteFailure(error);

		expect(failure.kind).toBe("failed");
		expect(failure.message).not.toMatch(/permission|access/i);
	});
});

describe("withoutReport", () => {
	const page = {
		instances: [
			{ id: "kept", isActive: true },
			{ id: "deleted", isActive: true },
		],
		total: 2,
		activeTotal: 2,
	};

	it("drops the report and counts it out of the totals", () => {
		expect(withoutReport(page, "deleted")).toEqual({
			instances: [{ id: "kept", isActive: true }],
			total: 1,
			activeTotal: 1,
		});
	});

	it("leaves a page without the report as it was", () => {
		expect(withoutReport(page, "elsewhere")).toBe(page);
		expect(withoutReport(undefined, "deleted")).toBeUndefined();
	});
});
