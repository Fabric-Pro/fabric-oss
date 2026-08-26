/**
 * Regression coverage for Fizzy #2048 — the proposal-inbox "toggle kind before
 * approving" chain in `createStoryFromProposal`.
 *
 * The individual pieces are already covered elsewhere:
 *   - draft-body-by-kind.test.ts: per-kind Clean Spec template selection in
 *     isolation (`draftBodyByKind`).
 *   - BacklogChangeProposal.kindSelector.test.tsx: the reviewer-facing toggle
 *     UI (kindOverride construction/clearing, lazy draft-on-open, approve
 *     payload shape).
 *   - create-story-from-proposal-skip-drafting.test.ts, classify-work-item.test.ts:
 *     `skipDrafting` and the classifier helper in isolation.
 *
 * What's NOT covered anywhere else: the END-TO-END WIRING — that the reviewer's
 * final kind (passed through as `kind` + `skipClassifier: true`, exactly as
 * both approve paths call it — see
 * `packages/api/modules/projects/procedures/teams-channel-monitor/approve-pending-proposal.ts`
 * (~L831-852) and
 * `packages/temporal/src/activities/backlog-context/analyze-context.ts`
 * (~L2335-2378)) is what (a) `createStoryFromProposal`'s prompt resolution
 * uses to pick the Clean Spec template, AND (b) what lands on the persisted
 * `UserStory.kind`. This file pins that chain so it can't silently drift apart
 * (e.g. a future refactor that resolves the template off `params.kind` but
 * persists a different `effectiveKind`, or vice versa, would desync template
 * and stored kind without either half's own isolated test catching it).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		classifyWorkItem: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		getPromptById: vi.fn(),
		createStory: vi.fn(),
		createFeatureVersion: vi.fn(),
		retrieveProjectContexts: vi.fn(),
		formatContextsForPrompt: vi.fn(),
		fetchLiveIntegrationContext: vi.fn(),
		formatLiveContextForPrompt: vi.fn(),
		renderTemplate: vi.fn(),
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		projectFindUnique: vi.fn(),
		promptVersionFindFirst: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {
		constructor() {
			super("AI provider not configured");
			this.name = "AIProviderNotConfiguredError";
		}
	},
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/database", () => ({
	createFeatureVersion: mocks.createFeatureVersion,
	createStory: mocks.createStory,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		promptVersion: { findFirst: mocks.promptVersionFindFirst },
	},
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getPromptById: mocks.getPromptById,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/rag", () => ({
	formatContextsForPrompt: mocks.formatContextsForPrompt,
	retrieveProjectContexts: mocks.retrieveProjectContexts,
}));

vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: mocks.fetchLiveIntegrationContext,
	formatLiveContextForPrompt: mocks.formatLiveContextForPrompt,
}));

// `stripWorkItemTitlePrefix` / `stripLeadingDuplicateTitleHeading` are pure
// helpers consumed by the function under test — use the real implementations;
// only `renderTemplate` is mocked to avoid the template engine.
vi.mock("@repo/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/utils")>();
	return { ...actual, renderTemplate: mocks.renderTemplate };
});

vi.mock("../src/lib/classify-work-item", () => ({
	classifyWorkItem: mocks.classifyWorkItem,
}));

import {
	createStoryFromProposal,
	draftBodyByKind,
} from "../src/lib/create-story-from-proposal";

const BASE_PARAMS = {
	projectId: "proj-1",
	organizationId: "org-1",
	createdById: "user-1",
	title: "Bulk export fails silently",
	description: "Original analyzer-produced description.",
	source: "APPROVED_PROPOSAL" as const,
};

/**
 * Wires the mocks for a full successful create+draft pass targeting `kind`,
 * mirroring the fixtures in draft-body-by-kind.test.ts. Both the Clean Spec
 * agent name AND the schema shape returned by `generateObject` are matched to
 * `kind` — if the source resolved the WRONG agent, `getBoundPromptForAgent`
 * would still return content (so the run wouldn't crash) but the returned
 * `key`/schema pairing lets the assertions below catch the mismatch instead of
 * passing vacuously.
 */
function mockSuccessfulDraftFlow(kind: "FEATURE" | "BUG") {
	mocks.getBoundPromptForAgent.mockResolvedValue({
		version: { content: "TEMPLATE" },
		format: "HANDLEBARS",
		key:
			kind === "BUG"
				? "bug_clean_spec_generator"
				: "feature_clean_spec_generator",
	});
	mocks.renderTemplate.mockResolvedValue({
		rendered: "rendered prompt",
		error: null,
	});
	mocks.projectFindUnique.mockResolvedValue({
		name: "Example Project",
		description: null,
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.fetchLiveIntegrationContext.mockResolvedValue({});
	mocks.formatLiveContextForPrompt.mockReturnValue(null);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { modelId: "test-model" },
		metadata: { provider: "test" },
		trackUsage: vi.fn(),
	});
	mocks.createFeatureVersion.mockResolvedValue({ id: "ver-1" });

	if (kind === "BUG") {
		mocks.generateObject.mockResolvedValue({
			object: {
				title: undefined,
				needsMoreInfo: false,
				markdown: "## Steps to Reproduce\n1. export a large report",
			},
			usage: { totalTokens: 100 },
		});
	} else {
		mocks.generateObject.mockResolvedValue({
			object: {
				description: "Structured feature description.",
				acceptanceCriteria: "Given/When/Then",
			},
			usage: { totalTokens: 100 },
		});
	}
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createStoryFromProposal — kindOverride -> template -> persisted kind chain (Fizzy #2048)", () => {
	it("AC1: FEATURE-classified proposal, approved with a BUG override, resolves the BUG clean-spec template and persists kind BUG", async () => {
		// The classifier would say FEATURE if it ran. It must NOT run — both
		// approve paths call createStoryFromProposal with skipClassifier: true
		// exactly because the reviewer's toggle is authoritative over the
		// original AI classification.
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "FEATURE",
			confidence: "High",
			fallback_used: false,
			primary_signals: [],
			rationale: "would classify as feature if consulted",
		});
		mockSuccessfulDraftFlow("BUG");
		mocks.createStory.mockResolvedValue({
			id: "story-1",
			identifier: "F-101",
			title: BASE_PARAMS.title,
			kind: "BUG",
		});

		await createStoryFromProposal({
			...BASE_PARAMS,
			kind: "BUG",
			skipClassifier: true,
		});

		expect(mocks.classifyWorkItem).not.toHaveBeenCalled();
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "bug_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "BUG",
			}),
		);
		expect(mocks.createStory).toHaveBeenCalledOnce();
		expect(mocks.createStory.mock.calls[0]?.[0]).toMatchObject({
			kind: "BUG",
			description: expect.stringContaining("Steps to Reproduce"),
		});
	});

	it("AC2: BUG-classified proposal, approved with a FEATURE override, resolves the FEATURE clean-spec template and persists kind FEATURE", async () => {
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
			primary_signals: ["crash", "500"],
			rationale: "would classify as bug if consulted",
		});
		mockSuccessfulDraftFlow("FEATURE");
		mocks.createStory.mockResolvedValue({
			id: "story-2",
			identifier: "F-102",
			title: BASE_PARAMS.title,
			kind: "FEATURE",
		});

		await createStoryFromProposal({
			...BASE_PARAMS,
			kind: "FEATURE",
			skipClassifier: true,
		});

		expect(mocks.classifyWorkItem).not.toHaveBeenCalled();
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "FEATURE",
			}),
		);
		expect(mocks.createStory).toHaveBeenCalledOnce();
		expect(mocks.createStory.mock.calls[0]?.[0]).toMatchObject({
			kind: "FEATURE",
			description: "Structured feature description.",
			acceptanceCriteria: "Given/When/Then",
		});
	});

	it("AC3: each call is decided solely by the kindOverride it was given — no earlier toggle leaks in, and skipClassifier always skips the classifier", async () => {
		// Multiple toggles before approval are resolved entirely CLIENT-SIDE:
		// BacklogChangeProposal caches a drafted body per (change index, kind) and
		// sends only the reviewer's FINAL kindOverride on approve — see
		// BacklogChangeProposal.kindSelector.test.tsx ("flipping sends
		// kindOverride" / "flipping back strips it"). There is no multi-toggle
		// STATE on the server to assert on: createStoryFromProposal is invoked
		// exactly once per approval, with exactly one kind. So what this test
		// honestly pins is the server-side property that actually exists —
		// createStoryFromProposal is stateless per call, never re-runs the
		// classifier when skipClassifier is set, and one call's override cannot
		// bleed into another's. Proven by driving it with two back-to-back,
		// oppositely-kinded calls (as if a reviewer had toggled feature -> bug ->
		// feature -> bug, and the final approved state were the second call).
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "FEATURE",
			confidence: "High",
			fallback_used: false,
			primary_signals: [],
			rationale: "should never be consulted in this test",
		});

		mockSuccessfulDraftFlow("FEATURE");
		mocks.createStory.mockResolvedValueOnce({
			id: "story-3a",
			identifier: "F-103",
			title: BASE_PARAMS.title,
			kind: "FEATURE",
		});
		await createStoryFromProposal({
			...BASE_PARAMS,
			kind: "FEATURE",
			skipClassifier: true,
		});

		mockSuccessfulDraftFlow("BUG");
		mocks.createStory.mockResolvedValueOnce({
			id: "story-3b",
			identifier: "F-104",
			title: BASE_PARAMS.title,
			kind: "BUG",
		});
		await createStoryFromProposal({
			...BASE_PARAMS,
			kind: "BUG",
			skipClassifier: true,
		});

		expect(mocks.classifyWorkItem).not.toHaveBeenCalled();
		expect(mocks.createStory).toHaveBeenCalledTimes(2);
		expect(mocks.createStory.mock.calls[0]?.[0]).toMatchObject({
			kind: "FEATURE",
		});
		expect(mocks.createStory.mock.calls[1]?.[0]).toMatchObject({
			kind: "BUG",
		});
		expect(mocks.getBoundPromptForAgent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
			}),
		);
		expect(mocks.getBoundPromptForAgent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ agentName: "bug_clean_spec_generator" }),
		);
	});

	it("AC4: no reviewer override — the classifier's own kind decides, overriding any caller-supplied hint, and skipClassifier is not set", async () => {
		// Unopened / bulk-approved creates pass a `kind` HINT derived from
		// `change.type` but do NOT set skipClassifier (see
		// approve-pending-proposal.ts's `effectiveKindHint` +
		// `skipClassifier: overrideKind !== undefined`). Today's unchanged
		// behavior is classifier-first: the hint loses to the classifier.
		mocks.classifyWorkItem.mockResolvedValue({
			kind: "BUG",
			confidence: "High",
			fallback_used: false,
			primary_signals: ["crash"],
			rationale: "classifier disagrees with the hint",
		});
		mockSuccessfulDraftFlow("BUG");
		mocks.createStory.mockResolvedValue({
			id: "story-4",
			identifier: "F-105",
			title: BASE_PARAMS.title,
			kind: "BUG",
		});

		await createStoryFromProposal({
			...BASE_PARAMS,
			kind: "FEATURE", // hint only — no reviewer override, no skipClassifier
		});

		expect(mocks.classifyWorkItem).toHaveBeenCalledOnce();
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "bug_clean_spec_generator",
				storyKind: "BUG",
			}),
		);
		expect(mocks.createStory.mock.calls[0]?.[0]).toMatchObject({
			kind: "BUG",
		});
	});

	it("AC5: reformatting a proposal body for a new kind (draftBodyByKind) never creates or updates a work item, even across repeated toggles", async () => {
		// `reformatProposalBody` (packages/api/.../stories/reformat-proposal-body.ts)
		// is a thin wrapper over this exact `draftBodyByKind` helper — "this does
		// NOT create or persist a story" per its own doc comment. Asserting here,
		// at the shared helper, pins the guarantee both the toggle-preview path
		// and any future caller inherit. `draftBodyByKind` has no update call site
		// at all (only reads db.project + retrieves RAG context + drafts), so the
		// two persisting entry points in this module — createStory and
		// createFeatureVersion — are the complete surface to assert against.
		mockSuccessfulDraftFlow("BUG");
		await draftBodyByKind({
			projectId: "proj-1",
			organizationId: "org-1",
			userId: "user-1",
			kind: "BUG",
			title: BASE_PARAMS.title,
			description: "raw",
		});

		mockSuccessfulDraftFlow("FEATURE");
		await draftBodyByKind({
			projectId: "proj-1",
			organizationId: "org-1",
			userId: "user-1",
			kind: "FEATURE",
			title: BASE_PARAMS.title,
			description: "raw",
		});

		mockSuccessfulDraftFlow("BUG");
		await draftBodyByKind({
			projectId: "proj-1",
			organizationId: "org-1",
			userId: "user-1",
			kind: "BUG",
			title: BASE_PARAMS.title,
			description: "raw",
		});

		expect(mocks.createStory).not.toHaveBeenCalled();
		expect(mocks.createFeatureVersion).not.toHaveBeenCalled();
	});
});
