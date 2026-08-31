/**
 * The readiness read path (Fizzy #2165).
 *
 * Two properties matter more than the arithmetic, which is already covered by
 * the level tests: the feature flag must be a real gate rather than a UI hint,
 * and a project with no phase must come back unjudged rather than graded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockIsFeatureEnabled, mockGather } = vi.hoisted(() => ({
	mockDb: {
		projectReadinessItemState: { findMany: vi.fn() },
		projectReadinessVerdict: { findMany: vi.fn(), upsert: vi.fn() },
		projectUserPreference: { findUnique: vi.fn() },
		$transaction: vi.fn(async () => []),
	},
	mockIsFeatureEnabled: vi.fn(),
	mockGather: vi.fn(),
}));

// Spread the real module rather than replacing it: importing the procedure pulls
// in the whole oRPC stack, which reaches other `@repo/database` exports through
// `@repo/payments`. A bare factory would strip those and fail at import time.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mockDb,
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
	// Whether the viewer may act on an item. Owner by default here; the
	// read-only case is asserted in the panel's own tests.
	getProjectRole: (...args: unknown[]) => mockGetProjectRole(...args),
}));

const mockGetProjectRole = vi.fn(async () => "owner");

vi.mock("../../../lib/readiness/evidence", () => ({
	gatherReadinessEvidence: (...args: unknown[]) => mockGather(...args),
}));

import { emptyEvidence } from "../../../lib/readiness/__tests__/evidence-fixture";
import { resolveReadiness } from "../../../lib/readiness/level";
import { getReadinessProcedure } from "../get";

const CONTEXT = { user: { id: "user-1" }, session: {} };
const INPUT = { projectId: "p1", organizationId: null };

function callHandler() {
	// oRPC exposes the composed handler on the procedure definition; calling it
	// directly keeps this a unit test of the read path rather than of oRPC.
	const handler = (
		getReadinessProcedure as unknown as {
			"~orpc": { handler: (opts: unknown) => Promise<unknown> };
		}
	)["~orpc"].handler;
	return handler({ input: INPUT, context: CONTEXT }) as Promise<{
		enabled: boolean;
		level: string;
		items: unknown[];
		totalCount: number;
		recentlyCompleted: Array<{ key: string }>;
	}>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.projectReadinessItemState.findMany.mockResolvedValue([]);
	mockDb.projectReadinessVerdict.findMany.mockResolvedValue([]);
	mockDb.projectUserPreference.findUnique.mockResolvedValue(null);
	mockDb.$transaction.mockResolvedValue([]);
});

describe("projects.readiness.get", () => {
	it("returns a disabled shape and reads nothing when the flag is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		const result = await callHandler();

		expect(result.enabled).toBe(false);
		expect(result.items).toHaveLength(0);
		// The gate must short-circuit before any work — a flag that still runs
		// the queries and hides the output is not a kill switch.
		expect(mockGather).not.toHaveBeenCalled();
		expect(
			mockDb.projectReadinessItemState.findMany,
		).not.toHaveBeenCalled();
	});

	it("still grades a project that has no phase, and says the phase was inferred", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		const evidence = emptyEvidence();
		evidence.phase = null;
		mockGather.mockResolvedValue({
			evidence,
			tenant: { userId: "u", organizationId: null },
		});

		const result = (await callHandler()) as unknown as {
			enabled: boolean;
			level: string;
			phaseSource: string;
			totalCount: number;
		};

		expect(result.enabled).toBe(true);
		expect(result.level).toBe("NOT_READY");
		expect(result.phaseSource).toBe("inferred");
		expect(result.totalCount).toBeGreaterThan(0);
	});

	it("grades a project once a phase is set", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockGather.mockResolvedValue({
			evidence: emptyEvidence(),
			tenant: { userId: "u", organizationId: null },
		});

		const result = await callHandler();

		expect(result.enabled).toBe(true);
		expect(result.level).toBe("NOT_READY");
		expect(result.totalCount).toBeGreaterThan(0);
	});

	it("degrades to the disabled shape when the project is gone", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockGather.mockResolvedValue(null);

		const result = await callHandler();

		expect(result.enabled).toBe(false);
		expect(result.items).toHaveLength(0);
	});
});

/**
 * "Recently completed" is the one thing derivation cannot answer on its own —
 * it needs a memory of the previous verdict. The failure mode worth testing is
 * the FIRST read of a project, when that memory does not exist yet: absence of a
 * stored verdict must read as "never observed", not as "just changed", or every
 * long-standing achievement is announced as fresh news the first time anybody
 * opens the panel.
 */
describe("projects.readiness.get — recently completed", () => {
	/** Evidence where a couple of items detect complete, so there is something to report. */
	function evidenceWithSomeComplete() {
		const evidence = emptyEvidence();
		evidence.featureCount = 3;
		evidence.techStackCount = 2;
		evidence.acceptedMemberCount = 2;
		return evidence;
	}

	beforeEach(() => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockGather.mockResolvedValue({
			evidence: evidenceWithSomeComplete(),
			tenant: { userId: "u", organizationId: null },
		});
	});

	it("reports nothing on the first read, when no verdict has ever been stored", async () => {
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue([]);

		const result = await callHandler();

		// Items were already complete before Fabric ever looked. Seeding a
		// verdict row is not a completion event.
		expect(result.recentlyCompleted).toEqual([]);
	});

	it("still seeds verdict rows on that first read, so the next one can compare", async () => {
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue([]);

		await callHandler();

		expect(mockDb.$transaction).toHaveBeenCalled();
		expect(mockDb.projectReadinessVerdict.upsert).toHaveBeenCalled();
	});

	it("reports an item that was previously seen incomplete and is now complete", async () => {
		const items = resolveReadiness({
			evidence: evidenceWithSomeComplete(),
			manualStates: [],
			viewerUserId: "user-1",
			now: new Date(),
		}).items;
		const completedKey = items.find((i) => i.isComplete)?.key;
		expect(completedKey).toBeDefined();

		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			items.map((item) => ({
				itemKey: item.key,
				// Everything was incomplete last time we looked.
				isComplete: false,
				changedAt: new Date("2020-01-01"),
			})),
		);

		const result = await callHandler();

		expect(result.recentlyCompleted.map((r) => r.key)).toContain(
			completedKey,
		);
	});

	// The trap this nearly walked into a second time. Adding `isVisible` left
	// every existing row false, so the next read flips visibility on most of
	// them. If a visibility flip moved `changedAt`, that single pass would date
	// every long-finished item to now and announce the lot as recently
	// completed — which is precisely the defect this file was corrected for
	// when a missing row was read as a transition.
	it("does not resurface a long-complete item when its visibility flips", async () => {
		const items = resolveReadiness({
			evidence: evidenceWithSomeComplete(),
			manualStates: [],
			viewerUserId: "user-1",
			now: new Date(),
		}).items;

		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			items.map((item) => ({
				itemKey: item.key,
				isComplete: item.isComplete,
				// Every row as the migration leaves it.
				isVisible: false,
				visibleChangedAt: null,
				changedAt: new Date("2020-01-01"),
			})),
		);

		const result = await callHandler();

		expect(result.recentlyCompleted).toEqual([]);
	});

	it("records the visibility it just observed without touching changedAt", async () => {
		const items = resolveReadiness({
			evidence: evidenceWithSomeComplete(),
			manualStates: [],
			viewerUserId: "user-1",
			now: new Date(),
		}).items;
		const visibleItem = items.find((i) => i.isVisible);

		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			items.map((item) => ({
				itemKey: item.key,
				isComplete: item.isComplete,
				isVisible: false,
				visibleChangedAt: null,
				changedAt: new Date("2020-01-01"),
			})),
		);

		await callHandler();

		const upsertFor = mockDb.projectReadinessVerdict.upsert.mock.calls
			.map(([args]) => args as Record<string, never>)
			.find(
				(args) =>
					(
						args.where as {
							projectId_itemKey: { itemKey: string };
						}
					).projectId_itemKey.itemKey === visibleItem?.key,
			);

		expect(upsertFor?.update).toMatchObject({ isVisible: true });
		expect(upsertFor?.update).not.toHaveProperty("changedAt");
	});

	it("does not report an item that has been complete since before the window", async () => {
		const items = resolveReadiness({
			evidence: evidenceWithSomeComplete(),
			manualStates: [],
			viewerUserId: "user-1",
			now: new Date(),
		}).items;

		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			items.map((item) => ({
				itemKey: item.key,
				isComplete: item.isComplete,
				changedAt: new Date("2020-01-01"),
			})),
		);

		const result = await callHandler();

		expect(result.recentlyCompleted).toEqual([]);
	});
});

/**
 * Attention: what changed since THIS viewer last looked (Fizzy #2165).
 *
 * Verdict rows are project-wide but attention is personal, and the pairing only
 * works because `changedAt` records when a verdict FLIPPED rather than when it
 * was recomputed. A per-viewer verdict table would have been the obvious
 * mistake; these pin the behaviour that makes the shared one correct.
 */
describe("projects.readiness.get — attention", () => {
	/** Same shape the recently-completed suite uses: a few items detect complete. */
	function someComplete() {
		const evidence = emptyEvidence();
		evidence.featureCount = 3;
		evidence.techStackCount = 2;
		evidence.acceptedMemberCount = 2;
		return evidence;
	}

	function storedAs(
		overrides: Partial<{
			isComplete: boolean;
			isVisible: boolean;
			changedAt: Date;
			visibleChangedAt: Date | null;
		}> = {},
	) {
		const items = resolveReadiness({
			evidence: someComplete(),
			manualStates: [],
			viewerUserId: "user-1",
			now: new Date(),
		}).items;
		return items.map((item) => ({
			itemKey: item.key,
			isComplete: item.isComplete,
			isVisible: item.isVisible,
			changedAt: new Date("2020-01-01"),
			visibleChangedAt: new Date("2020-01-01"),
			...overrides,
		}));
	}

	beforeEach(() => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockGather.mockResolvedValue({
			evidence: someComplete(),
			tenant: { userId: "u", organizationId: null },
		});
	});

	it("reports nothing to a viewer who has never opened the panel", async () => {
		// Not "nothing changed" — nothing to compare against. Reporting every
		// flip since the beginning of the project on someone's first open is
		// noise, not news.
		mockDb.projectUserPreference.findUnique.mockResolvedValue(null);
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			storedAs({ isComplete: false }),
		);

		const result = await callHandler();

		expect(result.attention.changes).toEqual([]);
		expect(result.attention.seenAt).toBeNull();
	});

	it("reports only the flips that happened after the viewer last looked", async () => {
		mockDb.projectUserPreference.findUnique.mockResolvedValue({
			readinessSeenAt: new Date("2020-06-01"),
			readinessSeenLevel: "NOT_READY",
			readinessAutoExpandedAt: null,
		});
		// Stored as incomplete; the resolver says several are complete now, so
		// those flip on this read and are dated now — after the marker.
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			storedAs({ isComplete: false }),
		);

		const result = await callHandler();

		expect(result.attention.changes.length).toBeGreaterThan(0);
		expect(
			result.attention.changes.every((c) => c.kind === "COMPLETED"),
		).toBe(true);
	});

	it("calls an item that was complete and is not any more a regression", async () => {
		mockDb.projectUserPreference.findUnique.mockResolvedValue({
			readinessSeenAt: new Date("2020-06-01"),
			readinessSeenLevel: "READY",
			readinessAutoExpandedAt: null,
		});
		// Everything stored complete; the resolver disagrees about most of them.
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			storedAs({ isComplete: true }),
		);

		const result = await callHandler();

		expect(
			result.attention.changes.some((c) => c.kind === "REGRESSED"),
		).toBe(true);
	});

	it("calls a newly reachable item an appearance", async () => {
		mockDb.projectUserPreference.findUnique.mockResolvedValue({
			readinessSeenAt: new Date("2020-06-01"),
			readinessSeenLevel: "NOT_READY",
			readinessAutoExpandedAt: null,
		});
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			storedAs({ isVisible: false }),
		);

		const result = await callHandler();

		expect(
			result.attention.changes.some((c) => c.kind === "APPEARED"),
		).toBe(true);
	});

	it("notices the level getting worse, and stays quiet when it improves", async () => {
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(storedAs());

		mockDb.projectUserPreference.findUnique.mockResolvedValue({
			readinessSeenAt: new Date("2020-06-01"),
			readinessSeenLevel: "READY",
			readinessAutoExpandedAt: null,
		});
		expect((await callHandler()).attention.levelDropped).toBe(true);

		// Climbing back up is the project getting better; the item that caused
		// it already carries its own marker.
		mockDb.projectUserPreference.findUnique.mockResolvedValue({
			readinessSeenAt: new Date("2020-06-01"),
			readinessSeenLevel: "NOT_READY",
			readinessAutoExpandedAt: null,
		});
		expect((await callHandler()).attention.levelDropped).toBe(false);
	});
});
