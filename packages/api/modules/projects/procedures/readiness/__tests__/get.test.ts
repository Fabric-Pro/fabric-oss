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
		// The CLI-connection block's two viewer reads (Fizzy #2457): the
		// viewer's organization role and their dismissal. Both are skipped
		// outright when the rollout gate is off.
		member: { findFirst: vi.fn() },
		cliConnectionPromptDismissal: { findUnique: vi.fn() },
		// Kept solely so the tests can prove this read is never issued: whether
		// the project is live now comes back on the evidence gather, off the
		// row it has already read by the same primary key.
		project: { findUnique: vi.fn() },
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
import { READINESS_RULES } from "../../../lib/readiness/registry";
import {
	CONTEXT_AND_CONNECTIONS_THRESHOLD_KEYS,
	getReadinessProcedure,
} from "../get";

const INPUT = { projectId: "p1", organizationId: null };

/**
 * FIXTURE — what `gatherReadinessEvidence` hands back (Fizzy #2457).
 *
 * It now resolves two things the read path used to fetch for itself: the
 * project's own non-rule facts, off the row it already reads by primary key,
 * and the CLI rollout gate. So every fixture here carries them, and the two
 * things a test wants to vary — the project's status and the gate — are set
 * through the mutable values below rather than by staging a second query.
 *
 * Installed as an implementation rather than a resolved value because several
 * tests flip the gate AFTER staging the project.
 */
const PROJECT_NAME = "Example project";
let nudgeEnabled = true;
let projectStatus = "ACTIVE";

function gatherReturns(evidence: unknown, tenant: unknown) {
	mockGather.mockImplementation(async () => ({
		evidence,
		tenant,
		project: { name: PROJECT_NAME, status: projectStatus },
		cliNudgeEnabled: nudgeEnabled,
	}));
}

/** The shape these tests read off the payload. */
interface ReadinessPayload {
	enabled: boolean;
	projectName: string;
	level: string;
	items: Array<{
		key: string;
		isComplete: boolean;
		manualState: string | null;
	}>;
	activeGaps: Array<{ key: string }>;
	completedCount: number;
	totalCount: number;
	recentlyCompleted: Array<{ key: string }>;
	attention: {
		changes: Array<{ key: string; kind: string }>;
		levelDropped: boolean;
		seenAt: Date | null;
		autoExpandedAt: Date | null;
	};
	cliConnection: {
		organizationConnected: boolean;
		viewerCanCreateKey: boolean;
		viewerDismissed: boolean;
		promptEligible: boolean;
	};
}

function callHandler(userId = "user-1") {
	// oRPC exposes the composed handler on the procedure definition; calling it
	// directly keeps this a unit test of the read path rather than of oRPC.
	const handler = (
		getReadinessProcedure as unknown as {
			"~orpc": { handler: (opts: unknown) => Promise<unknown> };
		}
	)["~orpc"].handler;
	return handler({
		input: INPUT,
		context: { user: { id: userId }, session: {} },
	}) as Promise<ReadinessPayload>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockIsFeatureEnabled.mockResolvedValue(true);
	mockGetProjectRole.mockResolvedValue("owner");
	mockDb.projectReadinessItemState.findMany.mockResolvedValue([]);
	mockDb.projectReadinessVerdict.findMany.mockResolvedValue([]);
	mockDb.projectUserPreference.findUnique.mockResolvedValue(null);
	mockDb.member.findFirst.mockResolvedValue(null);
	mockDb.cliConnectionPromptDismissal.findUnique.mockResolvedValue(null);
	mockDb.$transaction.mockResolvedValue([]);
	nudgeEnabled = true;
	projectStatus = "ACTIVE";
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
		gatherReturns(evidence, { userId: "u", organizationId: null });

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
		gatherReturns(emptyEvidence(), { userId: "u", organizationId: null });

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
		gatherReturns(evidenceWithSomeComplete(), {
			userId: "u",
			organizationId: null,
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
			createdAt: Date;
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
			// FIXTURE, not an assertion: every real verdict row has a
			// `createdAt`, and the introduction suppression now dates the CLI
			// row's arrival from it rather than from a ship-date constant. A
			// fixture without one would read as "these rows are being seeded on
			// this very read", which suppresses the level drop these tests are
			// about. Long-standing rows, which is what this suite describes.
			createdAt: new Date("2020-01-01"),
			...overrides,
		}));
	}

	beforeEach(() => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		gatherReturns(someComplete(), { userId: "u", organizationId: null });
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

		// Dated after the CLI row shipped on purpose: a viewer whose marker
		// predates it has their first level drop suppressed as the row's
		// introduction blast, which is asserted in its own suite below.
		mockDb.projectUserPreference.findUnique.mockResolvedValue({
			readinessSeenAt: new Date("2026-09-10T00:00:00.001Z"),
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

/**
 * The CLI-connection block: the rollout gate, eligibility, and the settle
 * constraints that ride on the same test (Fizzy #2457).
 *
 * The property worth guarding above all others is that merging this is INERT.
 * With the gate off for an organization the row is absent, the denominator is
 * what it was before the rule existed, and the level does not move — otherwise
 * every project in every readiness-enabled deployment changes verdict on the
 * day this lands.
 */

/** The row this feature adds, and the tenant that owns it in these tests. */
const CLI_KEY = "api-key-for-cli";
const ORG_TENANT = { userId: "u", organizationId: "org-1" };

/**
 * Evidence with `satisfied` of the eight Context & Connections items met.
 *
 * One counter moves two of them — `context-source` wants one indexed source and
 * `additional-context-sources` wants two — which is exactly what makes the
 * one-versus-two threshold cheap to express here.
 */
function evidenceWithContextItems(satisfied: 0 | 1 | 2) {
	const evidence = emptyEvidence();
	evidence.indexedContext.total = satisfied;
	return evidence;
}

/**
 * Set `PROJECT_READINESS` and the CLI rollout gate independently.
 *
 * A single flag value cannot express the case this whole suite exists for,
 * which is readiness on and the rollout gate off. The two now arrive by
 * different routes: readiness is the procedure's own flag read, while the
 * rollout gate rides in on the evidence gather, which is the only place it is
 * resolved.
 */
function withFlags({ readiness = true, nudge = true } = {}) {
	mockIsFeatureEnabled.mockImplementation(
		async (key: string) => key === "PROJECT_READINESS" && readiness,
	);
	nudgeEnabled = nudge;
}

/** A project that qualifies, viewed by someone who can act on the prompt. */
function qualifyingProject(satisfied: 0 | 1 | 2 = 2) {
	withFlags();
	gatherReturns(evidenceWithContextItems(satisfied), ORG_TENANT);
	mockDb.member.findFirst.mockResolvedValue({ role: "member" });
}

describe("projects.readiness.get — CLI connection eligibility", () => {
	it("offers the prompt to a member whose organization role carries key creation", async () => {
		qualifyingProject();

		const result = await callHandler();

		expect(result.cliConnection).toEqual({
			organizationConnected: false,
			viewerCanCreateKey: true,
			viewerDismissed: false,
			promptEligible: true,
		});
	});

	it("denies an organization viewer, who cannot mint a key", async () => {
		qualifyingProject();
		mockDb.member.findFirst.mockResolvedValue({ role: "viewer" });

		const result = await callHandler();

		expect(result.cliConnection.viewerCanCreateKey).toBe(false);
		expect(result.cliConnection.promptEligible).toBe(false);
	});

	it("follows the organization role even when a project-viewer row exists", async () => {
		// The trap: project membership takes precedence over organization role
		// wherever a row exists, so asking the project would hide the prompt
		// from an admin who can plainly act on it.
		qualifyingProject();
		mockDb.member.findFirst.mockResolvedValue({ role: "admin" });
		mockGetProjectRole.mockResolvedValue("viewer");

		const result = await callHandler();

		expect(result.cliConnection.promptEligible).toBe(true);
		// And the panel's own action gate is untouched by any of this.
		expect((result as unknown as { canAct: boolean }).canAct).toBe(false);
	});

	it("follows the organization role even when a project-editor row exists", async () => {
		qualifyingProject();
		mockDb.member.findFirst.mockResolvedValue({ role: "viewer" });
		mockGetProjectRole.mockResolvedValue("editor");

		const result = await callHandler();

		expect(result.cliConnection.promptEligible).toBe(false);
	});

	it("denies a guest, who has no organization membership at all", async () => {
		qualifyingProject();
		mockDb.member.findFirst.mockResolvedValue(null);
		mockGetProjectRole.mockResolvedValue("editor");

		const result = await callHandler();

		expect(result.cliConnection.viewerCanCreateKey).toBe(false);
		expect(result.cliConnection.promptEligible).toBe(false);
	});

	it("says nothing on a project with no organization", async () => {
		withFlags();
		gatherReturns(evidenceWithContextItems(2), {
			userId: "u",
			organizationId: null,
		});

		const result = await callHandler();

		expect(result.cliConnection.promptEligible).toBe(false);
		expect(
			mockDb.cliConnectionPromptDismissal.findUnique,
		).not.toHaveBeenCalled();
	});

	it("stays quiet on a project with only one of the eight satisfied", async () => {
		qualifyingProject(1);

		const result = await callHandler();

		expect(result.cliConnection.promptEligible).toBe(false);
	});

	it("counts the eight by name, so the row it adds can never be one of them", async () => {
		// The regression this guards: counting the CATEGORY instead of the list.
		// The new row lives in Context & Connections, so a category count would
		// silently have become two-of-nine and let the row be its own second
		// satisfied item.
		expect(CONTEXT_AND_CONNECTIONS_THRESHOLD_KEYS).toHaveLength(8);
		expect(CONTEXT_AND_CONNECTIONS_THRESHOLD_KEYS).not.toContain(CLI_KEY);

		const category = READINESS_RULES.filter(
			(rule) => rule.category === "CONTEXT_AND_CONNECTIONS",
		).map((rule) => rule.key);
		// The category is already larger than the counted set, and every counted
		// key still belongs to it.
		expect(category).toContain(CLI_KEY);
		expect(category.length).toBeGreaterThan(
			CONTEXT_AND_CONNECTIONS_THRESHOLD_KEYS.length,
		);
		for (const key of CONTEXT_AND_CONNECTIONS_THRESHOLD_KEYS) {
			expect(category).toContain(key);
		}
	});

	it("never prompts on an archived project", async () => {
		qualifyingProject();
		projectStatus = "ARCHIVED";

		const result = await callHandler();

		expect(result.cliConnection.promptEligible).toBe(false);
	});

	it("stops once the organization is connected, and says so", async () => {
		withFlags();
		const evidence = evidenceWithContextItems(2);
		evidence.organizationCliConnected = true;
		gatherReturns(evidence, ORG_TENANT);
		mockDb.member.findFirst.mockResolvedValue({ role: "member" });

		const result = await callHandler();

		expect(result.cliConnection.organizationConnected).toBe(true);
		expect(result.cliConnection.promptEligible).toBe(false);
		expect(
			result.items.find((item) => item.key === CLI_KEY)?.isComplete,
		).toBe(true);
	});

	it("stops for everyone once the item is marked not applicable", async () => {
		qualifyingProject();
		mockDb.projectReadinessItemState.findMany.mockResolvedValue([
			{
				itemKey: CLI_KEY,
				state: "NOT_APPLICABLE",
				snoozeUntil: null,
				personalForUserId: null,
			},
		]);

		// Reading the RESOLVED item rather than the raw connected fact is what
		// makes this work: the organization is still disconnected.
		expect((await callHandler("user-1")).cliConnection.promptEligible).toBe(
			false,
		);
		expect((await callHandler("user-2")).cliConnection.promptEligible).toBe(
			false,
		);
	});

	it("stops for the person holding an in-force snooze, and for nobody else", async () => {
		qualifyingProject();
		mockDb.projectReadinessItemState.findMany.mockResolvedValue([
			{
				itemKey: CLI_KEY,
				state: "SNOOZED",
				snoozeUntil: new Date(Date.now() + 60_000),
				personalForUserId: "user-1",
			},
		]);

		expect((await callHandler("user-1")).cliConnection.promptEligible).toBe(
			false,
		);
		expect((await callHandler("user-2")).cliConnection.promptEligible).toBe(
			true,
		);
	});

	it("comes back for that person once the snooze lapses", async () => {
		qualifyingProject();
		mockDb.projectReadinessItemState.findMany.mockResolvedValue([
			{
				itemKey: CLI_KEY,
				state: "SNOOZED",
				snoozeUntil: new Date(Date.now() - 60_000),
				personalForUserId: "user-1",
			},
		]);

		expect((await callHandler("user-1")).cliConnection.promptEligible).toBe(
			true,
		);
	});

	it("stays dismissed across projects, because the decline is organization-wide", async () => {
		// A project this viewer has never opened: no preference row, no verdict
		// rows, nothing project-shaped to remember them by. The dismissal is
		// keyed on the organization, so it still answers.
		qualifyingProject();
		mockDb.cliConnectionPromptDismissal.findUnique.mockResolvedValue({
			dismissedAt: new Date("2026-09-01"),
		});

		const result = await callHandler();

		expect(result.cliConnection.viewerDismissed).toBe(true);
		expect(result.cliConnection.promptEligible).toBe(false);
		expect(
			mockDb.cliConnectionPromptDismissal.findUnique.mock.calls[0][0],
		).toMatchObject({
			where: {
				organizationId_userId: {
					organizationId: "org-1",
					userId: "user-1",
				},
			},
		});
	});

	it("treats a stored row with no timestamp as not dismissed", async () => {
		// The row is an upsert target, so its mere existence must not read as an
		// answer — the timestamp carries it.
		qualifyingProject();
		mockDb.cliConnectionPromptDismissal.findUnique.mockResolvedValue({
			dismissedAt: null,
		});

		const result = await callHandler();

		expect(result.cliConnection.viewerDismissed).toBe(false);
		expect(result.cliConnection.promptEligible).toBe(true);
	});
});

describe("projects.readiness.get — the rollout gate", () => {
	it("takes the gate from the gather, and resolves it no second time", async () => {
		// The gate is resolved once, by the gather, against the PROJECT'S
		// organization — asserted in `evidence.test.ts`, where that read lives.
		// What matters here is that this path does not ask again: two reads of
		// one org-scopable flag are two chances to disagree about it, and the
		// second one used to be issued on every readiness read.
		qualifyingProject();

		await callHandler();

		expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(1);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith("PROJECT_READINESS");
	});

	it("issues neither viewer lookup when the gate is off", async () => {
		// The common path, not an edge case: the gate is off by default and
		// rolls out one organization at a time. Both answers were being read
		// and then discarded — the row is absent from `items`, and eligibility
		// requires the row.
		qualifyingProject();
		withFlags({ nudge: false });

		const result = await callHandler();

		expect(mockDb.member.findFirst).not.toHaveBeenCalled();
		expect(
			mockDb.cliConnectionPromptDismissal.findUnique,
		).not.toHaveBeenCalled();
		expect(result.cliConnection).toEqual({
			organizationConnected: false,
			viewerCanCreateKey: false,
			viewerDismissed: false,
			promptEligible: false,
		});
	});

	it("leaves the row out and the denominator untouched when the gate is off", async () => {
		qualifyingProject();
		const on = await callHandler();

		withFlags({ nudge: false });
		const off = await callHandler();

		expect(on.items.map((item) => item.key)).toContain(CLI_KEY);
		expect(off.items.map((item) => item.key)).not.toContain(CLI_KEY);
		// The row is the ONLY thing the gate removes from the denominator, so
		// the gated-off count is what the payload carried before this rule
		// existed.
		expect(off.totalCount).toBe(on.totalCount - 1);
		expect(off.completedCount).toBe(on.completedCount);
		expect(off.activeGaps.map((item) => item.key)).toEqual(
			on.activeGaps
				.map((item) => item.key)
				.filter((key) => key !== CLI_KEY),
		);
	});

	it("does not let the row move the level when the gate is off", async () => {
		// Every other rule settled, so the new row is the one thing standing
		// between this project and Ready. With the gate on it is a Should gap
		// and the project reads Partially Ready; with the gate off it must not
		// be able to say anything at all.
		qualifyingProject();
		mockDb.projectReadinessItemState.findMany.mockResolvedValue(
			READINESS_RULES.filter((rule) => rule.key !== CLI_KEY).map(
				(rule) => ({
					itemKey: rule.key,
					state: "NOT_APPLICABLE",
					snoozeUntil: null,
					personalForUserId: null,
				}),
			),
		);

		expect((await callHandler()).level).toBe("PARTIALLY_READY");

		withFlags({ nudge: false });
		expect((await callHandler()).level).toBe("READY");
	});

	it("writes no verdict row for a row the gate is hiding", async () => {
		qualifyingProject(0);
		withFlags({ nudge: false });

		await callHandler();

		const written = mockDb.projectReadinessVerdict.upsert.mock.calls.map(
			([args]) =>
				(args as { where: { projectId_itemKey: { itemKey: string } } })
					.where.projectId_itemKey.itemKey,
		);
		expect(written).not.toContain(CLI_KEY);
	});
});

/**
 * R22 — introducing the row must not read as a readiness regression.
 *
 * Keyed on each VIEWER's own last-seen marker, never on the project's verdict
 * rows: seeding fires once per project, so a project-shaped suppression would be
 * spent by whoever opened the panel first and every colleague after them would
 * still be told their project had got worse.
 *
 * What the marker is compared against is the row's arrival ON THIS PROJECT, read
 * off its verdict row's `createdAt`, and not a global ship date. The rollout gate
 * is org-scopable and off by default, so organizations meet the row on different
 * days; a constant would announce a phantom regression to everyone in an
 * organization flagged in after it.
 */
describe("projects.readiness.get — the introduction blast", () => {
	/**
	 * Give the project a stored verdict row for the CLI item, created at
	 * `arrival` — i.e. the moment the rollout gate was switched on for this
	 * organization, since a gated-off one is never seeded the row at all.
	 *
	 * Every other row is dated long ago so nothing else in the payload moves.
	 */
	function arrivedAt(arrival: Date) {
		const items = resolveReadiness({
			evidence: evidenceWithContextItems(2),
			manualStates: [],
			viewerUserId: "user-1",
			now: new Date(),
		}).items;
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue(
			items.map((item) => ({
				itemKey: item.key,
				isComplete: item.isComplete,
				isVisible: item.isVisible,
				changedAt: new Date("2020-01-01"),
				visibleChangedAt: new Date("2020-01-01"),
				createdAt:
					item.key === CLI_KEY ? arrival : new Date("2020-01-01"),
			})),
		);
	}

	function seenBy(markers: Record<string, Date>) {
		mockDb.projectUserPreference.findUnique.mockImplementation(
			async (args: {
				where: { projectId_userId: { userId: string } };
			}) => ({
				readinessSeenAt: markers[args.where.projectId_userId.userId],
				readinessSeenLevel: "READY",
				readinessAutoExpandedAt: null,
			}),
		);
	}

	it("stays quiet for every viewer whose marker predates the row", async () => {
		qualifyingProject();
		seenBy({
			"user-1": new Date("2026-08-01"),
			"user-2": new Date("2020-06-01"),
		});

		expect((await callHandler("user-1")).attention.levelDropped).toBe(
			false,
		);
		expect((await callHandler("user-2")).attention.levelDropped).toBe(
			false,
		);
	});

	it("still reports a drop to a viewer who has looked since the row shipped", async () => {
		qualifyingProject();
		// FIXTURE, not an assertion: "since the row shipped" is now dated from
		// the row's own arrival on this project rather than from a constant, so
		// the row has to have arrived. `arrivedAt` gives it the verdict row a
		// real project would already hold; the marker below still postdates it,
		// which is the case this test has always described.
		arrivedAt(new Date("2026-09-10T00:00:00.000Z"));
		seenBy({ "user-1": new Date("2026-09-10T00:00:00.001Z") });

		expect((await callHandler("user-1")).attention.levelDropped).toBe(true);
	});

	it("stays quiet for a viewer flagged in after the row shipped elsewhere", async () => {
		// The rollout gate is org-scopable and off by default, so organizations
		// are switched on one at a time and an organization enabled LATER meets
		// the row later. This viewer's marker is well past the day the feature
		// shipped — a ship-date constant would have called them "someone who has
		// looked since" and popped the panel open announcing a regression — but
		// it predates their own organization's rollout, which is what counts.
		qualifyingProject();
		arrivedAt(new Date("2026-11-01"));
		seenBy({ "user-1": new Date("2026-10-01") });

		expect((await callHandler("user-1")).attention.levelDropped).toBe(
			false,
		);
	});

	it("stays quiet on the read that first seeds the row for the project", async () => {
		// No verdict row yet: the gate has just been enabled here and this read
		// is the row's first appearance, so no marker can postdate it however
		// recent. Fails towards saying nothing — the cost of being wrong the
		// other way is a panel forcing itself open about a regression that
		// never happened.
		qualifyingProject();
		mockDb.projectReadinessVerdict.findMany.mockResolvedValue([]);
		seenBy({ "user-1": new Date("2026-12-25") });

		expect((await callHandler("user-1")).attention.levelDropped).toBe(
			false,
		);
	});

	it("keeps the reference instant per organization but the comparison per viewer", async () => {
		// Both properties in one place. The row arrived here on the same day for
		// everyone — that half is project-wide — but whether a given viewer is
		// told about the drop still depends on their OWN marker, so the first
		// teammate to open the panel cannot consume the suppression.
		qualifyingProject();
		arrivedAt(new Date("2026-11-01"));
		seenBy({
			"user-1": new Date("2026-10-01"),
			"user-2": new Date("2026-11-02"),
		});

		expect((await callHandler("user-1")).attention.levelDropped).toBe(
			false,
		);
		expect((await callHandler("user-2")).attention.levelDropped).toBe(true);
	});

	it("suppresses nothing in an organization the gate is off for", async () => {
		// The gate has to be inert in both directions: an organization without
		// the row must report exactly the drops it reported before this landed.
		qualifyingProject();
		withFlags({ nudge: false });
		seenBy({ "user-1": new Date("2020-06-01") });

		expect((await callHandler("user-1")).attention.levelDropped).toBe(true);
	});
});

describe("projects.readiness.get — the disabled payload", () => {
	it("still validates against the output schema when readiness is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		const result = await callHandler();

		const schema = (
			getReadinessProcedure as unknown as {
				"~orpc": {
					outputSchema: { parse: (value: unknown) => unknown };
				};
			}
		)["~orpc"].outputSchema;
		expect(() => schema.parse(result)).not.toThrow();
		// Nothing to name: the shape is returned before a project is read.
		expect(result.projectName).toBe("");
		expect(result.cliConnection).toEqual({
			organizationConnected: false,
			viewerCanCreateKey: false,
			viewerDismissed: false,
			promptEligible: false,
		});
	});
});

/**
 * One project row per readiness read (Fizzy #2457).
 *
 * `gatherReadinessEvidence` reads the project by primary key; this path then
 * read the SAME row again for one column, on every readiness read and on every
 * fifteen-second poll of the open panel. Both non-rule facts it needs now come
 * back on the gather.
 */
describe("projects.readiness.get — the project row", () => {
	/** The procedure's declared output schema. */
	const outputSchema = () =>
		(
			getReadinessProcedure as unknown as {
				"~orpc": {
					outputSchema: { parse: (value: unknown) => unknown };
				};
			}
		)["~orpc"].outputSchema;

	it("takes the project's status from the gather, never a second query", async () => {
		qualifyingProject();
		projectStatus = "ARCHIVED";

		const result = await callHandler();

		expect(mockDb.project.findUnique).not.toHaveBeenCalled();
		// And the status still does its job: an archived project is never
		// interrupted with the prompt.
		expect(result.cliConnection.promptEligible).toBe(false);
	});

	it("puts the project's name on the payload", async () => {
		// The panel opened a second lazy query purely to read this one string,
		// for the view that names the project it is minting a key for.
		qualifyingProject();

		const result = await callHandler();

		expect(result.projectName).toBe(PROJECT_NAME);
	});

	it("declares the name in the output schema, not merely on the object", async () => {
		// A field the schema does not carry is a field the client never sees:
		// the schema strips what it does not declare.
		qualifyingProject();

		const parsed = outputSchema().parse(await callHandler()) as {
			projectName: string;
		};

		expect(parsed.projectName).toBe(PROJECT_NAME);
	});
});
