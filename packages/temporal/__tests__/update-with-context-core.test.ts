/**
 * FR-25: the "Update using context" AI edit flow (`runContextUpdate`)
 * must carry the shared locked-attachment rule so it never claims to have
 * analysed a locked attachment or drops/fabricates one while rewriting the spec.
 * Captures the `generateObject` call and asserts the marker is in the system prompt.
 */

import { readFileSync } from "node:fs";
import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	getProjectFunctionTagClause: vi.fn(),
}));

// `zodSchema` is mocked here, not on `ai`, because the core imports it from
// @repo/ai. That is deliberate: `ai` peer-depends on zod, so pnpm installs one
// copy of `ai` per zod version — importing `zodSchema` straight from `ai` gets a
// DIFFERENT copy than the `generateObject` it is handed to, and the two types
// refuse to unify. Both must come through @repo/ai.
// NoObjectGeneratedError is the REAL `ai` class (via importActual), not a
// stand-in — the core's catch block calls the real `.isInstance()`, which
// checks a private brand symbol that a hand-rolled stand-in wouldn't carry.
vi.mock("@repo/ai", async () => {
	const actualAi = await vi.importActual<typeof import("ai")>("ai");
	return {
		AIProviderNotConfiguredError: class extends Error {},
		generateObject: mocks.generateObject,
		getAIModelWithMetadata: mocks.getAIModelWithMetadata,
		logModelUsageAsync: mocks.logModelUsageAsync,
		NoObjectGeneratedError: actualAi.NoObjectGeneratedError,
		zodSchema: (s: unknown) => s,
	};
});
vi.mock("@repo/rag", () => ({ retrieveRelevantContextsForSpec: vi.fn() }));
vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: vi.fn(),
}));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));

const {
	runContextUpdate,
	ContextUpdateTruncatedError,
	UPDATE_WITH_CONTEXT_SYSTEM_PROMPT,
} = await import("../src/lib/update-with-context-core");
const actualAiForTests = await vi.importActual<typeof import("ai")>("ai");

describe("runContextUpdate — FR-25 locked-attachment rule", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: "# Spec\nbody",
				needsHumanResolution: false,
				summary: "no change",
			},
			usage: {},
		});
		// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so this
		// pre-existing suite keeps asserting the pre-Stage-4 system prompt shape.
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
	});

	it("appends the DEDICATED ATTACHMENTS rule to the update-with-context system prompt", async () => {
		await runContextUpdate({
			title: "Spec",
			baselineDate: new Date("2026-01-01T00:00:00Z"),
			documentMarkdown: "# Spec\nbody",
			contextItems: [
				{
					sourceLabel: "DSU",
					sourceType: "transcript",
					sourceDate: "2026-01-02",
					sourceLinkOrId: "id-1",
					content: "New decision.",
				},
			],
			userId: "u1",
			organizationId: undefined,
			projectId: "p1",
		});

		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
		const system = mocks.generateObject.mock.calls[0][0].system as string;
		expect(system).toContain("DEDICATED ATTACHMENTS");
		// The original spec-editor instructions must survive intact.
		expect(system).toContain("specification editor");
	});
});

describe("runContextUpdate — no-op relevance gate", () => {
	const baseArgs = {
		title: "Spec",
		baselineDate: new Date("2026-01-01T00:00:00Z"),
		contextItems: [
			{
				sourceLabel: "DSU",
				sourceType: "transcript",
				sourceDate: "2026-01-02",
				sourceLinkOrId: "id-1",
				content: "New decision.",
			},
		],
		userId: "u1",
		organizationId: undefined,
		projectId: "p1",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});
		// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so this
		// pre-existing suite keeps asserting the pre-Stage-4 system prompt shape.
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
	});

	it("flips hasRelevantContext to false when the proposed document is identical, preserving the model summary", async () => {
		const doc = "# Spec\n\nThe body of the spec.";
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: doc,
				needsHumanResolution: false,
				summary: "Applied the new decision.",
			},
			usage: {},
		});

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: doc,
		});

		expect(result?.hasRelevantContext).toBe(false);
		expect(result?.updatedDocument).toBe(doc);
		expect(result?.summary).toBe("Applied the new decision.");
	});

	it("flips on a trailing-whitespace/CRLF-only difference and falls back to a neutral summary", async () => {
		const doc = "# Spec\n\nLine one.\nLine two.";
		// Same content, only trailing whitespace + CRLF noise — a no-op under the
		// canonical comparator. Model returns an empty summary.
		const noisy = "# Spec\r\n\r\nLine one.   \r\nLine two.\t";
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: noisy,
				needsHumanResolution: false,
				summary: "   ",
			},
			usage: {},
		});

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: doc,
		});

		expect(result?.hasRelevantContext).toBe(false);
		// updatedDocument is reset to the caller's document, not the noisy variant.
		expect(result?.updatedDocument).toBe(doc);
		expect(result?.summary).toBe(
			"No updates found — the document already reflects the available context.",
		);
	});

	it("keeps hasRelevantContext true and the model's document for a real change", async () => {
		const doc = "# Spec\n\nOld body.";
		const changed = "# Spec\n\nNew body with an actual update.";
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: changed,
				needsHumanResolution: false,
				summary: "Rewrote the body.",
			},
			usage: {},
		});

		const result = await runContextUpdate({
			...baseArgs,
			documentMarkdown: doc,
		});

		expect(result?.hasRelevantContext).toBe(true);
		expect(result?.updatedDocument).toBe(changed);
		expect(result?.summary).toBe("Rewrote the body.");
	});
});

describe("runContextUpdate — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-update-with-context";

	const baseArgs = {
		title: "Spec",
		baselineDate: new Date("2026-01-01T00:00:00Z"),
		documentMarkdown: "# Spec\nbody",
		contextItems: [
			{
				sourceLabel: "DSU",
				sourceType: "transcript",
				sourceDate: "2026-01-02",
				sourceLinkOrId: "id-1",
				content: "New decision.",
			},
		],
		userId: "u1",
		organizationId: undefined,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: "# Spec\nbody",
				needsHumanResolution: false,
				summary: "no change",
			},
			usage: {},
		});
	});

	it("flag ON: resolves the role clause with the given project/user and appends it to the system prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await runContextUpdate({ ...baseArgs, projectId: "p1" });

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "p1",
			requesterUserId: "u1",
			surface: "update-with-context",
		});
		const system = mocks.generateObject.mock.calls[0][0].system as string;
		expect(system).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: system prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await runContextUpdate({ ...baseArgs, projectId: "p1" });
		const withClause = mocks.generateObject.mock.calls[0][0]
			.system as string;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await runContextUpdate({ ...baseArgs, projectId: "p1" });
		const withoutClause = mocks.generateObject.mock.calls[0][0]
			.system as string;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});

	it("projectId undefined: skips the resolver entirely and the prompt carries no clause", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await runContextUpdate({ ...baseArgs, projectId: undefined });

		expect(mocks.getProjectFunctionTagClause).not.toHaveBeenCalled();
		const system = mocks.generateObject.mock.calls[0][0].system as string;
		expect(system).not.toContain(ROLE_CLAUSE_SENTINEL);
	});
});

describe("runContextUpdate — output token budget", () => {
	const baseArgs = {
		title: "Spec",
		baselineDate: new Date("2026-01-01T00:00:00Z"),
		contextItems: [
			{
				sourceLabel: "DSU",
				sourceType: "transcript",
				sourceDate: "2026-01-02",
				sourceLinkOrId: "id-1",
				content: "New decision.",
			},
		],
		userId: "u1",
		organizationId: undefined,
		projectId: "p1",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: "# Spec\nbody",
				needsHumanResolution: false,
				summary: "no change",
			},
			usage: {},
		});
	});

	function mockMetadata(overrides: {
		provider: string;
		maxOutputTokens?: number;
	}) {
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: overrides,
			trackUsage: vi.fn(),
		});
	}

	it("DATABRICKS, no catalog cap, small doc (1,000 chars) -> 16,384", async () => {
		mockMetadata({ provider: "DATABRICKS" });

		await runContextUpdate({
			...baseArgs,
			documentMarkdown: "x".repeat(1_000),
		});

		expect(mocks.generateObject.mock.calls[0][0].maxOutputTokens).toBe(
			16_384,
		);
	});

	it("DATABRICKS, no catalog cap, large doc (60,000 chars) -> 42,048", async () => {
		mockMetadata({ provider: "DATABRICKS" });

		await runContextUpdate({
			...baseArgs,
			documentMarkdown: "x".repeat(60_000),
		});

		expect(mocks.generateObject.mock.calls[0][0].maxOutputTokens).toBe(
			42_048,
		);
	});

	it("DATABRICKS, catalog cap 128,000, huge doc (300,000 chars, desired 202,048) -> clamped to 128,000", async () => {
		mockMetadata({ provider: "DATABRICKS", maxOutputTokens: 128_000 });

		await runContextUpdate({
			...baseArgs,
			documentMarkdown: "x".repeat(300_000),
		});

		expect(mocks.generateObject.mock.calls[0][0].maxOutputTokens).toBe(
			128_000,
		);
	});

	it("catalog cap 4,096 (below floor) -> exactly 4,096, regardless of provider", async () => {
		mockMetadata({ provider: "VERCEL_GATEWAY", maxOutputTokens: 4_096 });

		await runContextUpdate({
			...baseArgs,
			documentMarkdown: "x".repeat(60_000),
		});

		expect(mocks.generateObject.mock.calls[0][0].maxOutputTokens).toBe(
			4_096,
		);
	});

	it("VERCEL_GATEWAY, no catalog cap -> maxOutputTokens omitted entirely", async () => {
		mockMetadata({ provider: "VERCEL_GATEWAY" });

		await runContextUpdate({
			...baseArgs,
			documentMarkdown: "x".repeat(1_000),
		});

		expect("maxOutputTokens" in mocks.generateObject.mock.calls[0][0]).toBe(
			false,
		);
	});

	it("ANTHROPIC_DIRECT, no catalog cap, small doc -> 16,384", async () => {
		mockMetadata({ provider: "ANTHROPIC_DIRECT" });

		await runContextUpdate({
			...baseArgs,
			documentMarkdown: "x".repeat(1_000),
		});

		expect(mocks.generateObject.mock.calls[0][0].maxOutputTokens).toBe(
			16_384,
		);
	});
});

describe("runContextUpdate — truncation classification", () => {
	const baseArgs = {
		title: "Spec",
		baselineDate: new Date("2026-01-01T00:00:00Z"),
		documentMarkdown: "# Spec\nbody",
		contextItems: [
			{
				sourceLabel: "DSU",
				sourceType: "transcript",
				sourceDate: "2026-01-02",
				sourceLinkOrId: "id-1",
				content: "New decision.",
			},
		],
		userId: "u1",
		organizationId: undefined,
		projectId: "p1",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: { provider: "DATABRICKS" },
			trackUsage: vi.fn(),
		});
	});

	it("rejects with ContextUpdateTruncatedError when the model finishes at 'length'", async () => {
		mocks.generateObject.mockRejectedValue(
			new actualAiForTests.NoObjectGeneratedError({
				message: "The generated object could not be parsed.",
				response: {
					id: "resp-1",
					timestamp: new Date("2026-01-01T00:00:00Z"),
					modelId: "test-model",
				},
				usage: {
					inputTokens: 100,
					inputTokenDetails: {
						noCacheTokens: 100,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					outputTokens: 100,
					outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
					totalTokens: 200,
				},
				finishReason: "length",
			}),
		);

		await expect(runContextUpdate(baseArgs)).rejects.toBeInstanceOf(
			ContextUpdateTruncatedError,
		);
	});

	it("resolves to null for a generic error (unchanged behavior)", async () => {
		mocks.generateObject.mockRejectedValue(new Error("boom"));

		const result = await runContextUpdate(baseArgs);

		expect(result).toBeNull();
	});
});

/**
 * Fizzy #2048 — the R10 release gate.
 *
 * One engine serves three callers: the interactive work item procedure, the
 * interactive document procedure, and the unattended scheduled document-refresh
 * sweep. Work item callers now hand the engine a kind-scoped instruction
 * addendum; document callers hand it nothing, and their request must stay
 * byte-identical to what shipped before the addendum existed.
 *
 * Written against the engine BEFORE it took an addendum, and asserted with
 * `toBe` deliberately: a `toContain` here would pass with a dangling separator,
 * with an empty-string addendum welded on, or with a clause leaking into every
 * caller. If this assertion is ever loosened or removed, the unit is not done.
 */
describe("runContextUpdate — document path system string (R10 gate)", () => {
	const documentArgs = {
		title: "Spec",
		baselineDate: new Date("2026-01-01T00:00:00Z"),
		documentMarkdown: "# Spec\nbody",
		contextItems: [
			{
				sourceLabel: "DSU",
				sourceType: "transcript",
				sourceDate: "2026-01-02",
				sourceLinkOrId: "id-1",
				content: "New decision.",
			},
		],
		userId: "u1",
		organizationId: undefined,
		projectId: "p1",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: "# Spec\nbody",
				needsHumanResolution: false,
				summary: "no change",
			},
			usage: {},
		});
		// Role clause off — the document path's baseline shape.
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
	});

	it("a caller that supplies no addendum gets exactly the base prompt plus the locked-attachment clause", async () => {
		await runContextUpdate(documentArgs);

		const system = mocks.generateObject.mock.calls[0][0].system as string;
		expect(system).toBe(
			`${UPDATE_WITH_CONTEXT_SYSTEM_PROMPT}\n\n${getLockedAttachmentRulesClause()}`,
		);
	});

	it("the system string ends at the locked-attachment clause — no trailing separator, no empty addendum slot", async () => {
		await runContextUpdate(documentArgs);

		const system = mocks.generateObject.mock.calls[0][0].system as string;
		expect(system.endsWith(getLockedAttachmentRulesClause())).toBe(true);
	});

	it("an empty or whitespace-only addendum assembles byte-identically to no addendum at all", async () => {
		await runContextUpdate(documentArgs);
		const baseline = mocks.generateObject.mock.calls[0][0].system as string;

		for (const blank of ["", "   ", "\n\n", "\t \n"]) {
			mocks.generateObject.mockClear();
			await runContextUpdate({
				...documentArgs,
				instructionAddendum: blank,
			});
			expect(mocks.generateObject.mock.calls[0][0].system).toBe(baseline);
		}
	});

	it("the scheduled document-refresh activity passes no addendum", () => {
		// The sweep runs unattended, with no diff review and nobody watching, so
		// its request is the one that must not drift. Asserted against the source
		// rather than by driving the whole activity: the ONLY reason this file
		// would ever name the field is to pass one.
		const source = readFileSync(
			new URL(
				"../src/activities/document-refresh/run-document-refresh.ts",
				import.meta.url,
			),
			"utf8",
		);

		expect(source).toContain("runContextUpdate({");
		expect(source).not.toContain("instructionAddendum");
	});
});

describe("runContextUpdate — kind-scoped instruction addendum (Fizzy #2048)", () => {
	const ADDENDUM_SENTINEL =
		"BUG INSTRUCTIONS — sentinel-test-addendum-update-with-context";
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-update-with-context";

	const baseArgs = {
		title: "Spec",
		baselineDate: new Date("2026-01-01T00:00:00Z"),
		documentMarkdown: "# Spec\nbody",
		contextItems: [
			{
				sourceLabel: "DSU",
				sourceType: "transcript",
				sourceDate: "2026-01-02",
				sourceLinkOrId: "id-1",
				content: "New decision.",
			},
		],
		userId: "u1",
		organizationId: undefined,
		projectId: "p1",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});
		mocks.generateObject.mockResolvedValue({
			object: {
				hasRelevantContext: true,
				updatedDocument: "# Spec\nbody",
				needsHumanResolution: false,
				summary: "no change",
			},
			usage: {},
		});
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
	});

	it("appends the addendum in a fixed position: the no-addendum string, then one separator, then the addendum", async () => {
		await runContextUpdate(baseArgs);
		const withoutAddendum = mocks.generateObject.mock.calls[0][0]
			.system as string;

		mocks.generateObject.mockClear();
		await runContextUpdate({
			...baseArgs,
			instructionAddendum: ADDENDUM_SENTINEL,
		});
		const withAddendum = mocks.generateObject.mock.calls[0][0]
			.system as string;

		expect(withAddendum).toBe(`${withoutAddendum}\n\n${ADDENDUM_SENTINEL}`);
	});

	it("stays last when the function-tag role clause is also present", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await runContextUpdate({
			...baseArgs,
			instructionAddendum: ADDENDUM_SENTINEL,
		});

		const system = mocks.generateObject.mock.calls[0][0].system as string;
		expect(system).toContain(`\n\n${ROLE_CLAUSE_SENTINEL}`);
		expect(system.endsWith(`\n\n${ADDENDUM_SENTINEL}`)).toBe(true);
		expect(system.indexOf(ROLE_CLAUSE_SENTINEL)).toBeLessThan(
			system.indexOf(ADDENDUM_SENTINEL),
		);
	});

	it("carries the caller's text verbatim — the engine composes, it does not author", async () => {
		const catalogText =
			"Preserve the following sections when they are present: Steps to Reproduce, Expected Result, Actual Result.";

		await runContextUpdate({
			...baseArgs,
			instructionAddendum: catalogText,
		});

		const system = mocks.generateObject.mock.calls[0][0].system as string;
		expect(system).toContain(catalogText);
	});
});
