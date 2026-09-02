/**
 * The sweep's gates: flag, cadence, stale actor, and collision.
 *
 * Style follows `activities/newsletter/find-due-newsletter-projects.test.ts` —
 * mock `@temporalio/activity`, partially mock `@repo/database`, and drive time
 * with fake timers so the activity's own `new Date()` is deterministic.
 *
 * The flag is the registry's `LIVING_DOCS_REFRESH`, read through
 * `isFeatureEnabled` from `@repo/database` (Fizzy #2210) — NOT the retired
 * `@repo/utils/feature-flag` helper. Mocking the old module here would stop
 * intercepting anything and leave this suite asserting nothing while it passed,
 * so the mock lives on `@repo/database` and runs the REAL `resolveFlag`: an
 * admin override row is exercised against the shipped precedence (override >
 * env var > default) rather than a re-implementation of it.
 */

import {
	type FeatureFlagKey,
	resolveFlag,
} from "@repo/utils/feature-flag-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const { listMock, resolveActorsMock, recordOutcomesMock, flagMock } =
	vi.hoisted(() => ({
		listMock: vi.fn(),
		resolveActorsMock: vi.fn(),
		recordOutcomesMock: vi.fn(),
		flagMock: vi.fn(),
	}));

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		listEnabledAutoRefreshSettings: listMock,
		resolveValidRefreshActors: resolveActorsMock,
		recordRefreshOutcomes: recordOutcomesMock,
		isFeatureEnabled: flagMock,
		// The sweep gate reads fail-closed through this one. Same resolver
		// here, so a suite that stubs the flag on still exercises the sweep;
		// the degraded-read case is covered separately.
		isKillSwitchArmed: flagMock,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { findDueDocumentsActivity } from "../find-due-documents";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/**
 * `isRefreshDue` adds a deterministic per-document jitter of 0-23 hours on top of
 * the cadence interval, so a document is due at `interval + jitter(documentId)` —
 * NOT at the interval exactly. These ids pin the ends of that range so the
 * boundary cases below can be exact:
 *   - `doc_34` hashes to a 0-hour jitter, `doc_35` to a 23-hour one.
 * The default fixture (`doc_1`) hashes to 10 hours.
 */
const NO_JITTER_ID = "doc_34";
const MAX_JITTER_ID = "doc_35";

function daysAgo(days: number): Date {
	return new Date(NOW.getTime() - days * DAY_MS);
}

/** `days` plus `hours` before NOW — for probing across the jitter window. */
function ago(days: number, hours: number): Date {
	return new Date(NOW.getTime() - (days * DAY_MS + hours * HOUR_MS));
}

function minutesAgo(mins: number): Date {
	return new Date(NOW.getTime() - mins * MIN_MS);
}

/** An enrolled, bi-weekly document that is due and has no reason to be skipped. */
function enrolled(over: Record<string, unknown> = {}) {
	return {
		documentId: "doc_1",
		projectId: "proj_1",
		enabled: true,
		cadence: "BIWEEKLY",
		createdByUserId: "user_1",
		lastRefreshedAt: daysAgo(20),
		lastAttemptAt: null,
		organizationId: null,
		userId: "user_1",
		document: {
			title: "PRD",
			// Well outside the one-hour collision window.
			updatedAt: daysAgo(3),
			lock: null,
		},
		// The project's tenant must agree with the settings row's, or the sweep
		// fails the row closed.
		project: { userId: "user_1", organizationId: null },
		...over,
	};
}

/** The same, in an organization tenant. */
function enrolledInOrg(over: Record<string, unknown> = {}) {
	return enrolled({
		organizationId: "org_1",
		userId: null,
		project: { userId: null, organizationId: "org_1" },
		...over,
	});
}

/**
 * The two lower-precedence inputs the registry resolves the flag from.
 * `flagOverride === undefined` means "no admin row", which is NOT the same as
 * `false` — the difference is the point of the registry, since an explicit
 * `false` beats a truthy env var.
 */
let flagOverride: boolean | undefined;
let flagEnvValue: string | undefined;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.clearAllMocks();
	flagOverride = undefined;
	// The deployed posture these tests assume: turned on by env var, no
	// override row. `packages/temporal/vitest.config.ts` sets no flag env, so
	// the env is supplied here rather than read from the process.
	flagEnvValue = "true";
	flagMock.mockImplementation(
		async (key: FeatureFlagKey) =>
			resolveFlag(key, { global: flagOverride }, {
				// Both gates. The sweep requires the rollout as well as its own
				// kill switch, so an environment that only arms the brakes must
				// NOT be able to run it — that combination would rewrite enrolled
				// documents while their owners could not see the control.
				FABRIC_FEATURE_LIVING_DOCS_REFRESH: flagEnvValue,
				FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT: flagEnvValue,
			} as NodeJS.ProcessEnv).enabled,
	);
	// By default every candidate's actor is valid — the resolver returns the set
	// of documentIds it was asked about.
	resolveActorsMock.mockImplementation(
		async (candidates: Array<{ documentId: string }>) =>
			new Set(candidates.map((c) => c.documentId)),
	);
	recordOutcomesMock.mockResolvedValue(undefined);
	listMock.mockResolvedValue([]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("feature flag", () => {
	// The combination the two-gate split creates and must refuse: the kill switch
	// armed (its env var is true in every environment) while the rollout is off.
	// If the sweep ran here it would rewrite enrolled documents unattended while
	// their owners could neither see the control nor reach the procedures to stop
	// it — the brakes must not be able to drive.
	it("stands down when the brakes are armed but the feature is not rolled out", async () => {
		flagMock.mockImplementation(
			async (key: FeatureFlagKey) =>
				resolveFlag(key, { global: undefined }, {
					FABRIC_FEATURE_LIVING_DOCS_REFRESH: "true",
					// rollout deliberately unset
				} as NodeJS.ProcessEnv).enabled,
		);

		const result = await findDueDocumentsActivity();

		expect(result.due).toEqual([]);
		expect(listMock).not.toHaveBeenCalled();
	});

	it("returns nothing and issues no query when the env var is off", async () => {
		flagEnvValue = "false";

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
		expect(listMock).not.toHaveBeenCalled();
	});

	it("returns nothing when the flag is unset — the registry default is OFF", async () => {
		flagEnvValue = undefined;

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
		expect(listMock).not.toHaveBeenCalled();
	});

	it("stands the sweep down on an admin override of false, even with the env var on", async () => {
		// The runtime kill switch the retired env-var helper could not provide:
		// no redeploy, effective on the very next tick.
		flagEnvValue = "true";
		flagOverride = false;

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
		expect(listMock).not.toHaveBeenCalled();
	});

	it("resolves the gate through the shared registry, by key", async () => {
		await findDueDocumentsActivity();

		expect(flagMock).toHaveBeenCalledWith("LIVING_DOCS_REFRESH_SWEEP");
	});
});

describe("cadence", () => {
	it("includes a bi-weekly document once its interval AND its jitter have elapsed", async () => {
		// A full day past the interval is beyond the widest possible jitter (23h),
		// so this holds whatever the document id hashes to.
		listMock.mockResolvedValue([
			enrolled({ lastRefreshedAt: ago(14, 24) }),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toHaveLength(1);
		expect(due[0]?.documentId).toBe("doc_1");
	});

	it("holds a bi-weekly document back at exactly 14 days — the jitter is not up yet", async () => {
		// doc_1 carries a 10-hour jitter, so the bare interval is not enough. This is
		// what stops every document enrolled in the same batch from re-forming into a
		// herd on the same hour, every fortnight, forever.
		listMock.mockResolvedValue([
			enrolled({ lastRefreshedAt: daysAgo(14) }),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
	});

	it("excludes a bi-weekly document last refreshed 13 days ago", async () => {
		listMock.mockResolvedValue([
			enrolled({ lastRefreshedAt: daysAgo(13) }),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
	});

	it("seeds the jitter per DOCUMENT, so a bulk enrollment does not stampede", async () => {
		// The sweep must pass each row's own documentId into the cadence check. It
		// once did not — the jitter was seeded with `undefined`, which threw and took
		// the WHOLE hourly sweep down with it for every tenant. Two documents with
		// identical timestamps and different ids must not come due in the same tick.
		listMock.mockResolvedValue([
			enrolled({
				documentId: NO_JITTER_ID,
				lastRefreshedAt: daysAgo(14),
			}),
			enrolled({
				documentId: MAX_JITTER_ID,
				lastRefreshedAt: daysAgo(14),
			}),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due.map((d) => d.documentId)).toEqual([NO_JITTER_ID]);
	});

	it("refreshes only the enrolled document when a sibling is not enrolled", async () => {
		// The query already filters on enabled, so a disabled sibling never
		// reaches the activity — assert the shape the sweep actually sees.
		listMock.mockResolvedValue([enrolled()]);

		const { due } = await findDueDocumentsActivity();

		expect(due.map((d) => d.documentId)).toEqual(["doc_1"]);
	});

	it("carries a deterministic workflow id", async () => {
		listMock.mockResolvedValue([enrolled()]);

		const first = await findDueDocumentsActivity();
		const second = await findDueDocumentsActivity();

		expect(first.due[0]?.workflowId).toBe(second.due[0]?.workflowId);
		expect(first.due[0]?.workflowId).toContain("doc_1");
	});
});

describe("mis-tenanted settings", () => {
	it("fails a settings row closed when its tenant disagrees with the project's", async () => {
		// A row claiming personal on an ORG project would otherwise be run as
		// personal — resolving the actor's own AI key and billing them for an org's
		// document. It must never reach the actor check, let alone the model.
		listMock.mockResolvedValue([
			enrolled({
				organizationId: null,
				userId: "user_1",
				project: { userId: "user_1", organizationId: "org_1" },
			}),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
		// The row must never reach the actor check, let alone the model. The
		// resolver is still invoked for the tick as a whole (it no-ops on an empty
		// list without issuing a query) — what matters is that it is never ASKED
		// about this document.
		const asked = (resolveActorsMock.mock.calls[0]?.[0] ?? []) as Array<{
			documentId: string;
		}>;
		expect(asked.map((c) => c.documentId)).not.toContain("doc_1");
		expect(recordOutcomesMock).toHaveBeenCalledWith(
			["doc_1"],
			"FAILED",
			expect.any(String),
		);
	});
});

describe("stale actor", () => {
	it("skips a document whose enroller has lost access to the project", async () => {
		resolveActorsMock.mockResolvedValue(new Set());
		listMock.mockResolvedValue([enrolledInOrg()]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
		expect(recordOutcomesMock).toHaveBeenCalledWith(
			["doc_1"],
			"SKIPPED_STALE_ACTOR",
			expect.any(String),
		);
	});

	it("passes the projectId so the resolver can check project access, not just org membership", async () => {
		listMock.mockResolvedValue([enrolledInOrg()]);

		await findDueDocumentsActivity();

		expect(resolveActorsMock.mock.calls[0]?.[0]).toEqual([
			expect.objectContaining({
				documentId: "doc_1",
				projectId: "proj_1",
				createdByUserId: "user_1",
				organizationId: "org_1",
			}),
		]);
	});

	it("resolves the whole tick's actors in a single call", async () => {
		listMock.mockResolvedValue([
			enrolled({ documentId: "doc_1" }),
			enrolled({ documentId: "doc_2" }),
			enrolled({ documentId: "doc_3" }),
		]);

		await findDueDocumentsActivity();

		// One batched resolve, not one query per document — this runs against every
		// enrolled document in the system, hourly.
		expect(resolveActorsMock).toHaveBeenCalledTimes(1);
		expect(resolveActorsMock.mock.calls[0]?.[0]).toHaveLength(3);
	});

	it("never asks about a document already skipped for collision", async () => {
		// The collision gate is free and the actor gate costs a query, so a locked
		// document must not pay for one.
		listMock.mockResolvedValue([
			enrolled({
				documentId: "doc_locked",
				document: {
					title: "PRD",
					updatedAt: minutesAgo(5),
					lock: null,
				},
			}),
			enrolled({ documentId: "doc_free" }),
		]);

		await findDueDocumentsActivity();

		const asked = resolveActorsMock.mock.calls[0]?.[0] as Array<{
			documentId: string;
		}>;
		expect(asked.map((c) => c.documentId)).toEqual(["doc_free"]);
	});
});

describe("collision", () => {
	it("skips a document held by an unexpired lock", async () => {
		listMock.mockResolvedValue([
			enrolled({
				document: {
					id: "doc_1",
					title: "PRD",
					updatedAt: daysAgo(3),
					lock: { expiresAt: new Date(NOW.getTime() + 4 * MIN_MS) },
				},
			}),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
		expect(recordOutcomesMock).toHaveBeenCalledWith(
			["doc_1"],
			"SKIPPED_COLLISION",
			expect.any(String),
		);
	});

	it("proceeds once the lock has expired", async () => {
		listMock.mockResolvedValue([
			enrolled({
				document: {
					id: "doc_1",
					title: "PRD",
					updatedAt: daysAgo(3),
					lock: { expiresAt: new Date(NOW.getTime() - 1 * MIN_MS) },
				},
			}),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toHaveLength(1);
	});

	it("skips a document edited 20 minutes ago", async () => {
		listMock.mockResolvedValue([
			enrolled({
				document: {
					id: "doc_1",
					title: "PRD",
					updatedAt: minutesAgo(20),
					lock: null,
				},
			}),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toEqual([]);
	});

	it("proceeds for a document edited 70 minutes ago", async () => {
		// The collision window is exactly the sweep interval — an hour.
		listMock.mockResolvedValue([
			enrolled({
				document: {
					id: "doc_1",
					title: "PRD",
					updatedAt: minutesAgo(70),
					lock: null,
				},
			}),
		]);

		const { due } = await findDueDocumentsActivity();

		expect(due).toHaveLength(1);
	});
});

describe("tenant contexts", () => {
	it("carries the personal-context tenant columns through", async () => {
		listMock.mockResolvedValue([enrolled()]);

		const { due } = await findDueDocumentsActivity();

		expect(due[0]).toMatchObject({
			organizationId: null,
			userId: "user_1",
			triggeredByUserId: "user_1",
		});
	});

	it("carries the organization-context tenant columns through", async () => {
		listMock.mockResolvedValue([enrolledInOrg()]);

		const { due } = await findDueDocumentsActivity();

		expect(due[0]).toMatchObject({
			organizationId: "org_1",
			userId: null,
		});
	});
});
