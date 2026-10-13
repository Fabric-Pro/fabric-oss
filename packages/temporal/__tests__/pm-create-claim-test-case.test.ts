/**
 * The PM create claim on a test case (`TestCase.pmCreateClaimId`, Fizzy
 * #3045): `acquirePmCreateClaim` and `releasePmCreateClaim` given a
 * `testCaseId` act on the `test_case` table with the same conditional
 * UPDATE as for a story, and a soft-deleted case is never claimed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	cases: new Map<string, Record<string, unknown> & { id: string }>(),
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => {
		const cell = row[key] ?? null;
		if (value && typeof value === "object" && "not" in value) {
			return cell !== null && cell !== (value as { not: unknown }).not;
		}
		return cell === value;
	});
}

function table(rows: Map<string, Row>) {
	return {
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				let count = 0;
				for (const row of rows.values()) {
					if (matches(row, where)) {
						Object.assign(row, data);
						count++;
					}
				}
				return { count };
			},
		),
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const row = rows.get(where.id);
			return row ? { ...row } : null;
		}),
	};
}

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	// The claim stamp is read from the database clock (`takeClaim`).
	readDatabaseClock: vi.fn(async () => new Date()),
	db: { testCase: table(h.cases), userStory: table(h.stories) },
}));

const { acquirePmCreateClaim, releasePmCreateClaim } = await import(
	"../src/activities/pm-integration/pm-create-claim"
);
const { db } = await import("@repo/database");

function unlinkedCase(overrides: Record<string, unknown> = {}): Row {
	return {
		id: "tc1",
		externalId: null,
		externalUrl: null,
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		deletedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	h.cases.clear();
	h.stories.clear();
	vi.clearAllMocks();
});

describe("acquirePmCreateClaim on a test case", () => {
	it("takes the claim on an unlinked, unclaimed case, in the test_case table only", async () => {
		h.cases.set("tc1", unlinkedCase());
		h.stories.set("tc1", unlinkedCase());

		const claim = await acquirePmCreateClaim({ testCaseId: "tc1" });

		expect(claim).toEqual({ claimId: expect.any(String) });
		expect(h.cases.get("tc1")).toMatchObject({
			pmCreateClaimId: (claim as { claimId: string }).claimId,
			pmCreateClaimedAt: expect.any(Date),
		});
		expect(h.stories.get("tc1")?.pmCreateClaimId).toBeNull();
		expect(db.testCase.updateMany).toHaveBeenCalledWith({
			where: {
				id: "tc1",
				externalId: null,
				pmCreateClaimId: null,
				deletedAt: null,
			},
			data: {
				pmCreateClaimId: expect.any(String),
				pmCreateClaimedAt: expect.any(Date),
			},
		});
	});

	it("says why it missed: linked, claimed, deleted or gone", async () => {
		h.cases.set(
			"tc1",
			unlinkedCase({
				externalId: "88",
				externalUrl: "https://pm.example.com/cards/88",
			}),
		);
		expect(await acquirePmCreateClaim({ testCaseId: "tc1" })).toEqual({
			miss: "linked",
			externalId: "88",
			externalUrl: "https://pm.example.com/cards/88",
		});

		h.cases.set("tc1", unlinkedCase({ pmCreateClaimId: "other" }));
		// The claim it saw, so a caller can fence its stamp on it.
		expect(await acquirePmCreateClaim({ testCaseId: "tc1" })).toEqual({
			miss: "claimed",
			heldBy: "other",
		});

		h.cases.set("tc1", unlinkedCase({ deletedAt: new Date() }));
		expect(await acquirePmCreateClaim({ testCaseId: "tc1" })).toEqual({
			miss: "missing",
		});
		expect(h.cases.get("tc1")?.pmCreateClaimId).toBeNull();

		h.cases.clear();
		expect(await acquirePmCreateClaim({ testCaseId: "tc1" })).toEqual({
			miss: "missing",
		});
	});
});

describe("releasePmCreateClaim on a test case", () => {
	it("clears only the caller's own claim", async () => {
		h.cases.set("tc1", unlinkedCase({ pmCreateClaimId: "mine" }));

		expect(
			await releasePmCreateClaim({ testCaseId: "tc1", claimId: "other" }),
		).toBe(false);
		expect(h.cases.get("tc1")?.pmCreateClaimId).toBe("mine");

		expect(
			await releasePmCreateClaim({ testCaseId: "tc1", claimId: "mine" }),
		).toBe(true);
		expect(h.cases.get("tc1")).toMatchObject({
			pmCreateClaimId: null,
			pmCreateClaimedAt: null,
		});
	});
});
