/**
 * `runAutomaticPrReview` — the unattended path, where nobody is watching.
 *
 * This is the function a webhook schedules. It spends model credits, reads a
 * customer's source with their credential, and writes a comment into their pull
 * request, with no person present to notice it doing the wrong thing. It shipped
 * with the webhook's gates tested and itself untested, which is backwards: the
 * gates decide whether it runs, and this decides what it does.
 *
 * Four properties, each the reason a rule exists:
 *
 *  1. **It refuses before it spends.** Feature off, no configuring user, project
 *     opted out — each returns without reading, analysing or posting.
 *  2. **A failed read stops everything.** There is nothing to review, and running
 *     the lenses on a review with no diff would bill for speculation.
 *  3. **One lens failing does not cost the other its result, or the comment.**
 *     A model outage should still leave the computed architecture findings on the
 *     pull request.
 *  4. **It never throws.** Its caller answers GitHub, and an exception there
 *     turns a working delivery into a retried, then throttled, then disabled one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	assertTestCasesFeatureEnabled,
	getProjectQaSettings,
	readPullRequestIntoReview,
	runQaLens,
	runArchitectureLens,
	postReviewCommentForReview,
	recordAudit,
} = vi.hoisted(() => ({
	recordAudit: vi.fn(),
	assertTestCasesFeatureEnabled: vi.fn(),
	getProjectQaSettings: vi.fn(),
	readPullRequestIntoReview: vi.fn(),
	runQaLens: vi.fn(),
	runArchitectureLens: vi.fn(),
	postReviewCommentForReview: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getProjectQaSettings: (...a: unknown[]) => getProjectQaSettings(...a),
	// Fire-and-forget by design, so a real call here rejects into the void and
	// surfaces as an unhandled error rather than a failed test.
	recordAudit: (...a: unknown[]) => recordAudit(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../test-cases-feature", () => ({
	assertTestCasesFeatureEnabled: () => assertTestCasesFeatureEnabled(),
}));
vi.mock("../pr-review-read", () => ({
	readPullRequestIntoReview: (...a: unknown[]) =>
		readPullRequestIntoReview(...a),
}));
vi.mock("../pr-review-lenses", () => ({
	runQaLens: (...a: unknown[]) => runQaLens(...a),
	runArchitectureLens: (...a: unknown[]) => runArchitectureLens(...a),
}));
vi.mock("../pr-review-comment", () => ({
	postReviewCommentForReview: (...a: unknown[]) =>
		postReviewCommentForReview(...a),
}));

const { runAutomaticPrReview } = await import("../pr-review-run");

const INPUT = {
	projectId: "proj-1",
	repositoryIntegrationId: "integration-1",
	prNumber: 42,
	actingUserId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	assertTestCasesFeatureEnabled.mockReturnValue(undefined);
	getProjectQaSettings.mockResolvedValue({
		prReviewAutoReviewEnabled: true,
		prReviewQaLensEnabled: true,
		prReviewArchitectureLensEnabled: true,
	});
	readPullRequestIntoReview.mockResolvedValue({
		review: {
			id: "review-1",
			status: "READ",
			qaAnalysedAt: null,
			architectureAnalysedAt: null,
			postedCommentId: null,
		},
	});
	// `configured` and `indexed` are what tell the comment "this lens actually
	// looked" from "this lens could not run", so the happy-path mocks state them.
	runQaLens.mockResolvedValue({
		configured: true,
		findings: [{ id: "f-1" }, { id: "f-2" }],
	});
	runArchitectureLens.mockResolvedValue({
		indexed: true,
		findings: [{ id: "f-3" }],
	});
	postReviewCommentForReview.mockResolvedValue({
		url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
		updated: false,
		findings: 3,
	});
});

describe("runAutomaticPrReview — refusing before spending", () => {
	it("does nothing when the QA surface is off for the deployment", async () => {
		assertTestCasesFeatureEnabled.mockImplementation(() => {
			throw new Error("feature disabled");
		});

		expect(await runAutomaticPrReview(INPUT)).toEqual({
			ran: false,
			skipped: "feature-off",
		});
		expect(readPullRequestIntoReview).not.toHaveBeenCalled();
	});

	it("refuses when no configuring user is recorded on the integration", async () => {
		// Reading needs a credential and a credential needs somebody it belongs
		// to. Guessing an owner would attribute a customer's API calls to a person
		// who never agreed to it.
		const result = await runAutomaticPrReview({
			...INPUT,
			actingUserId: null,
		});

		expect(result).toEqual({ ran: false, skipped: "no-acting-user" });
		expect(getProjectQaSettings).not.toHaveBeenCalled();
	});

	it("does nothing for a project that never opted in", async () => {
		getProjectQaSettings.mockResolvedValue({
			prReviewAutoReviewEnabled: false,
		});

		expect(await runAutomaticPrReview(INPUT)).toEqual({
			ran: false,
			skipped: "auto-review-off",
		});
		expect(readPullRequestIntoReview).not.toHaveBeenCalled();
		expect(runQaLens).not.toHaveBeenCalled();
	});
});

describe("runAutomaticPrReview — the read gate", () => {
	it("stops when the read failed, without billing a lens", async () => {
		readPullRequestIntoReview.mockRejectedValue(
			new Error("GitHub said 404"),
		);

		const result = await runAutomaticPrReview(INPUT);

		expect(result.ran).toBe(false);
		expect(result.skipped).toBe("read-failed");
		expect(result.error).toContain("404");
		expect(runQaLens).not.toHaveBeenCalled();
		expect(postReviewCommentForReview).not.toHaveBeenCalled();
	});

	it("stops when the pull request stored no diff", async () => {
		// A review with no diff is a review of nothing. Running the lenses on it
		// would spend credits having a model speculate from a title.
		readPullRequestIntoReview.mockResolvedValue({
			review: { id: "review-1", status: "FAILED" },
		});

		const result = await runAutomaticPrReview(INPUT);

		expect(result).toEqual({
			ran: false,
			skipped: "no-diff",
			reviewId: "review-1",
		});
		expect(runQaLens).not.toHaveBeenCalled();
	});
});

describe("runAutomaticPrReview — the same commit twice", () => {
	// The review row is keyed by head commit, so a repeat delivery for the SAME
	// commit resolves the SAME row. Without a guard each one billed another QA
	// generation, and repeats are ordinary: GitHub retries a delivery it thinks
	// timed out, an operator replays one, a push can produce two events.
	const reviewed = {
		review: {
			id: "review-1",
			status: "READ",
			qaAnalysedAt: new Date("2026-08-13T10:00:00Z"),
			architectureAnalysedAt: new Date("2026-08-13T10:00:00Z"),
			postedCommentId: 987n,
		},
	};

	it("spends nothing when every enabled lens already reviewed this commit", async () => {
		readPullRequestIntoReview.mockResolvedValue(reviewed);

		const result = await runAutomaticPrReview(INPUT);

		expect(result).toEqual({
			ran: false,
			skipped: "already-reviewed",
			reviewId: "review-1",
		});
		expect(runQaLens).not.toHaveBeenCalled();
		expect(runArchitectureLens).not.toHaveBeenCalled();
		expect(postReviewCommentForReview).not.toHaveBeenCalled();
	});

	it("still runs the lens that has NOT reviewed this commit", async () => {
		readPullRequestIntoReview.mockResolvedValue({
			review: {
				id: "review-1",
				status: "READ",
				qaAnalysedAt: new Date("2026-08-13T10:00:00Z"),
				architectureAnalysedAt: null,
				postedCommentId: 987n,
			},
		});

		const result = await runAutomaticPrReview(INPUT);

		expect(result.ran).toBe(true);
		expect(runArchitectureLens).toHaveBeenCalled();
	});

	it("ignores a lens the project switched off when deciding", async () => {
		// Architecture is off, so its missing timestamp must not force a re-run
		// of the QA lens that already ran.
		getProjectQaSettings.mockResolvedValue({
			prReviewAutoReviewEnabled: true,
			prReviewQaLensEnabled: true,
			prReviewArchitectureLensEnabled: false,
		});
		readPullRequestIntoReview.mockResolvedValue({
			review: {
				id: "review-1",
				status: "READ",
				qaAnalysedAt: new Date("2026-08-13T10:00:00Z"),
				architectureAnalysedAt: null,
				postedCommentId: 987n,
			},
		});

		expect((await runAutomaticPrReview(INPUT)).skipped).toBe(
			"already-reviewed",
		);
		expect(runQaLens).not.toHaveBeenCalled();
	});
});

describe("runAutomaticPrReview — reviewed but never posted", () => {
	// The wedge this replaced, and it is the failure that actually happened: the
	// comment fails for its own reason — a credential without write access — while
	// the lens timestamps are already set. Skipping on those alone meant every
	// later delivery skipped too, and the pull request kept a completed review
	// that never reached anybody.
	const reviewedNotPosted = {
		review: {
			id: "review-1",
			status: "READ",
			qaAnalysedAt: new Date("2026-08-13T10:00:00Z"),
			architectureAnalysedAt: new Date("2026-08-13T10:00:00Z"),
			postedCommentId: null,
		},
	};

	it("retries the comment without re-billing the lenses", async () => {
		readPullRequestIntoReview.mockResolvedValue(reviewedNotPosted);

		const result = await runAutomaticPrReview(INPUT);

		expect(result.ran).toBe(true);
		expect(result.lensesSkipped).toBe(true);
		expect(result.commented).toBe(true);
		// The expensive half does not repeat.
		expect(runQaLens).not.toHaveBeenCalled();
		expect(runArchitectureLens).not.toHaveBeenCalled();
		expect(postReviewCommentForReview).toHaveBeenCalledTimes(1);
	});
});

describe("runAutomaticPrReview — the run", () => {
	it("runs both lenses and comments, counting what each produced", async () => {
		const result = await runAutomaticPrReview(INPUT);

		expect(result).toEqual({
			ran: true,
			reviewId: "review-1",
			qaFindings: 2,
			architectureFindings: 1,
			commented: true,
		});
		expect(runQaLens).toHaveBeenCalledWith({
			projectId: "proj-1",
			reviewId: "review-1",
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("skips a lens the project switched off", async () => {
		getProjectQaSettings.mockResolvedValue({
			prReviewAutoReviewEnabled: true,
			prReviewQaLensEnabled: false,
			prReviewArchitectureLensEnabled: true,
		});

		const result = await runAutomaticPrReview(INPUT);

		expect(runQaLens).not.toHaveBeenCalled();
		expect(runArchitectureLens).toHaveBeenCalled();
		expect(result.qaFindings).toBeUndefined();
		expect(result.architectureFindings).toBe(1);
	});

	it("still posts the architecture findings when the QA lens fails", async () => {
		// The failure that actually happens: a model outage. The computed findings
		// cost nothing and are still worth putting on the pull request.
		runQaLens.mockRejectedValue(new Error("provider unavailable"));

		const result = await runAutomaticPrReview(INPUT);

		expect(result.ran).toBe(true);
		expect(result.error).toContain("provider unavailable");
		expect(result.architectureFindings).toBe(1);
		expect(result.commented).toBe(true);
	});

	it("still posts the QA findings when the architecture lens fails", async () => {
		runArchitectureLens.mockRejectedValue(new Error("no import graph"));

		const result = await runAutomaticPrReview(INPUT);

		expect(result.qaFindings).toBe(2);
		expect(result.commented).toBe(true);
	});

	it("records a failed comment rather than throwing at its caller", async () => {
		// The caller answers GitHub. An exception here turns a working delivery
		// into a retried, then throttled, then disabled one.
		postReviewCommentForReview.mockRejectedValue(
			new Error("GitHub refused the comment"),
		);

		const result = await runAutomaticPrReview(INPUT);

		expect(result.ran).toBe(true);
		expect(result.commented).toBe(false);
		expect(result.error).toContain("refused");
	});

	it("never rejects, not even when the settings read fails", async () => {
		// Writing this test is what found the hole: the settings read sat outside
		// every try, so a database blip became an unhandled rejection in
		// background work nobody awaits.
		getProjectQaSettings.mockRejectedValue(new Error("database down"));

		const result = await runAutomaticPrReview(INPUT);

		expect(result.ran).toBe(false);
		expect(result.skipped).toBe("settings-unavailable");
		expect(result.error).toContain("database down");
	});
});

/**
 * The quadrant nothing covered: BOTH lenses switched off.
 *
 * `lensesAlreadyRan` was `(!qaEnabled || qaAnalysedAt) && (!archEnabled ||
 * archAnalysedAt)`, which is true when both lenses are off — so the run skipped
 * both lens blocks, fell through to the comment, and posted "the lenses that ran
 * reported nothing outstanding" onto a customer's pull request having checked
 * nothing at all. On every push.
 */
describe("runAutomaticPrReview — both lenses switched off", () => {
	beforeEach(() => {
		getProjectQaSettings.mockResolvedValue({
			prReviewAutoReviewEnabled: true,
			prReviewQaLensEnabled: false,
			prReviewArchitectureLensEnabled: false,
		});
	});

	it("posts nothing, and says why", async () => {
		const result = await runAutomaticPrReview(INPUT);

		expect(result).toEqual({ ran: false, skipped: "no-lens-enabled" });
		expect(postReviewCommentForReview).not.toHaveBeenCalled();
	});

	it("does not even read the pull request", async () => {
		// Refusing before spending: there is nothing any lens would do with the
		// diff, so fetching it is a wasted API call against the customer's
		// credential.
		await runAutomaticPrReview(INPUT);

		expect(readPullRequestIntoReview).not.toHaveBeenCalled();
		expect(runQaLens).not.toHaveBeenCalled();
		expect(runArchitectureLens).not.toHaveBeenCalled();
	});
});

/**
 * What the comment is told about each lens. The composer can only be honest if
 * the run reports what it saw, and only the run sees a lens throw.
 */
describe("runAutomaticPrReview — telling the comment what happened", () => {
	it("reports a crashed QA lens as failed, and still posts", async () => {
		runQaLens.mockRejectedValue(new Error("model timeout"));

		const result = await runAutomaticPrReview(INPUT);

		expect(result.commented).toBe(true);
		expect(postReviewCommentForReview).toHaveBeenCalledWith(
			expect.objectContaining({ lensOutcomes: { QA: "failed" } }),
		);
	});

	it("distinguishes a missing AI provider from a lens that found nothing", async () => {
		runQaLens.mockResolvedValue({ configured: false, findings: [] });

		await runAutomaticPrReview(INPUT);

		expect(postReviewCommentForReview).toHaveBeenCalledWith(
			expect.objectContaining({ lensOutcomes: { QA: "no-ai-provider" } }),
		);
	});

	it("reports an unindexed repository rather than a clean architecture pass", async () => {
		runArchitectureLens.mockResolvedValue({ indexed: false, findings: [] });

		await runAutomaticPrReview(INPUT);

		expect(postReviewCommentForReview).toHaveBeenCalledWith(
			expect.objectContaining({
				lensOutcomes: { ARCHITECTURE: "not-indexed" },
			}),
		);
	});

	it("passes no outcome at all when both lenses ran cleanly", async () => {
		await runAutomaticPrReview(INPUT);

		expect(postReviewCommentForReview).toHaveBeenCalledWith(
			expect.objectContaining({ lensOutcomes: {} }),
		);
	});
});

/**
 * The automatic path used to write NOTHING to the audit log.
 *
 * Its button-driven twin has always been audited, so the one case where no human
 * witnessed Fabric writing into a customer's repository was also the one case
 * with no record of it. That matters more here than there: the delivery which
 * triggered this was authenticated by a secret shared across the deployment, so
 * the audit row is what says whose credential actually wrote.
 */
describe("runAutomaticPrReview — leaving a record", () => {
	it("audits the comment it posted, marked as webhook-triggered", async () => {
		await runAutomaticPrReview(INPUT);

		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "project.pull_request.comment_posted",
				projectId: "proj-1",
				organizationId: "org-1",
				metadata: expect.objectContaining({
					trigger: "webhook",
					prNumber: 42,
				}),
			}),
		);
	});

	it("records whether it created a comment or edited one in place", async () => {
		postReviewCommentForReview.mockResolvedValue({
			url: "u",
			updated: true,
			findings: 3,
		});

		await runAutomaticPrReview(INPUT);

		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ mode: "updated" }),
			}),
		);
	});

	it("writes no audit row when the comment failed", async () => {
		// Nothing reached the repository, so there is nothing to record. An audit
		// row here would claim Fabric wrote something it did not.
		postReviewCommentForReview.mockRejectedValue(new Error("403"));

		await runAutomaticPrReview(INPUT);

		expect(recordAudit).not.toHaveBeenCalled();
	});
});

/**
 * Each lens is gated on ITS OWN outstanding work.
 *
 * The gates read `!lensesAlreadyRan`, which is
 * `qaOutstanding || architectureOutstanding` — so whenever one lens still had
 * work the OTHER one re-ran as well. A redelivery of a commit whose QA lens had
 * finished but whose architecture lens had thrown billed a second QA generation
 * AND replaced the findings already stored for that commit, which is exactly what
 * the short-circuit's own comment says it prevents.
 *
 * Redeliveries are ordinary: GitHub retries a delivery it thinks timed out, an
 * operator replays one, and a push can produce two `synchronize` events.
 */
describe("runAutomaticPrReview — one lens outstanding must not re-run the other", () => {
	beforeEach(() => {
		readPullRequestIntoReview.mockResolvedValue({
			review: {
				id: "review-1",
				status: "READ",
				// QA finished on an earlier delivery for this same commit.
				qaAnalysedAt: new Date("2026-08-19T10:00:00Z"),
				// Architecture threw, so it is the only outstanding work.
				architectureAnalysedAt: null,
				postedCommentId: null,
			},
		});
	});

	it("does not re-run — or re-bill — the lens that already finished", async () => {
		await runAutomaticPrReview(INPUT);

		expect(runQaLens).not.toHaveBeenCalled();
	});

	it("still runs the lens that is actually outstanding", async () => {
		await runAutomaticPrReview(INPUT);

		expect(runArchitectureLens).toHaveBeenCalledTimes(1);
	});

	it("reports the finished lens as clean rather than as failed", async () => {
		// It did not run on THIS pass, but it ran on an earlier one, so the stored
		// timestamp is what the comment should speak from.
		await runAutomaticPrReview(INPUT);

		expect(postReviewCommentForReview).toHaveBeenCalledWith(
			expect.objectContaining({ lensOutcomes: {} }),
		);
	});

	it("runs neither when both have already finished, and posts nothing new", async () => {
		readPullRequestIntoReview.mockResolvedValue({
			review: {
				id: "review-1",
				status: "READ",
				qaAnalysedAt: new Date("2026-08-19T10:00:00Z"),
				architectureAnalysedAt: new Date("2026-08-19T10:00:00Z"),
				postedCommentId: 987n,
			},
		});

		const result = await runAutomaticPrReview(INPUT);

		expect(result.skipped).toBe("already-reviewed");
		expect(runQaLens).not.toHaveBeenCalled();
		expect(runArchitectureLens).not.toHaveBeenCalled();
	});
});
