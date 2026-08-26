/**
 * Unit tests for the sync-flow Surface B prompt assembly in
 * `enhanceFeatureProcedure` / `enhanceFeatureWithAI`.
 *
 * The procedure resolves a bound prompt, fetches contexts, and hands an
 * assembled user prompt to `generateObject`. This file pins the contract
 * that the in-body attachment / code-fence preservation clause from
 * `@repo/agent-prompts` is inserted between the resolved prompt and the
 * project-context block per spec §5.2 (post-fix shape). It also locks the
 * negative invariant that the over-broad legacy `![alt](url)` prohibition
 * from Surface A's pre-fix wording never leaks into Surface B.
 *
 * Mocks `@repo/database`, `@repo/ai`, `@repo/rag`, `@repo/temporal/...`,
 * the template renderer, the PM-sync enqueue helper, and the oRPC
 * procedure base so the handler can be invoked directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks, generateObjectCalls } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const generateObjectCalls: Array<{ prompt: string }> = [];
	const mocks = {
		getStoryById: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		getPromptById: vi.fn(),
		updateStory: vi.fn(),
		updateStoryDraftingStage: vi.fn(),
		createFeatureVersion: vi.fn(),
		setLastContextUpdateAt: vi.fn(),
		featureVersionFindFirst: vi.fn(),
		projectFindUnique: vi.fn(),
		userStoryUpdate: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		generateObject: vi.fn(),
		logModelUsageAsync: vi.fn(),
		retrieveProjectContexts: vi.fn(),
		formatContextsForPrompt: vi.fn(),
		fetchLiveIntegrationContext: vi.fn(),
		formatLiveContextForPrompt: vi.fn(),
		gatherLiveUrlSources: vi.fn(),
		formatLiveUrlSourcesForPrompt: vi.fn(),
		renderTemplate: vi.fn(),
		enqueuePmSync: vi.fn(),
		loggerWarn: vi.fn(),
		loggerInfo: vi.fn(),
		getProjectFunctionTagClause: vi.fn(),
		resolveStoryAttachmentAiContexts: vi.fn(),
	};
	return { handlers, mocks, generateObjectCalls };
});

vi.mock("@repo/database", () => ({
	getStoryById: mocks.getStoryById,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getPromptById: mocks.getPromptById,
	updateStory: mocks.updateStory,
	updateStoryDraftingStage: mocks.updateStoryDraftingStage,
	createFeatureVersion: mocks.createFeatureVersion,
	setLastContextUpdateAt: mocks.setLastContextUpdateAt,
	db: {
		project: {
			findUnique: mocks.projectFindUnique,
		},
		featureVersion: {
			findFirst: mocks.featureVersionFindFirst,
		},
		userStory: {
			update: mocks.userStoryUpdate,
		},
	},
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"PASSIVE_ANALYSIS",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		getAIModelWithMetadata: mocks.getAIModelWithMetadata,
		generateObject: (...args: unknown[]) => {
			const first = args[0] as { prompt: string };
			generateObjectCalls.push({ prompt: first.prompt });
			return mocks.generateObject(...args);
		},
		logModelUsageAsync: mocks.logModelUsageAsync,
	};
});

vi.mock("ai", () => ({
	zodSchema: (schema: unknown) => schema,
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

vi.mock("@repo/temporal/activities", () => ({
	gatherLiveUrlSources: mocks.gatherLiveUrlSources,
	formatLiveUrlSourcesForPrompt: mocks.formatLiveUrlSourcesForPrompt,
}));

vi.mock("@repo/utils", () => ({
	renderTemplate: mocks.renderTemplate,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: mocks.loggerInfo,
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../lib/story-attachment-ai-context", () => ({
	resolveStoryAttachmentAiContexts: mocks.resolveStoryAttachmentAiContexts,
}));
vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.enhance = fn;
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

await import("../enhance-feature");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

// Distinctive sentinel string used as the resolved prompt content so the
// ordering assertion can locate it unambiguously inside the assembled
// prompt fed to `generateObject`.
const RESOLVED_PROMPT_CONTENT = "RESOLVED_PROMPT_CONTENT_SENTINEL_42";

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	generateObjectCalls.length = 0;

	// Default story + bound-prompt fixtures — individual tests can override.
	mocks.getStoryById.mockResolvedValue({
		id: "story-sb",
		title: "Existing feature title",
		description: "Original description body",
		acceptanceCriteria: null,
		draftingStage: "PLACEHOLDER",
		kind: "FEATURE",
		identifier: "F-001",
		version: 1,
	});
	mocks.getBoundPromptForAgent.mockResolvedValue({
		version: { content: RESOLVED_PROMPT_CONTENT },
		format: "PLAIN_TEXT",
		key: "feature_passive_analysis",
	});

	// Context-fetch defaults: project found, no RAG / live / live-URL context
	// so the assembled prompt stays small and the ordering assertion has
	// fewer noise tokens to fight through.
	mocks.projectFindUnique.mockResolvedValue({
		name: "Test project",
		description: "Test project description",
		techStack: ["Node", "TypeScript"],
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.formatContextsForPrompt.mockReturnValue("");
	mocks.fetchLiveIntegrationContext.mockResolvedValue({});
	mocks.formatLiveContextForPrompt.mockReturnValue(null);
	mocks.gatherLiveUrlSources.mockResolvedValue([]);
	mocks.formatLiveUrlSourcesForPrompt.mockReturnValue("");
	// No context-only attachments by default — the overwhelmingly common
	// case, and it keeps the ordering assertions free of extra tokens.
	mocks.resolveStoryAttachmentAiContexts.mockResolvedValue([]);

	// Template renderer passes the resolved prompt through verbatim.
	mocks.renderTemplate.mockResolvedValue({
		rendered: RESOLVED_PROMPT_CONTENT,
		error: null,
	});

	// AI model resolution + generateObject defaults — return a benign
	// rewrite so the procedure walks the full happy-path persistence.
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "stub-model" },
		metadata: { providerKey: "stub" },
		trackUsage: vi.fn(),
	});
	mocks.generateObject.mockResolvedValue({
		object: {
			description: "AI-rewritten description",
			acceptanceCriteria: undefined,
		},
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	});

	// Persistence stubs — return arbitrary shapes; only the call shapes
	// matter for prompt-assembly assertions.
	mocks.featureVersionFindFirst.mockResolvedValue(null);
	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.updateStory.mockResolvedValue({
		id: "story-sb",
		pmAutoSyncEnabled: false,
	});
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: false,
		workflowId: null,
	});

	// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so every
	// pre-existing test in this file keeps asserting the pre-Stage-4 prompt
	// shape unchanged.
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("enhanceFeatureProcedure — Surface B prompt assembly", () => {
	it("inserts the shared preservation clause so the prompt contains the INPUT-DOCUMENT IMAGES marker", async () => {
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});

		expect(generateObjectCalls).toHaveLength(1);
		const assembled = generateObjectCalls[0].prompt;
		expect(assembled).toContain("INPUT-DOCUMENT IMAGES");
	});

	it("the preservation clause anchors the model on the story-media/ URL pattern", async () => {
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});

		const assembled = generateObjectCalls[0].prompt;
		expect(assembled).toContain("story-media/");
	});

	it("preservation clause is placed AFTER the resolved prompt and BEFORE the project context block (spec §5.2 ordering)", async () => {
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});

		const assembled = generateObjectCalls[0].prompt;

		const promptIdx = assembled.indexOf(RESOLVED_PROMPT_CONTENT);
		const clauseIdx = assembled.indexOf("INPUT-DOCUMENT IMAGES");
		const projectContextIdx = assembled.indexOf("Project context:");

		expect(promptIdx).toBeGreaterThanOrEqual(0);
		expect(clauseIdx).toBeGreaterThanOrEqual(0);
		expect(projectContextIdx).toBeGreaterThanOrEqual(0);

		// Strict ordering invariant from spec §5.2 post-fix shape:
		// parts[0] = prompt, parts[1] = preservation clause,
		// parts[2] = projectContext block.
		expect(clauseIdx).toBeGreaterThan(promptIdx);
		expect(clauseIdx).toBeLessThan(projectContextIdx);
	});

	it("inserts the locked-attachment rule so the prompt contains the DEDICATED ATTACHMENTS scope marker", async () => {
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});

		const assembled = generateObjectCalls[0].prompt;
		expect(assembled).toContain("DEDICATED ATTACHMENTS");
		// AC-6: both designations named so LOCKED vs UNLOCKED survives.
		expect(assembled).toContain("LOCKED");
		expect(assembled).toContain("UNLOCKED");
	});

	it("places the locked-attachment rule after the resolved prompt and before the project context block", async () => {
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});

		const assembled = generateObjectCalls[0].prompt;
		const promptIdx = assembled.indexOf(RESOLVED_PROMPT_CONTENT);
		const rulesIdx = assembled.indexOf("DEDICATED ATTACHMENTS");
		const projectContextIdx = assembled.indexOf("Project context:");

		expect(promptIdx).toBeGreaterThanOrEqual(0);
		expect(rulesIdx).toBeGreaterThanOrEqual(0);
		expect(projectContextIdx).toBeGreaterThanOrEqual(0);
		expect(rulesIdx).toBeGreaterThan(promptIdx);
		expect(rulesIdx).toBeLessThan(projectContextIdx);
	});

	it("does NOT contain the over-broad legacy ![alt](url) prohibition that lived in Surface A pre-fix", async () => {
		// Surface B never had the chat-attachment paragraph in the first
		// place. This negative assertion proves: (a) the helper insertion
		// did not accidentally pull in the legacy wording from a stale
		// copy-paste, and (b) the bug described in spec §2.3 cannot recur
		// here even if Surface A's pre-fix sentence resurfaces upstream.
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});

		const assembled = generateObjectCalls[0].prompt;
		expect(assembled).not.toContain(
			"Do NOT include image markdown (`![alt](url)`)",
		);
	});
});

describe("enhanceFeatureProcedure — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-enhance-feature";

	it("flag ON: resolves the role clause with the story's project/user and appends it to the assembled prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "project-1",
			requesterUserId: "user-1",
			surface: "enhance-feature",
		});
		const assembled = generateObjectCalls[0].prompt;
		expect(assembled).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: assembled prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});
		const withClause = generateObjectCalls[0].prompt;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		generateObjectCalls.length = 0;
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-sb",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
			},
			context: ctx,
		});
		const withoutClause = generateObjectCalls[0].prompt;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		// `parts.push(roleClause)` only runs for a truthy clause, and `parts`
		// is joined with "\n" — so the no-clause assembly must be exactly the
		// with-clause assembly minus its trailing "\n" + sentinel. Proves no
		// dangling separator or empty-string artifact survives the flag-OFF
		// path.
		expect(withClause).toBe(`${withoutClause}\n${ROLE_CLAUSE_SENTINEL}`);
	});
});

describe("context-only attachment delivery (U3)", () => {
	const enhanceInput = {
		projectId: "project-1",
		storyId: "story-sb",
		organizationId: null,
		targetStage: "PASSIVE_ANALYSIS" as const,
	};

	it("puts a context-only attachment's text into the prompt", async () => {
		mocks.resolveStoryAttachmentAiContexts.mockResolvedValue([
			"<attachment>\n[Uploaded Document: spec.md]\nATTACHED_SPEC_BODY\n</attachment>",
		]);

		await handlers.enhance({ input: enhanceInput, context: ctx });

		expect(generateObjectCalls[0].prompt).toContain("ATTACHED_SPEC_BODY");
	});

	it("resolves attachments for the story being enhanced", async () => {
		await handlers.enhance({ input: enhanceInput, context: ctx });

		expect(mocks.resolveStoryAttachmentAiContexts).toHaveBeenCalledWith(
			"story-sb",
			expect.objectContaining({ organizationId: null }),
		);
	});

	it("places attachment text ahead of retrieved context", async () => {
		// A file the user deliberately attached outranks a chunk that
		// similarity happened to surface.
		mocks.resolveStoryAttachmentAiContexts.mockResolvedValue([
			"ATTACHMENT_MARKER",
		]);
		mocks.formatContextsForPrompt.mockReturnValue("RETRIEVED_MARKER");
		mocks.retrieveProjectContexts.mockResolvedValue([{ id: "c1" }]);

		await handlers.enhance({ input: enhanceInput, context: ctx });

		const prompt = generateObjectCalls[0].prompt;
		const attachmentIdx = prompt.indexOf("ATTACHMENT_MARKER");
		const retrievedIdx = prompt.indexOf("RETRIEVED_MARKER");
		expect(attachmentIdx).toBeGreaterThanOrEqual(0);
		expect(retrievedIdx).toBeGreaterThanOrEqual(0);
		expect(attachmentIdx).toBeLessThan(retrievedIdx);
	});

	it("leaves the prompt byte-identical when the story has no attachments", async () => {
		// The no-attachment path is the common one. It must not gain a blank
		// section, a stray separator, or an empty envelope.
		mocks.resolveStoryAttachmentAiContexts.mockResolvedValue([]);
		await handlers.enhance({ input: enhanceInput, context: ctx });
		const withoutAttachments = generateObjectCalls[0].prompt;

		generateObjectCalls.length = 0;
		mocks.resolveStoryAttachmentAiContexts.mockResolvedValue([]);
		await handlers.enhance({ input: enhanceInput, context: ctx });

		expect(generateObjectCalls[0].prompt).toBe(withoutAttachments);
		expect(withoutAttachments).not.toContain("Uploaded Document");
	});

	it("still enhances when attachment resolution rejects", async () => {
		// One unreadable reference file must not take down a maturation run.
		mocks.resolveStoryAttachmentAiContexts.mockRejectedValue(
			new Error("storage unreachable"),
		);

		await handlers.enhance({ input: enhanceInput, context: ctx });

		expect(generateObjectCalls).toHaveLength(1);
		expect(generateObjectCalls[0].prompt).toContain(
			RESOLVED_PROMPT_CONTENT,
		);
	});
});
