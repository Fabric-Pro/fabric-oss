/**
 * Wiring tests for the Create-vs-Enrich routing pass inside
 * `analyzeContextAndPropose`.
 *
 * The routing algorithm itself is covered in
 * `src/activities/backlog-context/__tests__/route-action-items.test.ts`. What
 * matters here is the wiring, which is where this feature can silently break in
 * two directions:
 *
 *   - routing must be OFF by default, so every existing caller (AI Update, the
 *     document analyzer, Azure DevOps sync, and any capture-as-is flow in a
 *     project that has not opted in) is byte-for-byte unaffected;
 *   - a routed enrichment must still reach the structure-preserving merge,
 *     which is what keeps the review diff honest and stops the enrichment from
 *     reformatting the ticket it lands on.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/analyze-context-routing.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		heartbeat: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		routeActionItems: vi.fn(),
		reanalyzeBodyByKind: vi.fn(),
		findManyUserStory: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: mocks.heartbeat }));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: vi.fn() },
		userStory: { findMany: mocks.findManyUserStory },
	},
	tenantWhere: vi.fn(() => ({ organizationId: "org-1", userId: "user-1" })),
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	TERMINAL_DRAFTING_STAGES: ["CLOSED", "DECLINED"],
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/activities/backlog-context/route-action-items", () => ({
	routeActionItemsToExistingTickets: mocks.routeActionItems,
}));

vi.mock("../src/lib/reanalyze-body-by-kind", () => ({
	reanalyzeBodyByKind: mocks.reanalyzeBodyByKind,
}));

import { analyzeContextAndPropose } from "../src/activities/backlog-context/analyze-context";

const BACKLOG = {
	epics: [],
	features: [],
	stories: [
		{
			id: "story-1",
			identifier: "F-12",
			title: "Export throttling",
			description: "Exports need a queue.",
		},
	],
};

const CAPTURED_CREATE = {
	type: "feature" as const,
	action: "create" as const,
	title: { to: "Rate limit the export endpoint" },
	description: { to: "Large exports lock the worker." },
	reasoning: "Raised twice",
	sourceContext: "meeting_transcript" as const,
};

const BASE_INPUT = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	fetchedContext: { meetingTranscripts: ["some discussion"] },
	existingBacklog: BACKLOG,
	userPrompt: "Analyze",
	allowEpics: false,
	allowUpdates: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getBoundPromptForAgent.mockResolvedValue(null);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "test-model" },
		metadata: { modelString: "anthropic:claude-test" },
		trackUsage: vi.fn(),
	});
	mocks.generateObject.mockResolvedValue({
		object: {
			summary: "",
			contextSummary: "",
			changes: [{ ...CAPTURED_CREATE }],
		},
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	});
	mocks.findManyUserStory.mockResolvedValue([
		{
			id: "story-1",
			kind: "FEATURE",
			title: "Export throttling",
			identifier: "F-12",
			description: "Exports need a queue.",
			acceptanceCriteria: null,
		},
	]);
	mocks.reanalyzeBodyByKind.mockResolvedValue({
		description: "Exports need a queue.\n\nAlso rate limit the endpoint.",
		acceptanceCriteria: undefined,
		fallbackUsed: false,
	});
});

describe("allowRouting wiring", () => {
	it("does not run routing by default — every existing caller is unaffected", async () => {
		await analyzeContextAndPropose({ ...BASE_INPUT });

		expect(mocks.routeActionItems).not.toHaveBeenCalled();
	});

	it("does not run routing for the AI Update path either", async () => {
		await analyzeContextAndPropose({
			...BASE_INPUT,
			allowUpdates: true,
			deferDecisionPrecheck: true,
		});

		expect(mocks.routeActionItems).not.toHaveBeenCalled();
	});

	it("runs routing for a flow that permits it", async () => {
		mocks.routeActionItems.mockResolvedValue({
			changes: [{ ...CAPTURED_CREATE }],
			enriched: 0,
			created: 1,
			failed: 0,
		});

		await analyzeContextAndPropose({
			...BASE_INPUT,
			allowRouting: true,
		});

		expect(mocks.routeActionItems).toHaveBeenCalledOnce();
		const arg = mocks.routeActionItems.mock.calls[0][0];
		expect(arg.projectId).toBe("project-1");
		// Routing sees the create-only proposal, after the capture-as-is drop.
		expect(arg.changes).toHaveLength(1);
		expect(arg.changes[0].action).toBe("create");
	});

	it("sends a routed enrichment through the structure-preserving merge", async () => {
		mocks.routeActionItems.mockResolvedValue({
			changes: [
				{
					...CAPTURED_CREATE,
					action: "update" as const,
					existingId: "story-1",
					existingIdentifier: "F-12",
					title: {
						from: "Export throttling",
						to: "Export throttling",
					},
					description: {
						from: "Exports need a queue.",
						to: "Large exports lock the worker.",
					},
					routing: {
						decision: "enrich" as const,
						confidence: 0.9,
						matchedStoryId: "story-1",
						matchedIdentifier: "F-12",
					},
				},
			],
			enriched: 1,
			created: 0,
			failed: 0,
		});

		const proposal = await analyzeContextAndPropose({
			...BASE_INPUT,
			allowRouting: true,
		});

		// Without this the enrichment would replace the ticket's body with the
		// action item's text instead of merging into it — the exact regression
		// the structure-preserving pass exists to prevent — and the review diff
		// would read as a wholesale rewrite.
		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		const change = proposal.changes[0];
		expect(change.description?.from).toBe("Exports need a queue.");
		expect(change.description?.to).toContain(
			"Also rate limit the endpoint.",
		);
		expect(change.structurePreserved).toBe(true);
	});

	it("reconciles the routing stamp when a routed enrichment is demoted", async () => {
		// The backlog snapshot resolution runs against a 60s TTL cache, so a
		// routed target can be missing from it. The demotion must take the
		// routing stamp with it, or the row claims both "new item, no existing
		// match" and "enriching F-99" at once.
		mocks.routeActionItems.mockResolvedValue({
			changes: [
				{
					...CAPTURED_CREATE,
					action: "update" as const,
					existingId: "story-not-in-snapshot",
					existingIdentifier: "F-99",
					routing: {
						decision: "enrich" as const,
						confidence: 0.9,
						matchedStoryId: "story-not-in-snapshot",
						matchedIdentifier: "F-99",
						matchedTitle: "Vanished",
					},
				},
			],
			enriched: 1,
			created: 0,
			failed: 0,
		});

		const proposal = await analyzeContextAndPropose({
			...BASE_INPUT,
			allowRouting: true,
		});

		const change = proposal.changes[0];
		expect(change.action).toBe("create");
		expect(change.targetResolution?.demotedFromUpdate).toBe(true);
		expect(change.routing?.decision).toBe("create");
		expect(change.routing?.matchedIdentifier).toBeNull();
	});

	it("does not invoke the merge when routing produced no enrichment", async () => {
		mocks.routeActionItems.mockResolvedValue({
			changes: [{ ...CAPTURED_CREATE }],
			enriched: 0,
			created: 1,
			failed: 0,
		});

		await analyzeContextAndPropose({
			...BASE_INPUT,
			allowRouting: true,
		});

		expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
	});

	it("keeps the analyzer itself create-only, so routing decides enrichment alone", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				summary: "",
				contextSummary: "",
				changes: [
					{ ...CAPTURED_CREATE },
					{
						...CAPTURED_CREATE,
						action: "update" as const,
						existingIdentifier: "F-12",
						title: { to: "Model tried to update" },
					},
				],
			},
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});
		mocks.routeActionItems.mockImplementation(
			async ({ changes }: { changes: unknown[] }) => ({
				changes,
				enriched: 0,
				created: changes.length,
				failed: 0,
			}),
		);

		await analyzeContextAndPropose({
			...BASE_INPUT,
			allowRouting: true,
		});

		// The model-emitted update is dropped BEFORE routing sees it: enabling
		// routing must not quietly re-admit the analyzer's own unreliable
		// update suggestions through the back door.
		const arg = mocks.routeActionItems.mock.calls[0][0];
		expect(arg.changes).toHaveLength(1);
		expect(arg.changes[0].title.to).toBe("Rate limit the export endpoint");
	});
});
