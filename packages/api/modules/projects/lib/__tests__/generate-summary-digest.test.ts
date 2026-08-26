/**
 * Tests for the Logic Summary prompt assembly (`buildSummaryPrompt`).
 *
 * FR-25: the AI Summary flow (AC-3) must carry the shared
 * locked-attachment rule so it never fabricates attachment contents once
 * attachment metadata begins flowing through the spec. `buildSummaryPrompt`
 * is the single assembly point for the digest prompt, so the rule is asserted
 * here rather than through the full model round-trip.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The module pulls model/DB deps at import time; stub them so this stays a
// hermetic pure-function test of the prompt assembler.
const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	getProjectFunctionTagClause: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
}));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));
vi.mock("ai", () => ({ zodSchema: (s: unknown) => s }));
vi.mock("@repo/utils/clean-spec-content", () => ({
	combineCleanSpec: (d: string, a: string) => `${d}\n${a}`,
}));

const { buildSummaryPrompt, generateMaturationSummary } = await import(
	"../generate-summary-digest"
);

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

function feature() {
	return {
		id: "story-1",
		projectId: "project-1",
		title: "MFA",
		kind: "FEATURE",
		description: "## Overview\nAdd MFA.",
		acceptanceCriteria: null,
	} as const;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.getAIModelWithMetadata.mockResolvedValue({ model: {} });
	mocks.getBoundPromptForAgent.mockResolvedValue(null);
	// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so every
	// pre-existing test in this file keeps asserting the pre-Stage-4 prompt
	// shape unchanged.
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("buildSummaryPrompt — the locked-attachment rule", () => {
	it("includes the DEDICATED ATTACHMENTS scope marker (AC-3)", () => {
		const prompt = buildSummaryPrompt("INSTRUCTIONS", "SPEC BODY");
		expect(prompt).toContain("DEDICATED ATTACHMENTS");
	});

	it("places the rule after the instructions and before the spec", () => {
		const prompt = buildSummaryPrompt("INSTRUCTIONS", "SPEC BODY");
		const instrIdx = prompt.indexOf("INSTRUCTIONS");
		const ruleIdx = prompt.indexOf("DEDICATED ATTACHMENTS");
		const specIdx = prompt.indexOf("SPEC BODY");
		expect(instrIdx).toBeGreaterThanOrEqual(0);
		expect(ruleIdx).toBeGreaterThan(instrIdx);
		expect(ruleIdx).toBeLessThan(specIdx);
	});
});

describe("generateMaturationSummary — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-generate-summary-digest";

	beforeEach(() => {
		mocks.generateObject.mockResolvedValue({
			object: { summary: "A concise summary." },
		});
	});

	it("flag ON: resolves the role clause with the feature's project/user and appends it to the prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await generateMaturationSummary({
			feature: feature(),
			tenantFilter,
			instructions: "INSTRUCTIONS",
		});

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "project-1",
			requesterUserId: "user-1",
			surface: "generate-summary-digest",
		});
		const prompt = mocks.generateObject.mock.calls[0][0].prompt;
		expect(prompt).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await generateMaturationSummary({
			feature: feature(),
			tenantFilter,
			instructions: "INSTRUCTIONS",
		});
		const withClause = mocks.generateObject.mock.calls[0][0].prompt;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await generateMaturationSummary({
			feature: feature(),
			tenantFilter,
			instructions: "INSTRUCTIONS",
		});
		const withoutClause = mocks.generateObject.mock.calls[0][0].prompt;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});
