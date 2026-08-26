import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The deferred-email DRAIN activity (Phase 1C-2d-2b-2, Fizzy #2213), against REAL
 * Postgres.
 *
 * It has to be real: every property worth asserting lives in the atomic claim's
 * conditional UPDATE, the ledger's unique triple, or the partial index the page
 * walks — none of which a mocked Prisma client has.
 *
 * The provider call is the one thing that must NOT be real, and `isMailConfigured`
 * reads an environment this suite must control rather than inherit. The defaults
 * are the ordinary production shape — a configured key and an accepted send — so a
 * case that says nothing about mail exercises the path a healthy deployment takes.
 */
vi.mock("@repo/mail", () => ({
	isMailConfigured: vi.fn(() => true),
	sendEmail: vi.fn(() => Promise.resolve(true)),
}));

import {
	db,
	PUBLISHING_DRAIN_BATCH_SIZE,
	PUBLISHING_DRAIN_MAX_BATCHES,
} from "@repo/database";
import { isMailConfigured, sendEmail } from "@repo/mail";
import { drainDeferredPublishingNotifications } from "../src/activities/publishing-suggestion/drain-deferred-notifications";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const describeDb = RUN_DB ? describe : describe.skip;

const RUN = `draina_${randomUUID().replaceAll("-", "")}`;
const ORG_ID = `${RUN}_org`;
const ACTOR_ID = `${RUN}_actor`;
const PROJECT_ID = `${RUN}_proj`;
const ACCEPTED_AT = new Date("2026-01-01T00:00:00.000Z");

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 14 * 24 * 60 * 60_000);

let rowSeq = 0;

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.organization.create({
		data: {
			id: ORG_ID,
			name: `Drain Activity ${RUN}`,
			slug: `drain-activity-${RUN}`,
			createdAt: new Date(),
		},
	});
	await db.user.create({
		data: {
			id: ACTOR_ID,
			name: "Drain Activity Actor",
			email: `${ACTOR_ID}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await db.project.create({
		data: {
			id: PROJECT_ID,
			name: `Drain Activity ${RUN}`,
			organizationId: ORG_ID,
			userId: ACTOR_ID,
			status: "ACTIVE",
			techStack: [],
			features: [],
			tags: [],
		},
	});
	// An ACTIVE project member with a role that grants topic creation — the
	// capability `reauthorizePublishingRecipient` re-derives. Without it every
	// case would refuse at gate 3 and the suite would pass for the wrong reason.
	await db.projectMember.create({
		data: {
			projectId: PROJECT_ID,
			userId: ACTOR_ID,
			role: "OWNER",
			invitedBy: ACTOR_ID,
			acceptedAt: ACCEPTED_AT,
		},
	});
}, 180_000);

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	const prefix = `${RUN}\\_%`;
	await db.$executeRawUnsafe(
		`DELETE FROM "publishing_notification_delivery" WHERE "id" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(
		`DELETE FROM "publishing_suggestion_cycle" WHERE "id" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(
		`DELETE FROM "publishing_suite_settings" WHERE "projectId" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(
		`DELETE FROM "project_member" WHERE "projectId" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(
		`DELETE FROM "project" WHERE "id" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(`DELETE FROM "user" WHERE "id" LIKE $1`, prefix);
	await db.$executeRawUnsafe(
		`DELETE FROM "organization" WHERE "id" LIKE $1`,
		prefix,
	);
	await db.$disconnect();
}, 180_000);

/**
 * Seed ONE deferred obligation with its own cycle.
 *
 * Its own cycle because the ledger's unique triple is
 * (cycleId, recipientUserId, channel) and every case here uses the same
 * recipient — one cycle per row keeps the cases independent.
 */
async function seedDeferred(
	row: { attemptCount?: number; expiresAt?: Date } = {},
): Promise<{ id: string; cycleId: string }> {
	rowSeq += 1;
	const id = `${RUN}_row_${String(rowSeq).padStart(6, "0")}`;
	const cycleId = `${RUN}_cyc_${String(rowSeq).padStart(6, "0")}`;
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 VALUES ($1,$2,$3,NULL,'READY',$4,$5,$5,$5,'MAIL_NOT_CONFIGURED',1,$5,$5,$5)`,
		cycleId,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		NOW,
	);
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId",
		    "channel","status","expiresAt","attemptCount","createdAt")
		 VALUES ($1,$2,$3,$4,NULL,$5,'EMAIL','DEFERRED',$6::timestamp,$7::int,$8::timestamp)`,
		id,
		cycleId,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		row.expiresAt ?? FUTURE,
		row.attemptCount ?? 0,
		NOW,
	);
	return { id, cycleId };
}

async function readRow(
	id: string,
): Promise<{ status: string; reason: string | null; attemptCount: number }> {
	const rows = (await db.$queryRawUnsafe(
		`SELECT "status","reason","attemptCount"
		   FROM "publishing_notification_delivery" WHERE "id" = $1`,
		id,
	)) as Array<{
		status: string;
		reason: string | null;
		attemptCount: number;
	}>;
	return rows[0];
}

/**
 * Was a message sent FOR THIS OBLIGATION?
 *
 * `expect(sendEmail).not.toHaveBeenCalled()` is the tempting assertion and it is
 * the wrong one here, because THE DRAIN HAS NO PROJECT PREDICATE — the sweep is
 * global by design, so one run discharges every eligible row in the database,
 * including ones an earlier case in this file left behind. The bare assertion
 * therefore fails whenever a neighbouring case leaves work, which makes it a
 * function of test order rather than of the gate under test. Caught by exactly
 * that: the at-bound case went red because the mail-gate cases above it had
 * seeded rows nothing had drained yet.
 *
 * The idempotency key carries the cycle, so it identifies the obligation without
 * needing the run to be the only thing happening.
 */
function sentFor(cycleId: string): boolean {
	return vi
		.mocked(sendEmail)
		.mock.calls.some(([input]) => input?.idempotencyKey?.includes(cycleId));
}

async function setKillSwitch(enabled: boolean): Promise<void> {
	await db.publishingSuiteSettings.upsert({
		where: { projectId: PROJECT_ID },
		create: {
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			notificationsEnabled: enabled,
			createdByUserId: ACTOR_ID,
		},
		update: { notificationsEnabled: enabled },
	});
}

beforeAll(() => {
	vi.mocked(isMailConfigured).mockReturnValue(true);
	vi.mocked(sendEmail).mockResolvedValue(true);
});

describeDb("pass 2 — the mail-configuration gate", () => {
	it("returns with zero counts and mailConfigured false, and sends nothing", async () => {
		await seedDeferred();
		vi.mocked(isMailConfigured).mockReturnValue(false);
		vi.mocked(sendEmail).mockClear();
		try {
			const out = await drainDeferredPublishingNotifications();
			expect(out.mailConfigured).toBe(false);
			expect(out.scanned).toBe(0);
			expect(out.sent).toBe(0);
			expect(out.batches).toBe(0);
			expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
		} finally {
			vi.mocked(isMailConfigured).mockReturnValue(true);
		}
	});

	it("does not THROW when the mail path is unconfigured", async () => {
		// A throw here is a failed activity, retried three times, and then an
		// hourly red workflow on every deployment without a key — an alert firing
		// on a supported configuration. The absence of a key is a state to report.
		vi.mocked(isMailConfigured).mockReturnValue(false);
		try {
			await expect(
				drainDeferredPublishingNotifications(),
			).resolves.toBeDefined();
		} finally {
			vi.mocked(isMailConfigured).mockReturnValue(true);
		}
	});

	it("leaves every deferred row exactly where it was", async () => {
		// The gate is a RETURN, not a filter: nothing is claimed, nothing is
		// skipped, and no attempt is consumed on the deployment whose backlog is
		// largest.
		const row = await seedDeferred();
		vi.mocked(isMailConfigured).mockReturnValue(false);
		try {
			await drainDeferredPublishingNotifications();
			const after = await readRow(row.id);
			expect(after.status).toBe("DEFERRED");
			expect(after.attemptCount).toBe(0);
		} finally {
			vi.mocked(isMailConfigured).mockReturnValue(true);
		}
	});
});

describeDb("pass 3 — the drain", () => {
	it("claims, sends and confirms one deferred obligation", async () => {
		const row = await seedDeferred();
		vi.mocked(sendEmail).mockClear();

		const out = await drainDeferredPublishingNotifications();
		expect(out.mailConfigured).toBe(true);
		expect(out.sent).toBeGreaterThanOrEqual(1);

		const after = await readRow(row.id);
		expect(after.status).toBe("SENT");
		expect(after.attemptCount).toBe(1);

		// `sendEmail` takes a UNION — a templated send or a raw subject/body one —
		// so the templated arm's fields are not reachable without narrowing. Cast
		// to the shape this activity is asserted to send rather than adding a
		// runtime guard that would pass vacuously on the wrong arm.
		const call = vi.mocked(sendEmail).mock.calls.at(-1)?.[0] as
			| {
					templateId?: string;
					idempotencyKey?: string;
					context?: { url?: string };
			  }
			| undefined;
		expect(call?.templateId).toBe("publishingTopicsReady");
		// THE SAME KEY THE IN-BAND PATH USES, so an obligation attempted in-band
		// and then deferred collapses into that attempt at the provider rather
		// than arriving twice. Attempt-independent, or every retry is a new
		// message.
		expect(call?.idempotencyKey).toBe(
			`publishing-${row.cycleId}-${ACTOR_ID}`,
		);
		// An ABSOLUTE url: a mail client has no workspace base to prepend.
		expect(call?.context?.url).toMatch(/^https?:\/\/.+\/projects\/.+/);
	});

	it("a provider rejection returns the row to DEFERRED with its lease released", async () => {
		const row = await seedDeferred();
		vi.mocked(sendEmail).mockResolvedValueOnce(false);

		const out = await drainDeferredPublishingNotifications();
		expect(out.failed).toBeGreaterThanOrEqual(1);

		const after = await readRow(row.id);
		// DEFERRED and not FAILED: the row is under the attempt bound, so it is
		// still owed and the next tick re-takes it. A FAILED row carrying an
		// expiry is invisible to this drain AND to pass 1.
		expect(after.status).toBe("DEFERRED");
		expect(after.reason).toBe("PROVIDER_REJECTED");
		expect(after.attemptCount).toBe(1);
	});

	it("a row at the attempt bound is discharged to FAILED without a send", async () => {
		const row = await seedDeferred({ attemptCount: 5 });
		vi.mocked(sendEmail).mockClear();

		const out = await drainDeferredPublishingNotifications();
		expect(out.dischargedAtBound).toBeGreaterThanOrEqual(1);

		const after = await readRow(row.id);
		expect(after.status).toBe("FAILED");
		expect(after.reason).toBe("RECONCILE_ATTEMPT_BOUND");
		expect(sentFor(row.cycleId)).toBe(false);
	});
});

describeDb("the per-row gates", () => {
	it("a project with notifications switched off: SKIPPED, no send", async () => {
		const row = await seedDeferred();
		await setKillSwitch(false);
		vi.mocked(sendEmail).mockClear();
		try {
			const out = await drainDeferredPublishingNotifications();
			expect(out.sent).toBe(0);
			expect(
				out.skipped.RECONCILE_NOTIFICATIONS_DISABLED,
			).toBeGreaterThanOrEqual(1);
			const after = await readRow(row.id);
			expect(after.status).toBe("SKIPPED");
			expect(after.reason).toBe("RECONCILE_NOTIFICATIONS_DISABLED");
			expect(sentFor(row.cycleId)).toBe(false);
			// TERMINAL, so the row is never re-queued — which is what bounds the
			// backlog. And no attempt was consumed: this is a decision not to try,
			// not a failed try.
			expect(after.attemptCount).toBe(0);
		} finally {
			await setKillSwitch(true);
		}
	});

	it("a recipient who lost access: SKIPPED, no send", async () => {
		const row = await seedDeferred();
		await db.projectMember.deleteMany({
			where: { projectId: PROJECT_ID, userId: ACTOR_ID },
		});
		vi.mocked(sendEmail).mockClear();
		try {
			const out = await drainDeferredPublishingNotifications();
			expect(out.sent).toBe(0);
			expect(
				out.skipped.RECONCILE_RECIPIENT_UNAUTHORIZED,
			).toBeGreaterThanOrEqual(1);
			const after = await readRow(row.id);
			expect(after.status).toBe("SKIPPED");
			expect(after.reason).toBe("RECONCILE_RECIPIENT_UNAUTHORIZED");
			expect(sentFor(row.cycleId)).toBe(false);
		} finally {
			await db.projectMember.create({
				data: {
					projectId: PROJECT_ID,
					userId: ACTOR_ID,
					role: "OWNER",
					invitedBy: ACTOR_ID,
					acceptedAt: ACCEPTED_AT,
				},
			});
		}
	});

	it("a project that moved tenants: SKIPPED, no send", async () => {
		const row = await seedDeferred();
		// The row's denormalized tuple no longer matches the project's. Written on
		// the ROW rather than by moving the project, so the fixture's other cases
		// are untouched — the gate compares the two either way.
		await db.$executeRawUnsafe(
			`UPDATE "publishing_notification_delivery"
			    SET "organizationId" = NULL, "userId" = $2 WHERE "id" = $1`,
			row.id,
			ACTOR_ID,
		);
		vi.mocked(sendEmail).mockClear();

		const out = await drainDeferredPublishingNotifications();
		expect(out.skipped.RECONCILE_TENANT_CHANGED).toBeGreaterThanOrEqual(1);
		const after = await readRow(row.id);
		expect(after.status).toBe("SKIPPED");
		expect(after.reason).toBe("RECONCILE_TENANT_CHANGED");
		expect(sentFor(row.cycleId)).toBe(false);
	});

	it("reads the kill switch FRESH per row, not once per run", async () => {
		// THE MEMO CASE, and it is the one that separates a correct implementation
		// from a plausible one. Two rows on one page with the switch flipped
		// BETWEEN them: an implementation that reads the project's settings once
		// per run passes every case above and sends the second row anyway.
		//
		// The flip rides on the provider mock, which is a seam that already exists,
		// so it happens strictly between the first row's send and the second row's
		// gate rather than at a wall-clock moment the case cannot control.
		const first = await seedDeferred();
		const second = await seedDeferred();
		await setKillSwitch(true);
		vi.mocked(sendEmail).mockImplementationOnce(async () => {
			await setKillSwitch(false);
			return true;
		});
		try {
			await drainDeferredPublishingNotifications();
			expect((await readRow(first.id)).status).toBe("SENT");
			const later = await readRow(second.id);
			expect(later.status).toBe("SKIPPED");
			expect(later.reason).toBe("RECONCILE_NOTIFICATIONS_DISABLED");
		} finally {
			await setKillSwitch(true);
		}
	});
});

describeDb("the page budget and the source", () => {
	it("spends its whole page budget and PROBES what is left", async () => {
		const budget =
			PUBLISHING_DRAIN_BATCH_SIZE * PUBLISHING_DRAIN_MAX_BATCHES;
		for (let n = 0; n < budget + 1; n++) {
			await seedDeferred();
		}
		const out = await drainDeferredPublishingNotifications();
		expect(out.usedBatchBudget).toBe(true);
		expect(out.scanned).toBe(budget);
		// PROBED, never inferred from `batches === MAX` — which a short final page
		// and an exactly-full backlog also produce.
		expect(out.moreWorkRemains).toBe(true);
	}, 180_000);

	it("an EXACTLY full backlog spends the budget and reports NO work remaining", async () => {
		// The boundary the inference gets wrong, and the whole reason the probe
		// exists. Drain the leftovers from the case above first so this one starts
		// from a known count.
		await drainDeferredPublishingNotifications();
		const budget =
			PUBLISHING_DRAIN_BATCH_SIZE * PUBLISHING_DRAIN_MAX_BATCHES;
		for (let n = 0; n < budget; n++) {
			await seedDeferred();
		}
		const out = await drainDeferredPublishingNotifications();
		expect(out.usedBatchBudget).toBe(true);
		expect(out.moreWorkRemains).toBe(false);
	}, 180_000);

	it("the source reads the mail configuration, and pass 1 still does not", () => {
		const here = join(__dirname, "../src/activities/publishing-suggestion");
		const drain = readFileSync(
			join(here, "drain-deferred-notifications.ts"),
			"utf8",
		);
		const reclaim = readFileSync(
			join(here, "reconcile-notifications.ts"),
			"utf8",
		);
		expect(drain).toContain("isMailConfigured");
		// The property parent §9.9 is entirely about, still held after this slice
		// adds a mail path to the same directory: pass 1 must make progress on a
		// deployment with no key, so it must not contain a check that could stop
		// it. Asserted on the SOURCE because an import that is merely unreached
		// still couples the module.
		expect(reclaim).not.toContain("isMailConfigured");
		expect(reclaim).not.toContain("@repo/mail");
	});
});
