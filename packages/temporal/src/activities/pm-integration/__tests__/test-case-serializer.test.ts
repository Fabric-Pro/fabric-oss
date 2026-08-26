/**
 * Unit tests for the test-case PM serializer (the cross-provider step contract).
 *
 * The serializer is pure, so these run with no mocks:
 *  - `buildTestCaseDescription` lands the ordered steps in the body for EVERY tool.
 *  - `formatTestCaseStepsForProvider` adds native ADO Steps XML only for ADO.
 *  - `parseTestCaseStepsFromBody` round-trips the body back into steps.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test test-case-serializer
 */

import { describe, expect, it } from "vitest";
import {
	ADO_STEPS_FIELD,
	buildAdoStepsXml,
	buildTestCaseCreateArgs,
	buildTestCaseDescription,
	buildTestCaseUpdateArgs,
	formatTestCaseStepsForProvider,
	parseTestCaseStepsFromBody,
} from "../test-case-serializer";

const SAMPLE = {
	description: "User is signed in.",
	steps: [
		{ action: "Open the cart", expected: "Cart page renders" },
		{ action: "Click checkout", expected: "Payment step opens" },
	],
};

describe("buildTestCaseDescription", () => {
	it("renders preconditions + an ordered, plain-text Steps section", () => {
		const body = buildTestCaseDescription(SAMPLE);
		expect(body).toContain("User is signed in.");
		expect(body).toContain("Steps:");
		expect(body).toContain("1. Open the cart — Cart page renders");
		expect(body).toContain("2. Click checkout — Payment step opens");
		// No markdown emphasis — renders cleanly in plain-text tools.
		expect(body).not.toContain("**");
	});

	it("omits the Steps section when there are no steps", () => {
		expect(buildTestCaseDescription({ description: "Just a note." })).toBe(
			"Just a note.",
		);
	});

	it("drops fully-empty steps", () => {
		const body = buildTestCaseDescription({
			description: "",
			steps: [{ action: "  ", expected: "  " }],
		});
		expect(body).toBe("");
	});
});

describe("formatTestCaseStepsForProvider", () => {
	it("returns null for non-ADO tools (steps already in the body)", () => {
		for (const tool of ["jira", "github", "gitlab", "linear", "fizzy"]) {
			expect(formatTestCaseStepsForProvider(SAMPLE, tool)).toBeNull();
		}
	});

	it("emits a Microsoft.VSTS.TCM.Steps field for Azure DevOps", () => {
		const field = formatTestCaseStepsForProvider(SAMPLE, "azure-devops");
		expect(field).not.toBeNull();
		expect(field?.fieldName).toBe(ADO_STEPS_FIELD);
		expect(field?.value).toContain("<steps");
		expect(field?.value).toContain('type="ValidateStep"');
		expect(field?.value).toContain("parameterizedString");
	});

	it("returns null for ADO when there are no steps", () => {
		expect(
			formatTestCaseStepsForProvider(
				{ description: "x", steps: [] },
				"azure-devops",
			),
		).toBeNull();
	});
});

describe("buildAdoStepsXml", () => {
	it("escapes special characters across the XML + HTML layers", () => {
		const xml = buildAdoStepsXml([
			{ action: "a < b & c", expected: 'say "hi"' },
		]);
		// The action text's `<` and `&` are HTML-escaped, then the wrapping
		// HTML is XML-escaped (double-encoded), so no raw `<DIV>` appears.
		expect(xml).toContain("&lt;DIV&gt;");
		expect(xml).not.toContain("<DIV>");
		expect(xml).toContain('last="2"');
	});

	it("marks action-only steps ActionStep and steps with an expected ValidateStep", () => {
		const xml = buildAdoStepsXml([
			{ action: "Just do it", expected: "" },
			{ action: "Do and check", expected: "Result shown" },
		]);
		expect(xml).toContain('type="ActionStep"');
		expect(xml).toContain('type="ValidateStep"');
	});
});

describe("buildTestCaseCreateArgs / buildTestCaseUpdateArgs — Fizzy account_slug", () => {
	type Caps = Parameters<typeof buildTestCaseCreateArgs>[0]["capabilities"];
	// Minimal FLAT (non-fieldsBased) capabilities — only the params the builders read.
	const fizzyCaps = {
		taskCreation: {
			toolName: "fizzy_create_card",
			containerParam: "board_id",
			titleParam: "title",
			descriptionParam: "description",
		},
		taskUpdate: {
			toolName: "fizzy_update_card",
			idParam: "card_number",
			titleParam: "title",
			descriptionParam: "description",
		},
	} as unknown as Caps;
	const linearCaps = {
		taskCreation: {
			toolName: "linear_create_issue",
			containerParam: "team_id",
			titleParam: "title",
			descriptionParam: "description",
		},
	} as unknown as Caps;

	const baseCreate = {
		containerValue: "brd-1",
		title: "T",
		description: "D",
		stepsField: null,
	};

	it("injects account_slug into a Fizzy CREATE from additionalContext", () => {
		const args = buildTestCaseCreateArgs({
			capabilities: fizzyCaps,
			...baseCreate,
			additionalContext: { account_slug: "/000000" },
		});
		expect(args.account_slug).toBe("/000000");
		expect(args.board_id).toBe("brd-1");
		expect(args.title).toBe("T");
	});

	it("injects account_slug into a Fizzy UPDATE (targets the stored card id)", () => {
		const args = buildTestCaseUpdateArgs({
			capabilities: fizzyCaps,
			externalId: "1709",
			title: "T",
			description: "D",
			stepsField: null,
			additionalContext: { account_slug: "/000000" },
		});
		expect(args.account_slug).toBe("/000000");
		expect(args.card_number).toBe("1709");
	});

	it("falls back to the legacy `slug` key when account_slug is absent", () => {
		const args = buildTestCaseCreateArgs({
			capabilities: fizzyCaps,
			...baseCreate,
			additionalContext: { slug: "/999" },
		});
		expect(args.account_slug).toBe("/999");
	});

	it("adds nothing when the slug is missing — the tool surfaces its own error", () => {
		const args = buildTestCaseCreateArgs({
			capabilities: fizzyCaps,
			...baseCreate,
			additionalContext: {},
		});
		expect(args.account_slug).toBeUndefined();
	});

	it("does NOT add account_slug for a non-Fizzy flat tool, even if present", () => {
		const args = buildTestCaseCreateArgs({
			capabilities: linearCaps,
			...baseCreate,
			additionalContext: { account_slug: "/000000" },
		});
		expect(args.account_slug).toBeUndefined();
	});
});

describe("parseTestCaseStepsFromBody", () => {
	it("round-trips the numbered block buildTestCaseDescription writes", () => {
		const body = buildTestCaseDescription(SAMPLE);
		const { steps } = parseTestCaseStepsFromBody(body, "jira");
		expect(steps).toEqual(SAMPLE.steps);
	});

	it("parses native ADO Steps XML back into steps", () => {
		const xml = buildAdoStepsXml(SAMPLE.steps);
		const { steps } = parseTestCaseStepsFromBody(xml, "azure-devops");
		expect(steps).toHaveLength(2);
		expect(steps[0].action).toBe("Open the cart");
		expect(steps[0].expected).toBe("Cart page renders");
	});

	it("round-trips ADO step text containing <, >, and & through both encode layers", () => {
		const steps = [
			{ action: "click <Save> & wait", expected: "row a < b & c shows" },
		];
		const xml = buildAdoStepsXml(steps);
		const parsed = parseTestCaseStepsFromBody(xml, "azure-devops").steps;
		expect(parsed).toEqual(steps);
	});

	it("yields no steps for an unrecognised external body", () => {
		expect(
			parseTestCaseStepsFromBody("Some free-form description.", "jira")
				.steps,
		).toEqual([]);
	});

	it("returns no steps for empty input", () => {
		expect(parseTestCaseStepsFromBody(null).steps).toEqual([]);
		expect(parseTestCaseStepsFromBody("").steps).toEqual([]);
	});
});
