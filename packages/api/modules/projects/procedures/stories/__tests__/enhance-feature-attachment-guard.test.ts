/**
 * Unit tests for the server-side attachment-reinjection guard at the
 * sync-flow fallback procedure `enhanceFeatureProcedure`.
 *
 * The procedure is the Surface B persistence path and
 * runs when the StoryWorkspace front-end fails to resolve a streaming prompt
 * and falls through to a server-side AI enhancement via
 * `enhanceFeatureWithAI`. The guard reads `oldKeys` from the pre-mutation
 * `story.description` (already loaded for authorization), reads `newKeys`
 * from the AI-produced `enhanced.description`, and reinjects any dropped
 * `story-media/` keys as an `## Attachments` markdown block before
 * persisting via `updateStory(...)`.
 *
 * Mocks `@repo/database`, `@repo/ai`, `@repo/rag`, `@repo/temporal/...`,
 * the template renderer, `@repo/config`, `@repo/storage`, the PM-sync
 * enqueue helper, `@repo/logs`, and the oRPC procedure base so the handler
 * can be invoked directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks, generateObjectResults, updateStoryCalls } = vi.hoisted(
	() => {
		const handlers: Record<string, (...args: unknown[]) => unknown> = {};
		// Queue of stub responses for sequential generateObject calls so
		// individual tests can shape the AI output (preserve vs drop) per
		// invocation without re-mocking the whole `@repo/ai` surface.
		const generateObjectResults: Array<{
			description: string;
			acceptanceCriteria?: string;
		}> = [];
		const updateStoryCalls: Array<{
			id: string;
			projectId: string;
			data: {
				description: string;
				acceptanceCriteria: string | null;
				draftingStage: string;
			};
		}> = [];
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
			loggerError: vi.fn(),
			getSignedUrl: vi.fn(),
		};
		return { handlers, mocks, generateObjectResults, updateStoryCalls };
	},
);

vi.mock("@repo/database", () => ({
	getStoryById: mocks.getStoryById,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getPromptById: mocks.getPromptById,
	updateStory: (
		storyId: string,
		projectId: string,
		data: {
			description: string;
			acceptanceCriteria: string | null;
			draftingStage: string;
		},
	) => {
		updateStoryCalls.push({ id: storyId, projectId, data });
		return mocks.updateStory(storyId, projectId, data);
	},
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
		// Pull the next queued shape so tests can drive successive AI calls
		// (e.g. an idempotency test invokes the handler twice with a
		// different preserve/drop shape per call).
		generateObject: () => {
			const next = generateObjectResults.shift() ?? {
				description: "default",
				acceptanceCriteria: undefined,
			};
			return Promise.resolve({
				object: next,
				usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			});
		},
		logModelUsageAsync: mocks.logModelUsageAsync,
	};
});

vi.mock("ai", () => ({
	zodSchema: (schema: unknown) => schema,
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
		error: mocks.loggerError,
		debug: vi.fn(),
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-project-contexts-bucket",
			},
		},
	},
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		getSignedUrl: (
			key: string,
			opts: { bucket: string; expiresIn: number },
		) => mocks.getSignedUrl(key, opts),
	}),
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

// Standard fixture: the canonical inputs to `enhanceFeatureProcedure`. The
// project/story IDs are baked into the keyspace assertions below so
// helpers like `buildKey` stay deterministic across tests.
const PROJECT_ID = "project-attg";
const STORY_ID = "story-attg";

function buildKey(name: string): string {
	return `story-media/${PROJECT_ID}/${STORY_ID}/${name}`;
}

function buildHtmlImage(name: string): string {
	const key = buildKey(name);
	return `<img data-s3-key="${key}" src="https://example.cloudfront.net/${key}?signed=abc">`;
}

function buildMarkdownImage(name: string): string {
	const key = buildKey(name);
	return `![](https://example.cloudfront.net/${key}?signed=xyz)`;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	generateObjectResults.length = 0;
	updateStoryCalls.length = 0;

	// Bound prompt + template fixtures so the procedure walks the full
	// `enhanceFeatureWithAI` happy path. The exact prompt text is irrelevant
	// for the guard — these tests pin the post-AI persistence behaviour, not
	// the prompt assembly (which Group 2B's `enhance-feature.test.ts`
	// already covers).
	mocks.getBoundPromptForAgent.mockResolvedValue({
		version: { content: "PROMPT_CONTENT" },
		format: "PLAIN_TEXT",
		key: "feature_passive_analysis",
	});
	mocks.projectFindUnique.mockResolvedValue({
		name: "Test project",
		description: "Project description",
		techStack: ["TypeScript"],
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.formatContextsForPrompt.mockReturnValue("");
	mocks.fetchLiveIntegrationContext.mockResolvedValue({});
	mocks.formatLiveContextForPrompt.mockReturnValue(null);
	mocks.gatherLiveUrlSources.mockResolvedValue([]);
	mocks.formatLiveUrlSourcesForPrompt.mockReturnValue("");
	mocks.renderTemplate.mockResolvedValue({
		rendered: "PROMPT_CONTENT",
		error: null,
	});

	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "stub-model" },
		metadata: { providerKey: "stub" },
		trackUsage: vi.fn(),
	});

	mocks.featureVersionFindFirst.mockResolvedValue(null);
	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.updateStory.mockResolvedValue({
		id: STORY_ID,
		pmAutoSyncEnabled: false,
	});
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: false,
		workflowId: null,
	});

	// Deterministic signed URL stub so assertions can string-match without
	// reconstructing query strings. Mirrors the `update-drafting-stage-with-
	// version-attachment-guard.test.ts` (Group 5A) stub shape.
	mocks.getSignedUrl.mockImplementation(async (key: string) => {
		return `https://stub-bucket.local/${key}?signed=1`;
	});
});

async function invokeHandler(): Promise<unknown> {
	return handlers.enhance({
		input: {
			projectId: PROJECT_ID,
			storyId: STORY_ID,
			organizationId: null,
			targetStage: "PASSIVE_ANALYSIS",
		},
		context: ctx,
	});
}

describe("enhanceFeatureProcedure attachment-reinject guard", () => {
	it("happy path: prior + incoming contain the same key — guard is a no-op and no warn log fires", async () => {
		const html = buildHtmlImage("k1.png");
		mocks.getStoryById.mockResolvedValue({
			id: STORY_ID,
			title: "Existing feature",
			description: `Description body\n\n${html}`,
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-001",
			version: 1,
		});
		// Model preserves the same key in markdown form (round-trip via
		// Turndown is the realistic shape after AI rewrite).
		generateObjectResults.push({
			description: `Rewritten body\n\n${buildMarkdownImage("k1.png")}`,
			acceptanceCriteria: undefined,
		});

		await invokeHandler();

		expect(updateStoryCalls).toHaveLength(1);
		const persisted = updateStoryCalls[0].data.description;
		expect(persisted).not.toContain("## Attachments");
		expect(persisted).toContain(buildKey("k1.png"));
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.anything(),
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("relocation is not a drop: an image the model files under the acceptance section is left alone", async () => {
		// The criteria recovery moves everything under an acceptance heading out
		// of `description` and into `acceptanceCriteria`. An image that travels
		// with it is still in the feature — it changed column, not existence.
		// Diffing `description` alone reports it missing, re-signs it, and
		// appends a SECOND copy under `## Attachments` while logging a drop that
		// never happened.
		const html = buildHtmlImage("k1.png");
		mocks.getStoryById.mockResolvedValue({
			id: STORY_ID,
			title: "Existing feature",
			description: `Description body\n\n${html}`,
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-001",
			version: 1,
		});
		// The model returns ONE document with the image under the acceptance
		// heading and leaves the structured field empty — the exact shape the
		// recovery exists for.
		generateObjectResults.push({
			description: `Rewritten body\n\n## Acceptance Criteria\n\n- AC 1\n\n${buildMarkdownImage("k1.png")}`,
			acceptanceCriteria: undefined,
		});

		await invokeHandler();

		expect(updateStoryCalls).toHaveLength(1);
		const persisted = updateStoryCalls[0].data;
		// Recovered into the column, and NOT reported as dropped.
		expect(persisted.acceptanceCriteria).toContain(buildKey("k1.png"));
		expect(persisted.description).not.toContain("## Attachments");
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.anything(),
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("drop case (single image): incoming drops the key — guard reinjects and warn log fires with droppedKeyCount=1", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: STORY_ID,
			title: "Existing feature",
			description: `Body\n\n${buildHtmlImage("only.png")}`,
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-001",
			version: 1,
		});
		generateObjectResults.push({
			description: "AI dropped the image entirely",
			acceptanceCriteria: undefined,
		});

		await invokeHandler();

		expect(updateStoryCalls).toHaveLength(1);
		const persisted = updateStoryCalls[0].data.description;
		expect(persisted).toContain("## Attachments");
		expect(persisted).toContain(
			`![](https://stub-bucket.local/${buildKey("only.png")}?signed=1)`,
		);
		expect(persisted).toContain(buildKey("only.png"));
		expect(mocks.getSignedUrl).toHaveBeenCalledTimes(1);
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(buildKey("only.png"), {
			bucket: "test-project-contexts-bucket",
			expiresIn: 3600,
		});
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				storyId: STORY_ID,
				projectId: PROJECT_ID,
				surface: "enhance-feature",
				targetStage: null,
				droppedKeyCount: 1,
				droppedKeys: [buildKey("only.png")],
				draftingStage: "PLACEHOLDER",
			}),
		);
	});

	it("drop case (multiple images, order preserved): k1 + k3 reinjected in insertion order under one heading", async () => {
		const html1 = buildHtmlImage("k1.png");
		const md2 = buildMarkdownImage("k2.png");
		const html3 = buildHtmlImage("k3.png");
		mocks.getStoryById.mockResolvedValue({
			id: STORY_ID,
			title: "Multi-image feature",
			description: `Intro\n\n${html1}\n\nMiddle\n\n${md2}\n\nMore\n\n${html3}`,
			acceptanceCriteria: null,
			draftingStage: "ACTIVE_ANALYSIS",
			kind: "FEATURE",
			identifier: "F-002",
			version: 3,
		});
		// AI keeps only k2 — k1 and k3 are dropped.
		generateObjectResults.push({
			description: `Rewritten body keeping middle\n\n${buildMarkdownImage("k2.png")}`,
			acceptanceCriteria: undefined,
		});

		await invokeHandler();

		expect(updateStoryCalls).toHaveLength(1);
		const persisted = updateStoryCalls[0].data.description;
		// One reinjected section, two images in original insertion order.
		expect(persisted.match(/## Attachments/g)).toHaveLength(1);
		const headingIdx = persisted.indexOf("## Attachments");
		const k1Idx = persisted.indexOf(buildKey("k1.png"), headingIdx);
		const k3Idx = persisted.indexOf(buildKey("k3.png"), headingIdx);
		expect(k1Idx).toBeGreaterThan(headingIdx);
		expect(k3Idx).toBeGreaterThan(k1Idx);
		expect(mocks.getSignedUrl).toHaveBeenCalledTimes(2);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				surface: "enhance-feature",
				targetStage: null,
				droppedKeyCount: 2,
				droppedKeys: [buildKey("k1.png"), buildKey("k3.png")],
				draftingStage: "ACTIVE_ANALYSIS",
			}),
		);
	});

	it("idempotency: re-invoke with the just-reinjected description as the new prior — no further reinjection on the second call", async () => {
		const k = buildKey("idem.png");
		// First call: prior has the image, AI drops it, guard reinjects.
		mocks.getStoryById.mockResolvedValueOnce({
			id: STORY_ID,
			title: "Idempotent feature",
			description: `Body\n\n${buildHtmlImage("idem.png")}`,
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-003",
			version: 1,
		});
		generateObjectResults.push({
			description: "AI dropped on first pass",
			acceptanceCriteria: undefined,
		});

		await invokeHandler();
		expect(updateStoryCalls).toHaveLength(1);
		const firstPersisted = updateStoryCalls[0].data.description;
		expect(firstPersisted).toContain(k);

		// Second call: the row's description now matches the previously
		// reinjected content (which itself contains the `story-media/` key
		// in `![](signed-url)` markdown form). The AI again drops the image.
		// Guard sees the same key on both sides → droppedKeys is empty.
		mocks.getStoryById.mockResolvedValueOnce({
			id: STORY_ID,
			title: "Idempotent feature",
			description: firstPersisted,
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-003",
			version: 2,
		});
		generateObjectResults.push({
			description: `Body re-rewritten keeping image\n\n![](https://example.cloudfront.net/${k}?signed=fresh)`,
			acceptanceCriteria: undefined,
		});
		mocks.loggerWarn.mockClear();
		mocks.getSignedUrl.mockClear();

		await invokeHandler();
		expect(updateStoryCalls).toHaveLength(2);
		const secondPersisted = updateStoryCalls[1].data.description;
		expect(secondPersisted.match(/## Attachments/g) ?? []).toHaveLength(0);
		expect(secondPersisted).toContain(k);
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.anything(),
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("empty prior: story.description is null — guard is a no-op regardless of incoming", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: STORY_ID,
			title: "Brand-new feature",
			description: null,
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
			identifier: "F-004",
			version: 1,
		});
		generateObjectResults.push({
			description: "AI body with no images",
			acceptanceCriteria: undefined,
		});

		await invokeHandler();

		expect(updateStoryCalls).toHaveLength(1);
		const persisted = updateStoryCalls[0].data.description;
		expect(persisted).not.toContain("## Attachments");
		expect(persisted).toBe("AI body with no images");
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.anything(),
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("key-prefix safety: prior contains a foreign-tenant key — guard skips it, logs at error, valid keys still reinject", async () => {
		const validKey = buildKey("valid.png");
		const foreignKey = "story-media/other-project/other-story/poisoned.png";
		mocks.getStoryById.mockResolvedValue({
			id: STORY_ID,
			title: "Mixed-prefix feature",
			description: `Body\n\n<img data-s3-key="${validKey}" src="x">\n\n<img data-s3-key="${foreignKey}" src="x">`,
			acceptanceCriteria: null,
			draftingStage: "SANITY_CHECK",
			kind: "FEATURE",
			identifier: "F-005",
			version: 4,
		});
		generateObjectResults.push({
			description: "AI dropped both",
			acceptanceCriteria: undefined,
		});

		await invokeHandler();

		expect(updateStoryCalls).toHaveLength(1);
		const persisted = updateStoryCalls[0].data.description;
		expect(persisted).toContain("## Attachments");
		expect(persisted).toContain(validKey);
		expect(persisted).not.toContain(foreignKey);
		expect(mocks.getSignedUrl).toHaveBeenCalledTimes(1);
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(validKey, {
			bucket: "test-project-contexts-bucket",
			expiresIn: 3600,
		});
		expect(mocks.loggerError).toHaveBeenCalledWith(
			"[stage-transition] skipped key with unexpected prefix",
			expect.objectContaining({
				storyId: STORY_ID,
				projectId: PROJECT_ID,
				surface: "enhance-feature",
				key: foreignKey,
			}),
		);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				surface: "enhance-feature",
				targetStage: null,
				droppedKeyCount: 1,
				droppedKeys: [validKey],
			}),
		);
	});

	it("sign failure: one of two keys rejects — the successful key still reinjects and procedure resolves", async () => {
		const okKey = buildKey("ok.png");
		const badKey = buildKey("bad.png");
		mocks.getStoryById.mockResolvedValue({
			id: STORY_ID,
			title: "Flaky storage feature",
			description: `Body\n\n<img data-s3-key="${okKey}" src="x">\n\n<img data-s3-key="${badKey}" src="x">`,
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
			identifier: "F-006",
			version: 5,
		});
		generateObjectResults.push({
			description: "AI body without either image",
			acceptanceCriteria: undefined,
		});
		mocks.getSignedUrl.mockImplementation(async (key: string) => {
			if (key === badKey) {
				throw new Error("simulated S3 failure");
			}
			return `https://stub-bucket.local/${key}?signed=1`;
		});

		await invokeHandler();

		expect(updateStoryCalls).toHaveLength(1);
		const persisted = updateStoryCalls[0].data.description;
		expect(persisted).toContain("## Attachments");
		expect(persisted).toContain(okKey);
		expect(persisted).not.toContain(badKey);
		expect(mocks.loggerError).toHaveBeenCalledWith(
			"[stage-transition] failed to sign dropped attachment",
			expect.objectContaining({
				storyId: STORY_ID,
				projectId: PROJECT_ID,
				surface: "enhance-feature",
				key: badKey,
				err: "simulated S3 failure",
			}),
		);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				surface: "enhance-feature",
				targetStage: null,
				droppedKeyCount: 1,
				droppedKeys: [okKey],
			}),
		);
	});
});
