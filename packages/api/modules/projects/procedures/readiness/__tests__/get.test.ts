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
