/**
 * Which GitHub endpoint the comment posts to — create versus edit.
 *
 * These are two different paths and the second is not the first with an id
 * appended:
 *
 *   create/list  POST|GET /repos/{o}/{r}/issues/{number}/comments
 *   edit         PATCH    /repos/{o}/{r}/issues/comments/{id}
 *
 * Deriving the edit URL from the issue URL is the obvious mistake, and it was
 * the one shipped: every update 404'd, so a comment could only be created and
 * "edited in place" never happened. Only pressing the button a second time
 * against real GitHub showed it.
 *
 * The flow these pin: a recorded id is edited directly, and only a host saying
 * that comment is gone falls back to creating one. There is no listing step.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getPullRequestReviewForPosting,
	resolveFreshRepoToken,
	fetchMock,
	setPosted,
	integrationFind,
	getProjectQaSettings,
	findPostedComment,
} = vi.hoisted(() => ({
	integrationFind: vi.fn(),
	getPullRequestReviewForPosting: vi.fn(),
	resolveFreshRepoToken: vi.fn(),
	fetchMock: vi.fn(),
	setPosted: vi.fn(),
	getProjectQaSettings: vi.fn(),
	findPostedComment: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getPullRequestReviewForPosting: (...a: unknown[]) =>
		getPullRequestReviewForPosting(...a),
	setPullRequestReviewPostedComment: (...a: unknown[]) => setPosted(...a),
	// The body now states what each lens did, so composing it reads the
	// project's switches.
	getProjectQaSettings: (...a: unknown[]) => getProjectQaSettings(...a),
	// A review row is per head commit; the comment belongs to the pull request.
	findPostedCommentForPullRequest: (...a: unknown[]) =>
		findPostedComment(...a),
}));
// The comment path reads the integration for its URL and Azure organization,
// because the review stores only the id so it survives a disconnection.
vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectRepositoryIntegration: {
			findFirst: (...a: unknown[]) => integrationFind(...a),
		},
	},
}));
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: (...a: unknown[]) => resolveFreshRepoToken(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../pr-review-feature", () => ({ assertPrReviewEnabled: vi.fn() }));

const { postReviewCommentForReview } = await import("../pr-review-comment");

const INPUT = {
	projectId: "proj-1",
	reviewId: "review-1",
	actingUserId: "user-1",
	reviewUrl: null,
};

function ok(body: unknown) {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => "",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	getPullRequestReviewForPosting.mockResolvedValue(REVIEW);
	resolveFreshRepoToken.mockResolvedValue({ token: "tok" });
	integrationFind.mockResolvedValue({
		repositoryUrl: "https://github.com/acme/widgets",
		azureOrganization: null,
	});
	getProjectQaSettings.mockResolvedValue({
		prReviewQaLensEnabled: true,
		prReviewArchitectureLensEnabled: true,
	});
	// No earlier review of this pull request posted a comment, unless a test
	// says otherwise.
	findPostedComment.mockResolvedValue(null);
});

const REVIEW = {
	id: "review-1",
	provider: "GITHUB",
	repoOwner: "acme",
	repoName: "widgets",
	prNumber: 42,
	integrationId: "integration-1",
	organizationId: "org-1",
	postedCommentId: null as bigint | null,
	qaAnalysedAt: new Date("2026-08-13T00:00:00.000Z"),
	architectureAnalysedAt: new Date("2026-08-13T00:00:00.000Z"),
	findings: [
		{
			id: "f-1",
			lens: "QA",
			severity: "HIGH",
			title: "Retry path untested",
			detail: "No case covers it.",
			recommendation: "Add one.",
			filePath: null,
			line: null,
			status: "OPEN",
		},
	],
};

/** A review whose comment was already posted, so the edit path runs. */
function withRecordedComment(id: number) {
	getPullRequestReviewForPosting.mockResolvedValue({
		...REVIEW,
		postedCommentId: BigInt(id),
	});
}

describe("postReviewCommentForReview — endpoints", () => {
	it("creates against the issue's own comments collection", async () => {
		fetchMock.mockResolvedValueOnce(
			ok({ id: 555, html_url: "https://c/1" }),
		);

		const result = await postReviewCommentForReview(INPUT);

		expect(result.updated).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://api.github.com/repos/acme/widgets/issues/42/comments",
		);
		expect(init.method).toBe("POST");
	});

	it("edits against the REPOSITORY's comment id, not the issue path", async () => {
		withRecordedComment(987);
		fetchMock.mockResolvedValueOnce(
			ok({ id: 987, html_url: "https://c/1" }),
		);

		const result = await postReviewCommentForReview(INPUT);

		expect(result.updated).toBe(true);
		const [url, init] = fetchMock.mock.calls[0];
		// The shipped bug produced `/issues/42/comments/987`, which 404s.
		expect(url).toBe(
			"https://api.github.com/repos/acme/widgets/issues/comments/987",
		);
		expect(url).not.toContain("/issues/42/comments/987");
		expect(init.method).toBe("PATCH");
	});

	it("edits by the recorded id without listing anything first", async () => {
		// The pagination bug this replaced: a search read one page of comments, so
		// on a busy pull request Fabric's own fell off the end and every run posted
		// a new one. An id written down cannot fall off anything.
		withRecordedComment(987);
		fetchMock.mockResolvedValueOnce(ok({ id: 987, html_url: "u" }));

		await postReviewCommentForReview(INPUT);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("creates a new comment when the recorded one was deleted", async () => {
		// A person tidying a thread deletes it, which is ordinary, and the host
		// answers the edit with 404. Without this the id stays recorded and every
		// later run retries a comment that no longer exists.
		withRecordedComment(987);
		fetchMock
			.mockResolvedValueOnce({
				ok: false,
				status: 404,
				json: async () => ({}),
			})
			.mockResolvedValueOnce(ok({ id: 1234, html_url: "u" }));

		const result = await postReviewCommentForReview(INPUT);

		expect(result.updated).toBe(false);
		expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
		expect(fetchMock.mock.calls[1][1].method).toBe("POST");
		// The NEW id replaces the dead one, so this happens once.
		expect(setPosted).toHaveBeenCalledWith({
			id: "review-1",
			projectId: "proj-1",
			commentId: 1234,
		});
	});

	it("does not retry a create that fails, which would mean something else", async () => {
		// Only an edit of a deleted comment recovers. A failed create means the
		// pull request or repository is gone, and retrying hides the real status.
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 404,
			json: async () => ({}),
		});

		await expect(postReviewCommentForReview(INPUT)).rejects.toThrow(/404/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("records the comment id so the next run needs no search", async () => {
		fetchMock.mockResolvedValueOnce(ok({ id: 555, html_url: "u" }));

		await postReviewCommentForReview(INPUT);

		expect(setPosted).toHaveBeenCalledWith({
			id: "review-1",
			projectId: "proj-1",
			commentId: 555,
		});
	});

	it("refuses a provider it has no implementation for", async () => {
		getPullRequestReviewForPosting.mockResolvedValue({
			...REVIEW,
			provider: "BITBUCKET",
		});

		await expect(postReviewCommentForReview(INPUT)).rejects.toThrow(
			/not supported for BITBUCKET/i,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

/**
 * One comment per PULL REQUEST, not per commit.
 *
 * A review row is keyed by head commit, so every push creates a fresh row whose
 * `postedCommentId` is null. The lookup only ever asked that row, concluded
 * "never posted", and created another comment — so a pull request collected one
 * per push. Two customer-facing docs and an in-app string all promise the
 * comment is edited in place on later pushes.
 */
describe("a second push edits the first comment", () => {
	it("edits the comment an EARLIER review of the same pull request posted", async () => {
		// This review is new (null), but the pull request already has a comment.
		getPullRequestReviewForPosting.mockResolvedValue({
			...REVIEW,
			id: "review-2",
			postedCommentId: null,
		});
		findPostedComment.mockResolvedValue(4242);
		fetchMock.mockResolvedValue(ok({ id: 4242, html_url: "u" }));

		const result = await postReviewCommentForReview(INPUT);

		const [url, init] = fetchMock.mock.calls[0];
		expect(init.method).toBe("PATCH");
		expect(url).toContain("/issues/comments/4242");
		expect(result.updated).toBe(true);
	});

	it("asks about the pull request, excluding the review being posted", async () => {
		getPullRequestReviewForPosting.mockResolvedValue({
			...REVIEW,
			id: "review-2",
			postedCommentId: null,
		});
		fetchMock.mockResolvedValue(ok({ id: 1, html_url: "u" }));

		await postReviewCommentForReview(INPUT);

		expect(findPostedComment).toHaveBeenCalledWith({
			projectId: "proj-1",
			provider: "GITHUB",
			repoOwner: "acme",
			repoName: "widgets",
			prNumber: 42,
			excludeReviewId: "review-2",
		});
	});

	it("does not go looking when this review already recorded its own comment", async () => {
		getPullRequestReviewForPosting.mockResolvedValue({
			...REVIEW,
			postedCommentId: 99n,
		});
		fetchMock.mockResolvedValue(ok({ id: 99, html_url: "u" }));

		await postReviewCommentForReview(INPUT);

		expect(findPostedComment).not.toHaveBeenCalled();
	});

	it("creates one when the pull request genuinely has none", async () => {
		findPostedComment.mockResolvedValue(null);
		fetchMock.mockResolvedValue(ok({ id: 7, html_url: "u" }));

		const result = await postReviewCommentForReview(INPUT);

		expect(fetchMock.mock.calls[0][1].method).toBe("POST");
		expect(result.updated).toBe(false);
	});
});
