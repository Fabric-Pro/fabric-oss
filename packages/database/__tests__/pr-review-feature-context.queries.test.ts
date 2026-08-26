/**
 * `listFeaturesForPrReview` — the feature context the QA review lens reasons over.
 *
 * Found untested by the QA lens reviewing its own pull request (#2411). It is
 * load-bearing rather than cosmetic: the CALLER caps this list at
 * `PR_REVIEW_MAX_FEATURES`, so the ordering here decides which features the model
 * ever sees. Get it wrong and the lens silently reasons about the best-covered
 * features while the untested ones fall off the end — the exact opposite of the
 * job.
 *
 * That is precisely what it did. The cap was a `take` on a query ordered by
 * `createdAt desc`, and the coverage ordering was applied in memory to whatever
 * survived it, so above the limit the least-covered features were discarded
 * before anything ranked them. The ranking now decides the cap.
 *
 * Asserts the `where`/`select` handed to a mocked Prisma client plus the
 * ordering; no database needed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { storyFindMany, linkFindMany, linkGroupBy } = vi.hoisted(() => ({
	storyFindMany: vi.fn(),
	linkFindMany: vi.fn(),
	linkGroupBy: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		userStory: { findMany: (...a: unknown[]) => storyFindMany(...a) },
		testCaseWorkItemLink: {
			findMany: (...a: unknown[]) => linkFindMany(...a),
			groupBy: (...a: unknown[]) => linkGroupBy(...a),
		},
		project: { findUnique: vi.fn() },
	},
}));

const { listFeaturesForPrReview } = await import(
	"../prisma/queries/projects/pull-request-reviews"
);

type Feature = { id: string; identifier: string; createdAt: Date };

/**
 * The query reads features twice — scalar columns to rank them, then the full
 * rows for whichever survived the cap. This answers both from one fixture, so a
 * test states its features once.
 */
function givenFeatures(features: Feature[]) {
	storyFindMany.mockImplementation(
		async (args: {
			select?: { createdAt?: boolean };
			where?: { id?: { in: string[] } };
		}) => {
			if (args.select?.createdAt) {
				return features.map((f) => ({
					id: f.id,
					createdAt: f.createdAt,
				}));
			}
			const wanted = new Set(args.where?.id?.in ?? []);
			return features
				.filter((f) => wanted.has(f.id))
				.map((f) => ({
					id: f.id,
					identifier: f.identifier,
					title: `Feature ${f.identifier}`,
					acceptanceCriteria: "- does a thing",
				}));
		},
	);
}

/** `{ storyId: caseTitles }` — drives both the count and the titles. */
function givenCoverage(byStory: Record<string, string[]>) {
	linkGroupBy.mockResolvedValue(
		Object.entries(byStory)
			.filter(([, titles]) => titles.length > 0)
			.map(([userStoryId, titles]) => ({
				userStoryId,
				_count: { _all: titles.length },
			})),
	);
	linkFindMany.mockImplementation(
		async (args: { where?: { userStoryId?: { in: string[] } } }) => {
			const wanted = new Set(args.where?.userStoryId?.in ?? []);
			return Object.entries(byStory).flatMap(([userStoryId, titles]) =>
				wanted.has(userStoryId)
					? titles.map((title) => ({
							userStoryId,
							testCase: { title },
						}))
					: [],
			);
		},
	);
}

const at = (iso: string) => new Date(iso);

beforeEach(() => {
	vi.clearAllMocks();
	givenFeatures([]);
	givenCoverage({});
});

describe("listFeaturesForPrReview", () => {
	it("asks only for FEATUREs in this project — a bug is not a specification", async () => {
		// A bug reports broken behaviour; it is not something a change can fail to
		// cover, so including bugs would spend the feature cap on rows the lens
		// cannot reason about.
		await listFeaturesForPrReview({ projectId: "proj-1" });

		expect(storyFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj-1", kind: "FEATURE" },
			}),
		);
	});

	it("orders the LEAST covered features first", async () => {
		givenFeatures([
			{
				id: "s-well-covered",
				identifier: "F-1",
				createdAt: at("2026-01-03"),
			},
			{
				id: "s-uncovered",
				identifier: "F-2",
				createdAt: at("2026-01-02"),
			},
			{
				id: "s-one-case",
				identifier: "F-3",
				createdAt: at("2026-01-01"),
			},
		]);
		givenCoverage({
			"s-well-covered": ["a", "b"],
			"s-one-case": ["c"],
		});

		const result = await listFeaturesForPrReview({ projectId: "proj-1" });

		// Zero cases, then one, then two. The caller's cap sheds from the END, so
		// this order is what keeps the untested features in front of the model.
		expect(result.map((f) => f.identifier)).toEqual(["F-2", "F-3", "F-1"]);
	});

	it("keeps the least-covered feature when there are more features than the cap", async () => {
		// The regression. With the cap applied to `createdAt desc` before anything
		// ranked coverage, the OLDEST feature fell off the end — and here that is
		// the only untested one, the single row this lens exists to surface.
		const features: Feature[] = Array.from({ length: 45 }, (_, i) => ({
			id: `s-${i}`,
			identifier: `F-${i}`,
			// s-0 is the oldest, so `createdAt desc` sheds it first.
			createdAt: at(
				`2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
			),
		}));
		givenFeatures(features);
		givenCoverage(
			Object.fromEntries(
				features
					.filter((f) => f.id !== "s-0")
					.map((f) => [f.id, ["a case"]]),
			),
		);

		const result = await listFeaturesForPrReview({
			projectId: "proj-1",
			limit: 40,
		});

		expect(result).toHaveLength(40);
		expect(result[0].identifier).toBe("F-0");
		expect(result[0].linkedCaseTitles).toEqual([]);
	});

	it("attaches each feature's linked case titles", async () => {
		givenFeatures([
			{ id: "s-1", identifier: "F-1", createdAt: at("2026-01-01") },
		]);
		givenCoverage({ "s-1": ["Retries once on timeout"] });

		const [feature] = await listFeaturesForPrReview({
			projectId: "proj-1",
		});

		// The case TITLES are the only evidence of coverage the lens is given, so a
		// dropped title reads to the model as an uncovered feature.
		expect(feature.linkedCaseTitles).toEqual(["Retries once on timeout"]);
	});

	it("counts only LIVE cases from THIS project towards coverage", async () => {
		givenFeatures([
			{ id: "s-1", identifier: "F-1", createdAt: at("2026-01-01") },
		]);

		await listFeaturesForPrReview({ projectId: "proj-1" });

		// A deleted case must not make an untested feature read as covered —
		// which is why the ranking cannot be an `orderBy` on the relation count,
		// since Prisma would count the deleted one.
		expect(linkGroupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					testCase: { projectId: "proj-1", deletedAt: null },
				}),
			}),
		);
		expect(linkFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					testCase: { projectId: "proj-1", deletedAt: null },
				}),
			}),
		);
	});

	it("returns a feature with no links as explicitly uncovered, not missing", async () => {
		givenFeatures([
			{ id: "s-1", identifier: "F-1", createdAt: at("2026-01-01") },
		]);
		givenCoverage({});

		const result = await listFeaturesForPrReview({ projectId: "proj-1" });

		expect(result).toHaveLength(1);
		expect(result[0].linkedCaseTitles).toEqual([]);
	});

	it("skips the title query entirely when the project has no features", async () => {
		const result = await listFeaturesForPrReview({ projectId: "proj-1" });

		expect(result).toEqual([]);
		// An `IN ()` over an empty list is a query for nothing.
		expect(linkFindMany).not.toHaveBeenCalled();
	});

	it("clamps the limit so one caller cannot pull the whole backlog", async () => {
		const features: Feature[] = Array.from({ length: 250 }, (_, i) => ({
			id: `s-${i}`,
			identifier: `F-${i}`,
			createdAt: at("2026-01-01"),
		}));
		givenFeatures(features);

		const result = await listFeaturesForPrReview({
			projectId: "proj-1",
			limit: 5000,
		});

		// The promise is about what comes BACK. Asserting the `take` argument
		// pinned the mechanism instead, and the mechanism had to move: ranking
		// cannot decide the cap while the database is applying it.
		expect(result).toHaveLength(200);
	});
});
