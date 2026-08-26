import { describe, expect, it } from "vitest";
import {
	describeFindingChange,
	type FindingTriage,
} from "../describe-finding-change";

const base: FindingTriage = {
	title: "SQL injection in report export",
	status: "OPEN",
	category: "SECURITY",
	severity: "HIGH",
};

describe("describeFindingChange", () => {
	it("keeps the dedicated type + verb for a pure status transition", () => {
		expect(describeFindingChange(base, { status: "RESOLVED" })).toEqual({
			type: "FINDING_RESOLVED",
			summary: "Resolved “SQL injection in report export”",
		});
		expect(describeFindingChange(base, { status: "DISMISSED" })).toEqual({
			type: "FINDING_DISMISSED",
			summary: "Dismissed “SQL injection in report export”",
		});
		expect(
			describeFindingChange(
				{ ...base, status: "RESOLVED" },
				{ status: "OPEN" },
			),
		).toEqual({
			type: "FINDING_REOPENED",
			summary: "Reopened “SQL injection in report export”",
		});
	});

	it("emits FINDING_EDITED with a human diff for a severity change", () => {
		const result = describeFindingChange(base, { severity: "CRITICAL" });
		expect(result?.type).toBe("FINDING_EDITED");
		expect(result?.summary).toBe(
			"Updated “SQL injection in report export” — severity High → Critical",
		);
	});

	it("emits FINDING_EDITED with a human diff for a category change", () => {
		const result = describeFindingChange(base, {
			category: "ACCESSIBILITY",
		});
		expect(result?.type).toBe("FINDING_EDITED");
		expect(result?.summary).toContain("category Security → Accessibility");
	});

	it("lists every changed field when several move at once", () => {
		const result = describeFindingChange(base, {
			severity: "CRITICAL",
			status: "RESOLVED",
		});
		expect(result?.type).toBe("FINDING_EDITED");
		expect(result?.summary).toContain("severity High → Critical");
		expect(result?.summary).toContain("status Open → Resolved");
	});

	it("returns null when the patch matches the current values (no-op)", () => {
		expect(describeFindingChange(base, { status: "OPEN" })).toBeNull();
		expect(describeFindingChange(base, { severity: "HIGH" })).toBeNull();
		expect(
			describeFindingChange(base, {
				severity: "HIGH",
				category: "SECURITY",
			}),
		).toBeNull();
	});

	it("ignores unchanged fields in the diff even when sent in the patch", () => {
		// severity actually changes; status is sent but equals the current value.
		const result = describeFindingChange(base, {
			severity: "LOW",
			status: "OPEN",
		});
		expect(result?.type).toBe("FINDING_EDITED");
		expect(result?.summary).toContain("severity High → Low");
		expect(result?.summary).not.toContain("status");
	});
});
