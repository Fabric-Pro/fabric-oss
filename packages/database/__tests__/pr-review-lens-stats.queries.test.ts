/**
 * `getPrReviewLensStats` — the number behind the feature's false-positive target.
 *
 * The target ("under 20%, measured by developer feedback") was unfalsifiable
 * until something computed it. Three properties decide whether the figure is
 * honest, and all three are asserted here:
 *
 *  1. **Only judged findings count.** An OPEN finding is one nobody ruled on.
 *     Counting it as correct flatters the lens; counting it as wrong damns it.
 *     Neither is in the data, so it stays out of the denominator. A verdict is
 *     only ever written to the ledger, so "unjudged" is simply "absent".
 *  2. **A lens nobody has judged reports null, not zero.** "No false positives"
 *     and "no evidence either way" are opposite claims, and 0% is the more
 *     dangerous of the two to print.
 *  3. **A false positive is a dismissal reasoned INCORRECT, not any dismissal.**
 *     This is what changed. The figure was the DISMISSAL rate presented as the
 *     false-positive rate, and three of the four reasons record that a CORRECT
 *     finding went unactioned. Both numbers are returned now, separately.
 *
 * Read from the JUDGEMENT LEDGER rather than from the findings, because
 * re-running a lens deletes those — so the published figure used to be erased by
 * the architecture lens, which is free to re-run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { groupBy } = vi.hoisted(() => ({ groupBy: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: {
		prReviewJudgement: {
			groupBy: (...a: unknown[]) => groupBy(...a),
		},
	},
}));

const { getPrReviewLensStats } = await import(
	"../prisma/queries/projects/pull-request-reviews"
);

function row(
	lens: string,
	status: string,
	dismissalReason: string | null,
	count: number,
) {
	return { lens, status, dismissalReason, _count: { _all: count } };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getPrReviewLensStats", () => {
	it("separates the false-positive rate from the dismissal rate", async () => {
		groupBy.mockResolvedValue([
			row("QA", "ACCEPTED", null, 6),
			row("QA", "DISMISSED", "INCORRECT", 2),
			row("QA", "DISMISSED", "WONT_FIX", 2),
		]);

		const [qa] = await getPrReviewLensStats({ projectId: "proj-1" });

		// Four dismissals out of ten, but only two of them were the lens being
		// wrong. Reporting 40% as the false-positive rate is the defect.
		expect(qa).toEqual({
			lens: "QA",
			judged: 10,
			dismissed: 4,
			falsePositives: 2,
			dismissedRate: 0.4,
			falsePositiveRate: 0.2,
			meetsTarget: false,
			unclassifiedDismissals: 0,
		});
	});

	it("counts judgements per lens", async () => {
		groupBy.mockResolvedValue([
			row("QA", "ACCEPTED", null, 8),
			row("QA", "DISMISSED", "INCORRECT", 2),
			row("ARCHITECTURE", "ACCEPTED", null, 3),
			row("ARCHITECTURE", "DISMISSED", "INCORRECT", 1),
		]);

		const stats = await getPrReviewLensStats({ projectId: "proj-1" });

		expect(stats.map((s) => [s.lens, s.judged, s.falsePositives])).toEqual([
			["ARCHITECTURE", 4, 1],
			["QA", 10, 2],
		]);
	});

	it("asks the ledger only for this project", async () => {
		groupBy.mockResolvedValue([]);

		await getPrReviewLensStats({ projectId: "proj-1" });

		// Another project's judgements must never reach this project's rate. There
		// is no status filter any more: the ledger only ever holds verdicts, so an
		// unjudged finding cannot appear in it at all.
		expect(groupBy).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: "proj-1" } }),
		);
	});

	it("clears the target when the rate is under 20%", async () => {
		groupBy.mockResolvedValue([
			row("QA", "ACCEPTED", null, 19),
			row("QA", "DISMISSED", "INCORRECT", 1),
		]);

		const [qa] = await getPrReviewLensStats({ projectId: "proj-1" });

		expect(qa.falsePositiveRate).toBeCloseTo(0.05);
		expect(qa.meetsTarget).toBe(true);
	});

	it("treats exactly 20% as failing, because the target is UNDER 20%", async () => {
		groupBy.mockResolvedValue([
			row("QA", "ACCEPTED", null, 8),
			row("QA", "DISMISSED", "INCORRECT", 2),
		]);

		const [qa] = await getPrReviewLensStats({ projectId: "proj-1" });

		expect(qa.falsePositiveRate).toBe(0.2);
		expect(qa.meetsTarget).toBe(false);
	});

	it("counts a dismissal with no reason as judged but never as a false positive", async () => {
		// Judgements recorded before reasons existed, carried over by the
		// migration. They belong in the denominator — somebody did rule on them —
		// but calling them false positives would invent a verdict. Surfaced as a
		// count so a low rate is distinguishable from an unclassified one.
		groupBy.mockResolvedValue([
			row("QA", "ACCEPTED", null, 5),
			row("QA", "DISMISSED", null, 5),
		]);

		const [qa] = await getPrReviewLensStats({ projectId: "proj-1" });

		expect(qa).toEqual({
			lens: "QA",
			judged: 10,
			dismissed: 5,
			falsePositives: 0,
			dismissedRate: 0.5,
			falsePositiveRate: 0,
			meetsTarget: true,
			unclassifiedDismissals: 5,
		});
	});

	it("returns nothing for a project nobody has judged", async () => {
		// No ledger rows means no lens entry, rather than a lens sitting at 0%.
		groupBy.mockResolvedValue([]);

		expect(await getPrReviewLensStats({ projectId: "proj-1" })).toEqual([]);
	});
});
