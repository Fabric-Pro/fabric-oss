/**
 * Tests for the APPLY-TIME structure-preserving merge in applyBacklogChanges —
 * the guaranteed choke point that covers updates which bypassed the analysis
 * pass (e.g. the chat agent's "skip analysis" shortcut).
 *
 * Contract:
 *  - An UPDATE that changes the body and is NOT flagged `structurePreserved`
 *    runs reanalyzeBodyByKind and persists the MERGED body.
 *  - An UPDATE already flagged `structurePreserved` (merged at analysis time)
 *    does NOT re-run the merge (no double LLM call) and persists its body as-is.
 *  - On a merge fallback the existing body is kept with the update's new
 *    detail appended unchanged (no write when it adds nothing), and
 *    `bodyMergeFallback` is stamped.
 *  - The merge uses the item's TRUE DB kind (type-aware).
 *  - Fizzy #2048: the defensive `detectDestructiveRewrite` guard below the
 *    merge used to short-circuit to "not destructive" for FEATURE updates —
 *    only BUG updates were checked. It now runs unconditionally for both
 *    kinds, so a FEATURE update can be refused too (empty/collapsed output,
 *    or a rewrite that drops the narrative section signature), while a
 *    normal, substantial feature rewrite must still go through untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		createStoryFromProposal: vi.fn(),
		createStory: vi.fn(),
		updateStory: vi.fn(),
		tenantWhere: vi.fn(() => ({
			organizationId: "org-1",
			userId: "user-1",
		})),
		dbProjectFindFirst: vi.fn(),
		dbUserStoryFindMany: vi.fn(),
		dbUserStoryFindFirst: vi.fn(),
		generateText: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		recordAudit: vi.fn(),
		heartbeat: vi.fn(),
		applications: vi.fn(),
		transaction: vi.fn(),
		recordProposalApplication: vi.fn(),
		findAiConfigurationRefusal: vi.fn(),
		current: vi.fn(() => {
			throw new Error("outside activity");
		}),
		reanalyzeBodyByKind: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	Output: { object: (spec: unknown) => spec },
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.dbProjectFindFirst },
		pendingBacklogProposalApplication: { findMany: mocks.applications },
		pendingBacklogProposal: { findUnique: vi.fn(async () => null) },
		$transaction: mocks.transaction,
		userStory: {
			findMany: mocks.dbUserStoryFindMany,
			findFirst: mocks.dbUserStoryFindFirst,
		},
	},
	tenantWhere: mocks.tenantWhere,
	createStory: mocks.createStory,
	updateStory: mocks.updateStory,
	recordAudit: mocks.recordAudit,
	recordProposalDuplicateResolution: vi.fn(),
	recordProposalApplication: mocks.recordProposalApplication,
	normalizeBacklogTitle: (title: string) =>
		title
			.toLowerCase()
			.trim()
			.replace(/^\[bug\]\s+/i, "")
			.trim(),
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
	isTerminalWorkItemState: (item: {
		draftingStage: string;
		pmAutoHidden: boolean;
	}) =>
		["DECLINED", "CLOSED"].includes(item.draftingStage) ||
		item.pmAutoHidden === true,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	heartbeat: mocks.heartbeat,
	Context: { current: mocks.current },
}));
vi.mock("../src/lib/ai-configuration-refusal", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/lib/ai-configuration-refusal")
	>()),
	findAiConfigurationRefusal: mocks.findAiConfigurationRefusal,
}));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

vi.mock("../src/lib/reanalyze-body-by-kind", () => ({
	reanalyzeBodyByKind: mocks.reanalyzeBodyByKind,
}));

vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({ workflowId: "dup-test" })),
}));

import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";

import {
	applyBacklogChanges,
	type ChangeProposal,
} from "../src/activities/backlog-context/analyze-context";

// Valid Fabric CUID so the update path bypasses resolveBacklogUpdateTarget and
// proceeds straight to the update branch (fetch existing row → merge → write).
const STORY_ID = "cmstructmerge0000000000001";

const EXISTING_BUG_BODY =
	"## Steps to Reproduce\n1. Open /login\n2. Click sign in\n## Expected Result\nSigned in.\n## Actual Result\nNothing.\n## Original Description from User (Do Not Modify)\nlogin broken";

function makeUpdate(
	overrides: Record<string, unknown> = {},
): ChangeProposal["changes"][number] {
	return {
		action: "update" as const,
		type: "bug" as const,
		existingId: STORY_ID,
		existingIdentifier: "F-009",
		title: { from: "Login fails", to: "Login fails" },
		description: {
			from: "stale snapshot",
			to: "analyzer generic regenerated body",
		},
		acceptanceCriteria: undefined,
		priority: undefined,
		size: undefined,
		reasoning: "root cause confirmed",
		sourceContext: "test fixture",
		...overrides,
	} as unknown as ChangeProposal["changes"][number];
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.reanalyzeBodyByKind.mockReset();
	mocks.current.mockImplementation(() => {
		throw new Error("outside activity");
	});
	mocks.applications.mockResolvedValue([]);
	mocks.transaction.mockImplementation(async (fn) => fn({}));
	mocks.dbProjectFindFirst.mockResolvedValue({ id: "project-1" });
	mocks.dbUserStoryFindMany.mockResolvedValue([]);
	mocks.dbUserStoryFindFirst.mockResolvedValue({
		kind: "BUG",
		title: "Login fails",
		identifier: "F-009",
		description: EXISTING_BUG_BODY,
		acceptanceCriteria: "",
		labels: ["bug"],
	});
	mocks.updateStory.mockResolvedValue({ id: STORY_ID });
});

async function run(change: ChangeProposal["changes"][number]) {
	return applyBacklogChanges({
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		approvedChanges: [change],
		existingBacklog: { stories: [] },
	});
}

function lastUpdateData() {
	const call = mocks.updateStory.mock.calls.at(-1);
	return (call?.[2] ?? {}) as { description?: string; title?: string };
}

describe("applyBacklogChanges → apply-time structure-preserving merge", () => {
	afterEach(() => vi.useRealTimers());

	it.each(["deadline", "cancellation"] as const)(
		"rejects on %s mid-merge without completing that change",
		async (stop) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			mocks.current.mockReturnValue({
				info: {
					currentAttemptScheduledTimestampMs: Date.now(),
					startToCloseTimeoutMs: 61_000,
				},
				cancellationSignal: controller.signal,
			} as never);
			mocks.reanalyzeBodyByKind.mockImplementationOnce(
				({ abortSignal }) =>
					new Promise((resolve) => {
						abortSignal.addEventListener(
							"abort",
							() =>
								resolve({
									fallbackUsed: true,
									fallbackReason: "aborted",
									description: EXISTING_BUG_BODY,
								}),
							{ once: true },
						);
					}),
			);
			const earlier = makeUpdate({
				description: undefined,
				title: { from: "Login fails", to: "Earlier title" },
			});
			const interrupted = makeUpdate({
				title: { from: "Login fails", to: "Interrupted title" },
			});
			const pending = applyBacklogChanges({
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				proposalId: "proposal-1",
				approvedChanges: [earlier, interrupted],
				existingBacklog: { stories: [] },
			});
			const failure = pending.then(
				() => undefined,
				(error) => error,
			);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(
				mocks.heartbeat.mock.calls.filter(
					([arg]) => typeof arg === "object" && arg.keepalive,
				),
			).toHaveLength(2);
			if (stop === "deadline") {
				await vi.advanceTimersByTimeAsync(1_000);
			} else {
				controller.abort();
			}
			const error = await failure;
			if (stop === "deadline") {
				expect(error).toBeInstanceOf(ApplicationFailure);
				expect(error).toMatchObject({
					type: "ApplyMergeDeadline",
					nonRetryable: false,
				});
			} else {
				expect(error).toBeInstanceOf(CancelledFailure);
			}
			expect(mocks.updateStory).toHaveBeenCalledTimes(1);
			expect(lastUpdateData().title).toBe("Earlier title");
			expect(mocks.recordProposalApplication).toHaveBeenCalledTimes(1);
			expect(mocks.recordProposalApplication).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ changeIndex: 0 }),
			);
			expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
			expect(mocks.findAiConfigurationRefusal).not.toHaveBeenCalled();
			expect(interrupted.bodyMergeFallback).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["update", "create"] as const)(
		"stops before starting a %s when its deadline has already fired",
		async (action) => {
			mocks.reanalyzeBodyByKind.mockResolvedValue({
				fallbackUsed: true,
				description: EXISTING_BUG_BODY,
			});
			mocks.current.mockReturnValue({
				info: {
					currentAttemptScheduledTimestampMs: Date.now() - 60_000,
					startToCloseTimeoutMs: 60_000,
				},
				cancellationSignal: new AbortController().signal,
			} as never);
			await expect(run(makeUpdate({ action }))).rejects.toMatchObject({
				type: "ApplyMergeDeadline",
				nonRetryable: false,
			});
			expect(mocks.dbUserStoryFindFirst).not.toHaveBeenCalled();
			expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
			expect(mocks.updateStory).not.toHaveBeenCalled();
			expect(mocks.recordProposalApplication).not.toHaveBeenCalled();
			expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
			expect(mocks.findAiConfigurationRefusal).not.toHaveBeenCalled();
		},
	);

	it("merges an unflagged update through reanalyzeBodyByKind and persists the merged body", async () => {
		const merged =
			"## Steps to Reproduce\n1. Open /login\n2. Click sign in\n## Root Cause\nNull form ref.\n## Actual Result\nNothing.\n## Original Description from User (Do Not Modify)\nlogin broken";
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: merged,
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});

		// The merge writes only text the update holds: here, its root cause.
		await run(
			makeUpdate({
				description: {
					from: "stale snapshot",
					to: "## Root Cause\nNull form ref.",
				},
			}),
		);

		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		// Type-aware: uses the item's TRUE DB kind + existing body.
		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "BUG",
				existingDescription: EXISTING_BUG_BODY,
			}),
		);
		// The MERGED body is persisted, not the analyzer's generic body.
		expect(lastUpdateData().description).toBe(merged);
		expect(lastUpdateData().description).not.toContain(
			"generic regenerated",
		);
	});

	it("does NOT re-merge an update already flagged structurePreserved (no double LLM call)", async () => {
		const preMerged =
			"## Steps to Reproduce\n1. x\n## Root Cause\nalready merged at analysis\n## Original Description from User (Do Not Modify)\nlogin broken";
		await run(
			makeUpdate({
				structurePreserved: true,
				description: { from: EXISTING_BUG_BODY, to: preMerged },
			}),
		);

		expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
		// Persists the already-merged body verbatim.
		expect(lastUpdateData().description).toBe(preMerged);
	});

	it("merges into the current body when the ticket changed since analysis", async () => {
		const preMerged =
			"## Steps to Reproduce\n1. x\n## Root Cause\nmerged against an older body\n## Original Description from User (Do Not Modify)\nlogin broken";
		const merged = `${EXISTING_BUG_BODY.replace("1. Open /login", "1. x")}\n## Root Cause\nmerged against an older body`;
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: merged,
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});

		await run(
			makeUpdate({
				structurePreserved: true,
				description: {
					from: "an older body edited since analysis",
					to: preMerged,
				},
			}),
		);

		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledWith(
			expect.objectContaining({
				existingDescription: EXISTING_BUG_BODY,
				newInfo: expect.stringContaining(preMerged),
			}),
		);
		// The stale analysis-time body is never written over the edit.
		expect(lastUpdateData().description).toBe(merged);
	});

	it("on fallback keeps the existing body, appends the update's new detail unchanged, and flags it", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: EXISTING_BUG_BODY,
			acceptanceCriteria: undefined,
			fallbackUsed: true,
			fallbackReason: "destructive",
		});
		const change = makeUpdate({
			title: { from: "Login fails", to: "Login fails (urgent)" },
			description: {
				from: "stale snapshot",
				to: "## Root Cause\nNull form ref.",
			},
		});

		await run(change);

		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		const data = lastUpdateData();
		expect(data.title).toBe("Login fails (urgent)");
		// Nothing the update proposed is dropped: the body as it was, then
		// the update's own lines as it wrote them.
		expect(data.description).toBe(
			`${EXISTING_BUG_BODY}\n\n## Root Cause\nNull form ref.`,
		);
		expect(
			(change as unknown as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBe(true);
	});

	it("on fallback keeps the existing body (no description write) when the update adds nothing it lacks, and flags it", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: EXISTING_BUG_BODY,
			acceptanceCriteria: undefined,
			fallbackUsed: true,
			fallbackReason: "destructive",
		});
		// Include a title change so updateStory is still called.
		const change = makeUpdate({
			title: { from: "Login fails", to: "Login fails (urgent)" },
			description: {
				from: "stale snapshot",
				to: "## Actual Result\nNothing.",
			},
		});

		await run(change);

		const data = lastUpdateData();
		expect(data.title).toBe("Login fails (urgent)");
		expect(data.description).toBeUndefined();
		expect(
			(change as unknown as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBe(true);
	});

	it("does not merge metadata-only updates (no body change → no LLM call)", async () => {
		await run(
			makeUpdate({
				description: undefined,
				acceptanceCriteria: undefined,
				priority: { from: "P2_MEDIUM", to: "P1_HIGH" },
			}),
		);
		expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
	});
});

// A realistic, substantial (>600 char) feature body carrying the narrative
// section signature (`FEATURE_ONLY_SECTIONS`) that `detectDestructiveRewrite`
// checks for on the FEATURE path.
const EXISTING_FEATURE_BODY = [
	"## Feature Narrative",
	"A reviewer can pick the prompt template by hand instead of relying on",
	"the automatic classifier, which sometimes routes a proposal-type change",
	"to the wrong template family.",
	"",
	"## User Story",
	"As a reviewer, I want to choose the prompt template explicitly so the",
	"generated draft matches my intent even when the automatic classifier",
	"would have guessed wrong.",
	"",
	"## Benefit Hypothesis",
	"Fewer rewrites after the first draft, and fewer support threads asking",
	"why the draft used the wrong section structure.",
	"",
	"## Business Impact",
	"Reviewers stop hand-repairing generated bodies section by section, which",
	"was the single largest source of edit churn on proposal-type changes",
	"last quarter.",
].join("\n");

function makeFeatureUpdate(
	overrides: Record<string, unknown> = {},
): ChangeProposal["changes"][number] {
	return makeUpdate({
		type: "feature" as const,
		title: {
			from: "Choose prompt template",
			to: "Choose prompt template",
		},
		description: {
			from: "stale snapshot",
			to: "analyzer generic regenerated body",
		},
		...overrides,
	});
}

describe("applyBacklogChanges → destructive-rewrite guard now covers FEATURE updates (Fizzy #2048)", () => {
	beforeEach(() => {
		mocks.dbUserStoryFindFirst.mockResolvedValue({
			kind: "FEATURE",
			title: "Choose prompt template",
			identifier: "F-020",
			description: EXISTING_FEATURE_BODY,
			acceptanceCriteria: "",
			labels: [],
		});
	});

	it("refuses a FEATURE update whose candidate body is empty: every line stays, and the update's new detail is appended", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: "",
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		// Include a title change so updateStory is still called — proves this
		// is a hold on the DESCRIPTION field, not a skip of the whole update.
		const change = makeFeatureUpdate({
			title: {
				from: "Choose prompt template",
				to: "Choose prompt template (updated)",
			},
		});

		await run(change);

		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		const data = lastUpdateData();
		expect(data.title).toBe("Choose prompt template (updated)");
		// The update deletes none of the ticket's lines, so the empty merge
		// deletes none either; its new detail, which the merge dropped, is
		// appended unchanged.
		expect(data.description).toBe(
			`${EXISTING_FEATURE_BODY}\n\nanalyzer generic regenerated body`,
		);
		expect(
			(change as unknown as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBe(true);
	});

	it("refuses a FEATURE update whose candidate collapses the body far below the original length", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: "Reviewer can now pick a template.",
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		// The update proposes the collapsed text, so the merge is held to it
		// and reaches the guard.
		const change = makeFeatureUpdate({
			title: {
				from: "Choose prompt template",
				to: "Choose prompt template (updated)",
			},
			description: {
				from: "stale snapshot",
				to: "Reviewer can now pick a template.",
			},
		});

		await run(change);

		const data = lastUpdateData();
		expect(data.title).toBe("Choose prompt template (updated)");
		expect(data.description).toBeUndefined();
		expect(
			(change as unknown as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBe(true);
	});

	it("false-positive guard: a NORMAL feature rewrite (substantial, keeps its narrative sections) is still persisted", async () => {
		const normalRewrite = EXISTING_FEATURE_BODY.replace(
			"Fewer rewrites after the first draft, and fewer support threads asking\nwhy the draft used the wrong section structure.",
			"Fewer rewrites after the first draft — measured over the following\nsprint — and fewer support threads asking why the draft used the wrong\nsection structure.",
		);
		// Sanity: the fixture actually changed the body (a legitimate edit),
		// stayed well above the 45% collapse floor, and kept every narrative
		// heading — this is what a real feature update looks like.
		expect(normalRewrite).not.toBe(EXISTING_FEATURE_BODY);
		expect(normalRewrite.length).toBeGreaterThan(
			EXISTING_FEATURE_BODY.length * 0.45,
		);
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: normalRewrite,
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		// The update holds the new wording the merge puts in.
		const change = makeFeatureUpdate({
			description: {
				from: "stale snapshot",
				to: "Fewer rewrites after the first draft — measured over the following\nsprint — and fewer support threads asking why the draft used the wrong\nsection structure.",
			},
		});

		await run(change);

		const data = lastUpdateData();
		expect(data.description).toBe(normalRewrite);
		expect(
			(change as unknown as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBeFalsy();
	});

	it("BUG updates are unaffected (regression pin): a bug rewrite reformatted as a feature is still refused, same as before", async () => {
		mocks.dbUserStoryFindFirst.mockResolvedValue({
			kind: "BUG",
			title: "Login fails",
			identifier: "F-009",
			description: EXISTING_BUG_BODY,
			acceptanceCriteria: "",
			labels: ["bug"],
		});
		const featureShaped =
			"## Feature Narrative\nA nicer login experience.\n\n## Acceptance Criteria\nGIVEN a user WHEN they sign in THEN it works.";
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: featureShaped,
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		// The update proposes the feature-shaped text, so the merge is held
		// to it and reaches the guard.
		const change = makeUpdate({
			title: { from: "Login fails", to: "Login fails (urgent)" },
			description: { from: "stale snapshot", to: featureShaped },
		});

		await run(change);

		const data = lastUpdateData();
		expect(data.title).toBe("Login fails (urgent)");
		expect(data.description).toBeUndefined();
		expect(
			(change as unknown as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBe(true);
	});
});

describe("applyBacklogChanges → Apply all writes only the update's own edits", () => {
	// A meeting update in the inbox's shape: the ticket names its export
	// limit thirteen times, and the update lowers it once, adds a sentence
	// and adds a criterion, written as a whole version of each body.
	const LIMITS = Array.from({ length: 13 }, (_, index) =>
		index === 0
			? "- Exports are limited to 10,000 rows per file."
			: `- Rule ${index + 1}: a batch stays under 10,000 rows.`,
	);
	const DESCRIPTION = [
		"## Overview",
		"Supervisors export the break queue as CSV.",
		"",
		"### Limits",
		...LIMITS,
		"",
		"### Benefit Hypothesis",
		"Supervisors spend less time on exports.",
	].join("\n");
	const CRITERIA =
		"1. GIVEN a supervisor  \n   WHEN they export the queue  \n   THEN a CSV downloads.";
	const PROPOSED_DESCRIPTION = DESCRIPTION.replace(
		"limited to 10,000 rows",
		"limited to 5,000 rows",
	).replace(
		"### Benefit Hypothesis",
		"Supervisors can schedule a nightly export.\n\n### Benefit Hypothesis",
	);
	const PROPOSED_CRITERIA = `${CRITERIA}\n\n### Scheduling\n\n6. GIVEN a supervisor schedules a nightly export  \n   WHEN the schedule runs  \n   THEN the CSV is produced without manual action.`;

	function meetingUpdate(descriptionFrom?: string) {
		return makeUpdate({
			type: "feature" as const,
			title: { from: "Export the queue", to: "Export the queue" },
			description: { from: descriptionFrom, to: PROPOSED_DESCRIPTION },
			acceptanceCriteria: { to: PROPOSED_CRITERIA },
			bodyMergeFallback: true,
			sourceContext: "meeting_transcript",
		});
	}

	function written() {
		return (mocks.updateStory.mock.calls.at(-1)?.[2] ?? {}) as {
			description?: string;
			acceptanceCriteria?: string;
		};
	}

	beforeEach(() => {
		mocks.dbUserStoryFindFirst.mockResolvedValue({
			kind: "FEATURE",
			title: "Export the queue",
			identifier: "F-030",
			description: DESCRIPTION,
			acceptanceCriteria: CRITERIA,
			labels: [],
		});
	});

	it("writes a whole version of the ticket as it is, with no merge", async () => {
		await run(meetingUpdate());

		expect(mocks.reanalyzeBodyByKind).not.toHaveBeenCalled();
		const data = written();
		expect(data.description).toBe(PROPOSED_DESCRIPTION);
		expect(data.acceptanceCriteria).toBe(PROPOSED_CRITERIA);
		expect(data.description?.split("5,000").length).toBe(2);
		expect(data.description?.split("10,000").length).toBe(13);
	});

	it("holds a merge to the update once the ticket changed since it was written", async () => {
		// What a model merge wrote: every limit lowered, and blocks that are
		// in neither the ticket nor the update.
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: `${PROPOSED_DESCRIPTION.replaceAll("10,000", "5,000")}\n\n### UC2 Scheduled export\nFR6: exports run on a schedule.\n\n### Open questions\n- Which time zone?`,
			acceptanceCriteria: `${PROPOSED_CRITERIA}\n\n7. GIVEN a gap in the schedule  \n   THEN it is flagged.`,
			fallbackUsed: false,
		});

		await run(meetingUpdate("## Overview\nAn older text."));

		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		const data = written();
		expect(data.description?.trim()).toBe(PROPOSED_DESCRIPTION);
		expect(data.acceptanceCriteria?.trim()).toBe(PROPOSED_CRITERIA);
	});

	it("appends new detail the merge reworded, unchanged, and marks the merge as fallen back", async () => {
		// The merge reworded the update's sentence and added a block nobody
		// proposed: the filter leaves none of the update's detail.
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: DESCRIPTION.replace(
				"### Benefit Hypothesis",
				"Supervisors may set up nightly exports.\n\n### UC2 Scheduled export\n\n### Benefit Hypothesis",
			),
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		const change = makeUpdate({
			type: "feature" as const,
			title: { from: "Export the queue", to: "Export the queue" },
			description: { to: "Supervisors can schedule a nightly export." },
			sourceContext: "chat",
		});

		await run(change);

		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		const data = written();
		expect(data.description).toBe(
			`${DESCRIPTION}\n\nSupervisors can schedule a nightly export.`,
		);
		expect(data.acceptanceCriteria).toBeUndefined();
		expect(
			(change as unknown as { bodyMergeFallback?: boolean })
				.bodyMergeFallback,
		).toBe(true);
	});
});
