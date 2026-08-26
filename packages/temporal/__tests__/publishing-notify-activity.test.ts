import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";

/**
 * The contributor notification activity (Phase 1C-2b, Fizzy #1850), against REAL Postgres.
 *
 * It has to be real: every property worth asserting here lives in the ledger's unique triple, the
 * outcome column's compare-and-swap, or the tenant fence's `FOR UPDATE` — none of which a mocked
 * Prisma client has. Gated on RUN_DB_INTEGRATION=1 like the other DB-backed suites in the repo, so
 * an ordinary no-Postgres unit run skips rather than fails.
 *
 * `resolvePublishingEligibleRecipients` and `deliverPublishingTopicsReadyInApp` are wrapped in spies
 * that delegate to the real implementation by default. One test each changes that, and in both cases
 * it is the only way to make that call throw without also breaking an unrelated query — for the
 * delivery one it is the only way at all, because that function catches everything and returns
 * "FAILED" rather than throwing (see the test that uses it).
 */
const { resolveEligibleSpy, deliverInAppSpy } = vi.hoisted(() => ({
	resolveEligibleSpy: vi.fn(),
	deliverInAppSpy: vi.fn(),
}));

// The provider call is the one thing that must NOT be real here, and `isMailConfigured` reads an
// env var this suite must control rather than inherit. Everything else runs against real Postgres.
// The defaults are the ordinary production shape — a configured key and an accepted send — so a
// case that says nothing about mail exercises the same path a healthy deployment takes.
vi.mock("@repo/mail", () => ({
	isMailConfigured: vi.fn(() => true),
	sendEmail: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	resolveEligibleSpy.mockImplementation(
		actual.resolvePublishingEligibleRecipients,
	);
	deliverInAppSpy.mockImplementation(
		actual.deliverPublishingTopicsReadyInApp,
	);
	return {
		...actual,
		resolvePublishingEligibleRecipients: resolveEligibleSpy,
		deliverPublishingTopicsReadyInApp: deliverInAppSpy,
	};
});

import {
	activateCycleNotificationLifecycle,
	claimPublishingEmailDelivery,
	db,
	type PrismaQueryObserver,
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	recordPublishingDeliverySkip,
	resolvePublishingEligibleRecipients,
	selectRelevantRecipientIds,
	setPrismaQueryObserver,
	writeCycleNotificationOutcome,
} from "@repo/database";
import { isMailConfigured, sendEmail } from "@repo/mail";
import {
	PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
	runPublishingTopicsReadyNotification,
} from "../src/activities/publishing-suggestion/notify-topics-ready";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

/**
 * The registered query observer is MODULE state — `setPrismaQueryObserver` replaces the single
 * registered function — so it must be restored in a `finally`, or every later test in this file
 * runs under the fault-injecting observer. Same discipline as the delivery module's suite.
 */
const passThrough: PrismaQueryObserver = ({ args, query }) => query(args);
setPrismaQueryObserver(passThrough);

async function withQueryObserver<T>(
	observer: PrismaQueryObserver,
	body: () => Promise<T>,
): Promise<T> {
	setPrismaQueryObserver(observer);
	try {
		return await body();
	} finally {
		setPrismaQueryObserver(passThrough);
	}
}

const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function seedUser(name: string) {
	const user = await db.user.create({
		data: {
			id: `user-${randomUUID()}`,
			name,
			// `User.createdAt` / `updatedAt` carry no Prisma default, so both are required here.
			email: `${randomUUID()}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	return user;
}

async function seedOrg(name: string) {
	const orgId = `org-${randomUUID()}`;
	await db.organization.create({
		data: {
			id: orgId,
			name,
			slug: `slug-${randomUUID()}`,
			createdAt: new Date(),
		},
	});
	createdOrgIds.push(orgId);
	return orgId;
}

/**
 * An ACTIVE organization project with a READY cycle — the only state this activity is ever
 * triggered from. `status: ACTIVE` is not decoration: the tenant fence mirrors persistCycleTerminal's
 * F1 eligibility filter, so a DRAFT fixture would make every delivery answer TENANT_CHANGED for a
 * reason that cannot occur in production.
 */
async function seedReadyCycle() {
	const orgId = await seedOrg("1C-2b activity org");
	const owner = await seedUser("Tenant owner");
	const project = await db.project.create({
		data: {
			name: "Example project",
			userId: owner.id,
			organizationId: orgId,
			status: "ACTIVE",
		},
	});
	projectIds.push(project.id);
	const cycle = await db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			organizationId: orgId,
			status: "READY",
			actorUserId: owner.id,
			coveredThrough: new Date(),
		},
	});
	const tenant = {
		projectId: project.id,
		organizationId: orgId as string | null,
		userId: null as string | null,
	};
	return { orgId, owner, project, cycle, tenant };
}

const ACCEPTED_AT = new Date("2026-01-01T00:00:00.000Z");

async function addProjectMember(
	projectId: string,
	userId: string,
	role: "OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER",
) {
	await db.projectMember.create({
		data: {
			projectId,
			userId,
			role,
			invitedBy: userId,
			acceptedAt: ACCEPTED_AT,
		},
	});
}

/**
 * The same, with N eligible EDITORs instead of one. Returns their ids in creation order.
 *
 * See `seedReadyCycleWithRecipient` below for why the project is ACTIVE and why no
 * NotificationPreference row is written — both apply here, since that helper delegates to this one.
 *
 * The topic is NOT optional decoration, and it is the one thing eligibility alone does not buy.
 * Candidacy is `eligible ∩ relevant`, and relevance is ATTRIBUTION-driven: selectRelevantRecipientIds
 * reads the cycle's topics and keeps only users named in `contributorUserIds`. A fixture that seeds
 * members without a topic therefore produces an eligible roster and an EMPTY relevant set, so the
 * activity terminalizes at NO_RECIPIENTS before either channel is reached — which is what every
 * 1C-2c case saw before this line existed. ALL of them are attributed because every case built on
 * this fixture wants every seeded recipient to be a candidate; no case here depends on the ORDER
 * the activity walks them in, since each looks its recipients up by id.
 */
async function seedReadyCycleWithRecipients(count: number) {
	const { orgId, project, cycle, tenant } = await seedReadyCycle();
	const recipientUserIds: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const editor = await seedUser(`Eligible editor ${index + 1}`);
		await addProjectMember(project.id, editor.id, "EDITOR");
		recipientUserIds.push(editor.id);
	}
	await addTopic(
		project.id,
		tenant.organizationId,
		cycle.id,
		recipientUserIds,
	);
	return {
		cycleId: cycle.id,
		projectId: project.id,
		organizationId: orgId,
		recipientUserIds,
		tenant,
	};
}

/**
 * A READY cycle on an ACTIVE organization project, plus one recipient who is genuinely eligible:
 * an accepted, unexpired EDITOR. EDITOR because PUBLISHING_TOPIC_CREATE is Editor+ at project
 * level (roles.ts:222) — a VIEWER holds only PUBLISHING_TOPIC_READ and would be filtered out,
 * which is the distinction every recipient test in this suite depends on.
 *
 * `status: "ACTIVE"` is not decoration. The tenant fence mirrors persistCycleTerminal's F1
 * eligibility filter, so a project at the model default makes every delivery answer
 * TENANT_CHANGED — and a test asserting TENANT_CHANGED then passes without exercising anything.
 * (`seedReadyCycle`, which this delegates to, sets it and documents the same reason.)
 *
 * No NotificationPreference row is created: the opt-out model means a missing row is "enabled on
 * both channels", which is the state most tests want. Tests that need an opt-out create the row
 * themselves, so the absence is visible at the call site rather than buried here.
 */
async function seedReadyCycleWithRecipient() {
	const seeded = await seedReadyCycleWithRecipients(1);
	const recipientUserId = seeded.recipientUserIds[0];
	if (!recipientUserId) {
		throw new Error("seedReadyCycleWithRecipients(1) seeded no recipient");
	}
	return { ...seeded, recipientUserId };
}

async function addTopic(
	projectId: string,
	organizationId: string | null,
	cycleId: string,
	contributorUserIds: string[],
) {
	await db.publishingTopic.create({
		data: {
			projectId,
			organizationId,
			cycleId,
			title: "A topic",
			origin: "AI",
			status: "SUGGESTION",
			dedupeKey: `dk-${randomUUID()}`,
			contributorUserIds,
		},
	});
}

async function readOutcome(cycleId: string) {
	const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
		where: { id: cycleId },
	});
	return {
		outcome: row.notificationOutcome,
		version: row.notificationOutcomeVersion,
	};
}

/**
 * Every obligation this cycle carries, on EVERY channel.
 *
 * The cases below were written when there was one channel, so `toHaveLength(1)` meant both "one
 * IN_APP row" and "no rows anywhere else" at once. With EMAIL delivering beside it those two claims
 * came apart, and collapsing them again by quietly raising the number would drop the second one —
 * an unexpected row on a channel a case never mentions would stop being caught by anything. So each
 * case now names the channel it is asserting about, through `channelRows` below, and states the
 * other channel's expected shape explicitly rather than by omission.
 */
async function ledgerRows(cycleId: string) {
	return db.publishingNotificationDelivery.findMany({
		where: { cycleId },
		orderBy: { createdAt: "asc" },
	});
}

async function channelRows(cycleId: string, channel: "IN_APP" | "EMAIL") {
	return db.publishingNotificationDelivery.findMany({
		where: { cycleId, channel },
		orderBy: { createdAt: "asc" },
	});
}

/**
 * How many EMAIL obligations a case expects, asserted in one line beside its IN_APP assertions.
 *
 * A helper rather than a repeated `expect(await channelRows(id, "EMAIL")).toHaveLength(n)` because
 * the STATUSES matter as much as the count: a case that expected one delivered email and got one
 * FAILED email would otherwise pass. Passing the statuses makes the email side of every 1C-2b case
 * as specific as its in-app side.
 */
async function expectEmailRows(cycleId: string, statuses: string[]) {
	const rows = await channelRows(cycleId, "EMAIL");
	expect(rows.map((row) => row.status).sort()).toEqual([...statuses].sort());
}

function bellCount(userId: string) {
	return db.notification.count({
		where: { userId, type: "PUBLISHING_TOPICS_READY" },
	});
}

/**
 * Is the project row locked by SOMEONE ELSE right now?
 *
 * The honest instrument for "these two transactions are mutually exclusive". Asserting exclusion by
 * racing two real transactions needs a sleep and proves nothing on a fast machine; asking Postgres
 * whether the row is already locked is a fact, and `lock_timeout` bounds the question so the probe
 * always answers rather than hanging.
 *
 * Runs on its own connection (a second `db.$transaction`), which is what lets it block at all — and
 * why it must never be called from inside the transaction it is asking about.
 */
async function projectRowLockIsHeld(projectId: string): Promise<boolean> {
	try {
		await db.$transaction(async (tx) => {
			await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '400ms'");
			await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${projectId} FOR UPDATE`;
		});
		return false;
	} catch (error) {
		const described = String(error);
		// 55P03 lock_not_available. Anything else is a real fault and must not be read as "locked",
		// or this probe would answer `true` for a typo in the SQL.
		if (/55P03|lock timeout/i.test(described)) {
			return true;
		}
		throw error;
	}
}

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.notification.deleteMany({
		where: { userId: { in: createdUserIds } },
	});
	// Topics reference the cycle with onDelete: SetNull, so they go first for the cycle delete
	// below to leave nothing behind.
	await db.publishingTopic.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.publishingSuggestionCycle.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

// ---------------------------------------------------------------------------
// 1. The happy path.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"delivers to an attributed, eligible, toggle-on recipient and records SENT (1C-2b)",
	async () => {
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientUserId).toBe(editor.id);
		expect(rows[0]?.status).toBe("SENT");
		expect(rows[0]?.deliveredAt).not.toBeNull();
		// The recipient wrote no preference row, and under the opt-out model that means enabled on
		// BOTH channels — so the default configuration delivers an email as well as a bell. Stating
		// it here is what keeps this case a full description of what a healthy cycle does.
		await expectEmailRows(cycle.id, ["SENT"]);
		expect(await bellCount(editor.id)).toBe(1);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// 2. Attribution is not authorization.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a VIEWER is not notified even when the cycle attributes them (1C-2b)",
	async () => {
		// The only assertion that distinguishes PUBLISHING_TOPIC_CREATE from
		// PUBLISHING_TOPIC_READ: READ is granted to VIEWERS at both levels, so a predicate built on
		// it would notify precisely the read-only members FR24/FR25 forbid. The editor is in the
		// same batch so this cannot pass merely because nothing was delivered at all.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		const viewer = await seedUser("Attributed viewer");
		await addProjectMember(project.id, viewer.id, "VIEWER");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
			viewer.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientUserId).toBe(editor.id);
		// The VIEWER is filtered by ELIGIBILITY, which is upstream of both toggles — so they get no
		// email either. Asserting the email side by recipient rather than by count is what makes
		// that a claim about the viewer instead of a claim about arithmetic.
		const emailed = await channelRows(cycle.id, "EMAIL");
		expect(emailed.map((row) => row.recipientUserId)).toEqual([editor.id]);
		expect(await bellCount(editor.id)).toBe(1);
		expect(await bellCount(viewer.id)).toBe(0);
		expect((await readOutcome(cycle.id)).outcome).toBe("SENT");
	},
);

// ---------------------------------------------------------------------------
// 3. The per-user category toggle.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a recipient opted out of BOTH channels leaves the cycle at NO_RECIPIENTS (1C-2b)",
	async () => {
		// NOT `SENT`, and not silence either: an empty candidate set is a real, explicitly
		// non-incident answer that an operator can act on by checking attribution and toggles.
		//
		// BOTH toggles, and the second one is the 1C-2c correction rather than belt-and-braces.
		// This case's subject is the NO_RECIPIENTS classification, and NO_RECIPIENTS now means
		// "both candidate sets are empty" — `publishingSuggestions: false` alone no longer empties
		// anything but the bell, because `publishingEmails` is an INDEPENDENT default-on column and
		// a user with the bell off and email on is a supported configuration. Leaving this fixture
		// bell-only would have quietly turned this case into a second, worse copy of the four-
		// combination case at the bottom of this file, asserting NO_RECIPIENTS about a cycle that
		// correctly sends an email. (That bell-off/email-on combination IS covered there.)
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Opted-out editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await db.notificationPreference.create({
			data: {
				userId: editor.id,
				organizationId: "",
				publishingSuggestions: false,
				publishingEmails: false,
			},
		});
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		expect(await ledgerRows(cycle.id)).toHaveLength(0);
		expect(await bellCount(editor.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "NO_RECIPIENTS",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// 4. The project-level kill switch.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"the kill switch off records DISABLED, writes no ledger row, and completes (1C-2b)",
	async () => {
		const { orgId, owner, project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Would-be recipient");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await db.publishingSuiteSettings.create({
			data: {
				projectId: project.id,
				organizationId: orgId,
				userId: null,
				createdByUserId: owner.id,
				notificationsEnabled: false,
			},
		});
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		// Resolves — a disabled feature is not a fault, so there is nothing to retry.
		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		expect(await ledgerRows(cycle.id)).toHaveLength(0);
		expect(await bellCount(editor.id)).toBe(0);
		expect((await readOutcome(cycle.id)).outcome).toBe("DISABLED");
	},
);

// ---------------------------------------------------------------------------
// 5. Resolution failure: stamp, THEN reject.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a resolver failure stamps RESOLUTION_FAILED and then rejects (1C-2b)",
	async () => {
		// BOTH halves, because either one alone describes a broken implementation. The stamp is the
		// signal that must survive retry exhaustion — it has no ledger row to carry its reason. The
		// rejection is what earns the retry, because the read is usually transient; an
		// implementation that stamped and resolved would look tidy while permanently converting a
		// blip into a cycle nobody ever notified.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		resolveEligibleSpy.mockRejectedValueOnce(
			new Error("injected recipient-resolution failure (1C-2b)"),
		);
		await expect(
			runPublishingTopicsReadyNotification({ cycleId: cycle.id, tenant }),
		).rejects.toThrow("injected recipient-resolution failure");

		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "RESOLUTION_FAILED",
			version: 1,
		});
		expect(await ledgerRows(cycle.id)).toHaveLength(0);
		expect(await bellCount(editor.id)).toBe(0);
	},
);

// ---------------------------------------------------------------------------
// 6. An unconfirmed obligation rejects.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"an attempt that leaves a recipient unconfirmed REJECTS rather than completing (1C-2b)",
	async () => {
		// The assertion the whole slice exists for. A version that resolves here passes every
		// ledger-only assertion in this file while silently disabling every retry — the recipient
		// is never told, and nothing is left to notice. The cycle must also stay non-terminal, so a
		// later attempt can still classify it.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					if (model === "Notification" && operation === "create") {
						throw new Error(
							"injected bell-row write failure (1C-2b)",
						);
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: cycle.id,
						tenant,
					}),
			),
		).rejects.toThrow(/unconfirmed/);

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		// FAILED, not SKIPPED: it is claimable, which is what makes the retry able to discharge it.
		expect(rows[0]?.status).toBe("FAILED");
		expect(rows[0]?.deliveredAt).toBeNull();
		// The bell failing does not take the email down with it — the channels are accounted
		// independently, and a retry re-drives only what is still outstanding.
		await expectEmailRows(cycle.id, ["SENT"]);
		expect(await bellCount(editor.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "PENDING",
			version: 0,
		});
	},
);

// ---------------------------------------------------------------------------
// 7. Cancellation is per obligation, not per cycle.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a revoked recipient is skipped without denying the rest, and the activity completes (1C-2b)",
	async () => {
		// The divergence between batch resolution and per-recipient re-authorization is REAL and
		// cannot be produced by fixtures alone — both reads answer identically for a static roster,
		// which is the point of the second read: it exists to catch a change that lands between
		// them. Demoting through the registered query observer at a BATCH read — one taken before
		// the per-recipient loop begins — is how that window is staged deterministically; no
		// production seam is involved.
		const { project, cycle, tenant } = await seedReadyCycle();
		const kept = await seedUser("Still an editor");
		await addProjectMember(project.id, kept.id, "EDITOR");
		const revoked = await seedUser("Demoted mid-attempt");
		await addProjectMember(project.id, revoked.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			kept.id,
			revoked.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		let demoted = false;
		await withQueryObserver(
			async ({ model, operation, args, query }) => {
				// The BATCH category-toggle read. It is NOT the last query before the
				// per-recipient loop — the `Promise.all` that issues it also issues a
				// byte-identical NotificationPreference.findMany for the email toggle, and
				// project.findUnique / publishingTopic.count / organization.findUnique /
				// user.findMany all run after it — but it is comfortably before the loop, which
				// is all this staging needs: demoting here lands strictly between the batch answer
				// and the re-authorization that is supposed to notice.
				//
				// `!demoted` therefore pins this to the FIRST NotificationPreference.findMany, and
				// which of the two that is comes down to the argument order of that `Promise.all`.
				// Either one is a batch read taken before any delivery, so the staging holds
				// whichever wins; re-authorization issues the same query again per recipient, and
				// the flag is what keeps this off those.
				if (
					!demoted &&
					model === "NotificationPreference" &&
					operation === "findMany"
				) {
					demoted = true;
					const result = await query(args);
					await db.projectMember.update({
						where: {
							projectId_userId: {
								projectId: project.id,
								userId: revoked.id,
							},
						},
						data: { role: "VIEWER" },
					});
					return result;
				}
				return query(args);
			},
			() =>
				runPublishingTopicsReadyNotification({
					cycleId: cycle.id,
					tenant,
				}),
		);

		// Positive control: without it the assertions below would pass for a reason that has
		// nothing to do with the re-authorization read.
		expect(demoted).toBe(true);
		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(2);
		const keptRow = rows.find((r) => r.recipientUserId === kept.id);
		const revokedRow = rows.find((r) => r.recipientUserId === revoked.id);
		expect(keptRow?.status).toBe("SENT");
		expect(keptRow?.deliveredAt).not.toBeNull();
		expect(revokedRow?.status).toBe("SKIPPED");
		expect(revokedRow?.reason).toBe("RECIPIENT_UNAUTHORIZED");
		expect(revokedRow?.deliveredAt).toBeNull();
		// The demotion is a PROJECT-ROLE change, so it revokes both channels — the email loop
		// re-authorizes the same recipient a second time and reaches the same verdict. Asserting
		// it here is what would catch an email loop that skipped re-authorization entirely.
		const emailRows = await channelRows(cycle.id, "EMAIL");
		// The COUNT, beside the statuses. This case's original whole-ledger `toHaveLength(2)` said
		// "exactly two rows anywhere"; splitting it per channel kept the claim on IN_APP and left
		// the EMAIL side asserted only through `.find(...)`, which a spurious third row would
		// satisfy. Two recipients, one obligation each.
		expect(emailRows).toHaveLength(2);
		expect(
			emailRows.find((r) => r.recipientUserId === kept.id)?.status,
		).toBe("SENT");
		expect(
			emailRows.find((r) => r.recipientUserId === revoked.id)?.status,
		).toBe("SKIPPED");
		expect(
			emailRows.find((r) => r.recipientUserId === revoked.id)?.reason,
		).toBe("RECIPIENT_UNAUTHORIZED");
		expect(await bellCount(kept.id)).toBe(1);
		expect(await bellCount(revoked.id)).toBe(0);
		// A SKIPPED obligation is TERMINAL, so it does not keep the activity rejecting — and a
		// cycle with a confirmed delivery is SENT, not CANCELLED.
		expect((await readOutcome(cycle.id)).outcome).toBe("SENT");
	},
);

// ---------------------------------------------------------------------------
// 8. A tenant transfer before the attempt.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a transfer before the attempt records CANCELLED, writes no row, and completes (1C-2b)",
	async () => {
		// Completes rather than rejects: a tenant move will not resolve on retry, and retrying is
		// how a stale tuple leaks. There is nothing left unconfirmed because nothing was ever owed
		// under the new tuple.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		const newOrgId = await seedOrg("1C-2b receiving org");
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: newOrgId },
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		expect(await ledgerRows(cycle.id)).toHaveLength(0);
		expect(await bellCount(editor.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "CANCELLED",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// 9. The repair case.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a READY cycle left at NOT_APPLICABLE is repaired to PENDING and then delivered (1C-2b)",
	async () => {
		// What an OLDER worker commits during a rolling deploy: persistCycleTerminal ignores the
		// activation input and sets READY at the column default. Treating that cycle as out of
		// scope would be the silent miss this column exists to prevent. A literal reading of the
		// terminality predicate rejects the repair transition, which is the whole finding — so the
		// repair goes through activateCycleNotificationLifecycle, whose guard is its OWN expected
		// value.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		expect((await readOutcome(cycle.id)).outcome).toBe("NOT_APPLICABLE");

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SENT");
		await expectEmailRows(cycle.id, ["SENT"]);
		expect(await bellCount(editor.id)).toBe(1);
		// Version 1, not 2: activation deliberately does not bump, so the single increment here is
		// the completing write. That is the evidence the row travelled NOT_APPLICABLE -> PENDING ->
		// SENT rather than being stamped SENT from the default.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// 10. Re-driving is safe.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a second invocation against an already-SENT cycle is a no-op (1C-2b)",
	async () => {
		// This is what makes Task 11's recovery entry point safe to re-drive against any cycle
		// without checking first.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});
		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		expect(await channelRows(cycle.id, "IN_APP")).toHaveLength(1);
		// One email, not two. The second invocation returns at the already-terminal guard, so it
		// never reaches the email loop — and even if it did, the claim would be refused under a
		// terminal cycle. Counting EMAIL here is what makes "no-op" a claim about both channels.
		await expectEmailRows(cycle.id, ["SENT"]);
		expect(await bellCount(editor.id)).toBe(1);
		// The version does not move a second time either — the second attempt returns before it
		// reaches the completing write.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// 11. A transfer BETWEEN two recipients of the same batch.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a transfer between two recipients keeps the delivered row, creates none, and completes SENT (1C-2b)",
	async () => {
		// The window the batch gate cannot see BY CONSTRUCTION: it ran before the loop began. An
		// attempt-boundary test therefore passes against an implementation that leaks, which is why
		// this case stages the transfer inside the loop. The transfer is applied after the first
		// recipient's bell row commits and before the second recipient's re-authorization reads the
		// project, so no lock is held when it lands.
		const { project, cycle, tenant } = await seedReadyCycle();
		const first = await seedUser("First recipient");
		await addProjectMember(project.id, first.id, "EDITOR");
		const second = await seedUser("Second recipient");
		await addProjectMember(project.id, second.id, "EDITOR");
		// Candidate ORDER is deterministic: relevance walks the topic's contributorUserIds in array
		// order, and the toggle filter preserves it.
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			first.id,
			second.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		const newOrgId = await seedOrg("1C-2b mid-batch org");

		let delivered = false;
		let moved = false;
		await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					!delivered &&
					model === "Notification" &&
					operation === "create"
				) {
					delivered = true;
					return query(args);
				}
				// The first Project read AFTER that bell row belongs to the second recipient's
				// re-authorization. The delivery transaction has committed and released its
				// FOR UPDATE by then, so the transfer commits here instead of deadlocking against
				// our own lock.
				if (
					delivered &&
					!moved &&
					model === "Project" &&
					operation === "findUnique"
				) {
					moved = true;
					await db.project.update({
						where: { id: project.id },
						data: { organizationId: newOrgId },
					});
				}
				return query(args);
			},
			() =>
				runPublishingTopicsReadyNotification({
					cycleId: cycle.id,
					tenant,
				}),
		);

		expect(delivered).toBe(true);
		expect(moved).toBe(true);
		const rows = await ledgerRows(cycle.id);
		// Exactly three claims, and the third is the one a previous draft of this case got wrong.
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientUserId).toBe(first.id);
		expect(rows[0]?.status).toBe("SENT");
		expect(rows[0]?.deliveredAt).not.toBeNull();
		expect(await bellCount(second.id)).toBe(0);
		// SENT, not CANCELLED: one obligation was confirmed delivered and every remaining one is
		// terminal, so CANCELLED would tell an operator "none may be delivered" about a cycle that
		// delivered. And the activity RESOLVES — cancelled obligations are terminal, not
		// unconfirmed.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

it.skipIf(!RUN_DB)(
	"a transfer landing after re-authorization is caught by the delivery fence (1C-2b)",
	async () => {
		// The case above stages the transfer where the per-recipient re-authorization sees it. This
		// one lands it one step LATER — after that read answered OK, inside the second recipient's
		// delivery transaction — which is the only window the fence itself can close, and the only
		// way the activity's `result === "TENANT_CHANGED"` branch is reached at all. Removing the
		// re-authorization call makes the case above fail and this one still pass, and removing the
		// fence makes this one fail: that is what proves they are two layers rather than one
		// written twice.
		//
		// The injection point is the cycle-ownership read at the TOP of the delivery transaction,
		// before its `FOR UPDATE` on the project — so the transfer commits on its own connection
		// instead of deadlocking against a lock this transaction has not taken yet.
		const { project, cycle, tenant } = await seedReadyCycle();
		const first = await seedUser("First recipient");
		await addProjectMember(project.id, first.id, "EDITOR");
		const second = await seedUser("Second recipient");
		await addProjectMember(project.id, second.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			first.id,
			second.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		const newOrgId = await seedOrg("1C-2b fence-window org");

		let delivered = false;
		let moved = false;
		await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					!delivered &&
					model === "Notification" &&
					operation === "create"
				) {
					delivered = true;
					return query(args);
				}
				if (
					delivered &&
					!moved &&
					model === "PublishingSuggestionCycle" &&
					operation === "findUnique"
				) {
					moved = true;
					await db.project.update({
						where: { id: project.id },
						data: { organizationId: newOrgId },
					});
				}
				return query(args);
			},
			() =>
				runPublishingTopicsReadyNotification({
					cycleId: cycle.id,
					tenant,
				}),
		);

		expect(delivered).toBe(true);
		expect(moved).toBe(true);
		const rows = await ledgerRows(cycle.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientUserId).toBe(first.id);
		expect(rows[0]?.status).toBe("SENT");
		expect(await bellCount(second.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// 12. A transfer with a prior FAILED row.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a transfer terminalizes a prior FAILED row rather than abandoning it (1C-2b)",
	async () => {
		// The batch gate is the exit taken here, and exiting at the gate WITHOUT terminalizing —
		// or treating "has a row" as "is discharged" — leaves a non-terminal obligation with no
		// retry path while the cycle claims to be cancelled. That is the silent-miss class this
		// whole column exists to close.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: editor.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		const newOrgId = await seedOrg("1C-2b receiving org");
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: newOrgId },
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await ledgerRows(cycle.id);
		// Terminalized, not created: still one row, and it is the one that already existed.
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SKIPPED");
		expect(rows[0]?.reason).toBe("TENANT_CHANGED");
		expect(rows[0]?.deliveredAt).toBeNull();
		expect(await bellCount(editor.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "CANCELLED",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// Cases the plan's list left uncovered.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a pre-existing SKIPPED row is confirmed, not outstanding, so the activity completes (1C-2b)",
	async () => {
		// The unconfirmed set is derived from the ledger's STATE, never from `deliveredAt IS NULL`:
		// a terminal SKIPPED row never gets a deliveredAt, and counting it as outstanding would
		// spin the activity until its retry budget was exhausted over work it must not do. Test 7
		// reaches SKIPPED through the re-authorization branch; this one asserts the derivation
		// directly, on a row the attempt did not create.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Already cancelled");
		await addProjectMember(project.id, editor.id, "EDITOR");
		// Deliberately SINGLE-CHANNEL, and the opt-out is the scope declaration rather than a
		// convenience. The secondary claim below — CANCELLED because every obligation ended
		// terminal and NONE was delivered — is only expressible on a cycle with nothing to deliver
		// on the other channel: leaving email on would deliver one, `anyDelivered` would be true,
		// and the case would assert SENT, which tests the email channel rather than the derivation
		// it exists for. The email channel's own behaviour is covered by the 1C-2c cases below.
		await db.notificationPreference.create({
			data: {
				userId: editor.id,
				organizationId: "",
				publishingEmails: false,
			},
		});
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: editor.id,
				channel: "IN_APP",
				status: "SKIPPED",
				reason: "RECIPIENT_UNAUTHORIZED",
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await ledgerRows(cycle.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SKIPPED");
		expect(await bellCount(editor.id)).toBe(0);
		// Every obligation ended terminal and none was delivered — that is CANCELLED, and it is
		// read off the ledger rather than off a flag accumulated in the loop.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "CANCELLED",
			version: 1,
		});
	},
);

it.skipIf(!RUN_DB)(
	"a cycle that is not READY is left entirely alone (1C-2b)",
	async () => {
		// The entry guard. The trigger is READY-only by construction, so a cycle in any other state
		// is not this activity's to classify — and stamping an outcome on one would put a
		// notification verdict on a cycle that has no topics to notify about.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await db.publishingSuggestionCycle.update({
			where: { id: cycle.id },
			data: { status: "FAILED" },
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		expect(await ledgerRows(cycle.id)).toHaveLength(0);
		expect(await bellCount(editor.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "NOT_APPLICABLE",
			version: 0,
		});
	},
);

it.skipIf(!RUN_DB)(
	"a failing RESOLUTION_FAILED stamp does not replace the error it exists to preserve (1C-2b)",
	async () => {
		// The stamp is documented as best-effort, and the likely reason it fails is the reason the
		// resolver just did — the same database. Letting its rejection propagate would destroy the
		// original cause and hand Temporal a bookkeeping failure instead, which is the one thing the
		// stamp exists to prevent: the operator loses the outage and gains a write error about a
		// column.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		let stampAttempted = false;
		resolveEligibleSpy.mockRejectedValueOnce(
			new Error("injected recipient-resolution failure (1C-2b)"),
		);
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				withQueryObserver(
					async ({ model, operation, args, query }) => {
						// The stamp is the only cycle write left in this attempt: activation ran
						// outside the observer, and the activity rejects on the next statement.
						if (
							model === "PublishingSuggestionCycle" &&
							operation === "updateMany"
						) {
							stampAttempted = true;
							throw new Error(
								"injected outcome-stamp write failure (1C-2b)",
							);
						}
						return query(args);
					},
					() =>
						runPublishingTopicsReadyNotification({
							cycleId: cycle.id,
							tenant,
						}),
				),
				// The ORIGINAL cause, not the bookkeeping one.
			).rejects.toThrow("injected recipient-resolution failure");
		} finally {
			warned.mockRestore();
		}

		expect(stampAttempted).toBe(true);
		// The stamp genuinely did not land, so this is not passing because the write quietly
		// succeeded: the cycle is still where the resolver failure left it, and a retry re-drives.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "PENDING",
			version: 0,
		});
		expect(await ledgerRows(cycle.id)).toHaveLength(0);
	},
);

// ---------------------------------------------------------------------------
// No completing exit may strand an obligation. Three exits reach a terminal
// outcome without ever visiting the loop, and each of them can leave a row
// behind that nothing will ever resolve: the cycle is terminal, so no further
// attempt runs, and 1C-2d's sweep is CYCLE-level — ABANDONED is defined as an
// unresolved cycle, so a row-level obligation under a terminal cycle is
// invisible to it.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"the kill switch terminalizes a stranded row rather than leaving it claimable (1C-2b)",
	async () => {
		// The kill-switch exit is the sharpest of the three: it returns BEFORE candidates are
		// computed, so the stranded row can belong to someone who is still fully eligible. They are
		// not owed a notification — the feature is off — but a row left FAILED says the opposite: it
		// is retryable, and nothing will ever retry it.
		const { orgId, owner, project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: editor.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		// The SAME stranding on the EMAIL channel, and it is not a copy for symmetry's sake: the
		// closing exit terminalizes per channel, so a version that closed only IN_APP would leave
		// this row SENDING — claimable, holding a lease, under a cycle that is terminal and that no
		// attempt will revisit. 1C-2d's sweep is CYCLE-level and would never see it. SENDING rather
		// than FAILED because it is the state only the email channel can be stranded in.
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: editor.id,
				channel: "EMAIL",
				status: "SENDING",
				claimedAt: new Date(),
				claimToken: `claim-${randomUUID()}`,
			},
		});
		await db.publishingSuiteSettings.create({
			data: {
				projectId: project.id,
				organizationId: orgId,
				userId: null,
				createdByUserId: owner.id,
				notificationsEnabled: false,
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SKIPPED");
		// A THIRD reason, because neither sibling is honest here: the recipient was not unauthorized
		// and the tenant did not move. The cycle reached a terminal outcome with this obligation
		// still open, and that is what the ledger has to say.
		expect(rows[0]?.reason).toBe("CYCLE_CLOSED");
		expect(rows[0]?.deliveredAt).toBeNull();
		const emailed = await channelRows(cycle.id, "EMAIL");
		expect(emailed).toHaveLength(1);
		expect(emailed[0]?.status).toBe("SKIPPED");
		expect(emailed[0]?.reason).toBe("CYCLE_CLOSED");
		// The LEASE is released with the obligation. A terminal row carrying a live-looking claim is
		// what would invite 1C-2d's reclaimer to check the lease before the status.
		expect(emailed[0]?.claimedAt).toBeNull();
		expect(emailed[0]?.claimToken).toBeNull();
		expect(await bellCount(editor.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "DISABLED",
			version: 1,
		});
	},
);

it.skipIf(!RUN_DB)(
	"an empty candidate set terminalizes a stranded row rather than leaving it claimable (1C-2b)",
	async () => {
		// Attempt 1 left a FAILED row; the recipient then lost eligibility. Attempt 2 finds nobody to
		// notify and reaches NO_RECIPIENTS — a terminal outcome — so this is the last attempt that
		// will ever look at this cycle.
		const { project, cycle, tenant } = await seedReadyCycle();
		const stranded = await seedUser("No longer a candidate");
		await addTopic(project.id, tenant.organizationId, cycle.id, []);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: stranded.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await ledgerRows(cycle.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SKIPPED");
		expect(rows[0]?.reason).toBe("CYCLE_CLOSED");
		expect(await bellCount(stranded.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "NO_RECIPIENTS",
			version: 1,
		});
	},
);

it.skipIf(!RUN_DB)(
	"normal completion terminalizes a non-candidate's stranded row (1C-2b)",
	async () => {
		// The normal path only ever inspected `inAppCandidates`, so a row belonging to someone who
		// has since dropped out of the candidate set was invisible to it — and this exit is terminal
		// too.
		const { project, cycle, tenant } = await seedReadyCycle();
		const attributed = await seedUser("Attributed editor");
		await addProjectMember(project.id, attributed.id, "EDITOR");
		const dropped = await seedUser("Member, but not attributed");
		await addProjectMember(project.id, dropped.id, "EDITOR");
		// Only `attributed` is a candidate: relevance is attribution-driven, so a member the cycle
		// never attributed is eligible but not relevant.
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			attributed.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: dropped.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(2);
		const attributedRow = rows.find(
			(r) => r.recipientUserId === attributed.id,
		);
		const droppedRow = rows.find((r) => r.recipientUserId === dropped.id);
		expect(attributedRow?.status).toBe("SENT");
		expect(attributedRow?.deliveredAt).not.toBeNull();
		expect(droppedRow?.status).toBe("SKIPPED");
		expect(droppedRow?.reason).toBe("CYCLE_CLOSED");
		expect(droppedRow?.deliveredAt).toBeNull();
		// `dropped` is not a candidate on EITHER channel — relevance is attribution-driven and is
		// computed once, upstream of both toggles — so the email side carries the attributed
		// recipient and nobody else. The stranded row it terminalizes is the IN_APP one above.
		const emailed = await channelRows(cycle.id, "EMAIL");
		expect(emailed.map((r) => r.recipientUserId)).toEqual([attributed.id]);
		expect(emailed[0]?.status).toBe("SENT");
		expect(await bellCount(attributed.id)).toBe(1);
		expect(await bellCount(dropped.id)).toBe(0);
		expect((await readOutcome(cycle.id)).outcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"an already-terminal cycle still terminalizes a row that landed after it closed (1C-2b)",
	async () => {
		// The fourth exit of the same family, and the one that is easiest to read as "nothing to do
		// here". A row CAN appear under a cycle after the winner terminalized it: an attempt that
		// timed out but is still running records a FAILED row through the delivery module's failure
		// recorder, whose fence passes because the tenant has not changed. From then on every attempt
		// returns at this guard, and the row sits claimable under a cycle nothing will ever re-drive —
		// invisible to a CYCLE-level sweep, which is the only sweep 1C-2d has.
		//
		// This attempt has no completion to make, so it must NOT move the outcome. It only closes the
		// leftover.
		const { project, cycle, tenant } = await seedReadyCycle();
		const stranded = await seedUser("Recorded after the winner finished");
		await addProjectMember(project.id, stranded.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			stranded.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "SENT",
			observedVersion: 0,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: stranded.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		// And the same on EMAIL. This branch returns immediately, so its terminalization is the ONLY
		// thing that will ever touch these rows — a version that closed one channel and not the
		// other would leave a claimable email obligation with a live lease under a resolved cycle.
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: stranded.id,
				channel: "EMAIL",
				status: "FAILED",
				reason: "PROVIDER_REJECTED",
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SKIPPED");
		expect(rows[0]?.reason).toBe("CYCLE_CLOSED");
		const emailed = await channelRows(cycle.id, "EMAIL");
		expect(emailed).toHaveLength(1);
		expect(emailed[0]?.status).toBe("SKIPPED");
		expect(emailed[0]?.reason).toBe("CYCLE_CLOSED");
		expect(await bellCount(stranded.id)).toBe(0);
		// Untouched: another attempt's answer stands, and the version does not move — this attempt
		// wrote no outcome at all.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// "Delivered" means the same thing at every exit. It is read off ALL rows on
// BOTH channels — a delivery is a delivery whether it was a bell or a mail —
// and never off the current candidate set: a candidate set is a snapshot of
// who is owed a notification NOW, and the cycle-level outcome is a statement
// about what actually happened to this cycle.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a cycle that already delivered records SENT even when no candidate remains (1C-2b)",
	async () => {
		// NO_RECIPIENTS tells an operator nobody was notified. A bell row says otherwise, and the
		// bell row is the one the recipient can see.
		const { project, cycle, tenant } = await seedReadyCycle();
		const alreadyTold = await seedUser("Notified in attempt 1");
		await addTopic(project.id, tenant.organizationId, cycle.id, []);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: alreadyTold.id,
				channel: "IN_APP",
				status: "SENT",
				deliveredAt: new Date("2026-08-01T00:00:00.000Z"),
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		const rows = await ledgerRows(cycle.id);
		expect(rows).toHaveLength(1);
		// Terminalization never touches a delivered row.
		expect(rows[0]?.status).toBe("SENT");
		expect(rows[0]?.deliveredAt).not.toBeNull();
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

it.skipIf(!RUN_DB)(
	"normal completion reads delivered off all rows, not off the candidate set (1C-2b)",
	async () => {
		// Every surviving CANDIDATE ends terminal-but-undelivered, which a candidates-only reading
		// calls CANCELLED — "obligations existed and none may be delivered" — about a cycle that put
		// a real bell row in someone's tray on an earlier attempt. The two closures in this activity
		// have to answer this question identically, so they now share one.
		const { project, cycle, tenant } = await seedReadyCycle();
		const cancelled = await seedUser("Candidate, already cancelled");
		await addProjectMember(project.id, cancelled.id, "EDITOR");
		const alreadyTold = await seedUser("Notified in attempt 1");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			cancelled.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: cancelled.id,
				channel: "IN_APP",
				status: "SKIPPED",
				reason: "RECIPIENT_UNAUTHORIZED",
			},
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: alreadyTold.id,
				channel: "IN_APP",
				status: "SENT",
				deliveredAt: new Date("2026-08-01T00:00:00.000Z"),
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: cycle.id,
			tenant,
		});

		expect(await bellCount(cancelled.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "SENT",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// The lost compare-and-swap, forced deterministically.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"losing the outcome compare-and-swap rejects rather than reporting success (1C-2b)",
	async () => {
		// No timing dependency at all: the competing write is made to land at a chosen query, using
		// the same registered observer seam the tenant-transfer cases already use. Bumping the
		// version is enough — `completeCycleNotificationOutcome` then answers LOST because the cycle
		// is still non-terminal, which is exactly the interleaving this branch exists for (a timed-out
		// attempt still running while a retry stamps RESOLUTION_FAILED).
		//
		// The activity must REJECT. Resolving here would report success over a cycle left
		// non-terminal with nothing scheduled to resolve it — a silent miss produced by the very
		// guard that exists to prevent one.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		let bumped = false;
		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					// The BATCH category-toggle read: after the activity captured `version`,
					// before it writes the outcome. `!bumped` pins this to the batch read —
					// re-authorization issues the same query once per recipient.
					if (
						!bumped &&
						model === "NotificationPreference" &&
						operation === "findMany"
					) {
						bumped = true;
						await writeCycleNotificationOutcome({
							cycleId: cycle.id,
							projectId: project.id,
							outcome: "RESOLUTION_FAILED",
							observedVersion: 0,
						});
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: cycle.id,
						tenant,
					}),
			),
		).rejects.toThrow(/compare-and-swap/);

		// Positive control: without it this passes for any reason at all.
		expect(bumped).toBe(true);
		// The delivery itself still happened and is still confirmed — losing the swap says nothing
		// about the ledger, which is why a fresh attempt can re-drive this safely. That holds on
		// both channels: the swap is a statement about the CYCLE's outcome, not about any row.
		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SENT");
		await expectEmailRows(cycle.id, ["SENT"]);
		expect(await bellCount(editor.id)).toBe(1);
		// Left non-terminal, for the newer attempt to classify.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "RESOLUTION_FAILED",
			version: 1,
		});
	},
);

it.skipIf(!RUN_DB)(
	"losing the swap at a terminalizing exit rolls the terminalization back (1C-2b)",
	async () => {
		// The closing exit does two writes — terminalize the open obligations, then compare-and-swap
		// the cycle's outcome — and they have to be ONE unit. Committing the first on the authority of
		// a completion that is then lost is a silent miss with a plausible-looking ledger: the kill
		// switch here terminalizes a STILL-ELIGIBLE candidate's row, loses the swap, and rejects. An
		// admin turns the switch back on, the retry recomputes that person as a candidate, finds their
		// row SKIPPED, reads it as discharged — and they are never notified while the cycle resolves.
		//
		// It also makes the ledger assert something false: CYCLE_CLOSED is defined as "the cycle
		// reached a terminal outcome with this obligation still open", and on this path the cycle
		// reached no terminal outcome at all.
		//
		// So the assertion is on the ROW, not on the rejection: after a lost swap the obligation must
		// still be claimable. Same deterministic technique as the case above — the competing write is
		// staged at a chosen query, with no timing dependency.
		const { orgId, owner, project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Still eligible");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: editor.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		await db.publishingSuiteSettings.create({
			data: {
				projectId: project.id,
				organizationId: orgId,
				userId: null,
				createdByUserId: owner.id,
				notificationsEnabled: false,
			},
		});

		let bumped = false;
		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					// The kill-switch read: after the activity captured `version`, before the closing
					// exit opens its transaction — so the competing write commits on its own
					// connection with nothing of ours locked.
					if (
						!bumped &&
						model === "PublishingSuiteSettings" &&
						operation === "findUnique"
					) {
						bumped = true;
						await writeCycleNotificationOutcome({
							cycleId: cycle.id,
							projectId: project.id,
							outcome: "RESOLUTION_FAILED",
							observedVersion: 0,
						});
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: cycle.id,
						tenant,
					}),
			),
		).rejects.toThrow(/compare-and-swap/);

		// Positive control: without it this passes for any reason at all.
		expect(bumped).toBe(true);
		const rows = await ledgerRows(cycle.id);
		expect(rows).toHaveLength(1);
		// The whole point. FAILED is claimable; SKIPPED is not, and nothing that ran here earned the
		// right to close it.
		expect(rows[0]?.status).toBe("FAILED");
		expect(rows[0]?.reason).toBe("WRITE_FAILED");
		expect(rows[0]?.deliveredAt).toBeNull();
		expect(await bellCount(editor.id)).toBe(0);
		// Left where the competing attempt put it — non-terminal, so a fresh attempt re-drives.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "RESOLUTION_FAILED",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// The per-recipient catch boundary, driven by an actual throw.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"a throw for one recipient neither denies the rest nor stops the retry (1C-2b)",
	async () => {
		// Both halves at once, because either alone describes a broken implementation: the sibling
		// still gets their notification (the catch is per recipient), AND the activity still rejects
		// (the unconfirmed count is what turns an absorbed throw back into a retry).
		//
		// The `step` label asserts the third property: each fallible call sits in its OWN try, so a
		// throw is attributed to the boundary it came from instead of being reported as an
		// undifferentiated "recipient failed" that a TypeError in the branch logic could also produce.
		const { project, cycle, tenant } = await seedReadyCycle();
		const first = await seedUser("First recipient");
		await addProjectMember(project.id, first.id, "EDITOR");
		const second = await seedUser("Second recipient");
		await addProjectMember(project.id, second.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			first.id,
			second.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				withQueryObserver(
					async ({ model, operation, args, query }) => {
						// Only the SECOND recipient's re-authorization. `resolvePublishing-
						// EligibleRecipients` reads the roster with findMany, so findUnique here is
						// the per-recipient read and nothing else.
						if (
							model === "ProjectMember" &&
							operation === "findUnique" &&
							(
								args as {
									where?: {
										projectId_userId?: { userId?: string };
									};
								}
							).where?.projectId_userId?.userId === second.id
						) {
							throw new Error(
								"injected re-authorization failure (1C-2b)",
							);
						}
						return query(args);
					},
					() =>
						runPublishingTopicsReadyNotification({
							cycleId: cycle.id,
							tenant,
						}),
				),
			).rejects.toThrow(/unconfirmed/);

			expect(warned).toHaveBeenCalledWith(
				expect.stringContaining("notifyPublishingTopicsReady"),
				expect.objectContaining({
					step: "reauthorize",
					channel: "IN_APP",
					recipientUserId: second.id,
				}),
			);
			// The EMAIL loop re-authorizes the same recipient and hits the same injected throw, so
			// the boundary reports a SECOND line — and that line must name its own channel. The
			// field used to be the literal "IN_APP" for every step; left that way, an operator
			// debugging a failed email would read a log entry that says the bell failed, which is
			// worse than no field at all because it looks authoritative. Asserting both lines is
			// what makes the parameter load-bearing instead of decorative.
			expect(warned).toHaveBeenCalledWith(
				expect.stringContaining("notifyPublishingTopicsReady"),
				expect.objectContaining({
					step: "reauthorize-email",
					channel: "EMAIL",
					recipientUserId: second.id,
				}),
			);
		} finally {
			warned.mockRestore();
		}

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientUserId).toBe(first.id);
		expect(rows[0]?.status).toBe("SENT");
		// The injected throw is at the per-recipient ProjectMember read, which the EMAIL loop makes
		// for the same recipient — so `second` is left undischarged on both channels and `first` is
		// discharged on both. That is the per-recipient boundary doing its job twice, not once.
		const emailed = await channelRows(cycle.id, "EMAIL");
		expect(emailed.map((r) => r.recipientUserId)).toEqual([first.id]);
		expect(emailed[0]?.status).toBe("SENT");
		expect(await bellCount(first.id)).toBe(1);
		expect(await bellCount(second.id)).toBe(0);
		// Non-terminal, so the retry can still discharge the second recipient. Nothing was
		// terminalized: the rejection happens BEFORE the completing exit, which is what keeps an
		// undischarged obligation claimable.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "PENDING",
			version: 0,
		});
	},
);

it.skipIf(!RUN_DB)(
	"a throw while recording a skip is attributed to the record-skip boundary (1C-2b)",
	async () => {
		// The second of the three boundaries. The case above proves the PROPERTY on "reauthorize";
		// this one proves the label is wired per call rather than being one `try` around the loop body
		// wearing three names — a distinction that only shows up when a different call throws.
		//
		// recordPublishingDeliverySkip is genuinely throwable (an uncaught db.$transaction), so this
		// drives it with a real throw at a real query rather than through a spy.
		const { project, cycle, tenant } = await seedReadyCycle();
		const kept = await seedUser("Still an editor");
		await addProjectMember(project.id, kept.id, "EDITOR");
		const revoked = await seedUser("Demoted mid-attempt");
		await addProjectMember(project.id, revoked.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			kept.id,
			revoked.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		let demoted = false;
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				withQueryObserver(
					async ({ model, operation, args, query }) => {
						// Same staging as the revoked-recipient case: demote at the FIRST
						// NotificationPreference.findMany — a batch toggle read, well before the
						// per-recipient loop though no longer the last query before it, and which
						// of the two identical batch reads it is comes down to the argument order
						// of the `Promise.all` that issues them. See that case for the full note.
						if (
							!demoted &&
							model === "NotificationPreference" &&
							operation === "findMany"
						) {
							demoted = true;
							const result = await query(args);
							await db.projectMember.update({
								where: {
									projectId_userId: {
										projectId: project.id,
										userId: revoked.id,
									},
								},
								data: { role: "VIEWER" },
							});
							return result;
						}
						// The only upsert on this model in this flow: the delivery module's failure
						// recorder is the other one, and nothing here makes a delivery fail.
						if (
							model === "PublishingNotificationDelivery" &&
							operation === "upsert"
						) {
							throw new Error(
								"injected skip-write failure (1C-2b)",
							);
						}
						return query(args);
					},
					() =>
						runPublishingTopicsReadyNotification({
							cycleId: cycle.id,
							tenant,
						}),
				),
			).rejects.toThrow(/unconfirmed/);

			expect(warned).toHaveBeenCalledWith(
				expect.stringContaining("notifyPublishingTopicsReady"),
				expect.objectContaining({
					step: "record-skip",
					recipientUserId: revoked.id,
				}),
			);
		} finally {
			warned.mockRestore();
		}

		expect(demoted).toBe(true);
		const rows = await channelRows(cycle.id, "IN_APP");
		// The sibling is unaffected, and the demoted recipient has NO row — the skip write is the one
		// that threw, so nothing recorded them as discharged.
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientUserId).toBe(kept.id);
		expect(rows[0]?.status).toBe("SENT");
		// Same on EMAIL, and for the same reason: the injected throw is on the delivery table's
		// `upsert`, which only `recordPublishingDeliverySkip` issues — the email CLAIM creates its
		// row instead, so the sibling's send is untouched while the demoted recipient stays
		// undischarged on both channels.
		const emailed = await channelRows(cycle.id, "EMAIL");
		expect(emailed.map((r) => r.recipientUserId)).toEqual([kept.id]);
		expect(emailed[0]?.status).toBe("SENT");
		expect(await bellCount(revoked.id)).toBe(0);
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "PENDING",
			version: 0,
		});
	},
);

it.skipIf(!RUN_DB)(
	"a throw while delivering is attributed to the deliver boundary (1C-2b)",
	async () => {
		// The third boundary, and the only one that needs a spy — deliberately, and worth saying
		// plainly: deliverPublishingTopicsReadyInApp is TOTAL today. Every path through it, including
		// its own failure recorder and that recorder's own catch, ends in a `return`, so it answers
		// "FAILED"/"TENANT_CHANGED" instead of throwing and no query-level injection can make it throw.
		//
		// That makes this boundary defence against a future change rather than a live path, which is
		// exactly why it is worth a test: the day someone adds a rethrow — or a fourth call into this
		// loop — the label has to already be right, and the sibling has to already be safe. Driving it
		// through the module spy is honest about the fact that the throw is synthetic.
		const { project, cycle, tenant } = await seedReadyCycle();
		const failing = await seedUser("First recipient");
		await addProjectMember(project.id, failing.id, "EDITOR");
		const sibling = await seedUser("Second recipient");
		await addProjectMember(project.id, sibling.id, "EDITOR");
		// Candidate order follows contributorUserIds, so `failing` is delivered to first and consumes
		// the one-shot rejection.
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			failing.id,
			sibling.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			deliverInAppSpy.mockRejectedValueOnce(
				new Error("injected in-app delivery failure (1C-2b)"),
			);
			await expect(
				runPublishingTopicsReadyNotification({
					cycleId: cycle.id,
					tenant,
				}),
			).rejects.toThrow(/unconfirmed/);

			expect(warned).toHaveBeenCalledWith(
				expect.stringContaining("notifyPublishingTopicsReady"),
				expect.objectContaining({
					step: "deliver",
					recipientUserId: failing.id,
				}),
			);
		} finally {
			warned.mockRestore();
		}

		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientUserId).toBe(sibling.id);
		expect(rows[0]?.status).toBe("SENT");
		// BOTH get their email. The one-shot rejection is queued on the IN_APP delivery module
		// alone, so the email channel is untouched by it — which is the per-channel independence
		// this slice added, asserted where a shared failure path would show up as a missing row.
		await expectEmailRows(cycle.id, ["SENT", "SENT"]);
		expect(await bellCount(failing.id)).toBe(0);
		expect(await bellCount(sibling.id)).toBe(1);
		// Non-terminal and nothing terminalized, so the retry can still discharge the first recipient.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "PENDING",
			version: 0,
		});
	},
);

it.skipIf(!RUN_DB)(
	"a cycle belonging to a different project writes nothing under this tenant (1C-2b)",
	async () => {
		// The `projectId` predicate on the state read is the first line of that defence, and it is
		// asserted here at the ACTIVITY level: a stale or version-skewed input naming another
		// project's cycle must not reach the ledger at all, and must not stamp an outcome on
		// either cycle.
		const foreign = await seedReadyCycle();
		const { project, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");

		await runPublishingTopicsReadyNotification({
			cycleId: foreign.cycle.id,
			tenant,
		});

		expect(await ledgerRows(foreign.cycle.id)).toHaveLength(0);
		expect(await bellCount(editor.id)).toBe(0);
		expect(await readOutcome(foreign.cycle.id)).toEqual({
			outcome: "NOT_APPLICABLE",
			version: 0,
		});
	},
);

// ---------------------------------------------------------------------------
// The opt-out is re-read per recipient, not carried as a batch snapshot.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"an opt-out committed after the batch query still suppresses that recipient (1C-2b)",
	async () => {
		// The batch answer from getEnabledRecipientsForCategory is a snapshot of who was opted in
		// at ONE instant. Delivery happens afterwards, recipient by recipient, and an execution
		// that timed out keeps running — so a user who turns the toggle off can otherwise still be
		// notified by an attempt that read their preference minutes earlier. The sibling is in the
		// same batch so this cannot pass merely because nothing was delivered at all.
		const { project, cycle, tenant } = await seedReadyCycle();
		const kept = await seedUser("Still opted in");
		await addProjectMember(project.id, kept.id, "EDITOR");
		const optsOut = await seedUser("Opts out mid-attempt");
		await addProjectMember(project.id, optsOut.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			kept.id,
			optsOut.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		let optedOut = false;
		await withQueryObserver(
			async ({ model, operation, args, query }) => {
				// The FIRST NotificationPreference.findMany is a batch toggle filter — not the
				// last query before the per-recipient loop (a byte-identical sibling for the email
				// toggle shares its `Promise.all`, and several other reads follow), but well
				// before it, which is what this staging needs. Writing the opt-out immediately
				// after it answers lands the change strictly between the batch snapshot and the
				// re-check that is supposed to notice. WHICH of the two identical batch reads
				// `!optedOut` catches is decided by that `Promise.all`'s argument order, and
				// either serves. (The per-recipient re-check issues the same query later; the flag
				// is what keeps this to a batch one.)
				if (
					!optedOut &&
					model === "NotificationPreference" &&
					operation === "findMany"
				) {
					optedOut = true;
					const result = await query(args);
					await db.notificationPreference.create({
						data: {
							userId: optsOut.id,
							organizationId: "",
							publishingSuggestions: false,
						},
					});
					return result;
				}
				return query(args);
			},
			() =>
				runPublishingTopicsReadyNotification({
					cycleId: cycle.id,
					tenant,
				}),
		);

		// Positive control: without it the assertions below pass for a reason unrelated to the
		// re-check.
		expect(optedOut).toBe(true);
		const rows = await channelRows(cycle.id, "IN_APP");
		expect(rows).toHaveLength(2);
		const keptRow = rows.find((r) => r.recipientUserId === kept.id);
		const optedOutRow = rows.find((r) => r.recipientUserId === optsOut.id);
		expect(keptRow?.status).toBe("SENT");
		// The opt-out row sets `publishingSuggestions` ONLY, so both recipients are still email
		// candidates and both are emailed. That is the independence, asserted from the other
		// direction than the four-combination case: switching the bell off mid-attempt must not
		// switch email off as a side effect.
		await expectEmailRows(cycle.id, ["SENT", "SENT"]);
		expect(await bellCount(kept.id)).toBe(1);
		// SKIPPED and terminal, so the activity completes rather than rejecting over an
		// obligation it must not discharge. RECIPIENT_UNAUTHORIZED is the reason because the
		// ledger's reason set is closed and this is a decision ABOUT this person.
		expect(optedOutRow?.status).toBe("SKIPPED");
		expect(optedOutRow?.reason).toBe("RECIPIENT_UNAUTHORIZED");
		expect(await bellCount(optsOut.id)).toBe(0);
		expect((await readOutcome(cycle.id)).outcome).toBe("SENT");
	},
);

// ---------------------------------------------------------------------------
// Delivery and terminalization are MUTUALLY EXCLUSIVE.
//
// Atomicity alone does not give that: the closing transaction can commit its
// terminal outcome while a still-running overlapping attempt commits a delivery
// beside it. An activity's start-to-close timeout does NOT stop the attempt that
// timed out, so "an older attempt is still in the loop" is the normal case, not a
// corner. The two are serialized on the project row, which the delivery paths
// already take FOR UPDATE and the close now takes as well.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"the closing transaction holds the project row lock while it terminalizes (1C-2b)",
	async () => {
		// The kill-switch exit, because it returns BEFORE candidates are computed: the only
		// ledger `updateMany` in the whole attempt is then the one inside the closing
		// transaction, so the probe below cannot fire at some earlier write and pass for the
		// wrong reason.
		const { orgId, owner, project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Still eligible");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: editor.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		await db.publishingSuiteSettings.create({
			data: {
				projectId: project.id,
				organizationId: orgId,
				userId: null,
				createdByUserId: owner.id,
				notificationsEnabled: false,
			},
		});

		let probed = false;
		let lockHeldDuringClose: boolean | null = null;
		await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					!probed &&
					model === "PublishingNotificationDelivery" &&
					operation === "updateMany"
				) {
					// `probed` is set BEFORE the probe runs: the probe issues its own queries
					// through this same observer, and without the flag it would re-enter.
					probed = true;
					lockHeldDuringClose = await projectRowLockIsHeld(
						project.id,
					);
				}
				return query(args);
			},
			() =>
				runPublishingTopicsReadyNotification({
					cycleId: cycle.id,
					tenant,
				}),
		);

		// Positive control on the staging: without it the assertion below passes for a probe
		// that never ran.
		expect(probed).toBe(true);
		expect(lockHeldDuringClose).toBe(true);
		// Negative control on the PROBE. The same question, asked with no transaction of ours
		// open, must answer `false` — otherwise `true` above would prove nothing except that
		// the probe always says `true`.
		expect(await projectRowLockIsHeld(project.id)).toBe(false);
	},
);

it.skipIf(!RUN_DB)(
	"a cycle terminalized mid-attempt gets no further ledger row and no bell (1C-2b)",
	async () => {
		// The other half of the same gap, and the one a user would feel. A newer attempt closes
		// the cycle while this one is between its own entry guard and its delivery; without the
		// fence's terminality check this attempt writes a SENT row and a real bell for a cycle
		// whose outcome says nobody was notified — and 1C-2d's sweep is CYCLE-level, so nothing
		// ever reconciles the row.
		//
		// Staged at the per-recipient re-authorization's ProjectMember read, which is strictly
		// after this attempt's entry guard read the outcome and strictly before the delivery
		// transaction opens.
		const { project, cycle, tenant } = await seedReadyCycle();
		const editor = await seedUser("Attributed editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		await addTopic(project.id, tenant.organizationId, cycle.id, [
			editor.id,
		]);
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});

		let closed = false;
		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					if (
						!closed &&
						model === "ProjectMember" &&
						operation === "findUnique"
					) {
						closed = true;
						await writeCycleNotificationOutcome({
							cycleId: cycle.id,
							projectId: project.id,
							outcome: "DISABLED",
							observedVersion: 0,
						});
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: cycle.id,
						tenant,
					}),
			),
			// It REJECTS rather than completing: the recipient is left unconfirmed, which is the
			// honest state. The retry then returns at the entry guard, whose already-terminal
			// branch terminalizes whatever is outstanding — so nothing is stranded, and nothing
			// was written under a closed cycle.
		).rejects.toThrow(/unconfirmed/);

		expect(closed).toBe(true);
		expect(await ledgerRows(cycle.id)).toHaveLength(0);
		expect(await bellCount(editor.id)).toBe(0);
		// The winner's answer stands, untouched by the attempt that lost.
		expect(await readOutcome(cycle.id)).toEqual({
			outcome: "DISABLED",
			version: 1,
		});
	},
);

// ---------------------------------------------------------------------------
// 1C-2c fixtures. This file's copy is independent of the one in
// packages/database — deliberately, since the two run in different packages
// against different mock setups — so it gets its own sanity check.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"fixture: the seeded recipient is genuinely eligible",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		// If this returns [] the fixture is wrong — not the resolver. Asserting it here means a later
		// test that expects "nobody was notified" cannot pass because the fixture never made anyone
		// eligible in the first place.
		await expect(
			resolvePublishingEligibleRecipients({
				projectId: seeded.projectId,
			}),
		).resolves.toContain(seeded.recipientUserId);

		// And RELEVANCE, which eligibility does not imply and which the check above cannot see.
		// Candidacy is `eligible ∩ relevant`, so an eligible recipient the cycle never attributed
		// is not a candidate on either channel — the activity terminalizes at NO_RECIPIENTS before
		// reaching them. That is precisely the defect this fixture shipped with: it seeded members
		// and no topic, and five of the seven 1C-2c cases below died at NO_RECIPIENTS while this
		// sanity check stayed green, because eligibility does not depend on attribution. Asserting
		// the selector too is what makes the fixture's `addTopic` self-guarding.
		await expect(
			selectRelevantRecipientIds({
				projectId: seeded.projectId,
				cycleId: seeded.cycleId,
				candidateUserIds: [seeded.recipientUserId],
			}),
		).resolves.toContain(seeded.recipientUserId);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: all four toggle combinations, each on its own channel",
	async () => {
		const seeded = await seedReadyCycleWithRecipients(4);
		const [both, bellOnly, emailOnly, neither] = seeded.recipientUserIds;
		await db.notificationPreference.createMany({
			data: [
				// `both` gets no row: a missing row means enabled on both channels under the
				// opt-out model, and exercising that path beats a redundant true/true row.
				{
					userId: bellOnly,
					organizationId: "",
					publishingEmails: false,
				},
				{
					userId: emailOnly,
					organizationId: "",
					publishingSuggestions: false,
				},
				{
					userId: neither,
					organizationId: "",
					publishingSuggestions: false,
					publishingEmails: false,
				},
			],
		});
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(true);

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		const rows = await db.publishingNotificationDelivery.findMany({
			where: { cycleId: seeded.cycleId },
			select: { recipientUserId: true, channel: true, status: true },
		});
		const at = (userId: string, channel: string) =>
			rows.find(
				(r) => r.recipientUserId === userId && r.channel === channel,
			)?.status ?? null;

		expect(at(both, "IN_APP")).toBe("SENT");
		expect(at(both, "EMAIL")).toBe("SENT");
		expect(at(bellOnly, "IN_APP")).toBe("SENT");
		expect(at(bellOnly, "EMAIL")).toBeNull();
		// THE case that fails if the two filters are chained. Chaining passes every other
		// combination here and fails only this one, silently: publishingSuggestions=false would
		// remove the user before the email filter ever saw them.
		expect(at(emailOnly, "IN_APP")).toBeNull();
		expect(at(emailOnly, "EMAIL")).toBe("SENT");
		expect(at(neither, "IN_APP")).toBeNull();
		expect(at(neither, "EMAIL")).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a missing mail key records MAIL_NOT_CONFIGURED and still delivers the bell",
	async () => {
		const seeded = await seedReadyCycleWithRecipient(); // both toggles on
		vi.mocked(isMailConfigured).mockReturnValue(false);
		vi.mocked(sendEmail).mockClear();

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		// MAIL_NOT_CONFIGURED must WIN over SENT. The bell did reach someone, so an outcome
		// derived from "was anything delivered" would report SENT and the outage would be
		// invisible — which is the exact hole this value was added to close.
		expect(cycle.notificationOutcome).toBe("MAIL_NOT_CONFIGURED");

		const rows = await db.publishingNotificationDelivery.findMany({
			where: { cycleId: seeded.cycleId },
			select: { channel: true, status: true },
		});
		expect(rows.filter((r) => r.channel === "IN_APP")[0]?.status).toBe(
			"SENT",
		);
		// No email row is CLAIMED: the key is checked before any claim, so an unsendable lease is
		// never taken.
		expect(rows.filter((r) => r.channel === "EMAIL")).toHaveLength(0);
		expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a missing mail key does NOT discharge an outstanding bell — it rejects",
	async () => {
		// THE CONJUNCTION. Each half alone is covered above and each passes against the wrong
		// implementation: a missing key with a SUCCESSFUL bell terminalizes correctly, and a
		// failed bell with a WORKING key rejects correctly. Only together do they catch a gate
		// that closes the cycle before in-app accounting runs — and that gate would flip the
		// recipient's FAILED row to SKIPPED, write a terminal outcome, and leave them with
		// neither channel and no retry. A mail outage must not cost the channel that works.
		const seeded = await seedReadyCycleWithRecipient();
		vi.mocked(isMailConfigured).mockReturnValue(false);

		// The bell WRITE is what fails, injected at the real query — not the delivery module
		// stubbed to answer "FAILED". The distinction is the whole third assertion below:
		// deliverPublishingTopicsReadyInApp never returns FAILED without recording a FAILED row
		// through its own failure recorder, so a spy that returns the verdict and skips the write
		// stages a state production cannot reach — no row at all — and the case would then be
		// asserting against its own fixture rather than against the code. Same injection point as
		// the 1C-2b unconfirmed case above, for the same reason.
		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					if (model === "Notification" && operation === "create") {
						throw new Error(
							"injected bell-row write failure (1C-2c)",
						);
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
					}),
			),
		).rejects.toThrow(/unconfirmed/i);

		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		// Still non-terminal, so the retry can still deliver the bell. Asserting the rejection
		// alone would pass against an implementation that rejected AFTER terminalizing.
		expect(cycle.notificationOutcome).toBe("PENDING");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "IN_APP",
				},
			},
		});
		// FAILED means "try again". SKIPPED here would be the silent discharge.
		expect(row.status).toBe("FAILED");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: an EMPTY email candidate set with the key absent reports SENT, not a fault",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		await db.notificationPreference.create({
			data: {
				userId: seeded.recipientUserId,
				organizationId: "",
				publishingEmails: false,
			},
		});
		vi.mocked(isMailConfigured).mockReturnValue(false);

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		// The trigger is the EMAIL CANDIDATE SET, never the relevant set. A cycle where nobody
		// wanted email has no email to send, so a missing key is not a fault there — reporting one
		// manufactures an alert out of a correctly configured, fully delivered cycle and trains
		// operators to ignore the value.
		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		expect(cycle.notificationOutcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: NO_RECIPIENTS requires BOTH candidate sets to be empty",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		await db.notificationPreference.create({
			data: {
				userId: seeded.recipientUserId,
				organizationId: "",
				publishingSuggestions: false,
				publishingEmails: true,
			},
		});
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(true);

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		// The in-app set is empty and the email set is not. An early return keyed on the in-app
		// set alone would terminalize the cycle as NO_RECIPIENTS and never send the email — and
		// every single-channel test in this file would still pass.
		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		expect(cycle.notificationOutcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a recipient with no email address is SKIPPED terminally, not retried",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		vi.mocked(isMailConfigured).mockReturnValue(true);

		// STAGED, and the fixture cannot produce this state for real — worth saying plainly rather
		// than dressing a synthetic stimulus up as a natural one.
		//
		// `User.email` is `String @unique`, NOT NULL (schema.prisma:22), so no update makes an
		// eligible recipient addressless. The only route to a null address in production is a
		// candidate MISSING from the batch `user.findMany` — the account deleted between the roster
		// read and this one. That cannot be staged with a real delete either:
		// PublishingNotificationDelivery.recipientUserId is an FK to User (onDelete: Cascade), so
		// the skip row this test is about could not be inserted afterwards.
		//
		// So the read is staged at the registered query observer instead, exactly as the
		// tenant-transfer cases stage a transfer: the activity issues its real query and is handed a
		// result with this candidate absent, which is what a deleted account would look like from
		// inside the activity. The user row itself stays, so the ledger write has its FK.
		//
		// That makes this guard defence against a schema that has not happened yet — the same
		// honest footing as the "deliver boundary" case above, which drives a spy because
		// deliverPublishingTopicsReadyInApp is total today. It is worth pinning anyway: without the
		// guard the null address flows into deliverPublishingTopicsReadyEmail, which BURNS A CLAIM
		// and hands `to: null` to the provider.
		let addressWithheld = false;
		await withQueryObserver(
			async ({ model, operation, args, query }) => {
				// The RECIPIENT-ADDRESS read specifically, keyed on the shape only it has:
				// `select: { id, email }` over `where: { id: { in: [...] } }`. Matching every
				// `User.findMany` would make this case quietly stronger than it looks —
				// `addressWithheld` would prove only that SOME user read fired, and a future
				// upstream `User.findMany` would be filtered instead, failing this test with what
				// reads like a production regression in the guard it is actually asserting.
				const addressRead = args as {
					where?: { id?: { in?: unknown } };
					select?: { email?: boolean };
				};
				if (
					model === "User" &&
					operation === "findMany" &&
					Array.isArray(addressRead.where?.id?.in) &&
					addressRead.select?.email === true
				) {
					addressWithheld = true;
					const result = (await query(args)) as { id: string }[];
					return result.filter(
						(row) => row.id !== seeded.recipientUserId,
					);
				}
				return query(args);
			},
			() =>
				runPublishingTopicsReadyNotification({
					cycleId: seeded.cycleId,
					tenant: seeded.tenant,
				}),
		);

		// Positive control: without it this passes for an implementation that never reads addresses
		// at all, and the filter above would be asserting nothing.
		expect(addressWithheld).toBe(true);
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		// Terminal, because retrying cannot create an address. FAILED would make the activity
		// reject until its budget was exhausted over work that can never be discharged.
		expect(row.status).toBe("SKIPPED");
		expect(row.reason).toBe("NO_EMAIL_ADDRESS");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: an unconfirmed EMAIL row makes the activity reject",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(false);

		// Rejecting is what earns the Temporal retry. Asserting only that the row is FAILED would
		// pass against a version that resolves — the silent-loss shape this suite exists to catch.
		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).rejects.toThrow(/unconfirmed/i);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a HELD email claim stays UNCONFIRMED — it is not a discharge",
	async () => {
		// HELD is the one non-claim verdict that is NOT terminal, and treating it as one is the
		// quietest possible way to lose a notification. It means ANOTHER live attempt owns the
		// lease — a start-to-close timeout does not stop the attempt that timed out, so an
		// overlapping attempt is the normal case rather than a corner. This attempt has therefore
		// discharged NOTHING for that recipient, and if it reported success the completing exit
		// would run and terminalize the row the other attempt is still working on: the obligation
		// is marked SKIPPED, the cycle goes terminal, no further attempt runs, and 1C-2d's sweep is
		// CYCLE-level so nothing ever notices.
		//
		// Rejecting is the only honest answer, and the rejection is what earns the retry that will
		// find the row in whatever state the other attempt left it.
		const seeded = await seedReadyCycleWithRecipient();
		// A real lease taken by a real claim, not a hand-written SENDING row: the point is that the
		// activity's OWN claim answers HELD against it, which is a property of the claim predicate.
		const held = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		// A throw rather than an `expect`, because it has to NARROW as well as assert: the claim's
		// result is a discriminated union and only the CLAIMED member carries a token. It is still
		// the fixture's positive control — without it, a claim that quietly failed would leave the
		// row unclaimed and every assertion below would be about an ordinary send.
		if (held.outcome !== "CLAIMED") {
			throw new Error(
				`fixture failed to take the email lease: ${held.outcome}`,
			);
		}
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockReset();
		vi.mocked(sendEmail).mockResolvedValue(true);

		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).rejects.toThrow(/unconfirmed/i);

		// Nothing was handed to the provider by THIS attempt — the lease is what makes the two
		// mutually exclusive, asserted at the level that matters rather than at the return value.
		expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		// Untouched: still SENDING, still carrying the other attempt's token. A SKIPPED row here
		// would be the silent discharge.
		expect(row.status).toBe("SENDING");
		expect(row.claimToken).toBe(held.claimToken);
		// The bell is unaffected — one channel being held does not deny the other.
		expect((await channelRows(seeded.cycleId, "IN_APP"))[0]?.status).toBe(
			"SENT",
		);
		// Non-terminal, so the retry can still resolve the held obligation.
		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		expect(cycle.notificationOutcome).toBe("PENDING");
	},
);

/**
 * A READY cycle on an ACTIVE PERSONAL project — `organizationId: null`, tenant userId = the owner.
 *
 * The org fixtures above cannot reach the `/app` link branch, because a project with an
 * organization always has a slug to prefix with. Both the cycle's `organizationId` AND its `userId`
 * are set from the project, because the tenant fence compares the cycle's normalized tuple against
 * the project's and a cycle carrying neither would not belong to any tenant.
 */
async function seedPersonalReadyCycleWithRecipient() {
	const owner = await seedUser("Personal project owner");
	const project = await db.project.create({
		data: {
			name: "Example project",
			userId: owner.id,
			organizationId: null,
			status: "ACTIVE",
		},
	});
	projectIds.push(project.id);
	const cycle = await db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			organizationId: null,
			userId: owner.id,
			status: "READY",
			actorUserId: owner.id,
			coveredThrough: new Date(),
		},
	});
	const editor = await seedUser("Personal project editor");
	await addProjectMember(project.id, editor.id, "EDITOR");
	// Not `addTopic`, which only takes an organizationId: `publishing_topic` carries a tenant XOR
	// check, so a personal-project topic must set `userId` and leave `organizationId` null.
	await db.publishingTopic.create({
		data: {
			projectId: project.id,
			organizationId: null,
			userId: owner.id,
			cycleId: cycle.id,
			title: "A topic",
			origin: "AI",
			status: "SUGGESTION",
			dedupeKey: `dk-${randomUUID()}`,
			contributorUserIds: [editor.id],
		},
	});
	return {
		cycleId: cycle.id,
		projectId: project.id,
		recipientUserId: editor.id,
		tenant: {
			projectId: project.id,
			organizationId: null as string | null,
			userId: owner.id as string | null,
		},
	};
}

/**
 * Pin the base URL for the two link cases, and restore whatever the environment had.
 *
 * The TRAILING SLASH is deliberate. `getBaseUrl()` returns the configured value verbatim, and an
 * operator setting `APP_URL=https://…/` is ordinary; without the activity's own `replace(/\/+$/, "")`
 * every link would carry `//app/…`. A fixture without the slash would leave that normalisation
 * unpinned, which is how it gets deleted as noise.
 */
async function withBaseUrl<T>(
	value: string,
	body: () => Promise<T>,
): Promise<T> {
	const previousSite = process.env.NEXT_PUBLIC_SITE_URL;
	process.env.NEXT_PUBLIC_SITE_URL = value;
	try {
		return await body();
	} finally {
		// `delete` rather than assigning undefined when it was unset: assigning turns the variable
		// into the STRING "undefined" on process.env, so a later reader would resolve a base URL of
		// "undefined" instead of falling through to getBaseUrl's localhost default.
		if (previousSite === undefined) {
			delete process.env.NEXT_PUBLIC_SITE_URL;
		} else {
			process.env.NEXT_PUBLIC_SITE_URL = previousSite;
		}
	}
}

it.skipIf(!RUN_DB)(
	"1C-2c: the email carries the recipient's address, an ABSOLUTE workspace url, the project name and the topic count",
	async () => {
		// EVERY field the activity computes, read back off the provider call.
		//
		// This is the only case that looks at what actually LEAVES the activity. The ledger cases
		// above assert that a row reached SENT, and a row reaches SENT for a message sent to the
		// wrong address, with an unclickable link, naming the wrong project — all of them invisible
		// to a status column. `deliverPublishingTopicsReadyEmail`'s own suite pins the same call
		// shape, but against values ITS test supplies; the recipient address, the workspace URL,
		// the project name and the topic count are all derived HERE, and nothing else reads them.
		//
		// The URL is the sharpest of the four. A bell link is stored context-relative because the
		// reader's workspace base is prepended when it is rendered; a mail client has no such
		// resolver, so a relative link in this template is simply dead — the failure recorded in
		// `toAbsoluteUrl`'s doc comment, which shipped an unclickable button to real users.
		const seeded = await seedReadyCycleWithRecipient();
		const recipient = await db.user.findUniqueOrThrow({
			where: { id: seeded.recipientUserId },
			select: { email: true },
		});
		const organization = await db.organization.findUniqueOrThrow({
			where: { id: seeded.organizationId },
			select: { slug: true },
		});
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockReset();
		vi.mocked(sendEmail).mockResolvedValue(true);

		await withBaseUrl("https://example.com/", () =>
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		);

		expect(vi.mocked(sendEmail)).toHaveBeenCalledWith({
			to: recipient.email,
			templateId: "publishingTopicsReady",
			idempotencyKey: `publishing-${seeded.cycleId}-${seeded.recipientUserId}`,
			context: {
				projectName: "Example project",
				// The fixture seeds exactly one topic for this cycle, so a count read off the wrong
				// cycle — or off the project — would not be 1.
				topicCount: 1,
				// One slash after the host, not two: the configured base ends in one.
				url: `https://example.com/app/${organization.slug}/projects/${seeded.projectId}/publishing`,
			},
		});
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a personal-project cycle links to /app with no workspace segment",
	async () => {
		// The other arm of the slug ternary, and it has no organization to name. Without it the
		// link would read `/app/undefined/projects/…` for every personal-project recipient — a
		// broken URL that no ledger status and no send failure would ever report, because the send
		// succeeds and the row reaches SENT exactly as it does on the org path.
		const seeded = await seedPersonalReadyCycleWithRecipient();
		const recipient = await db.user.findUniqueOrThrow({
			where: { id: seeded.recipientUserId },
			select: { email: true },
		});
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockReset();
		vi.mocked(sendEmail).mockResolvedValue(true);

		await withBaseUrl("https://example.com", () =>
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		);

		expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
			expect.objectContaining({
				to: recipient.email,
				context: expect.objectContaining({
					url: `https://example.com/app/projects/${seeded.projectId}/publishing`,
				}),
			}),
		);
	},
);

// ---------------------------------------------------------------------------
// The interleavings a sequential test cannot reach.
//
// Every case above changes the world BEFORE the attempt starts, and both reads the activity takes
// of that world then agree — which is the one thing the second read exists to catch. The two cases
// below move the world WHILE the attempt is inside a provider call, so the batch answer and the
// per-recipient answer genuinely differ. That window is the reason the per-recipient check exists,
// and nothing else in this file reaches it.
//
// The seam is the mail mock. A provider call is the only place in this activity where a recipient's
// delivery is in flight and durable state is settled — the claim is committed, the confirmation is
// not — so a write committed from inside it lands provably BETWEEN two statements the activity
// treats as one decision.
// ---------------------------------------------------------------------------

/**
 * Who each seeded recipient is, by the address the activity will actually mail.
 *
 * The email loop walks `emailCandidates`, whose order comes from a `Set` built by a batch query —
 * it is not the seeding order and is not ours to assume. A case that hardcoded "revoke the second
 * one while the first is sending" would, on the other ordering, revoke the recipient it had just
 * mailed and leave the other free to be mailed too: two sends, and a case that reported the
 * opposite of what it observed. So the mock decides from the address it was handed.
 */
async function recipientsByAddress(recipientUserIds: string[]) {
	const users = await db.user.findMany({
		where: { id: { in: recipientUserIds } },
		select: { id: true, email: true },
	});
	return new Map(users.map((user) => [user.email, user.id]));
}

it.skipIf(!RUN_DB)(
	"1C-2c: a recipient revoked mid-batch acquires no claim and is not sent to",
	async () => {
		const seeded = await seedReadyCycleWithRecipients(2);
		const byAddress = await recipientsByAddress(seeded.recipientUserIds);
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockReset();
		// An ARRAY rather than a `let … | null`, and the reason is a compile error rather than a
		// style opinion: TypeScript cannot see that a callback ran, so it narrows a closure-assigned
		// `let` back to its initial `null` at every read below and every property access is then an
		// error on `never`. Pushing to a const array keeps the element type intact, and the length
		// check doubles as the positive control on the staging.
		const captured: {
			mailed: string | undefined;
			revoked: string | undefined;
			revokedWasStillAMember: boolean;
			emailRowsInFlight: {
				recipientUserId: string;
				status: string;
				claimToken: string | null;
			}[];
		}[] = [];
		vi.mocked(sendEmail).mockImplementation(async (input) => {
			if (captured.length > 0) {
				return true; // one staging only; a second send is the failure, not the trigger
			}
			const mailedNow = byAddress.get(input.to as string);
			const revokedNow = seeded.recipientUserIds.find(
				(id) => id !== mailedNow,
			);
			// EVIDENCE, taken at the instant the message is in flight and before anything is
			// revoked. It is what makes "mid-batch" a fact: the recipient about to be revoked is
			// still a member, and the ledger shows exactly one EMAIL obligation — the one being
			// sent — holding a live claim. The revoked recipient has no row, so nothing has been
			// claimed on their behalf yet.
			captured.push({
				mailed: mailedNow,
				revoked: revokedNow,
				revokedWasStillAMember:
					(await db.projectMember.count({
						where: {
							projectId: seeded.projectId,
							userId: revokedNow ?? "",
						},
					})) === 1,
				emailRowsInFlight: (
					await db.publishingNotificationDelivery.findMany({
						where: {
							cycleId: seeded.cycleId,
							channel: "EMAIL",
						},
						select: {
							recipientUserId: true,
							status: true,
							claimToken: true,
						},
					})
				).map((row) => ({
					recipientUserId: row.recipientUserId,
					status: row.status,
					claimToken: row.claimToken,
				})),
			});
			// Revoke the OTHER recipient while this one's send is in flight. An attempt-boundary
			// test cannot see this window at all: both recipients were authorized when the batch
			// began, and both still are according to the batch answer the loop is walking.
			await db.projectMember.deleteMany({
				where: {
					projectId: seeded.projectId,
					userId: revokedNow ?? "",
				},
			});
			return true;
		});

		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).resolves.toBeUndefined();

		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
		// The staging fired, and fired where it was meant to.
		expect(captured).toHaveLength(1);
		const observed = captured[0];
		if (observed === undefined) {
			throw new Error("the provider was never called");
		}
		const { mailed, revoked } = observed;
		expect(mailed).toBeDefined();
		expect(revoked).toBeDefined();
		expect(observed.revokedWasStillAMember).toBe(true);
		expect(observed.emailRowsInFlight).toEqual([
			{
				recipientUserId: mailed,
				status: "SENDING",
				claimToken: expect.any(String),
			},
		]);

		const row = await db.publishingNotificationDelivery.findUnique({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: revoked ?? "",
					channel: "EMAIL",
				},
			},
		});
		expect(row?.status).toBe("SKIPPED");
		expect(row?.reason).toBe("RECIPIENT_UNAUTHORIZED");
		// "ACQUIRES NO CLAIM", asserted rather than implied by the absence of a send. `lastAttemptAt`
		// has exactly ONE writer in this design — the claim stamps it, and nothing ever clears it —
		// so a null here is proof that no claim was ever taken for this recipient, which is a
		// stronger statement than "no message went out". A row that had been claimed and then
		// cancelled would carry the timestamp and be indistinguishable by status alone.
		expect(row?.lastAttemptAt).toBeNull();
		expect(row?.claimToken).toBeNull();
		expect(row?.claimedAt).toBeNull();
		expect(row?.deliveredAt).toBeNull();

		// The mailed recipient is unaffected: one revocation is about one person.
		const mailedRow =
			await db.publishingNotificationDelivery.findUniqueOrThrow({
				where: {
					cycleId_recipientUserId_channel: {
						cycleId: seeded.cycleId,
						recipientUserId: mailed ?? "",
						channel: "EMAIL",
					},
				},
			});
		expect(mailedRow.status).toBe("SENT");
		expect(mailedRow.deliveredAt).not.toBeNull();
		// A SKIPPED obligation is terminal, so nothing is left unconfirmed and the activity
		// completes — which is what the `resolves` above already established, recorded here as the
		// cycle-level consequence.
		expect((await readOutcome(seeded.cycleId)).outcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a tenant transfer between two recipients cancels the second",
	async () => {
		// Permission and tenancy are separate questions. The second recipient keeps an active
		// project role across the transfer, so she still PASSES the permission check while
		// belonging to a different tenant than the cycle — and the batch gate has already been
		// left behind. Only the per-recipient tenancy condition catches this.
		const seeded = await seedReadyCycleWithRecipients(2);
		const byAddress = await recipientsByAddress(seeded.recipientUserIds);
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockReset();
		// Captured through an array for the same reason as the case above: a closure-assigned `let`
		// is narrowed back to its initial value at every read, which is a compile error waiting for
		// the first property access.
		const captured: {
			mailed: string | undefined;
			stranded: string | undefined;
			receivingOrgId: string;
			strandedKeptTheirRole: boolean;
		}[] = [];
		vi.mocked(sendEmail).mockImplementation(async (input) => {
			if (captured.length > 0) {
				return true;
			}
			const mailedNow = byAddress.get(input.to as string);
			const strandedNow = seeded.recipientUserIds.find(
				(id) => id !== mailedNow,
			);
			// The half of the evidence that makes this case DIFFERENT from the revocation one
			// above: the stranded recipient keeps a live, accepted project role right across the
			// transfer. Permission alone would still say OK for her.
			const keptTheirRole =
				(await db.projectMember.count({
					where: {
						projectId: seeded.projectId,
						userId: strandedNow ?? "",
						role: "EDITOR",
					},
				})) === 1;
			const receivingOrgId = await seedOrg("Receiving org");
			await db.project.update({
				where: { id: seeded.projectId },
				data: { organizationId: receivingOrgId },
			});
			captured.push({
				mailed: mailedNow,
				stranded: strandedNow,
				receivingOrgId,
				strandedKeptTheirRole: keptTheirRole,
			});
			return true;
		});

		// RESOLVING is itself the evidence that the TENANT-MOVE exit was taken, and it is the only
		// observable that tells that exit apart from normal completion here. The stranded recipient
		// is in `emailCandidates` and has NO ledger row, so the unconfirmed accounting counts her as
		// outstanding and the activity would REJECT — unless the per-recipient tenancy verdict set
		// `tenantMoved` and returned before that check ever ran.
		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).resolves.toBeUndefined();

		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
		expect(captured).toHaveLength(1);
		const observed = captured[0];
		if (observed === undefined) {
			throw new Error("the provider was never called");
		}
		const { mailed, stranded } = observed;
		expect(mailed).toBeDefined();
		expect(stranded).toBeDefined();
		expect(observed.strandedKeptTheirRole).toBe(true);
		// The project really did move, and it moved DURING the loop.
		const project = await db.project.findUniqueOrThrow({
			where: { id: seeded.projectId },
			select: { organizationId: true },
		});
		expect(project.organizationId).toBe(observed.receivingOrgId);
		expect(project.organizationId).not.toBe(seeded.organizationId);

		// EVIDENCE THE TRANSFER LANDED BETWEEN THE TWO RECIPIENTS. The mailed recipient has a
		// COMPLETED email obligation written under the OLD tuple, and the stranded one has NO EMAIL
		// ROW AT ALL. Neither state is reachable from a transfer before the attempt (no row would
		// exist) or after it (both rows would). Together they place the transfer inside the loop.
		const emailRows = await channelRows(seeded.cycleId, "EMAIL");
		expect(emailRows).toHaveLength(1);
		expect(emailRows[0]?.recipientUserId).toBe(mailed);
		expect(emailRows[0]?.status).toBe("SENT");
		expect(emailRows[0]?.organizationId).toBe(seeded.organizationId);
		// No row was created under the STALE tuple for the recipient the loop never reached —
		// §9.2(d)'s "writes no ledger row under the stale tuple", asserted at the one moment it
		// could be violated.
		expect(emailRows.some((row) => row.recipientUserId === stranded)).toBe(
			false,
		);

		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		// SENT, and NOT the "CANCELLED" this case was first drafted to expect. The correction is
		// worth recording rather than quietly making, because the draft's reasoning — "an email did
		// go out before the transfer, but the outcome the operator needs to see is that the
		// remaining obligations were cancelled" — is self-refuting: an email going out is exactly
		// the condition under which this activity is designed to say SENT.
		//
		// `closeObligationsAndComplete` derives a FALLBACK outcome from the rows
		// (`anyDelivered ? "SENT" : opts.outcome.value`), and its own comment names writing
		// CANCELLED over a delivered cycle as the defect: it "tells an operator 'nobody was
		// notified' about a cycle with a real bell row in someone's tray, or a mail in their inbox".
		// The sibling case "a transfer between two recipients keeps the delivered row, creates none,
		// and completes SENT (1C-2b)" already pins exactly this on the IN_APP channel.
		//
		// The cancellation this case is named for is real and IS asserted — above, as the absence of
		// any obligation for the stranded recipient and as the activity resolving instead of
		// rejecting. It lives in the LEDGER, which is per obligation; the cycle-level column answers
		// a different question, namely whether anything reached anybody.
		//
		// Said plainly: this assertion carries NO email-specific information. Both recipients get
		// their IN_APP delivery in the loop that runs BEFORE the email loop even starts, so
		// `anyDelivered` is already true before a single email attempt happens — this line would
		// hold even if the email side sent nothing at all. Its job is to document the CORRECTED
		// expectation above, nothing more; the assertions that pin what THIS case is actually about
		// are the ledger ones already made above it (the mailed recipient's single SENT email row,
		// and the stranded recipient's total absence from the EMAIL channel).
		expect(cycle.notificationOutcome).toBe("SENT");
	},
);

// =============================================================================
// 1C-2d-3a — the producer flip: an email-only obligation is DEFERRED, not dropped
// =============================================================================

/**
 * Two eligible recipients, of whom the second has the bell switched off. That makes them
 * "email-only" in §9.6's sense — in the email candidate set and NOT in the in-app one —
 * which is the ONLY set this slice defers.
 *
 * The first recipient is deliberately left with no preference row: under the opt-out
 * model that means enabled on both channels, so they sit in the intersection and must
 * NOT be deferred. Having both in one fixture is what makes each case a comparison
 * rather than an assertion about a single row.
 */
async function seedBellAndMailOnly() {
	const seeded = await seedReadyCycleWithRecipients(2);
	const [bellAndMail, mailOnly] = seeded.recipientUserIds;
	if (!bellAndMail || !mailOnly) {
		throw new Error("seedReadyCycleWithRecipients(2) seeded too few");
	}
	await db.notificationPreference.create({
		data: {
			userId: mailOnly,
			organizationId: "",
			publishingSuggestions: false,
		},
	});
	return { ...seeded, bellAndMail, mailOnly };
}

it.skipIf(!RUN_DB)(
	"1C-2d-3a: an email-only obligation is DEFERRED and the row SURVIVES the close",
	async () => {
		// THE READ-BACK CASE, and the reason it reads the ledger after the activity has
		// RETURNED rather than inside it. Every other assertion about this scenario passes
		// with the obligation destroyed: the row exists, its status is terminal, the cycle
		// outcome is right and every count agrees. Only reading it back afterwards can
		// tell a hand-off from a round trip to nowhere.
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(false);
		vi.mocked(sendEmail).mockClear();

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		const rows = new Map(
			(
				await db.publishingNotificationDelivery.findMany({
					where: { cycleId: seeded.cycleId, channel: "EMAIL" },
				})
			).map((row) => [row.recipientUserId, row]),
		);
		const deferred = rows.get(seeded.mailOnly);
		expect(deferred?.status).toBe("DEFERRED");
		expect(deferred?.expiresAt).not.toBeNull();
		// A deferral is not a claim, so the lease fence is untouched and the drain can
		// take the row normally.
		expect(deferred?.claimedAt).toBeNull();
		expect(deferred?.claimToken).toBeNull();
		expect(deferred?.attemptCount).toBe(0);
		// And the intersection recipient is NOT deferred. The bell reached them, which is
		// the entire basis of §9.6's split — deferring them too would create a second,
		// slower obligation for someone the fast channel already served.
		expect(rows.has(seeded.bellAndMail)).toBe(false);
		// No claim was taken and nothing was sent: the key is checked before any claim.
		expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: deferring does not change the cycle outcome or cost the bell",
	async () => {
		// The conjunction. Deferral is an ADDITION to the MAIL_NOT_CONFIGURED path, not a
		// replacement for it: the outage is still an outage and must still be visible, and
		// the channel that works must still work.
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(false);

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		expect(cycle.notificationOutcome).toBe("MAIL_NOT_CONFIGURED");
		const bell = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: {
				cycleId: seeded.cycleId,
				channel: "IN_APP",
				recipientUserId: seeded.bellAndMail,
			},
		});
		expect(bell.status).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: defers nobody when every email candidate also gets a bell",
	async () => {
		// The negative control for the split. Without it, a producer that deferred the
		// WHOLE email candidate set would pass every case above.
		const seeded = await seedReadyCycleWithRecipients(2); // no preference rows: both on
		vi.mocked(isMailConfigured).mockReturnValue(false);

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: seeded.cycleId, channel: "EMAIL" },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: writes no deferral when the key IS configured",
	async () => {
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(true);

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: {
				cycleId: seeded.cycleId,
				channel: "EMAIL",
				recipientUserId: seeded.mailOnly,
			},
		});
		expect(row.status).toBe("SENT");
		// THE STATUS ALONE DOES NOT PIN THIS, which a delete-a-guard run showed: with the
		// mail gate removed the row is deferred and then claimed IN BAND — DEFERRED is a
		// claimable status — so it reaches SENT either way and the case stayed green.
		// expiresAt is the discriminator. The in-band claim creates its row without one
		// and never writes one, so a null expiry means this row was never a deferral.
		expect(row.expiresAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: REJECTS when the deferral write fails, rather than closing the cycle over it",
	async () => {
		// §9.6 names this as the one case the reject rule exists for: the obligation
		// undischarged AND unrecorded. Swallowing it — the shape perRecipient would give —
		// closes the cycle MAIL_NOT_CONFIGURED over recipients nothing will ever come back
		// for.
		//
		// Injected at the QUERY layer rather than by mocking the writer. Mocking proves the
		// caller handles a rejected promise; failing the createMany proves the REAL
		// writer's failure reaches the caller as one.
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(false);

		await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					model === "PublishingNotificationDelivery" &&
					operation === "createMany"
				) {
					throw new Error("deferral write failed");
				}
				return query(args);
			},
			async () => {
				await expect(
					runPublishingTopicsReadyNotification({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
					}),
				).rejects.toThrow();
			},
		);

		const cycle = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: seeded.cycleId },
			select: { notificationOutcome: true },
		});
		// NOT terminalized. A cycle left unresolved is retried; a cycle closed over a lost
		// obligation is not.
		expect(cycle.notificationOutcome).not.toBe("MAIL_NOT_CONFIGURED");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: a retried attempt adds no second row and does not move the expiry",
	async () => {
		// The attempt budget is 5, so an outage that outlives one attempt runs this path
		// repeatedly. An upsert would extend the 14-day deadline on every one of them.
		//
		// THE FIRST ATTEMPT MUST REJECT, or this case cannot fail — and its first staging
		// could not. An attempt that defers and COMPLETES closes the cycle
		// MAIL_NOT_CONFIGURED, so the second one exits on the already-terminal branch
		// without ever reaching the deferral writer: every assertion below then passes
		// over a second attempt that did nothing, and skipDuplicates is never exercised at
		// all. Failing the bell write keeps the cycle live so the second attempt really
		// does re-run the write.
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(false);

		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					if (model === "Notification" && operation === "create") {
						throw new Error(
							"injected bell-row write failure (1C-2d-3a)",
						);
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
					}),
			),
		).rejects.toThrow(/unconfirmed/i);
		const first = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: {
				cycleId: seeded.cycleId,
				channel: "EMAIL",
				recipientUserId: seeded.mailOnly,
			},
		});

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});
		const second = await db.publishingNotificationDelivery.findFirstOrThrow(
			{
				where: {
					cycleId: seeded.cycleId,
					channel: "EMAIL",
					recipientUserId: seeded.mailOnly,
				},
			},
		);

		expect(second.id).toBe(first.id);
		expect(second.expiresAt?.toISOString()).toBe(
			first.expiresAt?.toISOString(),
		);
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: seeded.cycleId, channel: "EMAIL" },
			}),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: once the key returns, the in-band loop claims the deferred row and sends it",
	async () => {
		// The hand-off going the other way, and the reason DEFERRED has been in
		// PUBLISHING_EMAIL_CLAIMABLE_STATUSES since 1C-2c. An operator who restores the key
		// mid-workflow gets the obligation discharged by the fast path rather than waiting
		// for the hourly drain.
		// THE CYCLE MUST SURVIVE THE DEFERRING ATTEMPT, and only a rejection makes it. An
		// attempt that defers and then COMPLETES closes the cycle MAIL_NOT_CONFIGURED, and
		// every later attempt exits on the already-terminal branch having accounted
		// nothing — which is what the first staging of this case got wrong. The bell write
		// is failed at the real query, the same injection point the 1C-2c conjunction case
		// uses, so the attempt rejects with the deferral already committed.
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(false);
		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					if (model === "Notification" && operation === "create") {
						throw new Error(
							"injected bell-row write failure (1C-2d-3a)",
						);
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
					}),
			),
		).rejects.toThrow(/unconfirmed/i);

		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(true);
		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: {
				cycleId: seeded.cycleId,
				channel: "EMAIL",
				recipientUserId: seeded.mailOnly,
			},
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: a DEFERRED row the in-band claim cannot take does not hold the cycle open",
	async () => {
		// DECISION 50's reachable case. The row was deferred by an earlier keyless attempt;
		// this attempt HAS the key, so EMAIL is accounted — and the claim is refused
		// because the row is at the attempt bound. Counted as unconfirmed, the activity
		// would reject and burn its remaining budget on an obligation the drain owns; the
		// cycle would be left PENDING for the cycle sweep instead of closed.
		// THE CYCLE MUST SURVIVE THE DEFERRING ATTEMPT, and only a rejection makes it. An
		// attempt that defers and then COMPLETES closes the cycle MAIL_NOT_CONFIGURED, and
		// every later attempt exits on the already-terminal branch having accounted
		// nothing — which is what the first staging of this case got wrong. The bell write
		// is failed at the real query, the same injection point the 1C-2c conjunction case
		// uses, so the attempt rejects with the deferral already committed.
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(false);
		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					if (model === "Notification" && operation === "create") {
						throw new Error(
							"injected bell-row write failure (1C-2d-3a)",
						);
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
					}),
			),
		).rejects.toThrow(/unconfirmed/i);
		await db.publishingNotificationDelivery.updateMany({
			where: { cycleId: seeded.cycleId, channel: "EMAIL" },
			data: { attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND },
		});

		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(true);

		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).resolves.toBeUndefined();

		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: {
				cycleId: seeded.cycleId,
				channel: "EMAIL",
				recipientUserId: seeded.mailOnly,
			},
		});
		// Still DEFERRED, still carrying its expiry: spared by the close, and left for the
		// mechanism whose job it is.
		expect(row.status).toBe("DEFERRED");
		expect(row.expiresAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-3a: a HELD email row is still unconfirmed — the DEFERRED case does not swallow it",
	async () => {
		// The negative control for the case above. A status list that excluded too much
		// would pass both, so this one drives the shape that MUST still reject: a live
		// lease another attempt owns.
		// THE CYCLE MUST SURVIVE THE DEFERRING ATTEMPT, and only a rejection makes it. An
		// attempt that defers and then COMPLETES closes the cycle MAIL_NOT_CONFIGURED, and
		// every later attempt exits on the already-terminal branch having accounted
		// nothing — which is what the first staging of this case got wrong. The bell write
		// is failed at the real query, the same injection point the 1C-2c conjunction case
		// uses, so the attempt rejects with the deferral already committed.
		const seeded = await seedBellAndMailOnly();
		vi.mocked(isMailConfigured).mockReturnValue(false);
		await expect(
			withQueryObserver(
				async ({ model, operation, args, query }) => {
					if (model === "Notification" && operation === "create") {
						throw new Error(
							"injected bell-row write failure (1C-2d-3a)",
						);
					}
					return query(args);
				},
				() =>
					runPublishingTopicsReadyNotification({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
					}),
			),
		).rejects.toThrow(/unconfirmed/i);
		await db.publishingNotificationDelivery.updateMany({
			where: { cycleId: seeded.cycleId, channel: "EMAIL" },
			data: {
				status: "SENDING",
				claimedAt: new Date(),
				claimToken: "held-elsewhere",
			},
		});

		vi.mocked(isMailConfigured).mockReturnValue(true);
		vi.mocked(sendEmail).mockResolvedValue(true);

		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).rejects.toThrow(/unconfirmed/);
	},
);

/**
 * A roster just over the per-attempt bound — the only state in which the bound, the cursor, the
 * convergence and the in-app asymmetry are observable at all.
 *
 * Five over rather than one, so the second attempt has a remainder worth naming; and five rather
 * than a hundred, so the fixture's ~60 inserts stay far inside this suite's 20 s testTimeout on
 * CI's postgres:16.
 */
const OVER_BOUND = PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT + 5;

/**
 * THE MOCKS DO NOT RESET THEMSELVES, and every case below that counts sends depends on it.
 *
 * packages/temporal/vitest.config.ts sets neither clearMocks nor mockReset, so sendEmail's call
 * count ACCUMULATES across every case in this file. A bare toHaveBeenCalledTimes(25) would
 * therefore be asserting against the whole file's history — it would fail for a reason that has
 * nothing to do with the bound, or worse, pass by coincidence once the totals happened to line up.
 *
 * mockReset rather than mockClear, with the resolution re-established immediately after, because
 * reset drops the implementation too — which is the idiom the five existing count-asserting cases
 * in this file already use. isMailConfigured is set explicitly for the same reason: several
 * earlier cases leave it returning false.
 */
function healthyMailFromZero() {
	vi.mocked(isMailConfigured).mockReturnValue(true);
	vi.mocked(sendEmail).mockReset();
	vi.mocked(sendEmail).mockResolvedValue(true);
}

it.skipIf(!RUN_DB)(
	"sends at most PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT emails in one attempt, and leaves the rest to the retry",
	async () => {
		const seeded = await seedReadyCycleWithRecipients(OVER_BOUND);
		healthyMailFromZero();

		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).rejects.toThrow(/unconfirmed/i);

		// THE BOUND BIT: exactly the cap, not the roster.
		expect(await channelRows(seeded.cycleId, "EMAIL")).toHaveLength(
			PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
		);
		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(
			PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
		);

		// AND IN_APP WAS NOT BOUNDED, which is Decision 59 rather than an oversight. Asserted in
		// the same case as the email cap because the property is the DIFFERENCE between the two
		// channels: a case that only counted bells would stay green if someone bounded both, and a
		// case that only counted emails would stay green if someone bounded neither correctly.
		expect(await channelRows(seeded.cycleId, "IN_APP")).toHaveLength(
			OVER_BOUND,
		);

		// THE CYCLE IS NOT CLOSED, and this is the assertion that pins the accounting to the FULL
		// candidate set rather than to the list the loop walked. Narrow it to the walked list and
		// every bounded attempt reports zero unconfirmed, closes the cycle SENT, and the five
		// recipients nobody emailed are silently lost — the exact silent truncation the bound must
		// not introduce.
		expect((await readOutcome(seeded.cycleId)).outcome).toBe("PENDING");
	},
);

it.skipIf(!RUN_DB)(
	"advances on the retry instead of re-walking the roster, and converges",
	async () => {
		const seeded = await seedReadyCycleWithRecipients(OVER_BOUND);
		healthyMailFromZero();

		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).rejects.toThrow(/unconfirmed/i);
		const afterFirst = (await channelRows(seeded.cycleId, "EMAIL")).map(
			(row) => row.recipientUserId,
		);
		expect(afterFirst).toHaveLength(
			PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
		);

		// Clear, NOT reset: the resolution set above must survive into attempt 2. Reset would drop
		// the implementation and every send would resolve undefined, which the delivery module
		// reads as a provider rejection.
		vi.mocked(sendEmail).mockClear();
		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		// THE DISCRIMINATOR, and the reason this case is not merely "it finished eventually": the
		// second attempt sent exactly the REMAINDER. Without the cursor it would re-walk from the
		// head of the roster and re-send the first 25 — the ledger would still end up complete, so
		// an assertion on the final state alone would pass straight over the defect. With a finite
		// retry budget that re-walk is what stops a roster only a little over the cap from ever
		// finishing.
		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(
			OVER_BOUND - afterFirst.length,
		);

		const afterSecond = await channelRows(seeded.cycleId, "EMAIL");
		expect(afterSecond).toHaveLength(OVER_BOUND);
		// One row per recipient, not one per attempt: nobody was emailed twice.
		expect(
			new Set(afterSecond.map((row) => row.recipientUserId)).size,
		).toBe(OVER_BOUND);
		expect((await readOutcome(seeded.cycleId)).outcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"spends no part of the bound on a recipient the ledger already terminalized",
	async () => {
		// THE FIRST VERSION OF THIS CASE COULD NOT FAIL, and the numbers are why it now can.
		//
		// It seeded 30 with 5 pre-terminalized and asserted 25 sends. That is ALSO what an
		// unbounded, cursorless walk produces: it walks all 30, the claim refuses the 5 terminal
		// rows on its own, and 25 sends come out either way. The assertion was true of the defect
		// it was written to catch — a delete-a-guard run is what surfaced it, because the case
		// stayed green with neither the bound nor the cursor in the file.
		//
		// The roster is now larger than bound + terminal, so the three worlds separate:
		//
		//   bound + cursor (correct) : work list 30, attempt 25, 5 unreached -> REJECTS, 25 sends
		//   bound, no cursor         : walks the first 25 of the roster — 10 of them terminal —
		//                              so only 15 sends, and 15 recipients never reached
		//   neither                  : walks all 40, 30 sends, resolves
		//
		// Every assertion below is false in at least two of those.
		const PRE_TERMINAL = 10;
		const roster = PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT + 15;
		const seeded = await seedReadyCycleWithRecipients(roster);
		healthyMailFromZero();

		// Terminalize five of them BEFORE the attempt, on EMAIL only, with no lifecycle activation
		// first. The creation fence reads terminality through the shared predicate, under which
		// NOT_APPLICABLE (never entered the lifecycle) is explicitly NON-terminal — see the note on
		// readCycleFenceState in publishing-notification-delivery.ts. Writing these rows against a
		// cycle the activity has not touched yet is therefore legal, and an
		// activateCycleNotificationLifecycle call here would be a no-op that hid what the fence
		// actually permits.
		//
		// The property: the cursor must spend the whole bound on recipients that still NEED one. A
		// cursor that ignored terminal rows would spend 10 of its 25 slots on people already
		// discharged, and 10 recipients who are owed an email would go unreached for it.
		const preSkipped = seeded.recipientUserIds.slice(0, PRE_TERMINAL);
		for (const recipientUserId of preSkipped) {
			await recordPublishingDeliverySkip({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
				recipientUserId,
				channel: "EMAIL",
				reason: "RECIPIENT_UNAUTHORIZED",
			});
		}

		await expect(
			runPublishingTopicsReadyNotification({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
			}),
		).rejects.toThrow(/unconfirmed/i);

		// A FULL bound spent entirely on recipients who needed it — 25, not the 15 a cursorless
		// bounded walk would manage, and not the 30 an unbounded one would.
		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(
			PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
		);
		const sentTo = new Set(
			(await channelRows(seeded.cycleId, "EMAIL"))
				.filter((row) => row.status === "SENT")
				.map((row) => row.recipientUserId),
		);
		expect(sentTo.size).toBe(PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT);
		for (const recipientUserId of preSkipped) {
			expect(sentTo.has(recipientUserId)).toBe(false);
		}
	},
);

it.skipIf(!RUN_DB)(
	"leaves a roster inside the bound behaving exactly as it did before the bound existed",
	async () => {
		const seeded = await seedReadyCycleWithRecipients(3);
		healthyMailFromZero();

		await runPublishingTopicsReadyNotification({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
		});

		await expectEmailRows(seeded.cycleId, ["SENT", "SENT", "SENT"]);
		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(3);
		expect((await readOutcome(seeded.cycleId)).outcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"reports the remainder on a bounded run, because the runbook sends an operator to grep for exactly that line",
	async () => {
		// PINNED BECAUSE A RUNBOOK NOW DEPENDS ON IT. The deploy runbook's large-roster
		// section tells an operator to look for this message and read `remaining` off it,
		// and to treat it on the fifth attempt of one cycle as "the roster is above the
		// ceiling". Nothing else in this suite would notice if the payload were renamed or
		// the block deleted — the send counts and the ledger would all still agree.
		//
		// That gap has a precedent in this repo: a chat-delivery path failed every send for
		// a month while its telemetry was written and never read. A log line an operator is
		// instructed to rely on is part of the interface, not decoration.
		const seeded = await seedReadyCycleWithRecipients(OVER_BOUND);
		healthyMailFromZero();
		// Restored in a finally: the spy is module state, and leaking it would silence
		// every later case in this file.
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		try {
			await expect(
				runPublishingTopicsReadyNotification({
					cycleId: seeded.cycleId,
					tenant: seeded.tenant,
				}),
			).rejects.toThrow(/unconfirmed/i);

			const bounded = info.mock.calls.find(
				([message]) =>
					typeof message === "string" &&
					message.includes("email walk bounded"),
			);
			expect(bounded).toBeDefined();
			// Every field the runbook names, and the arithmetic between them: attempting +
			// remaining must account for the whole undischarged set, or the line would
			// under-report a truncation while looking correct.
			expect(bounded?.[1]).toMatchObject({
				projectId: seeded.tenant.projectId,
				cycleId: seeded.cycleId,
				emailCandidates: OVER_BOUND,
				alreadyDischarged: 0,
				attempting: PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
				remaining:
					OVER_BOUND - PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT,
			});
		} finally {
			info.mockRestore();
		}
	},
);
