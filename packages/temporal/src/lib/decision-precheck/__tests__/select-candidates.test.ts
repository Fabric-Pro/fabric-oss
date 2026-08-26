/**
 * Tests for `selectCandidateDecisions` — the candidate query + relevance
 * ranking that feeds the decision-contradiction judge.
 *
 * Strategy: mock the DB boundary (`@repo/database`: the single
 * `db.architectureDecision.findMany` that fetches the judge-facing bodies) and
 * the logger, and run the REAL selection/ranking logic. Asserts it asks only
 * for ACCEPTED + REJECTED (soft-deleted excluded) in ONE query, caps at top-K,
 * ranks relevant over merely recent, and degrades to `[]` on an empty log or a
 * query throw.
 *
 * Run: pnpm --filter @repo/temporal test src/lib/decision-precheck
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({
	mockFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { architectureDecision: { findMany: mockFindMany } },
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { selectCandidateDecisions } from "../select-candidates";

type Decision = {
	id: string;
	identifier: string;
	title: string;
	status: string;
	domain: string | null;
	decision: string;
	rationale: string;
	contextProblem: string;
};

function decision(over: Partial<Decision> & { id: string }): Decision {
	return {
		identifier: `ADR-${over.id}`,
		title: "",
		status: "ACCEPTED",
		domain: null,
		decision: "",
		rationale: "",
		contextProblem: "",
		...over,
	};
}

/**
 * Wire the single DB mock from a flat decision list: the status-filtered
 * findMany returns the matching subset (recency order = array order), honoring
 * the `status.in` filter and the `take` cap.
 */
function arrange(decisions: Decision[]) {
	mockFindMany.mockImplementation(
		async (args: {
			where: { status?: { in?: string[] } };
			take?: number;
		}) => {
			const statuses = new Set(args.where.status?.in ?? []);
			const matched = decisions.filter((d) => statuses.has(d.status));
			return typeof args.take === "number"
				? matched.slice(0, args.take)
				: matched;
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("selectCandidateDecisions", () => {
	it("fetches only ACCEPTED and REJECTED, soft-deleted excluded, in a single query", async () => {
		arrange([
			decision({ id: "1", status: "ACCEPTED", title: "auth" }),
			decision({ id: "2", status: "REJECTED", title: "sessions" }),
		]);

		await selectCandidateDecisions({
			projectId: "p1",
			artifactText: "auth sessions",
		});

		// One round-trip — no wasted COUNT, no detail re-fetch.
		expect(mockFindMany).toHaveBeenCalledTimes(1);
		const { where, take } = mockFindMany.mock.calls[0][0];
		expect(where.projectId).toBe("p1");
		expect(where.deletedAt).toBeNull();
		expect(new Set(where.status.in)).toEqual(
			new Set(["ACCEPTED", "REJECTED"]),
		);
		// Bounded recent window so ranking (not recency) picks the top-K.
		expect(take).toBeGreaterThan(0);
	});

	it("merges both statuses and returns the judge-facing detail rows", async () => {
		arrange([
			decision({
				id: "1",
				status: "ACCEPTED",
				title: "Use Postgres",
				decision: "We use Postgres",
				contextProblem: "pick a database",
			}),
			decision({
				id: "2",
				status: "REJECTED",
				title: "Use Mongo",
				decision: "Mongo was ruled out",
			}),
		]);

		const result = await selectCandidateDecisions({
			projectId: "p1",
			artifactText: "postgres mongo database",
		});

		expect(result).toHaveLength(2);
		const postgres = result.find((c) => c.id === "1");
		expect(postgres?.decision).toBe("We use Postgres");
		expect(postgres?.contextProblem).toBe("pick a database");
		expect(postgres?.status).toBe("ACCEPTED");
	});

	it("caps the result at top-K", async () => {
		arrange([
			decision({ id: "1", status: "ACCEPTED", title: "alpha" }),
			decision({ id: "2", status: "ACCEPTED", title: "beta" }),
			decision({ id: "3", status: "REJECTED", title: "gamma" }),
			decision({ id: "4", status: "REJECTED", title: "delta" }),
		]);

		const result = await selectCandidateDecisions({
			projectId: "p1",
			artifactText: "alpha beta gamma delta",
			topK: 2,
		});

		expect(result).toHaveLength(2);
		// A single query serves both ranking and the judge — the cap is applied
		// in code after ranking, not via a second detail fetch.
		expect(mockFindMany).toHaveBeenCalledTimes(1);
	});

	it("ranks a relevant older decision above irrelevant recent ones", async () => {
		// Recency order = array order. The relevant decision is LAST (oldest).
		arrange([
			decision({
				id: "recent-1",
				status: "ACCEPTED",
				title: "Logging format",
				rationale: "structured json logs",
			}),
			decision({
				id: "recent-2",
				status: "ACCEPTED",
				title: "Cache eviction",
				rationale: "lru policy",
			}),
			decision({
				id: "relevant-old",
				status: "REJECTED",
				title: "GraphQL gateway",
				rationale: "graphql federation was rejected",
			}),
		]);

		const result = await selectCandidateDecisions({
			projectId: "p1",
			artifactText: "add a graphql federation gateway endpoint",
			topK: 1,
		});

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("relevant-old");
	});

	it("returns [] when the decision log is empty for both statuses", async () => {
		arrange([]);

		const result = await selectCandidateDecisions({
			projectId: "p1",
			artifactText: "anything",
		});

		expect(result).toEqual([]);
		// The single query still fires; it simply returns nothing to rank.
		expect(mockFindMany).toHaveBeenCalledTimes(1);
	});

	it("returns [] when the candidate query throws", async () => {
		mockFindMany.mockRejectedValue(new Error("decision log unavailable"));

		const result = await selectCandidateDecisions({
			projectId: "p1",
			artifactText: "anything",
		});

		expect(result).toEqual([]);
	});
});
