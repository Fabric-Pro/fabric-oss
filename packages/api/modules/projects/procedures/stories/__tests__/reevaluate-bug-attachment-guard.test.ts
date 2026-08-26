/**
 * Unit tests for the auto-reinject attachment guard in
 * `reevaluateBugProcedure`.
 *
 * The procedure runs the `bug_reanalysis` prompt against an existing BUG
 * story. Spec §6 mandates that any `story-media/<key>` URL present in the
 * prior description but missing from the LLM-produced markdown is
 * re-signed and reinjected under an `## Attachments` heading before
 * persistence — a recovery action, not a user-facing error.
 *
 * Cases exercised:
 *   1. Happy path — model preserved every key, guard is a no-op.
 *   2. Drop (one) — single key reinjected, warn fires with count=1.
 *   3. Drop (multiple, ordered) — keys reinjected in original
 *      first-appearance order.
 *   4. Idempotency — re-running with the already-reinjected description
 *      yields zero drops.
 *   5. Empty prior — `story.description = null`; guard is a no-op.
 *   6. Empty prior (no story-media) — prior description has none; guard
 *      is a no-op.
 *   7. Key-prefix safety — keys outside `story-media/{project}/{story}/`
 *      are skipped, an `error` log is emitted, and persistence still runs.
 *
 * Story fixture is `kind: "BUG"` throughout — this procedure rejects
 * non-bug stories with `ORPCError("BAD_REQUEST")`, so the test must
 * exercise the bug path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getStoryById: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		updateStory: vi.fn(),
		setLastContextUpdateAt: vi.fn(async () => {}),
		getAIModelWithMetadata: vi.fn(),
		generateObject: vi.fn(),
		logModelUsageAsync: vi.fn(),
		retrieveProjectContexts: vi.fn(),
		formatContextsForPrompt: vi.fn(),
		fetchLiveIntegrationContext: vi.fn(),
		formatLiveContextForPrompt: vi.fn(),
		renderTemplate: vi.fn(),
		getStorageProvider: vi.fn(),
		getSignedUrl: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
		loggerInfo: vi.fn(),
		loggerDebug: vi.fn(),
		getProjectFunctionTagClause: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getStoryById: mocks.getStoryById,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	updateStory: mocks.updateStory,
	setLastContextUpdateAt: mocks.setLastContextUpdateAt,
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		getAIModelWithMetadata: mocks.getAIModelWithMetadata,
		generateObject: (...args: unknown[]) => mocks.generateObject(...args),
		logModelUsageAsync: mocks.logModelUsageAsync,
	};
});

vi.mock("ai", () => ({
	zodSchema: (schema: unknown) => schema,
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-bucket",
			},
		},
	},
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () =>
		mocks.getStorageProvider() ?? {
			getSignedUrl: mocks.getSignedUrl,
		},
}));

vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));

vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: mocks.retrieveProjectContexts,
	formatContextsForPrompt: mocks.formatContextsForPrompt,
}));

vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: mocks.fetchLiveIntegrationContext,
	formatLiveContextForPrompt: mocks.formatLiveContextForPrompt,
}));

vi.mock("@repo/utils", () => ({
	renderTemplate: mocks.renderTemplate,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: mocks.loggerInfo,
		error: mocks.loggerError,
		debug: mocks.loggerDebug,
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.reevaluateBug = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../reevaluate-bug");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

const PROJECT_ID = "project-bug";
const STORY_ID = "story-bug";

const KEY_PREFIX = `story-media/${PROJECT_ID}/${STORY_ID}`;
const KEY_1 = `${KEY_PREFIX}/screenshot-a.png`;
const KEY_2 = `${KEY_PREFIX}/screenshot-b.jpg`;
const KEY_3 = `${KEY_PREFIX}/diagram-c.png`;

// Sentinel for the stub signed-URL pattern. Tests assert the
// reinjected markdown contains the canonical key as a path segment so
// the resolver round-trip is exercise-equivalent to production.
const stubSignedUrl = (key: string) =>
	`https://stub-bucket.local/${key}?signed=1`;

/**
 * Build a BUG story fixture matching the shape returned by `getStoryById`
 * (per `packages/database/prisma/queries/projects/stories.ts`). The
 * procedure rejects `kind !== "BUG"` with `BAD_REQUEST`, so every test
 * passes through this helper.
 */
function bugStory(overrides: Partial<{ description: string | null }> = {}) {
	return {
		id: STORY_ID,
		title: "Login button does nothing on first click",
		identifier: "B-001",
		description: overrides.description ?? null,
		acceptanceCriteria: null,
		draftingStage: "DRAFT",
		kind: "BUG",
		version: 1,
		pmAutoSyncEnabled: false,
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}

	// Storage provider stub: every test starts with a deterministic signed
	// URL that embeds the key as a path segment so the extractor round-trip
	// (markdown → keys) yields the canonical key.
	mocks.getStorageProvider.mockReturnValue({
		getSignedUrl: mocks.getSignedUrl,
	});
	mocks.getSignedUrl.mockImplementation(async (key: string) =>
		stubSignedUrl(key),
	);

	// Bound-prompt fixture — the `bug_reanalysis` prompt content does not
	// matter for guard assertions; only the render result feeds the LLM.
	mocks.getBoundPromptForAgent.mockResolvedValue({
		version: { content: "bug-reanalysis prompt template" },
		format: "PLAIN_TEXT",
		key: "bug_reanalysis",
	});
	mocks.renderTemplate.mockResolvedValue({
		rendered: "rendered prompt body",
		error: null,
	});

	// Context-fetch defaults: no RAG / live context so the test stays
	// focused on the guard behavior.
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.formatContextsForPrompt.mockReturnValue("");
	mocks.fetchLiveIntegrationContext.mockResolvedValue({});
	mocks.formatLiveContextForPrompt.mockReturnValue(null);

	// AI model resolution — return a benign stub; the per-test
	// `generateObject` mock supplies the LLM output that the guard inspects.
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "stub-model" },
		metadata: { providerKey: "stub" },
		trackUsage: vi.fn(),
	});

	// Persistence stub — returns an arbitrary shape; the guard test only
	// inspects the `description` arg passed to `updateStory`.
	mocks.updateStory.mockImplementation(async (_id, _project, data) => ({
		id: STORY_ID,
		needsMoreInfo: false,
		description: data.description,
	}));

	// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so every
	// pre-existing test in this file keeps asserting the pre-Stage-4 prompt
	// shape unchanged.
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("reevaluateBugProcedure attachment guard (spec §6, surface=reevaluate-bug)", () => {
	it("happy path — model preserved every key, guard is a no-op and no warn fires", async () => {
		const priorDescription = `Bug summary.\n\n![](${stubSignedUrl(KEY_1)})`;
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: priorDescription }),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				needsMoreInfo: false,
				// Model preserves the same `story-media/` URL byte-for-byte
				// (the canonical key is embedded in the URL path).
				markdown: `Refined bug summary.\n\n![](${stubSignedUrl(KEY_1)})`,
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
		expect(mocks.setLastContextUpdateAt).toHaveBeenCalledTimes(1);
		expect(mocks.setLastContextUpdateAt).toHaveBeenCalledWith({
			userStoryId: STORY_ID,
			projectId: PROJECT_ID,
			at: expect.any(Date),
		});

		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;

		// Persisted byte-for-byte — no `## Attachments` appended.
		expect(persisted).toBe(
			`Refined bug summary.\n\n![](${stubSignedUrl(KEY_1)})`,
		);
		expect(persisted).not.toContain("## Attachments");

		// No reinject signing happened, no warn fired.
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
		const reinjectWarns = mocks.loggerWarn.mock.calls.filter(
			(c) => c[0] === "[stage-transition] reinjected dropped attachments",
		);
		expect(reinjectWarns).toHaveLength(0);
	});

	it("appends the locked-attachment rule to the re-analysis prompt", async () => {
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: "Bug summary." }),
		);
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: "Refined bug summary." },
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		const prompt = mocks.generateObject.mock.calls[0][0].prompt as string;
		expect(prompt).toContain("DEDICATED ATTACHMENTS");
	});

	it("drop case (one image) — guard reinjects under ## Attachments and emits warn with count=1", async () => {
		const priorDescription = `Bug summary.\n\n![](${stubSignedUrl(KEY_1)})`;
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: priorDescription }),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				needsMoreInfo: false,
				markdown: "Refined bug summary with the image stripped.",
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;

		// The original LLM body is retained, plus the reinjected section
		// containing the missing key's signed URL.
		expect(persisted.startsWith("Refined bug summary")).toBe(true);
		expect(persisted).toContain("## Attachments");
		expect(persisted).toContain(`![](${stubSignedUrl(KEY_1)})`);

		// One signing call for the dropped key, one warn fired with the
		// expected structured payload per spec §10.1.
		expect(mocks.getSignedUrl).toHaveBeenCalledTimes(1);
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(KEY_1, {
			bucket: "test-bucket",
			expiresIn: 3600,
		});
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				storyId: STORY_ID,
				projectId: PROJECT_ID,
				surface: "reevaluate-bug",
				targetStage: null,
				droppedKeyCount: 1,
				droppedKeys: [KEY_1],
				draftingStage: "DRAFT",
			}),
		);
	});

	it("drop case (multiple, ordered) — keys reinjected in original first-appearance order", async () => {
		// Prior description has three keys in K1, K2, K3 order; LLM keeps
		// only K2. The reinjected `## Attachments` block must contain K1
		// before K3 (insertion-order preservation per spec §6.1).
		const priorDescription = [
			"Repro steps.",
			"",
			`![](${stubSignedUrl(KEY_1)})`,
			"More text.",
			`![](${stubSignedUrl(KEY_2)})`,
			"Even more.",
			`![](${stubSignedUrl(KEY_3)})`,
		].join("\n");
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: priorDescription }),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				needsMoreInfo: false,
				markdown: `Refined repro.\n\n![](${stubSignedUrl(KEY_2)})`,
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;

		const k1Idx = persisted.indexOf(KEY_1);
		const k3Idx = persisted.indexOf(KEY_3);
		expect(k1Idx).toBeGreaterThanOrEqual(0);
		expect(k3Idx).toBeGreaterThanOrEqual(0);
		// K1 before K3 — insertion order from the prior description is
		// preserved through the dropped-set + signing pipeline.
		expect(k1Idx).toBeLessThan(k3Idx);

		// Warn carries both dropped keys in the same order.
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				droppedKeyCount: 2,
				droppedKeys: [KEY_1, KEY_3],
			}),
		);
	});

	it("idempotency — re-running with the reinjected description yields zero drops", async () => {
		// Simulate a retry after the first reinject succeeded: the LLM
		// receives + returns the description that already includes
		// `## Attachments ![](signed-url for K1)`. The guard MUST detect
		// the key is present and skip the reinject.
		const priorDescription = `Bug summary.\n\n![](${stubSignedUrl(KEY_1)})`;
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: priorDescription }),
		);
		const alreadyReinjected = [
			"Refined bug summary.",
			"",
			"## Attachments",
			"",
			`![](${stubSignedUrl(KEY_1)})`,
		].join("\n");
		mocks.generateObject.mockResolvedValue({
			object: {
				needsMoreInfo: false,
				markdown: alreadyReinjected,
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;
		expect(persisted).toBe(alreadyReinjected);
		// No second `## Attachments` heading appended.
		const headingMatches = persisted.match(/## Attachments/g) ?? [];
		expect(headingMatches).toHaveLength(1);

		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
		const reinjectWarns = mocks.loggerWarn.mock.calls.filter(
			(c) => c[0] === "[stage-transition] reinjected dropped attachments",
		);
		expect(reinjectWarns).toHaveLength(0);
	});

	it("empty prior — story.description is null; guard is a no-op", async () => {
		mocks.getStoryById.mockResolvedValue(bugStory({ description: null }));
		mocks.generateObject.mockResolvedValue({
			object: {
				needsMoreInfo: false,
				markdown: "Brand new analysis.",
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;
		expect(persisted).toBe("Brand new analysis.");
		expect(persisted).not.toContain("## Attachments");
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
		const reinjectWarns = mocks.loggerWarn.mock.calls.filter(
			(c) => c[0] === "[stage-transition] reinjected dropped attachments",
		);
		expect(reinjectWarns).toHaveLength(0);
	});

	it("empty prior — story.description has no story-media URLs; guard is a no-op", async () => {
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: "Plain text bug report, no attachments." }),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				needsMoreInfo: false,
				markdown: "AI-rewritten plain text body.",
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;
		expect(persisted).toBe("AI-rewritten plain text body.");
		expect(persisted).not.toContain("## Attachments");
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("key-prefix safety — out-of-prefix key is skipped, error log fires, procedure still succeeds", async () => {
		// Defense-in-depth scenario: an out-of-prefix key somehow appears
		// in the prior description (impossible in normal flow but the
		// guard's key-prefix check exists for exactly this case). The
		// guard must skip the bad key, log at error, and still persist.
		const badKey = "story-media/other-project/other-story/leaked.png";
		const priorDescription = [
			`Bug.\n\n![](${stubSignedUrl(KEY_1)})`,
			`Plus a leaked ref: ![](https://example.com/${badKey})`,
		].join("\n");
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: priorDescription }),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				needsMoreInfo: false,
				// LLM dropped BOTH keys — one valid (must be reinjected),
				// one out-of-prefix (must be skipped).
				markdown: "Stripped body.",
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		// Procedure still resolves and persists.
		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;

		// Valid key is reinjected.
		expect(persisted).toContain(`![](${stubSignedUrl(KEY_1)})`);
		// Out-of-prefix key is NOT signed and NOT reinjected.
		expect(mocks.getSignedUrl).not.toHaveBeenCalledWith(
			badKey,
			expect.anything(),
		);

		// Error log emitted for the skipped key.
		expect(mocks.loggerError).toHaveBeenCalledWith(
			"[stage-transition] skipped reinject of out-of-prefix key",
			expect.objectContaining({
				storyId: STORY_ID,
				projectId: PROJECT_ID,
				surface: "reevaluate-bug",
				key: badKey,
			}),
		);

		// Warn for the (one) safe key fires with the spec §10.1 payload.
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				surface: "reevaluate-bug",
				targetStage: null,
				droppedKeyCount: 1,
				droppedKeys: [KEY_1],
			}),
		);
	});

	it("sign failure — every sign rejects: no reinjection, no warn log, sign-failure errors emitted", async () => {
		// Regression for the bug where the warn log fired with `droppedKeys:
		// safeKeys` even when zero keys were actually reinjected because
		// every getSignedUrl rejected. After the fix the warn is gated on
		// `signedPairs.length > 0` and reports only the successfully-signed
		// subset; sign rejections surface as `logger.error` lines.
		const priorDescription = [
			`Bug.\n\n![](${stubSignedUrl(KEY_1)})`,
			`![](${stubSignedUrl(KEY_2)})`,
		].join("\n");
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: priorDescription }),
		);
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: "Stripped body." },
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});
		// Both signs fail — simulates a misconfigured storage provider or
		// an object that was deleted out-of-band.
		mocks.getSignedUrl.mockRejectedValue(new Error("sign rejected"));

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		// Procedure still persists what the LLM produced — recovery action,
		// never an ORPCError.
		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;
		expect(persisted).toBe("Stripped body.");
		expect(persisted).not.toContain("## Attachments");

		// One error log per failed sign (two keys, two errors).
		const signErrors = mocks.loggerError.mock.calls.filter(
			(c) =>
				c[0] === "[stage-transition] failed to sign dropped attachment",
		);
		expect(signErrors).toHaveLength(2);
		expect(signErrors[0][1]).toMatchObject({
			storyId: STORY_ID,
			projectId: PROJECT_ID,
			surface: "reevaluate-bug",
		});

		// CRITICAL: no `warn` fires when nothing was reinjected. Before the
		// fix this would have fired with `droppedKeyCount: 2`.
		const reinjectWarns = mocks.loggerWarn.mock.calls.filter(
			(c) => c[0] === "[stage-transition] reinjected dropped attachments",
		);
		expect(reinjectWarns).toHaveLength(0);
	});

	it("sign failure (partial) — one of two keys fails: only the successful key is logged + reinjected", async () => {
		// Regression for the bug where `droppedKeys: safeKeys` overstated
		// the count on partial sign failure. After the fix the warn reports
		// only the successfully-signed key.
		const priorDescription = [
			`Bug.\n\n![](${stubSignedUrl(KEY_1)})`,
			`![](${stubSignedUrl(KEY_2)})`,
		].join("\n");
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: priorDescription }),
		);
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: "Stripped body." },
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});
		// Sign for KEY_1 succeeds, KEY_2 fails.
		mocks.getSignedUrl.mockImplementation(async (key: string) => {
			if (key === KEY_2) {
				throw new Error("transient sign failure");
			}
			return stubSignedUrl(key);
		});

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		const persisted = mocks.updateStory.mock.calls[0][2]
			.description as string;
		expect(persisted).toContain(`![](${stubSignedUrl(KEY_1)})`);
		expect(persisted).not.toContain(`![](${stubSignedUrl(KEY_2)})`);
		expect(persisted).toContain("## Attachments");

		// Error log for the one failed key.
		const signErrors = mocks.loggerError.mock.calls.filter(
			(c) =>
				c[0] === "[stage-transition] failed to sign dropped attachment",
		);
		expect(signErrors).toHaveLength(1);
		expect(signErrors[0][1]).toMatchObject({ key: KEY_2 });

		// Warn reports only the successfully-signed key, not safeKeys (=2).
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				surface: "reevaluate-bug",
				droppedKeyCount: 1,
				droppedKeys: [KEY_1],
			}),
		);
	});
});

describe("reevaluateBugProcedure — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-reevaluate-bug";

	beforeEach(() => {
		mocks.getStoryById.mockResolvedValue(
			bugStory({ description: "Bug summary." }),
		);
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: "Refined bug summary." },
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});
	});

	it("flag ON: resolves the role clause with the story's project/user and appends it to the prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			requesterUserId: "user-1",
			surface: "reevaluate-bug",
		});
		const prompt = mocks.generateObject.mock.calls[0][0].prompt as string;
		expect(prompt).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});
		const withClause = mocks.generateObject.mock.calls[0][0]
			.prompt as string;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await handlers.reevaluateBug({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});
		const withoutClause = mocks.generateObject.mock.calls[0][0]
			.prompt as string;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		// The splice is `${...}${roleClause ? `\n\n${roleClause}` : ""}` — so
		// the no-clause prompt must be exactly the with-clause prompt minus
		// its trailing "\n\n" + sentinel.
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});
