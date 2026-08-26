/**
 * `replaceLensFindings` — the re-run lifecycle.
 *
 * Found untested by the QA review lens reviewing its own pull request (#2411).
 * Two properties here were documented in the model comment and the changeset and
 * asserted nowhere:
 *
 *  1. delete + insert + stamp happen in ONE transaction, so a review can never be
 *     marked analysed while carrying the previous run's findings — or none at all;
 *  2. a re-run DISCARDS prior ACCEPTED/DISMISSED judgements, deliberately, because
 *     they were judgements about previous wording over a previous commit's diff.
 *
 * Property 2 is the surprising one, which is exactly why it needs a test saying so
 * out loud: a future reader who thinks it is a bug will find the reasoning here
 * rather than "fixing" it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMany, createMany, findMany, update, transaction, projectFind } =
	vi.hoisted(() => ({
		deleteMany: vi.fn(),
		createMany: vi.fn(),
		findMany: vi.fn(),
		update: vi.fn(),
		transaction: vi.fn(),
		projectFind: vi.fn(),
	}));

vi.mock("../prisma/client", () => {
	const tx = {
		pullRequestReviewFinding: {
			deleteMany: (...a: unknown[]) => deleteMany(...a),
			createMany: (...a: unknown[]) => createMany(...a),
			findMany: (...a: unknown[]) => findMany(...a),
		},
		pullRequestReview: { update: (...a: unknown[]) => update(...a) },
	};
	return {
		db: {
			project: { findUnique: (...a: unknown[]) => projectFind(...a) },
			// Runs the callback with the tx client, exactly as Prisma would — the
			// point being that every write below lands inside one.
			$transaction: (fn: (t: typeof tx) => unknown) => {
				transaction();
				return fn(tx);
			},
		},
	};
});

const { replaceLensFindings } = await import(
	"../prisma/queries/projects/pull-request-reviews"
);

const FINDING = {
	severity: "MEDIUM",
	title: "Retry path is untested",
	detail: "No case asserts a single capture.",
	recommendation: "Add a case asserting one charge after two retries.",
	filePath: "src/capture.ts",
	line: 12,
	storyId: null,
	criterionRef: null,
};

const ANALYSED_AT = new Date("2026-07-30T00:00:00.000Z");

function run(over: Partial<Parameters<typeof replaceLensFindings>[0]> = {}) {
	return replaceLensFindings({
		reviewId: "rev-1",
		projectId: "proj-1",
		lens: "QA",
		model: "gpt-4.1-mini",
		analysedAt: ANALYSED_AT,
		findings: [FINDING],
		...over,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	projectFind.mockResolvedValue({ organizationId: "org-1", userId: null });
	deleteMany.mockResolvedValue({ count: 1 });
	createMany.mockResolvedValue({ count: 1 });
	update.mockResolvedValue({});
	findMany.mockResolvedValue([]);
});

describe("replaceLensFindings", () => {
	it("does everything inside ONE transaction", async () => {
		await run();

		// If the stamp landed outside it, a failed insert would leave a review that
		// says "analysed" over the previous run's findings.
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(deleteMany).toHaveBeenCalled();
		expect(createMany).toHaveBeenCalled();
		expect(update).toHaveBeenCalled();
	});

	it("deletes only THIS lens's findings, scoped by project as well as review", async () => {
		await run();

		expect(deleteMany).toHaveBeenCalledWith({
			where: { reviewId: "rev-1", projectId: "proj-1", lens: "QA" },
		});
	});

	it("discards prior accept/dismiss judgements — deliberately", async () => {
		// The delete carries no status filter, so ACCEPTED and DISMISSED rows go
		// with the rest. They were judgements about previous wording over a previous
		// commit's diff; carrying them onto new text would show a verdict nobody
		// gave. If you are here because this looks wrong, that is the reasoning.
		await run();

		const where = deleteMany.mock.calls[0][0].where;
		expect(where).not.toHaveProperty("status");
	});

	it("takes tenant columns from the parent project, never from the caller", async () => {
		projectFind.mockResolvedValue({
			organizationId: "org-owning-the-project",
			userId: null,
		});

		await run();

		expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
			organizationId: "org-owning-the-project",
			userId: null,
		});
	});

	it("stamps the QA columns for the QA lens", async () => {
		await run({ lens: "QA" });

		expect(update).toHaveBeenCalledWith({
			where: { id: "rev-1" },
			data: {
				qaAnalysedAt: ANALYSED_AT,
				qaAnalysisModel: "gpt-4.1-mini",
			},
		});
	});

	it("stamps ONLY the architecture column for the architecture lens", async () => {
		// No model counterpart: that lens computes, so there is nothing to
		// attribute, and writing a model name would be a lie about provenance.
		await run({ lens: "ARCHITECTURE", model: null });

		expect(update).toHaveBeenCalledWith({
			where: { id: "rev-1" },
			data: { architectureAnalysedAt: ANALYSED_AT },
		});
	});

	it("still stamps when the run found NOTHING", async () => {
		// An empty set with a timestamp is a real result — the lens ran and was
		// happy. Skipping the stamp here would make it read as never having run.
		await run({ findings: [] });

		expect(createMany).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalled();
	});
});
