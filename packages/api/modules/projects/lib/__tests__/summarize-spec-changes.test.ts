import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateObject: vi.fn(),
	getProjectFunctionTagClause: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	generateObject: mocks.generateObject,
}));

vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));

const { summarizeSpecChanges, buildChangeSummaryPrompt } = await import(
	"../summarize-spec-changes"
);

describe("buildChangeSummaryPrompt — the locked-attachment rule", () => {
	it("includes the DEDICATED ATTACHMENTS scope marker", () => {
		expect(buildChangeSummaryPrompt("PREV", "NEXT")).toContain(
			"DEDICATED ATTACHMENTS",
		);
	});
});

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.getAIModelWithMetadata.mockResolvedValue({ model: {} });
	// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so every
	// pre-existing test in this file keeps asserting the pre-Stage-4 prompt
	// shape unchanged.
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("summarizeSpecChanges", () => {
	it("returns the model's bullets (trimmed, non-empty) for a real change", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				changeSummary: [
					"  Must Haves — restricted MFA methods to email and SMS  ",
					"",
					"Use Cases — added admin-only MFA disable",
				],
			},
		});
		const out = await summarizeSpecChanges({
			before: "old spec",
			after: "new spec",
			tenantFilter,
			projectId: "project-1",
		});
		expect(out).toEqual([
			"Must Haves — restricted MFA methods to email and SMS",
			"Use Cases — added admin-only MFA disable",
		]);
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	});

	it("prompts for additions/restructures, not just removals", () => {
		const prompt = buildChangeSummaryPrompt("old", "new");
		expect(prompt).toMatch(/additions and restructures equal weight/i);
		expect(prompt).toMatch(/restructure/i);
		expect(prompt).toMatch(/removal-only summary/i);
	});

	it("short-circuits to [] without a model call when before === after", async () => {
		const out = await summarizeSpecChanges({
			before: "  same  ",
			after: "same",
			tenantFilter,
			projectId: "project-1",
		});
		expect(out).toEqual([]);
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});
});

describe("summarizeSpecChanges — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-summarize-spec-changes";

	beforeEach(() => {
		mocks.generateObject.mockResolvedValue({
			object: { changeSummary: [] },
		});
	});

	it("flag ON: resolves the role clause with the caller's project/user and appends it to the prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await summarizeSpecChanges({
			before: "old spec",
			after: "new spec",
			tenantFilter,
			projectId: "project-1",
		});

		// Proves the new required `projectId` param actually flows into the
		// role-clause resolver, not just that a clause got appended.
		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "project-1",
			requesterUserId: "user-1",
			surface: "summarize-spec-changes",
		});
		const prompt = mocks.generateObject.mock.calls[0][0].prompt;
		expect(prompt).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await summarizeSpecChanges({
			before: "old spec",
			after: "new spec",
			tenantFilter,
			projectId: "project-1",
		});
		const withClause = mocks.generateObject.mock.calls[0][0].prompt;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await summarizeSpecChanges({
			before: "old spec",
			after: "new spec",
			tenantFilter,
			projectId: "project-1",
		});
		const withoutClause = mocks.generateObject.mock.calls[0][0].prompt;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});
