/**
 * The order findings come back in — which is the order they are READ in, both in
 * Fabric and in the customer's pull request.
 *
 * Both read paths ordered with `orderBy: [{ severity: "asc" }, ...]` on a plain
 * String column, so Postgres sorted the words: HIGH < LOW < MEDIUM. A MEDIUM
 * finding therefore rendered BELOW a LOW one, in the app and in the comment
 * Fabric writes into somebody else's repository.
 *
 * `bySeverityThenAge` already existed to fix exactly this, with a comment
 * explaining the alphabetical trap — and zero call sites. It has two now.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reviewFindFirst } = vi.hoisted(() => ({
	reviewFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		pullRequestReview: {
			findFirst: (...a: unknown[]) => reviewFindFirst(...a),
		},
	},
}));

const {
	bySeverityThenAge,
	getPullRequestReview,
	getPullRequestReviewForPosting,
} = await import("../prisma/queries/projects/pull-request-reviews");

const at = (iso: string) => new Date(iso);

/** Deliberately in the order the broken alphabetical sort produced. */
function shuffledFindings() {
	return [
		{
			id: "f-high",
			severity: "HIGH",
			createdAt: at("2026-08-13T00:00:03.000Z"),
		},
		{
			id: "f-low",
			severity: "LOW",
			createdAt: at("2026-08-13T00:00:02.000Z"),
		},
		{
			id: "f-medium",
			severity: "MEDIUM",
			createdAt: at("2026-08-13T00:00:01.000Z"),
		},
	];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("bySeverityThenAge", () => {
	it("ranks HIGH above MEDIUM above LOW, not alphabetically", () => {
		const sorted = shuffledFindings().sort(bySeverityThenAge);

		expect(sorted.map((f) => f.severity)).toEqual([
			"HIGH",
			"MEDIUM",
			"LOW",
		]);
	});

	it("breaks ties by age so a re-run does not reshuffle equal rows", () => {
		const older = {
			id: "older",
			severity: "HIGH",
			createdAt: at("2026-08-13T00:00:01.000Z"),
		};
		const newer = {
			id: "newer",
			severity: "HIGH",
			createdAt: at("2026-08-13T00:00:09.000Z"),
		};

		expect([newer, older].sort(bySeverityThenAge).map((f) => f.id)).toEqual(
			["older", "newer"],
		);
	});

	it("puts an unrecognised severity last rather than first", () => {
		// A severity nothing ranks must not outrank HIGH by accident.
		const rogue = {
			id: "rogue",
			severity: "SPICY",
			createdAt: at("2026-08-13T00:00:00.000Z"),
		};

		const sorted = [rogue, ...shuffledFindings()].sort(bySeverityThenAge);

		expect(sorted.at(-1)?.id).toBe("rogue");
	});
});

describe("the read paths apply it", () => {
	it("getPullRequestReview returns worst-first", async () => {
		reviewFindFirst.mockResolvedValue({
			id: "review-1",
			findings: shuffledFindings(),
		});

		const review = await getPullRequestReview({
			id: "review-1",
			projectId: "proj-1",
		});

		expect(review?.findings.map((f) => f.severity)).toEqual([
			"HIGH",
			"MEDIUM",
			"LOW",
		]);
	});

	it("getPullRequestReviewForPosting returns worst-first — this one reaches the customer", async () => {
		reviewFindFirst.mockResolvedValue({
			id: "review-1",
			provider: "GITHUB",
			findings: shuffledFindings(),
		});

		const review = await getPullRequestReviewForPosting({
			id: "review-1",
			projectId: "proj-1",
		});

		expect(review?.findings.map((f) => f.severity)).toEqual([
			"HIGH",
			"MEDIUM",
			"LOW",
		]);
	});

	it("no longer asks the database to sort severity as a word", async () => {
		reviewFindFirst.mockResolvedValue({ id: "review-1", findings: [] });

		await getPullRequestReview({ id: "review-1", projectId: "proj-1" });

		const [args] = reviewFindFirst.mock.calls[0] as [
			{ select: { findings: { orderBy: unknown } } },
		];
		expect(args.select.findings.orderBy).toEqual({ createdAt: "asc" });
	});
});
