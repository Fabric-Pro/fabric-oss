/**
 * The reads that describe a Publishing Suite verdict (Fizzy #1851 A9).
 *
 * Two properties are worth pinning here rather than leaving to the caller:
 * every read is scoped by the project as well as the topic — a topic id from
 * another project must resolve to the same nothing a missing one does — and the
 * prompt lookup addresses `PromptVersion` by its compound unique key, since the
 * draft table stores an integer version that is not a row id.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const promptVersionFindUnique = vi.hoisted(() => vi.fn());
const draftFindFirst = vi.hoisted(() => vi.fn());
const workingFindFirst = vi.hoisted(() => vi.fn());
const revisionFindFirst = vi.hoisted(() => vi.fn());
const analysisFindFirst = vi.hoisted(() => vi.fn());

vi.mock("../../client", () => ({
	db: {
		promptVersion: { findUnique: promptVersionFindUnique },
		publishingTopicDraft: { findFirst: draftFindFirst },
		publishingTopicWorkingDraft: { findFirst: workingFindFirst },
		publishingTopicAnalysisRevision: { findFirst: revisionFindFirst },
		publishingTopicPlanningAnalysis: { findFirst: analysisFindFirst },
	},
	Prisma: {},
}));

import {
	getAnalysisRevisionSnapshot,
	getLatestReadyDraft,
	getWorkingDraftSourceSnapshot,
	resolvePromptVersionId,
} from "../projects/publishing-outcomes";

const SCOPE = { topicId: "topic-1", projectId: "project-1" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolvePromptVersionId", () => {
	it("addresses PromptVersion by its (promptId, version) compound key", async () => {
		promptVersionFindUnique.mockResolvedValue({ id: "pv-42" });

		expect(
			await resolvePromptVersionId({
				promptId: "prompt-9",
				promptVersion: 3,
			}),
		).toBe("pv-42");
		expect(promptVersionFindUnique.mock.calls[0][0].where).toEqual({
			promptId_version: { promptId: "prompt-9", version: 3 },
		});
	});

	// A draft that predates prompt attribution is still worth a verdict.
	it.each([
		[{ promptId: null, promptVersion: 3 }],
		[{ promptId: "prompt-9", promptVersion: null }],
		[{ promptId: null, promptVersion: null }],
	])("returns null without querying for %o", async (input) => {
		expect(await resolvePromptVersionId(input)).toBeNull();
		expect(promptVersionFindUnique).not.toHaveBeenCalled();
	});

	it("returns null when the version row is gone", async () => {
		promptVersionFindUnique.mockResolvedValue(null);
		expect(
			await resolvePromptVersionId({
				promptId: "prompt-9",
				promptVersion: 3,
			}),
		).toBeNull();
	});
});

describe("getLatestReadyDraft", () => {
	it("asks only for READY candidates of one type, newest first", async () => {
		draftFindFirst.mockResolvedValue({ id: "draft-2" });

		await getLatestReadyDraft({ ...SCOPE, postType: "BLOG_POST" });

		const arg = draftFindFirst.mock.calls[0][0];
		expect(arg.where).toEqual({
			topicId: "topic-1",
			projectId: "project-1",
			postType: "BLOG_POST",
			status: "READY",
		});
		expect(arg.orderBy).toEqual({ version: "desc" });
	});
});

describe("getWorkingDraftSourceSnapshot", () => {
	it("scopes the candidate read by topic and project, not the id alone", async () => {
		workingFindFirst.mockResolvedValue({ sourceDraftId: "draft-7" });
		draftFindFirst.mockResolvedValue({
			model: "claude-opus-5",
			promptId: "prompt-2",
			promptVersion: 1,
		});

		expect(
			await getWorkingDraftSourceSnapshot({
				...SCOPE,
				postType: "CASE_STUDY",
			}),
		).toEqual({
			draftId: "draft-7",
			model: "claude-opus-5",
			promptId: "prompt-2",
			promptVersion: 1,
		});
		expect(draftFindFirst.mock.calls[0][0].where).toEqual({
			id: "draft-7",
			topicId: "topic-1",
			projectId: "project-1",
		});
	});

	/**
	 * `ON DELETE SET NULL ("sourceDraftId")` — a body whose candidate was
	 * removed has nothing to attribute an edit to, and a verdict against no
	 * subject is worse than no verdict.
	 */
	it("returns null when the body has no source candidate", async () => {
		workingFindFirst.mockResolvedValue({ sourceDraftId: null });

		expect(
			await getWorkingDraftSourceSnapshot({
				...SCOPE,
				postType: "CASE_STUDY",
			}),
		).toBeNull();
		expect(draftFindFirst).not.toHaveBeenCalled();
	});

	it("returns null when no working draft exists", async () => {
		workingFindFirst.mockResolvedValue(null);

		expect(
			await getWorkingDraftSourceSnapshot({
				...SCOPE,
				postType: "CASE_STUDY",
			}),
		).toBeNull();
	});
});

describe("getAnalysisRevisionSnapshot", () => {
	it("pairs the revision just written with the analysis it came from", async () => {
		revisionFindFirst.mockResolvedValue({ id: "rev-4" });
		analysisFindFirst.mockResolvedValue({ model: "claude-sonnet-5" });

		expect(
			await getAnalysisRevisionSnapshot({
				...SCOPE,
				revisionVersion: 4,
				sourceAnalysisVersion: 2,
			}),
		).toEqual({ revisionId: "rev-4", model: "claude-sonnet-5" });
		expect(revisionFindFirst.mock.calls[0][0].where).toMatchObject({
			version: 4,
		});
		expect(analysisFindFirst.mock.calls[0][0].where).toMatchObject({
			version: 2,
		});
	});

	/**
	 * Reading "the current revision" can pick up somebody else's newer save.
	 * Attributing this user's verdict to that row would be a lie, so the
	 * version is required to match and the verdict is dropped otherwise.
	 */
	it("returns null when the named revision version is not there", async () => {
		revisionFindFirst.mockResolvedValue(null);
		analysisFindFirst.mockResolvedValue({ model: "claude-sonnet-5" });

		expect(
			await getAnalysisRevisionSnapshot({
				...SCOPE,
				revisionVersion: 4,
				sourceAnalysisVersion: 2,
			}),
		).toBeNull();
	});

	it("still records the revision when the source analysis is gone", async () => {
		revisionFindFirst.mockResolvedValue({ id: "rev-4" });
		analysisFindFirst.mockResolvedValue(null);

		expect(
			await getAnalysisRevisionSnapshot({
				...SCOPE,
				revisionVersion: 4,
				sourceAnalysisVersion: 2,
			}),
		).toEqual({ revisionId: "rev-4", model: null });
	});
});
