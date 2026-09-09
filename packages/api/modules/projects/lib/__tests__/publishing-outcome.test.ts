/**
 * The Publishing Suite → `AiOutcomeEvent` mapping (Fizzy #1851 A9).
 *
 * What is under test is the mapping itself and the two rules that make it safe
 * to add to a mutation: it never throws, and it never overwrites a human's
 * acceptance with a machine-inferred rejection. The procedure-level wiring —
 * which handler emits which verdict — is covered in
 * `procedures/publishing-suite/__tests__/outcome-emission.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	recordAiOutcome: vi.fn(),
	resolvePromptVersionId: vi.fn(),
	getAiOutcomesForSubjects: vi.fn(),
	getAnalysisRevisionSnapshot: vi.fn(),
	getWorkingDraftSourceSnapshot: vi.fn(),
	getLatestReadyDraft: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
vi.mock("@repo/database", () => dbMocks);

import {
	recordAnalysisRevisionOutcome,
	recordEditedWorkingDraft,
	recordPublishingOutcome,
	recordSupersededDraft,
	recordTopicStatusOutcome,
} from "../publishing-outcome";

const SCOPE = {
	topicId: "topic-1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
};

/** A READY candidate as `getLatestReadyDraft` returns one. */
function readyDraft(overrides: Record<string, unknown> = {}) {
	return {
		id: "draft-1",
		model: "claude-sonnet-5",
		promptId: "prompt-9",
		promptVersion: 3,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.recordAiOutcome.mockResolvedValue({ outcome: "ACCEPTED_AS_IS" });
	dbMocks.resolvePromptVersionId.mockResolvedValue("pv-42");
	dbMocks.getAiOutcomesForSubjects.mockResolvedValue({});
	dbMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: null,
	});
});

describe("recordPublishingOutcome", () => {
	it("files every verdict under the one publishing-suite feature key", async () => {
		await recordPublishingOutcome({
			outcome: "ACCEPTED_AS_IS",
			subjectType: "publishing-blog-post",
			subjectId: "draft-1",
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
			projectId: SCOPE.projectId,
		});

		expect(dbMocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				featureKey: "publishing-suite",
				subjectType: "publishing-blog-post",
				subjectId: "draft-1",
				outcome: "ACCEPTED_AS_IS",
				organizationId: "org-1",
				projectId: "project-1",
				userId: "user-1",
			}),
		);
	});

	/**
	 * The draft table records an INTEGER prompt version; the outcome table
	 * wants a `PromptVersion` row id. Writing the integer would look fine and
	 * make every prompt comparison silently wrong.
	 */
	it("writes the resolved PromptVersion id, never the integer version", async () => {
		await recordPublishingOutcome({
			outcome: "ACCEPTED_AS_IS",
			subjectType: "publishing-blog-post",
			subjectId: "draft-1",
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
			projectId: SCOPE.projectId,
			model: "claude-sonnet-5",
			promptId: "prompt-9",
			promptVersion: 3,
		});

		expect(dbMocks.resolvePromptVersionId).toHaveBeenCalledWith({
			promptId: "prompt-9",
			promptVersion: 3,
		});
		expect(dbMocks.recordAiOutcome.mock.calls[0][0]).toMatchObject({
			modelCanonicalName: "claude-sonnet-5",
			promptVersionId: "pv-42",
		});
	});

	it("resolves rather than throwing when the write fails", async () => {
		dbMocks.recordAiOutcome.mockRejectedValueOnce(new Error("db down"));

		await expect(
			recordPublishingOutcome({
				outcome: "REJECTED",
				subjectType: "publishing-topic",
				subjectId: "topic-1",
				userId: SCOPE.userId,
				organizationId: SCOPE.organizationId,
				projectId: SCOPE.projectId,
			}),
		).resolves.toBeUndefined();
	});
});

describe("recordSupersededDraft", () => {
	it("rejects the candidate a regeneration passed over", async () => {
		dbMocks.getLatestReadyDraft.mockResolvedValue(readyDraft());

		await recordSupersededDraft({ ...SCOPE, postType: "BLOG_POST" });

		expect(dbMocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "REJECTED",
				subjectType: "publishing-blog-post",
				subjectId: "draft-1",
				modelCanonicalName: "claude-sonnet-5",
			}),
		);
	});

	it("records nothing on a first generation, which supersedes no one", async () => {
		dbMocks.getLatestReadyDraft.mockResolvedValue(null);

		await recordSupersededDraft({ ...SCOPE, postType: "BLOG_POST" });

		expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
	});

	/**
	 * The upsert holds ONE row per (feature, subject, user), so a blind
	 * rejection would erase the `ACCEPTED_WITH_EDITS` written when this person
	 * edited the body they adopted — destroying the revision count in exactly
	 * the flow "refine" was shipped for (adopt → edit → refine).
	 */
	it("refuses to overwrite this user's own acceptance", async () => {
		dbMocks.getLatestReadyDraft.mockResolvedValue(readyDraft());
		dbMocks.getAiOutcomesForSubjects.mockResolvedValue({
			"draft-1": "ACCEPTED_WITH_EDITS",
		});

		await recordSupersededDraft({ ...SCOPE, postType: "BLOG_POST" });

		expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
	});

	/**
	 * The FIRST generation seeds a working draft pointing at its own candidate,
	 * so "a working draft names this draft" is NOT evidence anybody adopted it.
	 * Inferring adoption that way would drop the rejection on every first
	 * regeneration — the most common one there is.
	 */
	it("still rejects a seeded candidate nobody ever adopted", async () => {
		dbMocks.getLatestReadyDraft.mockResolvedValue(readyDraft());
		dbMocks.getAiOutcomesForSubjects.mockResolvedValue({});

		await recordSupersededDraft({ ...SCOPE, postType: "BLOG_POST" });

		expect(dbMocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "REJECTED" }),
		);
		// The working draft is never consulted: the guard rests on the
		// recorded verdict alone.
		expect(dbMocks.getWorkingDraftSourceSnapshot).not.toHaveBeenCalled();
	});

	it("resolves rather than throwing when the lookup fails", async () => {
		dbMocks.getLatestReadyDraft.mockRejectedValueOnce(new Error("db down"));

		await expect(
			recordSupersededDraft({ ...SCOPE, postType: "BLOG_POST" }),
		).resolves.toBeUndefined();
	});
});

describe("recordEditedWorkingDraft", () => {
	it("attributes the edit to the candidate the body started as", async () => {
		dbMocks.getWorkingDraftSourceSnapshot.mockResolvedValue({
			draftId: "draft-7",
			model: "claude-opus-5",
			promptId: "prompt-2",
			promptVersion: 1,
		});

		await recordEditedWorkingDraft({ ...SCOPE, postType: "CASE_STUDY" });

		expect(dbMocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "ACCEPTED_WITH_EDITS",
				subjectType: "publishing-case-study",
				subjectId: "draft-7",
				modelCanonicalName: "claude-opus-5",
			}),
		);
	});

	it("records nothing when the source candidate is gone", async () => {
		dbMocks.getWorkingDraftSourceSnapshot.mockResolvedValue(null);

		await recordEditedWorkingDraft({ ...SCOPE, postType: "CASE_STUDY" });

		expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
	});
});

describe("recordAnalysisRevisionOutcome", () => {
	it("keys the verdict to the revision so revisions can be counted", async () => {
		dbMocks.getAnalysisRevisionSnapshot.mockResolvedValue({
			revisionId: "rev-3",
			model: "claude-sonnet-5",
		});

		await recordAnalysisRevisionOutcome({
			...SCOPE,
			revisionVersion: 3,
			sourceAnalysisVersion: 2,
		});

		expect(dbMocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "ACCEPTED_WITH_EDITS",
				subjectType: "publishing-analysis",
				subjectId: "rev-3",
				modelCanonicalName: "claude-sonnet-5",
			}),
		);
		// A planning analysis has no prompt columns at all, so nothing is
		// offered for resolution — rather than an id invented from somewhere.
		expect(dbMocks.resolvePromptVersionId).toHaveBeenCalledWith({
			promptId: null,
			promptVersion: null,
		});
	});

	it("records nothing when the saved revision cannot be identified", async () => {
		dbMocks.getAnalysisRevisionSnapshot.mockResolvedValue(null);

		await recordAnalysisRevisionOutcome({
			...SCOPE,
			revisionVersion: 3,
			sourceAnalysisVersion: 2,
		});

		expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
	});
});

describe("recordTopicStatusOutcome", () => {
	it.each([
		["PUBLISHED", "ACCEPTED_AS_IS"],
		["DECLINED", "REJECTED"],
	])("maps %s to %s", async (status, outcome) => {
		await recordTopicStatusOutcome({
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			userId: SCOPE.userId,
			status,
		});

		expect(dbMocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome,
				subjectType: "publishing-topic",
				subjectId: "topic-1",
				organizationId: "org-1",
			}),
		);
	});

	/**
	 * The intermediate moves are workflow, not verdicts. Recording them would
	 * put a "rejection" on every topic a person merely parked.
	 */
	it.each(["SUGGESTION", "SELECTED", "IN_PROGRESS"])(
		"records nothing for %s",
		async (status) => {
			await recordTopicStatusOutcome({
				topicId: SCOPE.topicId,
				projectId: SCOPE.projectId,
				userId: SCOPE.userId,
				status,
			});

			expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
			expect(dbMocks.resolveProjectTenant).not.toHaveBeenCalled();
		},
	);

	/**
	 * The tenant comes from the Project row, never from the request:
	 * `updatePublishingTopicStatus` carries no project ratchet to inherit one
	 * from, and adding one would start 404-ing status changes on archived
	 * projects.
	 */
	it("derives the organization from the project row", async () => {
		await recordTopicStatusOutcome({
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			userId: SCOPE.userId,
			status: "PUBLISHED",
		});

		expect(dbMocks.resolveProjectTenant).toHaveBeenCalledWith("project-1");
	});
});
