/**
 * The maturation enhance procedure refuses a hand-picked prompt bound to the
 * other kind (Fizzy #2048, U3 / R3 / AE2).
 *
 * `input.promptId` is the one branch of this procedure that never consulted
 * `story.kind`: a prompt named by the caller was fetched by id and applied to
 * the work item whatever it was bound to. These tests exercise the REAL guard
 * (`validate-prompt-for-kind` is deliberately not mocked) against a mocked
 * binding table, and assert the refusal happens before anything is written.
 *
 * Mock scaffolding mirrors `enhance-feature.test.ts` so the handler can be
 * invoked directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getStoryById: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		getPromptById: vi.fn(),
		promptBindingFindMany: vi.fn(),
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
		getProjectFunctionTagClause: vi.fn(),
		resolveStoryAttachmentAiContexts: vi.fn(),
	};
	return { handlers, mocks };
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
		project: { findUnique: mocks.projectFindUnique },
		featureVersion: { findFirst: mocks.featureVersionFindFirst },
		userStory: { update: mocks.userStoryUpdate },
		promptBinding: { findMany: mocks.promptBindingFindMany },
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
		generateObject: mocks.generateObject,
		logModelUsageAsync: mocks.logModelUsageAsync,
	};
});

vi.mock("ai", () => ({ zodSchema: (schema: unknown) => schema }));

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

vi.mock("@repo/utils", () => ({ renderTemplate: mocks.renderTemplate }));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
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
			organizationId ?? undefined,
		requireOrganizationMembership: vi.fn(),
	};
});

await import("../enhance-feature");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

const HAND_PICKED_CONTENT = "HAND_PICKED_PROMPT_SENTINEL";

/** Nothing was persisted and no model call was made. */
function expectNothingWritten() {
	expect(mocks.generateObject).not.toHaveBeenCalled();
	expect(mocks.createFeatureVersion).not.toHaveBeenCalled();
	expect(mocks.updateStory).not.toHaveBeenCalled();
	expect(mocks.updateStoryDraftingStage).not.toHaveBeenCalled();
	expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}

	mocks.getStoryById.mockResolvedValue({
		id: "story-1",
		title: "Existing work item",
		description: "Original description body",
		acceptanceCriteria: null,
		draftingStage: "PLACEHOLDER",
		kind: "BUG",
		identifier: "F-001",
		version: 1,
	});
	mocks.getPromptById.mockResolvedValue({
		id: "prompt-9",
		key: "hand_picked_prompt",
		name: "Hand-picked rewrite",
		format: "PLAIN_TEXT",
		versions: [{ content: HAND_PICKED_CONTENT }],
	});
	mocks.promptBindingFindMany.mockResolvedValue([]);
	mocks.getBoundPromptForAgent.mockResolvedValue(null);

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
	mocks.resolveStoryAttachmentAiContexts.mockResolvedValue([]);
	mocks.renderTemplate.mockResolvedValue({
		rendered: HAND_PICKED_CONTENT,
		error: null,
	});
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
	mocks.featureVersionFindFirst.mockResolvedValue(null);
	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.updateStory.mockResolvedValue({
		id: "story-1",
		pmAutoSyncEnabled: false,
	});
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: false,
		workflowId: null,
	});
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("enhanceFeatureProcedure — a hand-picked prompt is checked against the stored kind", () => {
	it("refuses a FEATURE-bound prompt on a BUG work item, and writes nothing", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([
			{ storyKind: "FEATURE" },
		]);

		await expect(
			handlers.enhance({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: null,
					targetStage: "DRAFT",
					promptId: "prompt-9",
				},
				context: ctx,
			}),
		).rejects.toThrow(/FEATURE/);

		expectNothingWritten();
	});

	it("names both kinds in the refusal, because the toast renders it verbatim", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([
			{ storyKind: "FEATURE" },
		]);

		let message = "";
		try {
			await handlers.enhance({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: null,
					targetStage: "DRAFT",
					promptId: "prompt-9",
				},
				context: ctx,
			});
		} catch (error) {
			message = (error as { message: string }).message;
		}

		expect(message).toContain("BUG");
		expect(message).toContain("FEATURE");
		expect(message).toContain("Hand-picked rewrite");
	});

	it("refuses a prompt with NO binding at this stage rather than treating it as kind-agnostic", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([]);

		await expect(
			handlers.enhance({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: null,
					targetStage: "DRAFT",
					promptId: "prompt-9",
				},
				context: ctx,
			}),
		).rejects.toThrow(/not bound to any work item kind/i);

		expectNothingWritten();
	});

	it("refuses a prompt bound to the other kind at a DIFFERENT document type", async () => {
		// Bound at CLEAN_SPEC for FEATURE; this run asks about DRAFT, so the
		// document-type-scoped lookup comes back empty — and empty is a refusal.
		mocks.promptBindingFindMany.mockImplementation(
			async (args: { where: { documentType: string } }) =>
				args.where.documentType === "CLEAN_SPEC"
					? [{ storyKind: "FEATURE" }]
					: [],
		);

		await expect(
			handlers.enhance({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: null,
					targetStage: "DRAFT",
					promptId: "prompt-9",
				},
				context: ctx,
			}),
		).rejects.toThrow();

		expectNothingWritten();
	});

	it("lets a matching prompt through to the model", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "DRAFT",
				promptId: "prompt-9",
			},
			context: ctx,
		});

		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
		const assembled = (
			mocks.generateObject.mock.calls[0][0] as { prompt: string }
		).prompt;
		expect(assembled).toContain(HAND_PICKED_CONTENT);
	});

	it("lets a NULL-scoped (kind-agnostic) binding through on a BUG", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: null }]);

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "DRAFT",
				promptId: "prompt-9",
			},
			context: ctx,
		});

		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	});

	it("checks the binding at the refresh document type when no stage is supplied", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				promptId: "prompt-9",
				cleanSpecRefresh: true,
			},
			context: ctx,
		});

		expect(
			mocks.promptBindingFindMany.mock.calls[0][0].where.documentType,
		).toBe("CLEAN_SPEC");
	});
});

describe("enhanceFeatureProcedure — omitting a prompt id leaves the existing path unchanged", () => {
	it("never consults the binding table when the caller names no prompt", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "BOUND_PROMPT_SENTINEL" },
			format: "PLAIN_TEXT",
			key: "bug_draft",
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "BOUND_PROMPT_SENTINEL",
			error: null,
		});

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "DRAFT",
			},
			context: ctx,
		});

		// The guard only ever runs on the explicit-prompt branch; the bound
		// lookup is already kind-exact by contract and stays untouched.
		expect(mocks.promptBindingFindMany).not.toHaveBeenCalled();
		expect(mocks.getPromptById).not.toHaveBeenCalled();
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				storyKind: "BUG",
				documentType: "DRAFT",
			}),
		);
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	});
});

/**
 * A Clean Spec refresh (`cleanSpecRefresh: true`, no `promptId`) resolves the
 * bound prompt through the type-scoped agent instead of the stage-scoped
 * `project_document_generator` (Fizzy #2048, U7). `cleanSpecAgentForKind` is
 * deliberately not mocked here — it's imported directly from
 * `@repo/temporal/clean-spec-agent-for-kind`, not from the mocked
 * `@repo/temporal/activities`, so these tests exercise the real mapping
 * against a mocked `getStoryById`.
 */
describe("enhanceFeatureProcedure — a Clean Spec refresh resolves the agent from the stored kind", () => {
	it("resolves the BUG Clean Spec agent when the stored kind is BUG", async () => {
		// beforeEach already seeds getStoryById with kind: "BUG".
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "BOUND_CLEAN_SPEC_SENTINEL" },
			format: "PLAIN_TEXT",
			key: "bug_clean_spec",
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "BOUND_CLEAN_SPEC_SENTINEL",
			error: null,
		});

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				cleanSpecRefresh: true,
			},
			context: ctx,
		});

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "bug_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "BUG",
			}),
		);
	});

	it("resolves the FEATURE Clean Spec agent when the stored kind is FEATURE", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-1",
			title: "Existing work item",
			description: "Original description body",
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-002",
			version: 1,
		});
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "BOUND_CLEAN_SPEC_SENTINEL" },
			format: "PLAIN_TEXT",
			key: "feature_clean_spec",
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "BOUND_CLEAN_SPEC_SENTINEL",
			error: null,
		});

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				cleanSpecRefresh: true,
			},
			context: ctx,
		});

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "FEATURE",
			}),
		);
	});

	it("takes the agent from the story load, not from anything the caller passed — the input carries no kind field at all", async () => {
		// The exact same `input` object is reused for both calls below; only the
		// `getStoryById` mock changes between them. `cleanSpecRefresh` inputs
		// have no kind field for a caller to influence, so if the resolved
		// agent name tracks the story mock across two identical inputs, the
		// story load is provably the only source of the kind.
		const input = {
			projectId: "project-1",
			storyId: "story-1",
			organizationId: null,
			cleanSpecRefresh: true,
		} as const;
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "BOUND_CLEAN_SPEC_SENTINEL" },
			format: "PLAIN_TEXT",
			key: "bug_clean_spec",
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "BOUND_CLEAN_SPEC_SENTINEL",
			error: null,
		});

		// beforeEach already seeds getStoryById with kind: "BUG".
		await handlers.enhance({ input, context: ctx });

		expect(mocks.getBoundPromptForAgent).toHaveBeenLastCalledWith(
			expect.objectContaining({ agentName: "bug_clean_spec_generator" }),
		);

		mocks.getStoryById.mockResolvedValue({
			id: "story-1",
			title: "Existing work item",
			description: "Original description body",
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-001",
			version: 1,
		});

		await handlers.enhance({ input, context: ctx });

		expect(mocks.getBoundPromptForAgent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
			}),
		);
	});
});

/**
 * Pins that adding the Clean Spec agent resolution above left the ordinary
 * stage-transition path (no `cleanSpecRefresh`) untouched: it still resolves
 * the single stage-scoped `project_document_generator` agent, regardless of
 * the work item's kind.
 */
describe("enhanceFeatureProcedure — a stage transition (no cleanSpecRefresh) keeps using the stage-scoped agent", () => {
	it("resolves project_document_generator at the target stage, not a kind-scoped Clean Spec agent", async () => {
		// beforeEach already seeds getStoryById with kind: "BUG".
		mocks.getBoundPromptForAgent.mockResolvedValue({
			version: { content: "BOUND_STAGE_SENTINEL" },
			format: "PLAIN_TEXT",
			key: "bug_draft",
		});
		mocks.renderTemplate.mockResolvedValue({
			rendered: "BOUND_STAGE_SENTINEL",
			error: null,
		});

		await handlers.enhance({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "DRAFT",
			},
			context: ctx,
		});

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "project_document_generator",
				documentType: "DRAFT",
				storyKind: "BUG",
			}),
		);
	});
});
