import { describe, expect, it } from "vitest";
import { buildTestCaseContextContent } from "../test-case-context";

describe("buildTestCaseContextContent", () => {
	it("leads with the identifier + title, then state and priority", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-001",
			title: "Login with valid credentials",
			state: "READY",
			priority: "HIGH",
		});

		const lines = out.split("\n");
		expect(lines[0]).toBe("TC-001 Login with valid credentials");
		expect(lines[1]).toBe("State: READY");
		expect(lines[2]).toBe("Priority: HIGH");
	});

	it("includes preconditions when present and omits them when blank", () => {
		const withPre = buildTestCaseContextContent({
			identifier: "TC-002",
			title: "Reset password",
			state: "DRAFT",
			priority: "MEDIUM",
			preconditions: "  User account exists and is active.  ",
		});
		expect(withPre).toContain(
			"Preconditions: User account exists and is active.",
		);

		const withoutPre = buildTestCaseContextContent({
			identifier: "TC-002",
			title: "Reset password",
			state: "DRAFT",
			priority: "MEDIUM",
			preconditions: "   ",
		});
		expect(withoutPre).not.toContain("Preconditions:");
	});

	it("numbers steps as '1. <action> → <expected>'", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-003",
			title: "Checkout flow",
			state: "READY",
			priority: "HIGH",
			steps: [
				{
					action: "Add an item to the cart",
					expected: "Cart count is 1",
				},
				{
					action: "Proceed to checkout",
					expected: "Payment form shown",
				},
			],
		});

		expect(out).toContain("Steps:");
		expect(out).toContain("1. Add an item to the cart → Cart count is 1");
		expect(out).toContain("2. Proceed to checkout → Payment form shown");
	});

	it("drops steps with an empty action and renumbers the rest", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-004",
			title: "Sparse steps",
			state: "DRAFT",
			priority: "LOW",
			steps: [
				{ action: "  ", expected: "ignored" },
				{ action: "Do the thing", expected: "It happens" },
			],
		});

		expect(out).toContain("1. Do the thing → It happens");
		expect(out).not.toContain("2.");
		expect(out).not.toContain("ignored");
	});

	it("renders a step with no expected result as just the action", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-005",
			title: "Action only",
			state: "DRAFT",
			priority: "MEDIUM",
			steps: [{ action: "Open the app", expected: "   " }],
		});

		expect(out).toContain("1. Open the app");
		expect(out).not.toContain("→");
	});

	it("omits the Steps section entirely when there are no usable steps", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-006",
			title: "No steps",
			state: "DRAFT",
			priority: "MEDIUM",
			steps: [],
		});
		expect(out).not.toContain("Steps:");
	});

	it("lists linked features and adds 'Covers AC N' when a ref is set", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-007",
			title: "Linked case",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-012",
					title: "Authentication",
					acceptanceCriterionRef: "2",
				},
				{ identifier: "F-015", title: "Session management" },
			],
		});

		expect(out).toContain("Covers:");
		expect(out).toContain("- F-012 Authentication (Covers AC 2)");
		expect(out).toContain("- F-015 Session management");
	});

	it("does not double-prefix an acceptance-criterion ref already worded as 'Covers AC'", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-008",
			title: "Pre-worded ref",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-020",
					title: "Billing",
					acceptanceCriterionRef: "Covers AC 3",
				},
			],
		});

		expect(out).toContain("- F-020 Billing (Covers AC 3)");
		expect(out).not.toContain("Covers AC Covers AC 3");
	});

	it("renders every criterion a stored link covers", () => {
		// The request path passes the link's plural column. It used to arrive as
		// an excess property on a singular-only input type and was silently
		// dropped, so "Validates criterion …" disappeared from every embedded
		// case body — retrieval could no longer answer "which cases cover AC 3".
		const out = buildTestCaseContextContent({
			identifier: "TC-030",
			title: "Multi-criterion case",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-030",
					title: "Audit export",
					acceptanceCriterionRefs: ["1", "AC 3"],
				},
			],
		});

		expect(out).toContain("- F-030 Audit export (Covers AC 1, AC 3)");
	});

	it("renders the drafting activity's own 'AC N' ref without doubling the prefix", () => {
		// The drafter is instructed to emit refs like "AC 3" (see the schema in
		// packages/ai). The old single-ref formatter only skipped its prefix for
		// values starting "Covers", so every AI-drafted case's embedded body read
		// "Covers AC AC 3".
		const out = buildTestCaseContextContent({
			identifier: "TC-033",
			title: "Drafted case",
			state: "DRAFT",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-033",
					title: "Webhooks",
					acceptanceCriterionRef: "AC 3",
				},
			],
		});

		expect(out).toContain("- F-033 Webhooks (Covers AC 3)");
		expect(out).not.toContain("AC AC");
	});

	it("renders a ref the traceability resolver can place as that criterion", () => {
		// "criterion 4" resolves to criterion 4 everywhere else in the product
		// (coverage ring, matrix, re-draft dedupe all read the first integer).
		// Rendering it verbatim produced "Covers AC criterion 4" — garbled, and
		// disagreeing with the number the ring actually counts.
		const out = buildTestCaseContextContent({
			identifier: "TC-035",
			title: "Numbered by wording",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-035",
					title: "Retention",
					acceptanceCriterionRefs: ["criterion 4"],
				},
			],
		});

		expect(out).toContain("- F-035 Retention (Covers AC 4)");
		expect(out).not.toContain("AC criterion");
	});

	it("does not invent an AC identifier for a ref nothing can place", () => {
		// A heading-text ref ("Tenant isolation") resolves to no criterion, so
		// the coverage ring counts it toward nothing. Rendering "Covers AC
		// Tenant isolation" would assert a specific criterion the rest of the
		// product denies exists — a confident wrong answer in the text the AI
		// retrieves.
		const out = buildTestCaseContextContent({
			identifier: "TC-036",
			title: "Unplaceable ref",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-036",
					title: "Isolation",
					acceptanceCriterionRefs: ["Tenant isolation"],
				},
			],
		});

		expect(out).toContain("- F-036 Isolation (Covers Tenant isolation)");
		expect(out).not.toContain("AC Tenant isolation");
	});

	it("collapses two spellings of one criterion", () => {
		// "2" and "AC 2" are the same criterion written the two ways the two
		// call-site shapes produce; rendering both would read "AC 2, AC 2".
		const out = buildTestCaseContextContent({
			identifier: "TC-034",
			title: "Mixed spellings",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-034",
					title: "Delivery",
					acceptanceCriterionRefs: ["2"],
					acceptanceCriterionRef: "AC 2",
				},
			],
		});

		expect(out).toContain("- F-034 Delivery (Covers AC 2)");
		expect(out).not.toContain("AC 2, AC 2");
	});

	it("renders one criterion once when both shapes carry it", () => {
		// The drafting activity passes the singular field; a link read back
		// carries the same value in the list. Rendering it twice would be noise
		// in the embedded body.
		const out = buildTestCaseContextContent({
			identifier: "TC-031",
			title: "Both shapes",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-031",
					title: "Retention",
					acceptanceCriterionRefs: ["AC 4"],
					acceptanceCriterionRef: "AC 4",
				},
			],
		});

		expect(out).toContain("- F-031 Retention (Covers AC 4)");
		expect(out).not.toContain("AC 4, AC 4");
	});

	it("omits the criterion phrase when a link names none", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-032",
			title: "No criterion",
			state: "READY",
			priority: "HIGH",
			linkedFeatures: [
				{
					identifier: "F-032",
					title: "Unmapped",
					acceptanceCriterionRefs: ["", "   "],
				},
			],
		});

		expect(out).toContain("- F-032 Unmapped");
		expect(out).not.toContain("Covers AC");
	});

	it("appends tags as a comma-joined line and skips blank tags", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-009",
			title: "Tagged case",
			state: "READY",
			priority: "HIGH",
			tags: ["smoke", "  ", "auth"],
		});

		expect(out).toContain("Tags: smoke, auth");
	});

	it("omits optional sections when nothing is provided", () => {
		const out = buildTestCaseContextContent({
			identifier: "TC-010",
			title: "Minimal",
			state: "DRAFT",
			priority: "MEDIUM",
		});

		expect(out).toBe("TC-010 Minimal\nState: DRAFT\nPriority: MEDIUM");
	});
});
