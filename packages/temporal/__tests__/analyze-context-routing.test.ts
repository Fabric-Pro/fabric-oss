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
 *   pnpm --filter @repo/temporal exec vitest run __tests__/analyze-context-routing.test.ts
 */

import { logger } from "@repo/logs";
import { asSchema } from "ai";
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
		decide: vi.fn(),
		getAIDecisionModelWithMetadata: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
	// The routing pass's optional decision fast path. These wiring tests run
	// with NO organization decision model configured, so the analyzer's
	// behaviour here is the unchanged, language-model one — asserted rather
	// than left to the routing module being mocked out below.
	experimental_decide: mocks.decide,
	getAIDecisionModelWithMetadata: mocks.getAIDecisionModelWithMetadata,
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	heartbeat: mocks.heartbeat,
	Context: {
		current: () => ({
			info: { workflowExecution: { workflowId: "example-workflow" } },
		}),
	},
}));

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
	// No organization decision model: the routing pass's typed fast path is
	// unavailable, which is the configuration every one of these wiring
	// assertions is written against.
	mocks.getAIDecisionModelWithMetadata.mockRejectedValue(
		new Error(
			"Decision evaluation requires this organization's configured Vercel AI Gateway provider.",
		),
	);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "test-model" },
		metadata: { modelString: "anthropic:claude-test" },
		trackUsage: vi.fn(),
	});
	mocks.generateObject.mockResolvedValue({
		object: {
			summary: "Capture export improvements.",
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

function modelResponse(value: unknown) {
	mocks.generateObject.mockImplementation(async ({ schema }) => {
		const parsed = await asSchema(schema).validate?.(value);
		if (!parsed?.success) {
			throw parsed?.error ?? new Error("No schema validator");
		}
		return { object: parsed.value, usage: {} };
	});
}

describe("allowRouting wiring", () => {
	it("warns about discarded elements when the whole response fails validation", async () => {
		modelResponse({
			summary: 42,
			changes: [CAPTURED_CREATE, { type: "feature", action: "create" }],
		});
		await expect(
			analyzeContextAndPropose({
				...BASE_INPUT,
				deferDecisionPrecheck: true,
			}),
		).rejects.toThrow();
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			"[Backlog Analysis] Discarded malformed changes from the model response",
			{
				discarded: 1,
				kept: 1,
				details: [
					{
						index: 1,
						action: "create",
						type: "feature",
						issues: "title:invalid_type:undefined",
					},
				],
			},
		);
	});

	it("excludes parse-time and unresolved-title update discards from create-only retry notes", async () => {
		modelResponse({
			summary: "Captured",
			changes: [
				CAPTURED_CREATE,
				{ ...CAPTURED_CREATE, action: "update", priority: 42 },
				{
					type: "feature",
					action: "update",
					existingIdentifier: "F-999",
				},
			],
		});
		const proposal = await analyzeContextAndPropose({
			...BASE_INPUT,
			deferDecisionPrecheck: true,
		});
		expect(proposal.summary).toBe("Captured");
		expect(proposal.changes).toEqual([CAPTURED_CREATE]);
		expect(logger.warn).toHaveBeenCalledWith(
			"[Backlog Analysis] Discarded malformed changes from the model response",
			expect.objectContaining({
				discarded: 2,
				kept: 1,
				details: [
					expect.objectContaining({ index: 1, action: "update" }),
					expect.objectContaining({
						index: 2,
						action: "update",
						issues: "title:missing_unresolved_target:undefined",
					}),
				],
			}),
		);
	});

	it.each([2, 12])(
		"counts only retryable create discards despite %s policy-rejected updates",
		async (count) => {
			modelResponse({
				summary: "Captured",
				changes: [
					CAPTURED_CREATE,
					...Array.from({ length: count }, () => ({
						...CAPTURED_CREATE,
						action: "update",
						priority: 42,
					})),
					{ type: "bug", action: "create" },
				],
			});
			const proposal = await analyzeContextAndPropose({
				...BASE_INPUT,
				deferDecisionPrecheck: true,
			});
			expect(proposal.summary).toBe(
				"Captured\n\n1 proposed change(s) could not be read from the AI response and were left out.",
			);
			expect(logger.warn).toHaveBeenCalledWith(
				"[Backlog Analysis] Discarded malformed changes from the model response",
				expect.objectContaining({ discarded: count + 1, kept: 1 }),
			);
		},
	);

	it.each(
		[true, false].flatMap((allowUpdates) =>
			["", "  "].map((summary) => ({ allowUpdates, summary })),
		),
	)(
		"preserves blank-summary behavior for allowUpdates=$allowUpdates, summary=$summary",
		async ({ allowUpdates, summary }) => {
			modelResponse({
				summary,
				changes: [
					CAPTURED_CREATE,
					{ type: "bug", action: "create" },
					{
						type: "feature",
						action: "update",
						existingIdentifier: "F-999",
					},
				],
			});
			const proposal = await analyzeContextAndPropose({
				...BASE_INPUT,
				allowUpdates,
				deferDecisionPrecheck: true,
			});
			expect(proposal.summary).toBe(
				allowUpdates
					? "Analysis complete. 1 change(s) proposed.\n\n2 proposed change(s) could not be read from the AI response and were left out. Run the analysis again to retry them."
					: summary,
			);
			expect(logger.warn).toHaveBeenCalledWith(
				"[Backlog Analysis] Discarded malformed changes from the model response",
				expect.objectContaining({ discarded: 2, kept: 1 }),
			);
		},
	);

	it("logs one aggregate fill count across reference strategies", async () => {
		const target = {
			...BACKLOG.stories[0],
			id: "ckaaaaaaaaaaaaaaaaaaaaaaa",
			externalId: "external-1",
		};
		modelResponse({
			changes: [
				{ type: "feature", action: "update", existingId: target.id },
				{
					type: "bug",
					action: "update",
					existingIdentifier: target.identifier,
				},
				{
					type: "feature",
					action: "update",
					existingExternalId: target.externalId,
				},
			],
		});
		const proposal = await analyzeContextAndPropose({
			...BASE_INPUT,
			existingBacklog: { stories: [target] },
			allowUpdates: true,
			deferDecisionPrecheck: true,
		});
		expect(proposal.changes).toHaveLength(3);
		const fills = vi
			.mocked(logger.info)
			.mock.calls.filter(
				([message]) =>
					message ===
					"[Backlog Analysis] Filled unchanged update titles from backlog targets",
			);
		expect(fills).toEqual([
			[
				"[Backlog Analysis] Filled unchanged update titles from backlog targets",
				{
					count: 3,
					resolvedBy: { id: 1, identifier: 1, externalId: 1 },
				},
			],
		]);
	});

	it.each(
		["id", "identifier", "externalId"].flatMap((resolvedBy) =>
			[undefined, null, { to: null }].map((title) => ({
				resolvedBy,
				title,
			})),
		),
	)(
		"fills omitted title $title by $resolvedBy before routing and structure preservation",
		async ({ resolvedBy, title }) => {
			const target = {
				...BACKLOG.stories[0],
				id: "ckaaaaaaaaaaaaaaaaaaaaaaa",
				externalId: "external-1",
			};
			const reference =
				resolvedBy === "id"
					? { existingId: target.id }
					: resolvedBy === "identifier"
						? { existingIdentifier: target.identifier }
						: { existingExternalId: target.externalId };
			const change = {
				...CAPTURED_CREATE,
				action: "update",
				...reference,
				title,
			};
			modelResponse({ summary: "Updates", changes: [change] });
			mocks.findManyUserStory.mockResolvedValue([
				{ ...target, kind: "FEATURE", acceptanceCriteria: null },
			]);
			mocks.routeActionItems.mockImplementation(async ({ changes }) => {
				expect(changes).toHaveLength(1);
				expect(changes[0].title).toEqual({
					from: target.title,
					to: target.title,
				});
				return { changes, enriched: 0 };
			});
			const proposal = await analyzeContextAndPropose({
				...BASE_INPUT,
				existingBacklog: { ...BACKLOG, stories: [target] },
				allowUpdates: true,
				allowRouting: true,
				deferDecisionPrecheck: true,
			});
			expect(proposal.changes).toHaveLength(1);
			expect(proposal.changes[0]).toMatchObject({
				action: "update",
				title: { from: target.title, to: target.title },
				targetResolution: { status: "resolved" },
				structurePreserved: true,
			});
			expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
			expect(logger.info).toHaveBeenCalledWith(
				"[Backlog Analysis] Filled unchanged update titles from backlog targets",
				{ count: 1, resolvedBy: { [resolvedBy]: 1 } },
			);
			expect(logger.warn).not.toHaveBeenCalledWith(
				"[Backlog Analysis] Discarded malformed changes from the model response",
				expect.anything(),
			);
		},
	);

	it.each([
		"no reference",
		"unknown identifier",
		"empty snapshot",
		"empty target title",
	])(
		"drops title-less updates with %s without demoting them",
		async (scenario) => {
			modelResponse({
				summary: "Updates",
				changes: [
					CAPTURED_CREATE,
					{
						type: "feature",
						action: "update",
						...(scenario === "no reference"
							? {}
							: {
									existingIdentifier:
										scenario === "unknown identifier"
											? "F-999"
											: "F-12",
								}),
					},
				],
			});
			const proposal = await analyzeContextAndPropose({
				...BASE_INPUT,
				existingBacklog:
					scenario === "empty snapshot"
						? { stories: [] }
						: scenario === "empty target title"
							? {
									...BACKLOG,
									stories: [
										{ ...BACKLOG.stories[0], title: "" },
									],
								}
							: BACKLOG,
				allowUpdates: true,
				deferDecisionPrecheck: true,
			});
			expect(proposal.changes).toEqual([CAPTURED_CREATE]);
			expect(proposal.summary).toContain(
				"1 proposed change(s) could not be read",
			);
			expect(logger.warn).toHaveBeenCalledWith(
				"[Backlog Analysis] Discarded malformed changes from the model response",
				{
					discarded: 1,
					kept: 1,
					details: [
						{
							index: 1,
							action: "update",
							type: "feature",
							issues: "title:missing_unresolved_target:undefined",
						},
					],
				},
			);
			expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
		},
	);

	it("combines parse discards and unresolved titles with original response indices and preserves a blank summary's count", async () => {
		modelResponse({
			summary: " ",
			changes: [
				CAPTURED_CREATE,
				{
					type: "feature",
					action: "update",
					existingIdentifier: "F-999",
				},
				{ type: "bug", action: "create" },
				{ ...CAPTURED_CREATE, title: { to: "Another item" } },
			],
		});
		const proposal = await analyzeContextAndPropose({
			...BASE_INPUT,
			allowUpdates: true,
			deferDecisionPrecheck: true,
		});
		expect(proposal.summary).toBe(
			"Analysis complete. 2 change(s) proposed.\n\n2 proposed change(s) could not be read from the AI response and were left out. Run the analysis again to retry them.",
		);
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			"[Backlog Analysis] Discarded malformed changes from the model response",
			{
				discarded: 2,
				kept: 2,
				details: [
					{
						index: 1,
						action: "update",
						type: "feature",
						issues: "title:missing_unresolved_target:undefined",
					},
					{
						index: 2,
						action: "create",
						type: "bug",
						issues: "title:invalid_type:undefined",
					},
				],
			},
		);
	});

	it("preserves a real update title without filling it", async () => {
		const title = {
			from: "Export throttling",
			to: "Improved export throttling",
		};
		modelResponse({
			summary: "Updates",
			changes: [
				{
					...CAPTURED_CREATE,
					action: "update",
					existingIdentifier: "F-12",
					title,
				},
			],
		});
		const proposal = await analyzeContextAndPropose({
			...BASE_INPUT,
			allowUpdates: true,
			deferDecisionPrecheck: true,
		});
		expect(proposal.changes[0]?.title).toEqual(title);
		expect(proposal.summary).toBe("Updates");
		expect(logger.info).not.toHaveBeenCalledWith(
			"[Backlog Analysis] Filled unchanged update titles from backlog targets",
			expect.anything(),
		);
	});

	it("does not share discard counts between successive activity calls", async () => {
		modelResponse({ summary: "Partial", changes: [null, CAPTURED_CREATE] });
		const partial = await analyzeContextAndPropose({
			...BASE_INPUT,
			deferDecisionPrecheck: true,
		});
		modelResponse({ summary: "Clean", changes: [CAPTURED_CREATE] });
		const clean = await analyzeContextAndPropose({
			...BASE_INPUT,
			deferDecisionPrecheck: true,
		});
		expect(partial.summary).toContain(
			"1 proposed change(s) could not be read",
		);
		expect(clean.summary).toBe("Clean");
	});

	it.each([false, true])(
		"retains the discarded-change summary note with routing %s",
		async (allowRouting) => {
			modelResponse({
				summary: "Capture export improvements.",
				changes: [
					CAPTURED_CREATE,
					{ type: "feature", action: "create", title: null },
				],
			});
			mocks.routeActionItems.mockImplementation(async ({ changes }) => ({
				changes,
				enriched: 0,
			}));
			const proposal = await analyzeContextAndPropose({
				...BASE_INPUT,
				allowRouting,
				deferDecisionPrecheck: true,
			});
			expect(proposal.changes).toHaveLength(1);
			expect(proposal.summary).toBe(
				"Capture export improvements.\n\n1 proposed change(s) could not be read from the AI response and were left out.",
			);
		},
	);

	it.each([undefined, false])(
		"does not run routing when allowRouting is %s",
		async (allowRouting) => {
			const proposal = await analyzeContextAndPropose({
				...BASE_INPUT,
				allowRouting,
			});
			expect(proposal.summary).toBe("Capture export improvements.");

			expect(mocks.routeActionItems).not.toHaveBeenCalled();
		},
	);

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
		expect(proposal.summary).toBe(
			"1 proposed item was matched to existing work item (F-12) and will update it.\n\nCapture export improvements.",
		);
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
		expect(proposal.summary).toBe("Capture export improvements.");
	});

	it("does not invoke the merge when routing produced no enrichment", async () => {
		mocks.routeActionItems.mockResolvedValue({
			changes: [{ ...CAPTURED_CREATE }],
			enriched: 0,
			created: 1,
			failed: 0,
		});

		const proposal = await analyzeContextAndPropose({
			...BASE_INPUT,
			allowRouting: true,
		});

		expect(proposal.summary).toBe("Capture export improvements.");
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
