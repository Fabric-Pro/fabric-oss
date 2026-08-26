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
 *  - On safe-hold fallback the existing body is kept (description NOT written),
 *    and `bodyMergeFallback` is stamped.
 *  - The merge uses the item's TRUE DB kind (type-aware).
 *  - Fizzy #2048: the defensive `detectDestructiveRewrite` guard below the
 *    merge used to short-circuit to "not destructive" for FEATURE updates —
 *    only BUG updates were checked. It now runs unconditionally for both
 *    kinds, so a FEATURE update can be refused too (empty/collapsed output,
 *    or a rewrite that drops the narrative section signature), while a
 *    normal, substantial feature rewrite must still go through untouched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		recordAudit: vi.fn(),
		heartbeat: vi.fn(),
		reanalyzeBodyByKind: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.dbProjectFindFirst },
		userStory: {
			findMany: mocks.dbUserStoryFindMany,
			findFirst: mocks.dbUserStoryFindFirst,
		},
	},
	tenantWhere: mocks.tenantWhere,
	createStory: mocks.createStory,
	updateStory: mocks.updateStory,
	recordAudit: mocks.recordAudit,
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

vi.mock("@temporalio/activity", () => ({ heartbeat: mocks.heartbeat }));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

vi.mock("../src/lib/reanalyze-body-by-kind", () => ({
	reanalyzeBodyByKind: mocks.reanalyzeBodyByKind,
}));

vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({ workflowId: "dup-test" })),
}));

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
	it("merges an unflagged update through reanalyzeBodyByKind and persists the merged body", async () => {
		const merged =
			"## Steps to Reproduce\n1. Open /login\n2. Click sign in\n## Root Cause\nNull form ref.\n## Actual Result\nNothing.\n## Original Description from User (Do Not Modify)\nlogin broken";
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: merged,
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});

		await run(makeUpdate());

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

	it("safe-holds on fallback: keeps the existing body (no description write) + flags it", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: EXISTING_BUG_BODY,
			acceptanceCriteria: undefined,
			fallbackUsed: true,
			fallbackReason: "destructive",
		});
		// Include a title change so updateStory is still called.
		const change = makeUpdate({
			title: { from: "Login fails", to: "Login fails (urgent)" },
		});

		await run(change);

		expect(mocks.reanalyzeBodyByKind).toHaveBeenCalledOnce();
		const data = lastUpdateData();
		// Title applied; description withheld (safe-hold).
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

	it("refuses a FEATURE update whose candidate body is empty (previously waved through)", async () => {
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description: "",
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		// Include a title change so updateStory is still called — proves this
		// is a safe-hold on the DESCRIPTION field, not a skip of the whole
		// update, mirroring the existing fallback test above.
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
		expect(data.description).toBeUndefined();
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
		const change = makeFeatureUpdate({
			title: {
				from: "Choose prompt template",
				to: "Choose prompt template (updated)",
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
		const change = makeFeatureUpdate();

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
		mocks.reanalyzeBodyByKind.mockResolvedValue({
			description:
				"## Feature Narrative\nA nicer login experience.\n\n## Acceptance Criteria\nGIVEN a user WHEN they sign in THEN it works.",
			acceptanceCriteria: undefined,
			fallbackUsed: false,
		});
		const change = makeUpdate({
			title: { from: "Login fails", to: "Login fails (urgent)" },
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
