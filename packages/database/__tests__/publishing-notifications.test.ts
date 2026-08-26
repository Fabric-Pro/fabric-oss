import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { db } from "../index";
import {
	type PrismaQueryObserver,
	setPrismaQueryObserver,
} from "../prisma/client";
import { getRecipientsWithEmailFlagEnabled } from "../prisma/queries/notification-preferences";
import {
	claimPublishingEmailDelivery,
	confirmPublishingEmailDelivery,
	deferPublishingEmailDeliveries,
	deliverPublishingTopicsReadyInApp,
	lockPublishingProjectRow,
	PUBLISHING_DEFERRAL_WINDOW_MS,
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	PUBLISHING_EMAIL_LEASE_MS,
	readPublishingDeliveryStates,
	recordPublishingDeliverySkip,
	recordPublishingEmailFailure,
	terminalizeExistingDeliveriesAsSkipped,
} from "../prisma/queries/projects/publishing-notification-delivery";
import {
	activateCycleNotificationLifecycle,
	completeCycleNotificationOutcome,
	writeCycleNotificationOutcome,
} from "../prisma/queries/projects/publishing-notification-outcome";
import {
	reauthorizePublishingRecipient,
	resolvePublishingEligibleRecipients,
	selectRelevantRecipientIds,
} from "../prisma/queries/projects/publishing-recipients";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

/**
 * Pass-through tape over the repo's own query observer. It is the only way to assert that the
 * flag-gated function-tag lookup is SKIPPED rather than run-and-discarded — a behavioural
 * assertion cannot tell those two apart, and "skip the query entirely" is the claim the module
 * makes.
 */
const queryTape: string[] = [];
const tapeObserver: PrismaQueryObserver = ({
	model,
	operation,
	args,
	query,
}) => {
	queryTape.push(`${model ?? "$raw"}.${operation}`);
	return query(args);
};
setPrismaQueryObserver(tapeObserver);

/**
 * The same registered seam, used the other way round: an observer that THROWS on a chosen operation
 * injects a fault at an exact point inside a transaction, which is how the delivery module's
 * post-rollback failure path is reachable from a test at all.
 *
 * The observer is MODULE state — `setPrismaQueryObserver` replaces the single registered function —
 * so the tape must be restored in a `finally`, or every later test in this file runs under the
 * fault-injecting observer.
 */
async function withQueryObserver<T>(
	observer: PrismaQueryObserver,
	body: () => Promise<T>,
): Promise<T> {
	setPrismaQueryObserver(observer);
	try {
		return await body();
	} finally {
		setPrismaQueryObserver(tapeObserver);
	}
}

const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function seedOrgProject() {
	const orgId = `org-${randomUUID()}`;
	await db.organization.create({
		data: {
			id: orgId,
			name: "1C-2b org",
			slug: `slug-${randomUUID()}`,
			createdAt: new Date(),
		},
	});
	createdOrgIds.push(orgId);
	const user = await db.user.create({
		data: {
			id: `user-${randomUUID()}`,
			name: "Owner",
			email: `${randomUUID()}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	// `status: ACTIVE` is not decoration. The delivery fence re-reads the Project FOR UPDATE and
	// mirrors persistCycleTerminal's F1 eligibility filter (status ACTIVE, deletedAt null), and a
	// cycle is only ever dispatched for an ACTIVE project — so a DRAFT fixture would make every
	// delivery answer TENANT_CHANGED for a reason that cannot occur in production. Same reasoning,
	// and same explicit `status`, as publishing-suite-persist.test.ts's fixtures.
	const project = await db.project.create({
		data: {
			name: "1C-2b project",
			userId: user.id,
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
			actorUserId: user.id,
			coveredThrough: new Date(),
		},
	});
	return { orgId, user, project, cycle };
}

async function seedUser(name: string) {
	const user = await db.user.create({
		data: {
			id: `user-${randomUUID()}`,
			name,
			email: `${randomUUID()}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	return user;
}

/** A personal project — `organizationId` null, `userId` the owner. */
async function seedPersonalProject() {
	const owner = await seedUser("Personal owner");
	const project = await db.project.create({
		data: { name: "1C-2b personal project", userId: owner.id },
	});
	projectIds.push(project.id);
	return { owner, project };
}

const ACCEPTED_AT = new Date("2026-01-01T00:00:00.000Z");

async function addProjectMember(
	projectId: string,
	userId: string,
	role: "OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER",
	overrides: { acceptedAt?: Date | null; expiresAt?: Date | null } = {},
) {
	await db.projectMember.create({
		data: {
			projectId,
			userId,
			role,
			invitedBy: userId,
			acceptedAt:
				overrides.acceptedAt === undefined
					? ACCEPTED_AT
					: overrides.acceptedAt,
			expiresAt: overrides.expiresAt ?? null,
		},
	});
}

async function addOrgMember(
	organizationId: string,
	userId: string,
	role: "owner" | "admin" | "member" | "viewer",
) {
	await db.member.create({
		data: { organizationId, userId, role, createdAt: new Date() },
	});
}

/**
 * The same, with N eligible EDITORs instead of one. Returns their ids in creation order.
 *
 * See `seedReadyCycleWithRecipient` below for why the project is ACTIVE and why no
 * NotificationPreference row is written — both apply here, since that helper delegates to this one.
 */
async function seedReadyCycleWithRecipients(count: number) {
	const { orgId, project, cycle } = await seedOrgProject();
	const recipientUserIds: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const editor = await seedUser(`Eligible editor ${index + 1}`);
		await addProjectMember(project.id, editor.id, "EDITOR");
		recipientUserIds.push(editor.id);
	}
	return {
		cycleId: cycle.id,
		projectId: project.id,
		organizationId: orgId,
		recipientUserIds,
		tenant: {
			projectId: project.id,
			organizationId: orgId as string | null,
			userId: null as string | null,
		},
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
 * (`seedOrgProject`, which this delegates to, sets it and documents the same reason.)
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

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// The delivery tests write REAL bell rows. Notification cascades from User, but delete it
	// explicitly and first so the cleanup does not depend on that cascade surviving a schema change.
	await db.notification.deleteMany({
		where: { userId: { in: createdUserIds } },
	});
	// Topics reference the cycle with onDelete: SetNull, so they must go first for the cycle delete
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

it.skipIf(!RUN_DB)(
	"a new cycle carries the NOT_APPLICABLE default and version 0 (1C-2b)",
	async () => {
		const { cycle } = await seedOrgProject();
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("NOT_APPLICABLE");
		expect(row.notificationOutcomeVersion).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"the outcome CHECK rejects a value outside the declared nine (1C-2b)",
	async () => {
		const { cycle } = await seedOrgProject();
		await expect(
			db.$executeRaw`UPDATE "publishing_suggestion_cycle" SET "notificationOutcome" = 'NONSENSE' WHERE "id" = ${cycle.id}`,
		).rejects.toThrow();
	},
);

it.skipIf(!RUN_DB)(
	"the ledger tenant-XOR CHECK rejects a row carrying both tenant columns (1C-2b)",
	async () => {
		const { orgId, user, project, cycle } = await seedOrgProject();
		await expect(
			db.publishingNotificationDelivery.create({
				data: {
					cycleId: cycle.id,
					projectId: project.id,
					organizationId: orgId,
					userId: user.id,
					recipientUserId: user.id,
					channel: "IN_APP",
					status: "SENT",
				},
			}),
		).rejects.toThrow();
	},
);

it.skipIf(!RUN_DB)(
	"the ledger status CHECK rejects a status no slice ships or plans to (1C-2b, widened in 1C-2c and 1C-2d)",
	async () => {
		// The claim is the CHECK's purpose, not the particular value: a status whose lifecycle has
		// not shipped, and none is planned to, must not be writable. SENDING was that value until
		// 1C-2c shipped its lease and widened the CHECK to admit it; DEFERRED and EXPIRED were that
		// value until 1C-2d widened the CHECK again to admit both — see the 1C-2c and 1C-2d cases
		// below, which pin the accept side of each widening. HELD is not a status any slice writes
		// or has planned. The matcher is anchored on the CHECK's own constraint name so this case
		// can only go green for the reason its name claims — a different constraint rejecting the
		// row would not satisfy it.
		const { orgId, user, project, cycle } = await seedOrgProject();
		await expect(
			db.publishingNotificationDelivery.create({
				data: {
					cycleId: cycle.id,
					projectId: project.id,
					organizationId: orgId,
					recipientUserId: user.id,
					channel: "IN_APP",
					status: "HELD",
				},
			}),
		).rejects.toThrow(/publishing_notification_delivery_status_check/);
	},
);

it.skipIf(!RUN_DB)(
	"the unique triple holds in ORGANIZATION context, where the tenant userId is NULL (1C-2b)",
	async () => {
		const { orgId, user, project, cycle } = await seedOrgProject();
		const data = {
			cycleId: cycle.id,
			projectId: project.id,
			organizationId: orgId,
			recipientUserId: user.id,
			channel: "IN_APP",
			status: "SENT" as const,
		};
		await db.publishingNotificationDelivery.create({ data });
		await expect(
			db.publishingNotificationDelivery.create({ data }),
		).rejects.toThrow();
	},
);

it.skipIf(!RUN_DB)(
	"deleting a cycle cascades its ledger rows away (1C-2b)",
	async () => {
		const { orgId, user, project, cycle } = await seedOrgProject();
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: orgId,
				recipientUserId: user.id,
				channel: "IN_APP",
				status: "SENT",
			},
		});
		await db.publishingSuggestionCycle.delete({ where: { id: cycle.id } });
		const remaining = await db.publishingNotificationDelivery.count({
			where: { cycleId: cycle.id },
		});
		expect(remaining).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"activation moves NOT_APPLICABLE to PENDING and reports that it did (1C-2b)",
	async () => {
		const { project, cycle } = await seedOrgProject();
		const moved = await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		expect(moved).toBe(true);
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("PENDING");
		// Activation deliberately does NOT bump the version: the entry transition is fenced on its
		// own expected value, and leaving the version alone keeps a mid-flight activity's
		// compare-and-swap valid against a row the migration left at 0.
		expect(row.notificationOutcomeVersion).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"a second activation affects no row and reports false — idempotent, not a failure (1C-2b)",
	async () => {
		const { project, cycle } = await seedOrgProject();
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		const again = await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		expect(again).toBe(false);
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("PENDING");
	},
);

it.skipIf(!RUN_DB)(
	"a terminal write from PENDING succeeds and bumps the version (1C-2b)",
	async () => {
		const { project, cycle } = await seedOrgProject();
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		const wrote = await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "SENT",
			observedVersion: 0,
		});
		expect(wrote).toBe(true);
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("SENT");
		expect(row.notificationOutcomeVersion).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"a stale observed version loses the compare-and-swap and learns it lost (1C-2b)",
	async () => {
		const { project, cycle } = await seedOrgProject();
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "RESOLUTION_FAILED",
			observedVersion: 0,
		});
		const loser = await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "NO_RECIPIENTS",
			observedVersion: 0,
		});
		expect(loser).toBe(false);
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("RESOLUTION_FAILED");
	},
);

it.skipIf(!RUN_DB)(
	"a late attempt cannot downgrade a terminal outcome (1C-2b)",
	async () => {
		// The concrete hazard: an attempt that timed out on a worker without the mail key resumes
		// AFTER a newer attempt recorded SENT, and overwrites truthful terminal evidence in the
		// direction that looks like a fault. The terminality predicate is what stops it, and this
		// is the assertion that proves the predicate is present.
		const { project, cycle } = await seedOrgProject();
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
		const late = await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "MAIL_NOT_CONFIGURED",
			observedVersion: 1,
		});
		expect(late).toBe(false);
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"RESOLUTION_FAILED is non-terminal, so a later success supersedes it (1C-2b)",
	async () => {
		// It is stamped BEFORE the activity rejects, precisely so the signal survives retry
		// exhaustion. That only works if a later successful attempt can still overwrite it.
		const { project, cycle } = await seedOrgProject();
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "RESOLUTION_FAILED",
			observedVersion: 0,
		});
		const recovered = await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "SENT",
			observedVersion: 1,
		});
		expect(recovered).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"activation refuses a cycle that has already left NOT_APPLICABLE (1C-2b)",
	async () => {
		// Activation is the ONLY escape from NOT_APPLICABLE, and it must not be a way back INTO
		// the lifecycle from a terminal state.
		const { project, cycle } = await seedOrgProject();
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
		const moved = await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		expect(moved).toBe(false);
		// A variant that returned false while still writing PENDING over SENT would pass the
		// assertion above and be exactly the resurrection this test is named for — so read the row
		// back, matching every other guard test in this file.
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"a stale completing write LOSES to a newer RESOLUTION_FAILED and must not overwrite it (1C-2b)",
	async () => {
		// The interleaving this represents cannot be scheduled from a test — there is no point in
		// the activity between capturing the version and writing where a competing write can be
		// forced to land. Passing a stale observedVersion IS that state, deterministically, which
		// is the reason this decision lives behind an exported function instead of inside the
		// activity's closure.
		const { project, cycle } = await seedOrgProject();
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		// A newer attempt hits a failing resolver and stamps the outage signal at version 0.
		await writeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "RESOLUTION_FAILED",
			observedVersion: 0,
		});
		// The older attempt, which had computed an empty candidate set, now tries to complete.
		const verdict = await completeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "NO_RECIPIENTS",
			observedVersion: 0,
		});
		expect(verdict).toBe("LOST");
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("RESOLUTION_FAILED");
	},
);

it.skipIf(!RUN_DB)(
	"a stale completing write against a TERMINAL cycle reports already-terminal, not lost (1C-2b)",
	async () => {
		// The companion, and the half that stops the caller rejecting forever: another writer's
		// terminal answer stands, and this attempt has nothing left to do.
		const { project, cycle } = await seedOrgProject();
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
		const verdict = await completeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "NO_RECIPIENTS",
			observedVersion: 0,
		});
		expect(verdict).toBe("ALREADY_TERMINAL");
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"completing a cycle that was never activated (still NOT_APPLICABLE) returns LOST (1C-2b)",
	async () => {
		// NOT_APPLICABLE is not a genuine terminal answer: classifying it ALREADY_TERMINAL would
		// tell the caller everything is fine while the cycle silently never got classified — exactly
		// the failure this module exists to prevent.
		const { project, cycle } = await seedOrgProject();
		const verdict = await completeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: project.id,
			outcome: "NO_RECIPIENTS",
			observedVersion: 0,
		});
		expect(verdict).toBe("LOST");
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("NOT_APPLICABLE");
	},
);

it.skipIf(!RUN_DB)(
	"completing with a projectId that does not own the cycle returns LOST, not ALREADY_TERMINAL (1C-2b)",
	async () => {
		// A wrong projectId means no row matches the (cycleId, projectId) pair, which reads back as
		// `null` — the exact cross-tenant mistake the projectId predicate exists to catch. It must
		// not be read as "someone else already handled it." This doubles as coverage that the
		// classifier does not leak across a tenant boundary.
		const { cycle } = await seedOrgProject();
		const other = await seedOrgProject();
		const verdict = await completeCycleNotificationOutcome({
			cycleId: cycle.id,
			projectId: other.project.id,
			outcome: "NO_RECIPIENTS",
			observedVersion: 0,
		});
		expect(verdict).toBe("LOST");
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("NOT_APPLICABLE");
	},
);

it.skipIf(!RUN_DB)(
	"both writers are project-scoped — a wrong projectId affects nothing (1C-2b)",
	async () => {
		const { cycle } = await seedOrgProject();
		const other = await seedOrgProject();
		expect(
			await activateCycleNotificationLifecycle(db, {
				cycleId: cycle.id,
				projectId: other.project.id,
			}),
		).toBe(false);
		// And the transition writer, which is the other half of the claim in this test's name:
		// activate under the OWNING project, then aim the terminal write at the neighbour. Only the
		// projectId is wrong — outcome and version both match — so a refusal here can come from
		// nothing but the project predicate.
		const owning = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: owning.projectId,
		});
		expect(
			await writeCycleNotificationOutcome({
				cycleId: cycle.id,
				projectId: other.project.id,
				outcome: "SENT",
				observedVersion: 0,
			}),
		).toBe(false);
		const row = await db.publishingSuggestionCycle.findUniqueOrThrow({
			where: { id: cycle.id },
		});
		expect(row.notificationOutcome).toBe("PENDING");
	},
);

it.skipIf(!RUN_DB)(
	"relevance is attribution-only when the function-tags flag is off (1C-2b)",
	async () => {
		const { user, project, cycle } = await seedOrgProject();
		const stranger = await db.user.create({
			data: {
				id: `user-${randomUUID()}`,
				name: "Stranger",
				email: `${randomUUID()}@example.com`,
				emailVerified: true,
				// `User.createdAt` / `updatedAt` carry no Prisma default, so both are required on an
				// explicit create — same as seedOrgProject above.
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(stranger.id);
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				cycleId: cycle.id,
				title: "Attributed topic",
				origin: "AI",
				status: "SUGGESTION",
				dedupeKey: `dk-${randomUUID()}`,
				contributorUserIds: [user.id],
			},
		});
		const relevant = await selectRelevantRecipientIds({
			projectId: project.id,
			cycleId: cycle.id,
			candidateUserIds: [user.id, stranger.id],
		});
		expect(relevant).toEqual([user.id]);
	},
);

it.skipIf(!RUN_DB)(
	"a cycle whose topics attribute nobody notifies nobody (1C-2b)",
	async () => {
		// UC4 verbatim, and the designed behaviour rather than a bug: on a project with weak
		// attribution the feature legitimately looks inert, which is why the cycle-level outcome
		// exists to record it.
		const { user, project, cycle } = await seedOrgProject();
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				cycleId: cycle.id,
				title: "Unattributed topic",
				origin: "AI",
				status: "SUGGESTION",
				dedupeKey: `dk-${randomUUID()}`,
				contributorUserIds: [],
			},
		});
		const relevant = await selectRelevantRecipientIds({
			projectId: project.id,
			cycleId: cycle.id,
			candidateUserIds: [user.id],
		});
		expect(relevant).toEqual([]);
	},
);

it.skipIf(!RUN_DB)(
	"with the flag OFF the function-tag lookup is not merely filtered — it never runs (1C-2b)",
	async () => {
		const { orgId, user, project, cycle } = await seedOrgProject();
		const tagged = await seedUser("Tagged non-contributor");
		await db.projectUserFunctionTag.create({
			data: {
				projectId: project.id,
				organizationId: orgId,
				userId: tagged.id,
				tags: ["DEVELOPER"],
			},
		});
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				cycleId: cycle.id,
				title: "Tagged topic",
				origin: "AI",
				status: "SUGGESTION",
				dedupeKey: `dk-${randomUUID()}`,
				contributorUserIds: [user.id],
				relevantFunctionTags: ["DEVELOPER"],
			},
		});

		queryTape.length = 0;
		const relevant = await selectRelevantRecipientIds({
			projectId: project.id,
			cycleId: cycle.id,
			candidateUserIds: [user.id, tagged.id],
		});

		expect(relevant).toEqual([user.id]);
		// Positive control first: without it, a tape that recorded nothing at all (an observer that
		// never got wired) would make the assertion below pass vacuously.
		expect(queryTape).toContain("PublishingTopic.findMany");
		expect(queryTape).not.toContain("ProjectUserFunctionTag.findMany");
	},
);

it.skipIf(!RUN_DB)(
	"with the flag ON a member carrying the cycle's relevant function tags is relevant (1C-2b)",
	async () => {
		// The other half of the gate. Without this, the entire tag branch — the only reach the
		// feature has beyond attribution — would ship with no test that ever executes it.
		const previous = process.env.FABRIC_FEATURE_FUNCTION_TAGS;
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "true";
		try {
			const { orgId, user, project, cycle } = await seedOrgProject();
			const tagged = await seedUser("Tagged non-contributor");
			await db.projectUserFunctionTag.create({
				data: {
					projectId: project.id,
					organizationId: orgId,
					userId: tagged.id,
					tags: ["DEVELOPER"],
				},
			});
			const mismatched = await seedUser("Differently tagged");
			await db.projectUserFunctionTag.create({
				data: {
					projectId: project.id,
					organizationId: orgId,
					userId: mismatched.id,
					tags: ["DESIGNER"],
				},
			});
			await db.publishingTopic.create({
				data: {
					projectId: project.id,
					organizationId: cycle.organizationId,
					cycleId: cycle.id,
					title: "Tagged topic",
					origin: "AI",
					status: "SUGGESTION",
					dedupeKey: `dk-${randomUUID()}`,
					contributorUserIds: [user.id],
					relevantFunctionTags: ["DEVELOPER"],
				},
			});

			queryTape.length = 0;
			const relevant = await selectRelevantRecipientIds({
				projectId: project.id,
				cycleId: cycle.id,
				candidateUserIds: [user.id, tagged.id, mismatched.id],
			});

			expect(relevant.sort()).toEqual([tagged.id, user.id].sort());
			// Carrying tags is not enough — they must intersect THIS cycle's tags.
			expect(relevant).not.toContain(mismatched.id);
			expect(queryTape).toContain("ProjectUserFunctionTag.findMany");
		} finally {
			if (previous === undefined) {
				delete process.env.FABRIC_FEATURE_FUNCTION_TAGS;
			} else {
				process.env.FABRIC_FEATURE_FUNCTION_TAGS = previous;
			}
		}
	},
);

// ---------------------------------------------------------------------------
// Eligibility through the DATABASE wrapper. The pure precedence table in
// src/__tests__/publishing-recipients.test.ts proves the decision; these prove the wiring that
// feeds it — which roster rows are loaded at all, and whether `now` reaches the core.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"eligibility returns null — not an empty list — for a project that is gone (1C-2b)",
	async () => {
		// The caller distinguishes these: "nobody is eligible" is a cycle outcome, "the project no
		// longer exists" is not the same event and must not be recorded as one.
		expect(
			await resolvePublishingEligibleRecipients({
				projectId: `project-${randomUUID()}`,
			}),
		).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"eligibility loads BOTH rosters: active project rows win, org roles fill the gaps (1C-2b)",
	async () => {
		const { orgId, user, project } = await seedOrgProject();
		const editor = await seedUser("Project editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		// Active VIEWER project row + org admin. The project row is authoritative, so the org role is
		// never consulted — the dangerous direction a naive union gets wrong.
		const demoted = await seedUser("Demoted admin");
		await addProjectMember(project.id, demoted.id, "VIEWER");
		await addOrgMember(orgId, demoted.id, "admin");
		// No project row at all — reached only if the org roster is actually loaded.
		const orgMember = await seedUser("Org member");
		await addOrgMember(orgId, orgMember.id, "member");
		const orgViewer = await seedUser("Org viewer");
		await addOrgMember(orgId, orgViewer.id, "viewer");

		const ids = await resolvePublishingEligibleRecipients({
			projectId: project.id,
		});

		expect(ids?.sort()).toEqual([editor.id, orgMember.id].sort());
		expect(ids).not.toContain(demoted.id);
		expect(ids).not.toContain(orgViewer.id);
		// `Project.userId` on an ORGANIZATION project is the denormalized tenant owner, not a
		// recipient. This user has neither a project row nor an org role, so nothing makes them one.
		expect(ids).not.toContain(user.id);
	},
);

it.skipIf(!RUN_DB)(
	"eligibility on a PERSONAL project still consults ProjectMember (1C-2b)",
	async () => {
		// The defect a copied newsletter helper ships: it returns the owner and stops, so an accepted
		// personal-project EDITOR who can act on these topics through oRPC is never told — a silent
		// miss with no error and no ledger row.
		const { owner, project } = await seedPersonalProject();
		const editor = await seedUser("Personal editor");
		await addProjectMember(project.id, editor.id, "EDITOR");
		const viewer = await seedUser("Personal viewer");
		await addProjectMember(project.id, viewer.id, "VIEWER");

		const ids = await resolvePublishingEligibleRecipients({
			projectId: project.id,
		});

		expect(ids?.sort()).toEqual([editor.id, owner.id].sort());
		expect(ids).not.toContain(viewer.id);
	},
);

it.skipIf(!RUN_DB)(
	"eligibility reads expiry against the injected clock, not the wall clock (1C-2b)",
	async () => {
		// `now` exists so a scheduled attempt can be replayed deterministically. If the wrapper
		// dropped it on the floor the two calls below would agree.
		const { project } = await seedPersonalProject();
		const temp = await seedUser("Temporary editor");
		await addProjectMember(project.id, temp.id, "EDITOR", {
			expiresAt: new Date("2026-09-01T00:00:00.000Z"),
		});

		const during = await resolvePublishingEligibleRecipients({
			projectId: project.id,
			now: new Date("2026-08-12T00:00:00.000Z"),
		});
		expect(during).toContain(temp.id);

		const after = await resolvePublishingEligibleRecipients({
			projectId: project.id,
			now: new Date("2026-10-01T00:00:00.000Z"),
		});
		// A personal project has no organization, so an expired row has no org role to fall back to.
		expect(after).not.toContain(temp.id);
	},
);

// ---------------------------------------------------------------------------
// In-app delivery. The ledger row and the bell row commit in ONE transaction, which is what makes
// this channel exactly-once rather than merely idempotent-ish.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"writes the ledger row and the bell row together, exactly once (1C-2b)",
	async () => {
		const { user, project, cycle } = await seedOrgProject();
		const first = await deliverPublishingTopicsReadyInApp({
			cycleId: cycle.id,
			tenant: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
			},
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 3,
		});
		expect(first).toBe("SENT");

		const second = await deliverPublishingTopicsReadyInApp({
			cycleId: cycle.id,
			tenant: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
			},
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 3,
		});
		expect(second).toBe("ALREADY_TERMINAL");

		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(1);
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: cycle.id, channel: "IN_APP" },
			}),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"the bell row carries a context-relative link and no topic content (1C-2b)",
	async () => {
		const { user, project, cycle } = await seedOrgProject();
		await deliverPublishingTopicsReadyInApp({
			cycleId: cycle.id,
			tenant: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
			},
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 2,
		});
		const row = await db.notification.findFirstOrThrow({
			where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
		});
		// No leading slash: the resolver prepends the notification's OWN workspace base, and an
		// absolute /app/... link resolves into the wrong workspace for a user in several.
		expect(row.link).toBe(`projects/${project.id}/publishing`);
		expect(row.category).toBe("PUBLISHING");
		// Count and project name only. Access is re-checked at read time, but the row itself must
		// not embed content that would leak if that check regressed.
		expect(row.title).toContain("2");
		expect(row.title).not.toContain("Attributed");
		// dedupeKey is deliberately null: the live partial unique index stops constraining a row
		// the moment the recipient opens the bell, and a retry after that would insert a second
		// one. The ledger is read-state-independent by construction and is the dedupe mechanism.
		expect(row.dedupeKey).toBeNull();
		expect(row.payload).toMatchObject({
			projectId: project.id,
			cycleId: cycle.id,
			topicCount: 2,
		});
	},
);

it.skipIf(!RUN_DB)(
	"a skip is terminal and records why, without a deliveredAt (1C-2b)",
	async () => {
		const { user, project, cycle } = await seedOrgProject();
		await recordPublishingDeliverySkip({
			cycleId: cycle.id,
			tenant: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
			},
			recipientUserId: user.id,
			channel: "IN_APP",
			reason: "RECIPIENT_UNAUTHORIZED",
		});
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		expect(row.status).toBe("SKIPPED");
		expect(row.reason).toBe("RECIPIENT_UNAUTHORIZED");
		expect(row.deliveredAt).toBeNull();
		// SKIPPED never gets a deliveredAt, which is exactly why "outstanding" must be derived from
		// the state machine and not from `deliveredAt IS NULL`.
	},
);

it.skipIf(!RUN_DB)(
	"a retry takes over an unresolved FAILED row and delivers (1C-2b)",
	async () => {
		// A pre-existing FAILED row is exactly the state a transient failure inside the delivery
		// transaction leaves behind. Under a blind create this is UNRECOVERABLE: the next attempt
		// hits P2002, reads it as "already handled", and never writes the Notification — the
		// recipient is never told, the row stays unconfirmed, and the activity rejects until its
		// budget runs out. This is the assertion that fails against that implementation.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				...tenant,
				recipientUserId: user.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		const retry = await deliverPublishingTopicsReadyInApp({
			cycleId: cycle.id,
			tenant,
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 1,
		});
		expect(retry).toBe("SENT");
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).not.toBeNull();
		expect(row.reason).toBeNull();
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"revoking a recipient whose row already FAILED terminalizes it to SKIPPED (1C-2b)",
	async () => {
		// The mirror of the case above. A create-only skip hits P2002, returns quietly, and leaves
		// FAILED behind — forever unconfirmed, and forever making the activity reject over an
		// obligation it is now forbidden to discharge.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				...tenant,
				recipientUserId: user.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		await recordPublishingDeliverySkip({
			cycleId: cycle.id,
			tenant,
			recipientUserId: user.id,
			channel: "IN_APP",
			reason: "RECIPIENT_UNAUTHORIZED",
		});
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		expect(row.status).toBe("SKIPPED");
		expect(row.reason).toBe("RECIPIENT_UNAUTHORIZED");
		expect(row.deliveredAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"a project that has moved tenant gets no bell row and no ledger row (1C-2b)",
	async () => {
		// The window between the per-recipient authorization check and the write. For EMAIL that
		// window is unavoidable — an external send cannot join a database transaction. For in-app
		// it is entirely database work, so the fence closes it outright, and a row written under a
		// stale tenant tuple is a tenant-isolation defect rather than an accepted residual.
		const { user, project, cycle } = await seedOrgProject();
		const staleTenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		const newOrgId = `org-${randomUUID()}`;
		await db.organization.create({
			data: {
				id: newOrgId,
				name: "1C-2b new org",
				slug: `slug-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(newOrgId);
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: newOrgId },
		});
		const result = await deliverPublishingTopicsReadyInApp({
			cycleId: cycle.id,
			tenant: staleTenant,
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 1,
		});
		expect(result).toBe("TENANT_CHANGED");
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: cycle.id },
			}),
		).toBe(0);
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"a skip write after the project has moved creates no row (1C-2b)",
	async () => {
		// The unauthorized-skip path CREATES a row, so it carries the same fence as delivery. Its
		// caller decided "not authorized" against a project that has since transferred; writing the
		// evidence under the old tuple would bypass the delivery fence through the door next to it.
		const { user, project, cycle } = await seedOrgProject();
		const staleTenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		const newOrgId = `org-${randomUUID()}`;
		await db.organization.create({
			data: {
				id: newOrgId,
				name: "1C-2b moved org",
				slug: `slug-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(newOrgId);
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: newOrgId },
		});
		const verdict = await recordPublishingDeliverySkip({
			cycleId: cycle.id,
			tenant: staleTenant,
			recipientUserId: user.id,
			channel: "IN_APP",
			reason: "RECIPIENT_UNAUTHORIZED",
		});
		expect(verdict).toBe("TENANT_CHANGED");
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: cycle.id },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"terminalizing existing rows after a move creates none, resolves FAILED and leaves SENT alone (1C-2b)",
	async () => {
		const { user, project, cycle } = await seedOrgProject();
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
				recipientUserId: user.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});
		// A recipient who was already told. Terminalization must not rewrite that: a transfer stops
		// FUTURE deliveries, it does not un-send one that already happened, and relabelling it
		// SKIPPED would make the ledger claim nobody was notified when somebody was.
		const delivered = await seedUser("Already delivered");
		const deliveredAt = new Date("2026-08-01T00:00:00.000Z");
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
				recipientUserId: delivered.id,
				channel: "IN_APP",
				status: "SENT",
				deliveredAt,
			},
		});
		await terminalizeExistingDeliveriesAsSkipped({
			cycleId: cycle.id,
			tenant: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
			},
			channel: "IN_APP",
			reason: "TENANT_CHANGED",
		});
		const rows = await db.publishingNotificationDelivery.findMany({
			where: { cycleId: cycle.id },
		});
		expect(rows).toHaveLength(2);
		const resolved = rows.find((r) => r.recipientUserId === user.id);
		expect(resolved?.status).toBe("SKIPPED");
		expect(resolved?.reason).toBe("TENANT_CHANGED");
		const untouched = rows.find((r) => r.recipientUserId === delivered.id);
		expect(untouched?.status).toBe("SENT");
		expect(untouched?.deliveredAt).toEqual(deliveredAt);
		expect(untouched?.reason).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"terminalizing a cycle this tenant does not own leaves those rows alone (1C-2b)",
	async () => {
		// Keyed on cycleId + channel alone, this update has no idea whose rows it is flipping. Every
		// other path in this module re-asserts cycle ownership before it writes; this one is
		// update-only, which makes it cheaper to guard, not safe to leave unguarded. A stale or
		// version-skewed cycleId reaching it would terminalize another tenant's unresolved
		// obligations — silently discharging work that tenant still needs done.
		const owned = await seedOrgProject();
		const foreign = await seedOrgProject();
		const stranded = await seedUser("Another tenant's recipient");
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: owned.cycle.id,
				projectId: owned.project.id,
				organizationId: owned.cycle.organizationId,
				userId: owned.cycle.userId,
				recipientUserId: stranded.id,
				channel: "IN_APP",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});

		await terminalizeExistingDeliveriesAsSkipped({
			cycleId: owned.cycle.id,
			// The caller names a project that does not own this cycle.
			tenant: {
				projectId: foreign.project.id,
				organizationId: foreign.cycle.organizationId,
				userId: foreign.cycle.userId,
			},
			channel: "IN_APP",
			reason: "TENANT_CHANGED",
		});

		const rows = await db.publishingNotificationDelivery.findMany({
			where: { cycleId: owned.cycle.id },
		});
		expect(rows).toHaveLength(1);
		// Still FAILED, so still claimable: the obligation stays with the tenant that owns it.
		expect(rows[0]?.status).toBe("FAILED");
		expect(rows[0]?.reason).toBe("WRITE_FAILED");
	},
);

it.skipIf(!RUN_DB)(
	"a cancelled row is not claimable, even though it carries a null deliveredAt (1C-2b)",
	async () => {
		// The claim predicate must exclude SKIPPED, not only non-null deliveredAt. The hazard is an
		// interleaving — the delivery reads FAILED, a cancellation commits SKIPPED, and the claim
		// then runs — which this harness cannot schedule deterministically, so the predicate itself
		// is asserted directly. That is the property; a timing test that cannot control the
		// interleaving would pass under both implementations and prove nothing.
		const { user, project, cycle } = await seedOrgProject();
		const row = await db.publishingNotificationDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
				recipientUserId: user.id,
				channel: "IN_APP",
				status: "SKIPPED",
				reason: "RECIPIENT_UNAUTHORIZED",
			},
		});
		const { count } = await db.publishingNotificationDelivery.updateMany({
			where: {
				id: row.id,
				deliveredAt: null,
				status: { not: "SKIPPED" },
			},
			data: { status: "SENT", deliveredAt: new Date() },
		});
		expect(count).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"the delivery states read reports STATE, not merely which rows exist (1C-2b)",
	async () => {
		// Not in the plan's list, added because the reader would otherwise ship with no coverage at
		// all and it is the input to the caller's "is every obligation discharged" decision. The
		// distinction it has to preserve is the one this module is organized around: a SKIPPED row
		// and a SENT row both EXIST, and only one of them carries a deliveredAt — so a caller that
		// answered from existence, or from `deliveredAt`, would get a different answer than the
		// state machine gives.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		const revoked = await seedUser("Revoked recipient");
		await deliverPublishingTopicsReadyInApp({
			cycleId: cycle.id,
			tenant,
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 1,
		});
		await recordPublishingDeliverySkip({
			cycleId: cycle.id,
			tenant,
			recipientUserId: revoked.id,
			channel: "IN_APP",
			reason: "RECIPIENT_UNAUTHORIZED",
		});

		const states = await readPublishingDeliveryStates({
			cycleId: cycle.id,
		});
		expect(states).toHaveLength(2);
		const sent = states.find((s) => s.recipientUserId === user.id);
		const skipped = states.find((s) => s.recipientUserId === revoked.id);
		expect(sent?.status).toBe("SENT");
		expect(sent?.channel).toBe("IN_APP");
		expect(sent?.deliveredAt).not.toBeNull();
		expect(skipped?.status).toBe("SKIPPED");
		expect(skipped?.deliveredAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"a cycle owned by another project is not deliverable under this tenant's tuple (1C-2b)",
	async () => {
		// The project fence compares the caller-supplied tuple against the project the caller NAMED —
		// Y against Y — so it says nothing about whether `cycleId` belongs to that project, and the
		// cycle's foreign key proves only that the cycle exists. Without a cycle-ownership assertion a
		// stale, malformed or version-skewed workflow input creates a ledger row whose cycleId belongs
		// to one project while its denormalized tuple names another, and readPublishingDeliveryStates
		// hands that foreign-tenant row straight back. Mirrors persistCycleTerminal's F5 guard.
		const foreign = await seedOrgProject();
		const { user, project, cycle } = await seedOrgProject();
		const verdict = await deliverPublishingTopicsReadyInApp({
			cycleId: foreign.cycle.id,
			tenant: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
			},
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 1,
		});
		expect(verdict).toBe("TENANT_CHANGED");
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: foreign.cycle.id },
			}),
		).toBe(0);
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"a skip against another project's cycle writes no row either (1C-2b)",
	async () => {
		// The skip path CREATES a row, so it carries the same ownership assertion. A cross-project
		// skip row is the same isolation defect as a cross-project delivery row, just quieter.
		const foreign = await seedOrgProject();
		const { user, project, cycle } = await seedOrgProject();
		const verdict = await recordPublishingDeliverySkip({
			cycleId: foreign.cycle.id,
			tenant: {
				projectId: project.id,
				organizationId: cycle.organizationId,
				userId: cycle.userId,
			},
			recipientUserId: user.id,
			channel: "IN_APP",
			reason: "RECIPIENT_UNAUTHORIZED",
		});
		expect(verdict).toBe("TENANT_CHANGED");
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: foreign.cycle.id },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"a concurrently-created FAILED row is not mistaken for a discharged one (1C-2b)",
	async () => {
		// The P2002 branch. A row appearing under the triple does NOT mean the recipient was told:
		// the failure recorder commits FAILED rows and the skip path commits SKIPPED ones. Answering
		// ALREADY_TERMINAL here is the has-a-row-is-discharged defect — the recipient would be left
		// with no delivery and no retry. Injecting the competing insert through the registered query
		// observer is the only way to reach the branch at all: it commits on another connection
		// between this transaction's findUnique (which saw nothing) and its insert.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		let injected = false;
		const verdict = await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					!injected &&
					model === "PublishingNotificationDelivery" &&
					operation === "create"
				) {
					injected = true;
					await db.publishingNotificationDelivery.create({
						data: {
							cycleId: cycle.id,
							...tenant,
							recipientUserId: user.id,
							channel: "IN_APP",
							status: "FAILED",
							reason: "WRITE_FAILED",
						},
					});
				}
				return query(args);
			},
			() =>
				deliverPublishingTopicsReadyInApp({
					cycleId: cycle.id,
					tenant,
					recipientUserId: user.id,
					projectName: "Example project",
					topicCount: 1,
				}),
		);
		expect(injected).toBe(true);
		expect(verdict).toBe("FAILED");
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		// Still claimable, which is the whole point of not calling it terminal.
		expect(row.status).toBe("FAILED");
		expect(row.deliveredAt).toBeNull();
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"a concurrently-created DELIVERED row IS terminal (1C-2b)",
	async () => {
		// The companion, and the reason the branch decides from state rather than being deleted
		// outright: a winner that actually delivered leaves nothing for this attempt to do.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		const winnerDeliveredAt = new Date("2026-08-02T00:00:00.000Z");
		let injected = false;
		const verdict = await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					!injected &&
					model === "PublishingNotificationDelivery" &&
					operation === "create"
				) {
					injected = true;
					await db.publishingNotificationDelivery.create({
						data: {
							cycleId: cycle.id,
							...tenant,
							recipientUserId: user.id,
							channel: "IN_APP",
							status: "SENT",
							deliveredAt: winnerDeliveredAt,
						},
					});
				}
				return query(args);
			},
			() =>
				deliverPublishingTopicsReadyInApp({
					cycleId: cycle.id,
					tenant,
					recipientUserId: user.id,
					projectName: "Example project",
					topicCount: 1,
				}),
		);
		expect(injected).toBe(true);
		expect(verdict).toBe("ALREADY_TERMINAL");
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).toEqual(winnerDeliveredAt);
	},
);

it.skipIf(!RUN_DB)(
	"a bell-row failure rolls the ledger row back and records the failure separately (1C-2b)",
	async () => {
		// The post-rollback failure record, staged through the registered query observer: the ledger
		// insert succeeds, the Notification insert throws, and the shared transaction takes both down.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		const verdict = await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (model === "Notification" && operation === "create") {
					throw new Error("injected bell-row write failure (1C-2b)");
				}
				return query(args);
			},
			() =>
				deliverPublishingTopicsReadyInApp({
					cycleId: cycle.id,
					tenant,
					recipientUserId: user.id,
					projectName: "Example project",
					topicCount: 1,
				}),
		);
		expect(verdict).toBe("FAILED");
		// One transaction, so neither write survives — including the ledger row the delivery had
		// already inserted.
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(0);
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		expect(row.status).toBe("FAILED");
		expect(row.reason).toBe("WRITE_FAILED");
		expect(row.deliveredAt).toBeNull();
		expect(row.errorMessage).toContain("injected bell-row write failure");

		// Recording it is what makes the failure visible; leaving it NON-terminal is what makes it
		// recoverable. The round trip is the property, not either half alone.
		const retry = await deliverPublishingTopicsReadyInApp({
			cycleId: cycle.id,
			tenant,
			recipientUserId: user.id,
			projectName: "Example project",
			topicCount: 1,
		});
		expect(retry).toBe("SENT");
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"a bell-row failure whose project then moves records nothing and reports TENANT_CHANGED (1C-2b)",
	async () => {
		// The failure recorder CREATES a row, so it re-fences — its own transaction, because the
		// delivery's rolled back and released the lock. This is the window that fence exists for: a
		// slow attempt fails, the project transfers, and the failure record must not land under the
		// stale tuple as a non-terminal row nothing will ever resolve.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		const newOrgId = `org-${randomUUID()}`;
		await db.organization.create({
			data: {
				id: newOrgId,
				name: "1C-2b recorder org",
				slug: `slug-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(newOrgId);
		let thrown = false;
		let moved = false;
		const verdict = await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					!thrown &&
					model === "Notification" &&
					operation === "create"
				) {
					thrown = true;
					throw new Error("injected bell-row write failure (1C-2b)");
				}
				// The next fence statement after the throw belongs to the RECORDER's transaction —
				// the delivery's has already rolled back and released the project row, and the
				// recorder has taken no lock of its own yet. Transferring here therefore commits
				// instead of deadlocking against our own FOR UPDATE. Matching either fence statement
				// keeps the hook independent of the order the two assertions run in.
				if (
					thrown &&
					!moved &&
					((model === "PublishingSuggestionCycle" &&
						operation === "findUnique") ||
						operation === "$queryRaw")
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
				deliverPublishingTopicsReadyInApp({
					cycleId: cycle.id,
					tenant,
					recipientUserId: user.id,
					projectName: "Example project",
					topicCount: 1,
				}),
		);
		// Positive controls: without them a hook that never fired would leave the assertions below
		// passing for a reason that has nothing to do with the recorder's fence.
		expect(thrown).toBe(true);
		expect(moved).toBe(true);
		expect(verdict).toBe("TENANT_CHANGED");
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: cycle.id },
			}),
		).toBe(0);
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"a delivered row is never downgraded by a later skip (1C-2b)",
	async () => {
		// Cancellation prevents a FUTURE claim and prevents the row ever recording a delivery; it
		// does not un-send one. Load-bearing in recordPublishingDeliverySkip's predicate and, until
		// now, held only by inspection.
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		expect(
			await deliverPublishingTopicsReadyInApp({
				cycleId: cycle.id,
				tenant,
				recipientUserId: user.id,
				projectName: "Example project",
				topicCount: 1,
			}),
		).toBe("SENT");
		expect(
			await recordPublishingDeliverySkip({
				cycleId: cycle.id,
				tenant,
				recipientUserId: user.id,
				channel: "IN_APP",
				reason: "RECIPIENT_UNAUTHORIZED",
			}),
		).toBe("OK");
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).not.toBeNull();
		expect(row.reason).toBeNull();
	},
);

// ---------------------------------------------------------------------------
// The creation fence and the cycle's TERMINAL outcome.
//
// Delivery and terminalization are not otherwise mutually exclusive. An overlapping
// attempt — a start-to-close timeout does NOT stop the attempt that timed out — can
// have read `notificationsEnabled: true` before an admin switched it off, then reach
// delivery after the newer attempt has already closed the cycle as DISABLED. Without
// this half of the fence it writes a SENT ledger row and a real bell row under a cycle
// whose outcome says nobody was notified, and the row is invisible to 1C-2d's sweep,
// which is CYCLE-level.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"the creation fence refuses to deliver under an already-terminal cycle (1C-2b)",
	async () => {
		const { user, project, cycle } = await seedOrgProject();
		const tenant = {
			projectId: project.id,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		};
		await activateCycleNotificationLifecycle(db, {
			cycleId: cycle.id,
			projectId: project.id,
		});
		expect(
			await writeCycleNotificationOutcome({
				cycleId: cycle.id,
				projectId: project.id,
				outcome: "DISABLED",
				observedVersion: 0,
			}),
		).toBe(true);

		expect(
			await deliverPublishingTopicsReadyInApp({
				cycleId: cycle.id,
				tenant,
				recipientUserId: user.id,
				projectName: "Example project",
				topicCount: 1,
			}),
			// ALREADY_TERMINAL, not TENANT_CHANGED: nothing moved tenant, and answering
			// TENANT_CHANGED would make the caller stamp that reason across the ledger —
			// the ledger's three skip reasons exist to stay tellable apart.
		).toBe("ALREADY_TERMINAL");

		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId: cycle.id },
			}),
		).toBe(0);
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(0);

		// Positive control, and a discriminator in one. Reset the outcome to the OTHER
		// non-terminal value — RESOLUTION_FAILED, not PENDING — and the same call must
		// deliver. A fence written as `outcome !== "PENDING"` would refuse here, and the
		// stamp-then-retry path is exactly where that would strand a recipient.
		await db.publishingSuggestionCycle.update({
			where: { id: cycle.id },
			data: { notificationOutcome: "RESOLUTION_FAILED" },
		});
		expect(
			await deliverPublishingTopicsReadyInApp({
				cycleId: cycle.id,
				tenant,
				recipientUserId: user.id,
				projectName: "Example project",
				topicCount: 1,
			}),
		).toBe("SENT");
		expect(
			await db.notification.count({
				where: { userId: user.id, type: "PUBLISHING_TOPICS_READY" },
			}),
		).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"the fence refuses a NOT_APPLICABLE cycle for tenancy, never for terminality (1C-2b)",
	async () => {
		// NOT_APPLICABLE is the column DEFAULT — "never entered the lifecycle" — and is the
		// state every cycle an older worker committed during a rolling deploy sits in. Reading
		// it as terminal would make the repair path in the activity unable to deliver anything
		// it just repaired, so the shared predicate excludes it and this pins that.
		const { user, project, cycle } = await seedOrgProject();
		expect(
			(
				await db.publishingSuggestionCycle.findUniqueOrThrow({
					where: { id: cycle.id },
				})
			).notificationOutcome,
		).toBe("NOT_APPLICABLE");

		expect(
			await deliverPublishingTopicsReadyInApp({
				cycleId: cycle.id,
				tenant: {
					projectId: project.id,
					organizationId: cycle.organizationId,
					userId: cycle.userId,
				},
				recipientUserId: user.id,
				projectName: "Example project",
				topicCount: 1,
			}),
		).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"a terminal cycle does not block a SKIPPED row, which needs no reconciliation (1C-2b)",
	async () => {
		// The deliberate asymmetry. The harm the terminal half of the fence exists to stop is a
		// row nothing will ever reconcile — a FAILED row saying "retry me" under a cycle no
		// attempt will revisit, or a SENT row plus a bell under a cycle that says nobody was
		// notified. A SKIPPED row is neither: it is terminal on arrival, carries no bell, and
		// records that this specific person was deliberately not notified. Refusing it would
		// delete evidence rather than protect anything.
		const { user, project, cycle } = await seedOrgProject();
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

		expect(
			await recordPublishingDeliverySkip({
				cycleId: cycle.id,
				tenant: {
					projectId: project.id,
					organizationId: cycle.organizationId,
					userId: cycle.userId,
				},
				recipientUserId: user.id,
				channel: "IN_APP",
				reason: "RECIPIENT_UNAUTHORIZED",
			}),
		).toBe("OK");
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId: cycle.id, recipientUserId: user.id },
		});
		expect(row.status).toBe("SKIPPED");
		expect(row.deliveredAt).toBeNull();
	},
);

// ---------------------------------------------------------------------------
// 1C-2c — the email channel's schema foundation, and the fixtures every later
// case in this slice is written against.
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
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: the ledger accepts SENDING and still rejects an unknown status",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		await expect(
			db.publishingNotificationDelivery.create({
				data: {
					cycleId: seeded.cycleId,
					projectId: seeded.projectId,
					organizationId: seeded.organizationId,
					userId: null,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
					status: "SENDING",
					claimedAt: new Date(),
					claimToken: "token-1",
				},
			}),
		).resolves.toMatchObject({ status: "SENDING" });

		await expect(
			db.publishingNotificationDelivery.create({
				data: {
					cycleId: seeded.cycleId,
					projectId: seeded.projectId,
					organizationId: seeded.organizationId,
					userId: null,
					recipientUserId: seeded.recipientUserId,
					channel: "CHAT",
					status: "QUEUED",
				},
			}),
		).rejects.toThrow(/status_check/);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2d-2a: the widened ledger CHECK is now VALIDATED, not NOT VALID",
	async () => {
		// convalidated=false is what NOT VALID leaves behind. 1C-2c shipped it
		// that way on purpose and recorded the obligation in
		// pending-constraint-validations.json; 1C-2d-2a's migration discharged
		// it. This asserts the obligation was actually discharged rather than
		// the JSON entry merely deleted — reading the catalog is the only way to
		// tell those two apart, and it is why the migration's success criterion
		// is convalidated rather than "a migration ran".
		const rows = await db.$queryRaw<{ convalidated: boolean }[]>`
			SELECT convalidated FROM pg_constraint
			WHERE conname = 'publishing_notification_delivery_status_check'`;
		expect(rows).toHaveLength(1);
		expect(rows[0].convalidated).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: the cycle's notificationOutcome CHECK is now VALIDATED, not NOT VALID",
	async () => {
		// convalidated=false is what NOT VALID leaves behind. 1C-2b shipped it that way on
		// purpose and recorded the obligation in pending-constraint-validations.json; this
		// asserts the obligation was actually discharged rather than the JSON entry merely
		// deleted. Reading the catalog is the only way to tell those two apart.
		const rows = await db.$queryRaw<{ convalidated: boolean }[]>`
			SELECT convalidated FROM pg_constraint
			WHERE conname = 'publishing_suggestion_cycle_notification_outcome_check'`;
		expect(rows).toHaveLength(1);
		expect(rows[0].convalidated).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: notification_preference.publishingEmails defaults to true",
	async () => {
		const user = await seedUser("email pref default");
		const row = await db.notificationPreference.create({
			data: { userId: user.id, organizationId: "" },
			select: { publishingEmails: true, publishingSuggestions: true },
		});
		// Both default ON — the opt-out model. They are INDEPENDENT columns: nothing in the
		// schema or the readers makes one imply the other, and the activity's two candidate
		// sets depend on that.
		expect(row.publishingEmails).toBe(true);
		expect(row.publishingSuggestions).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"getRecipientsWithEmailFlagEnabled drops only an explicit false",
	async () => {
		const optedOut = await seedUser("opted out");
		const optedIn = await seedUser("opted in");
		const noRow = await seedUser("no preference row");
		await db.notificationPreference.create({
			data: {
				userId: optedOut.id,
				organizationId: "",
				publishingEmails: false,
			},
		});
		await db.notificationPreference.create({
			data: {
				userId: optedIn.id,
				organizationId: "",
				publishingEmails: true,
			},
		});

		const enabled = await getRecipientsWithEmailFlagEnabled(
			[optedOut.id, optedIn.id, noRow.id],
			"publishingEmails",
		);
		expect(enabled.has(optedOut.id)).toBe(false);
		expect(enabled.has(optedIn.id)).toBe(true);
		// A user with NO row is INCLUDED. This is the assertion that distinguishes the opt-out
		// model from an opt-in one, and getting it backwards would silently notify nobody until
		// every user had visited the settings page.
		expect(enabled.has(noRow.id)).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"getRecipientsWithEmailFlagEnabled reads the flag it was given, not a fixed one",
	async () => {
		// publishingSuggestions=false must NOT drop the user from the EMAIL set. Two independent
		// toggles is the whole point of §9.2(c); a helper hard-coded to one column would pass
		// every other test in this file.
		const user = await seedUser("bell off, email on");
		await db.notificationPreference.create({
			data: {
				userId: user.id,
				organizationId: "",
				publishingSuggestions: false,
				publishingEmails: true,
			},
		});
		const enabled = await getRecipientsWithEmailFlagEnabled(
			[user.id],
			"publishingEmails",
		);
		expect(enabled.has(user.id)).toBe(true);
	},
);

// Moved from notification-preferences-publishing.test.ts (1C-2c): that file must import nothing
// but Vitest and the pure helpers, but pinning "without querying" needs a spy on
// db.notificationPreference.findMany — this file already has `db` in scope. No RUN_DB guard: the
// early return means no query ever fires, so the assertion needs no live database, only the
// client object to spy on.
it("an empty input returns an empty set without querying", async () => {
	const findManySpy = vi.spyOn(db.notificationPreference, "findMany");
	try {
		await expect(
			getRecipientsWithEmailFlagEnabled([], "publishingEmails"),
		).resolves.toEqual(new Set());
		expect(findManySpy).not.toHaveBeenCalled();
	} finally {
		findManySpy.mockRestore();
	}
});

it.skipIf(!RUN_DB)(
	"1C-2c: re-authorization reads the toggle for the channel it was given",
	async () => {
		const seeded = await seedReadyCycleWithRecipient(); // editor on an org project
		await db.notificationPreference.create({
			data: {
				userId: seeded.recipientUserId,
				organizationId: "",
				publishingSuggestions: false,
				publishingEmails: true,
			},
		});

		const forBell = await reauthorizePublishingRecipient({
			projectId: seeded.projectId,
			recipientUserId: seeded.recipientUserId,
			cycleTenant: {
				organizationId: seeded.organizationId,
				userId: null,
			},
			channel: "IN_APP",
		});
		const forEmail = await reauthorizePublishingRecipient({
			projectId: seeded.projectId,
			recipientUserId: seeded.recipientUserId,
			cycleTenant: {
				organizationId: seeded.organizationId,
				userId: null,
			},
			channel: "EMAIL",
		});

		// The same person, the same instant, the same permissions — and opposite answers,
		// because the two toggles are independent. A function that read one fixed column would
		// return the same verdict twice here and pass any test that only checked one channel.
		expect(forBell).toBe("RECIPIENT_UNAUTHORIZED");
		expect(forEmail).toBe("OK");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: the tenancy gate short-circuits ahead of any toggle read, on any channel",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		// No NotificationPreference row exists for this recipient at all — the toggle is never
		// reached, so there is nothing for it to say. If this case somehow depended on it reading
		// "on", that dependency would be the bug: TENANT_CHANGED must not need the toggle's answer.
		// The spy below makes that claim checkable rather than incidental: a TENANT_CHANGED verdict
		// alone would also be produced by an implementation that read the toggle and then discarded
		// its answer, so the case needs the query itself to be silent, not just the return value.
		const findManySpy = vi.spyOn(db.notificationPreference, "findMany");
		try {
			const verdict = await reauthorizePublishingRecipient({
				projectId: seeded.projectId,
				recipientUserId: seeded.recipientUserId,
				cycleTenant: {
					organizationId: "org-that-does-not-own-it",
					userId: null,
				},
				channel: "EMAIL",
			});
			expect(verdict).toBe("TENANT_CHANGED");
			expect(findManySpy).not.toHaveBeenCalled();
		} finally {
			findManySpy.mockRestore();
		}
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: an EMAIL-channel opt-out is honored, not just selected",
	async () => {
		// This pins the EMAIL branch's OWN verdict, not just which toggle it reads (that is the
		// case above). An implementation that swapped in
		// `const stillEnabled = new Set([input.recipientUserId])` for the EMAIL arm — i.e. skipped
		// the toggle read entirely and always called the recipient enabled — would still pass the
		// "reads the toggle for the channel it was given" case above, because that case only ever
		// asserts a difference between the two channels' answers, never EMAIL's answer against a
		// known-off preference row. This case exists to exclude exactly that implementation.
		const seeded = await seedReadyCycleWithRecipient();
		await db.notificationPreference.create({
			data: {
				userId: seeded.recipientUserId,
				organizationId: "",
				publishingEmails: false,
			},
		});

		const verdict = await reauthorizePublishingRecipient({
			projectId: seeded.projectId,
			recipientUserId: seeded.recipientUserId,
			cycleTenant: {
				organizationId: seeded.organizationId,
				userId: null,
			},
			channel: "EMAIL",
		});
		expect(verdict).toBe("RECIPIENT_UNAUTHORIZED");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a first claim takes the row as SENDING with a token",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const result = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		expect(result.outcome).toBe("CLAIMED");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SENDING");
		expect(row.claimedAt).not.toBeNull();
		expect(row.claimToken).toBe(
			result.outcome === "CLAIMED" ? result.claimToken : null,
		);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a second claim inside the lease is HELD and does not move the token",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const first = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		const second = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});

		// This is the assertion the whole fence exists for. A sequential timeout-then-retry test
		// passes under the UNFENCED rule too — reading a null deliveredAt and re-sending — so it
		// is not evidence. What makes this one evidence is that the row is still claimed.
		expect(second.outcome).toBe("HELD");
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.claimToken).toBe(
			first.outcome === "CLAIMED" ? first.claimToken : null,
		);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: an expired lease IS re-granted, with a different token",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const first = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		// `now` is injected rather than the clock being mocked: the lease boundary is a
		// comparison the function makes, so pushing `now` past it tests the real predicate.
		const later = new Date(Date.now() + PUBLISHING_EMAIL_LEASE_MS + 1_000);
		const second = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			now: later,
		});

		// The at-least-once recovery the contract was chosen for. A suite that only tested
		// refusal would pass against the REJECTED at-most-once design too — this is the one
		// assertion that tells the two apart.
		expect(second.outcome).toBe("CLAIMED");
		expect(
			second.outcome === "CLAIMED" ? second.claimToken : null,
		).not.toBe(first.outcome === "CLAIMED" ? first.claimToken : null);
	},
);

it.skipIf(!RUN_DB)("1C-2c: a cancelled row is never re-claimed", async () => {
	const seeded = await seedReadyCycleWithRecipient();
	await db.publishingNotificationDelivery.create({
		data: {
			cycleId: seeded.cycleId,
			projectId: seeded.projectId,
			organizationId: seeded.organizationId,
			userId: null,
			recipientUserId: seeded.recipientUserId,
			channel: "EMAIL",
			status: "SKIPPED",
			reason: "RECIPIENT_UNAUTHORIZED",
		},
	});
	const result = await claimPublishingEmailDelivery({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
	});
	// Cancellation prevents a FUTURE claim. Without this the revoked recipient is mailed on
	// the next attempt, which is the security property §9.2(d) is about.
	expect(result.outcome).toBe("ALREADY_TERMINAL");
});

it.skipIf(!RUN_DB)("1C-2c: a delivered row is never re-claimed", async () => {
	// The sibling of the case above, and NOT the same predicate: a cancellation is caught by
	// `status === "SKIPPED"` while a delivery is caught by `deliveredAt !== null`. A fixture
	// that only ever set one of the two leaves the other held by inspection, which is what the
	// pair's old shared name promised and did not deliver. Re-claiming here would hand a
	// second copy to someone who already has the mail.
	const seeded = await seedReadyCycleWithRecipient();
	const deliveredAt = new Date("2026-08-02T00:00:00.000Z");
	await db.publishingNotificationDelivery.create({
		data: {
			cycleId: seeded.cycleId,
			projectId: seeded.projectId,
			organizationId: seeded.organizationId,
			userId: null,
			recipientUserId: seeded.recipientUserId,
			channel: "EMAIL",
			status: "SENT",
			deliveredAt,
		},
	});
	const result = await claimPublishingEmailDelivery({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
	});
	expect(result.outcome).toBe("ALREADY_TERMINAL");

	const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
		where: {
			cycleId_recipientUserId_channel: {
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				channel: "EMAIL",
			},
		},
	});
	// The verdict alone would also come back from an implementation that answered terminal and
	// still moved the row. The delivery record has to be untouched as well.
	expect(row.status).toBe("SENT");
	expect(row.deliveredAt).toEqual(deliveredAt);
	expect(row.claimToken).toBeNull();
});

it.skipIf(!RUN_DB)(
	"1C-2c: a cancellation committed mid-claim is not overwritten by the update",
	async () => {
		// The claim's conditional UPDATE carries publishingEmailClaimableSql, and two of its terms
		// — `deliveredAt IS NULL` and the SKIPPED-excluding status allow-list — are load-bearing
		// TODAY. The lease term beside them is redundant while creationFenceVerdict takes the
		// project row FOR UPDATE as the transaction's first statement, because that serializes
		// every claim for one project. These two are not, because a writer that genuinely does NOT
		// hold the project lock already exists: terminalizeExistingDeliveriesAsSkipped, called on
		// the base client from the already-terminal branch. Delete them and the claim overwrites a
		// cancellation and mails a recipient whose access was revoked mid-flight — and every other
		// case in this file stays green.
		//
		// The competing write is injected through the registered query observer, on another
		// connection, BETWEEN this transaction's existence findUnique (which saw a claimable row)
		// and its conditional UPDATE. That is the only window in which the two can interleave. It
		// takes no project lock and autocommits, so it neither inverts the module's project →
		// ledger → cycle order nor deadlocks against the lock this claim is holding.
		//
		// STAGED ON THE RAW UPDATE, not on a Prisma `updateMany`: 1C-2d-2a moved the claim's write
		// to `$queryRawUnsafe`, because the expiry term has to read clock_timestamp() and no
		// where-input can express that. The observer sees raw operations with `model` undefined,
		// so the seam is keyed on the operation plus the statement's own text — the SAME window,
		// asserted the same way, pointed at the statement that now occupies it.
		const seeded = await seedReadyCycleWithRecipient();
		// A previously-FAILED row: claimable by construction — `claimedAt` null, `deliveredAt`
		// null — so the lease clause CANNOT be what refuses the claim below. Only the two
		// predicates under test can be.
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: seeded.cycleId,
				projectId: seeded.projectId,
				organizationId: seeded.organizationId,
				userId: null,
				recipientUserId: seeded.recipientUserId,
				channel: "EMAIL",
				status: "FAILED",
				reason: "WRITE_FAILED",
			},
		});

		let injected = false;
		const result = await withQueryObserver(
			async ({ operation, args, query }) => {
				if (
					!injected &&
					operation === "$queryRawUnsafe" &&
					Array.isArray(args) &&
					typeof args[0] === "string" &&
					args[0].startsWith(
						'UPDATE "publishing_notification_delivery"',
					)
				) {
					injected = true;
					await terminalizeExistingDeliveriesAsSkipped({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
						channel: "EMAIL",
						reason: "RECIPIENT_UNAUTHORIZED",
					});
				}
				return query(args);
			},
			() =>
				claimPublishingEmailDelivery({
					cycleId: seeded.cycleId,
					tenant: seeded.tenant,
					recipientUserId: seeded.recipientUserId,
				}),
		);
		// Positive control: without it a hook that never fired would leave the assertions below
		// passing for a reason that has nothing to do with the predicate.
		expect(injected).toBe(true);
		// Not `toBe("HELD")`. Which non-claiming verdict this returns is the subject of the
		// three-way ambiguity documented on the refusal branch, which 1C-2d-2a sharpens: the
		// re-read below the UPDATE now answers ALREADY_TERMINAL for a row that is not owed at
		// all. What must never change is that it did not take the row.
		expect(result.outcome).not.toBe("CLAIMED");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		// The cancellation survives. This is what fails the moment either predicate leaves the
		// `where`: the row comes back SENDING under a fresh token, and the revoked recipient is
		// mailed by the send that follows.
		expect(row.status).toBe("SKIPPED");
		expect(row.reason).toBe("RECIPIENT_UNAUTHORIZED");
		expect(row.claimToken).toBeNull();
		expect(row.deliveredAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: the claim clears the same fence every creating path clears",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		// A cycle whose outcome is already terminal must not gain a new obligation: no further
		// attempt runs, and 1C-2d's sweep is CYCLE-level, so the row would be invisible to
		// everything that could still discharge it.
		await db.publishingSuggestionCycle.update({
			where: { id: seeded.cycleId },
			data: { notificationOutcome: "SENT" },
		});
		const terminal = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		expect(terminal.outcome).toBe("ALREADY_TERMINAL");

		const moved = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: {
				...seeded.tenant,
				organizationId: "org-that-does-not-own-it",
			},
			recipientUserId: seeded.recipientUserId,
		});
		expect(moved.outcome).toBe("TENANT_CHANGED");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: two concurrent claims — exactly one wins",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		// Overlapping, not sequential. Attempts genuinely overlap in production because a
		// start-to-close timeout does not stop the attempt that timed out.
		const [a, b] = await Promise.all([
			claimPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
				recipientUserId: seeded.recipientUserId,
			}),
			claimPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
				recipientUserId: seeded.recipientUserId,
			}),
		]);
		const claimed = [a, b].filter((r) => r.outcome === "CLAIMED");
		expect(claimed).toHaveLength(1);
	},
);

// ---------------------------------------------------------------------------
// 1C-2d-2a: ONE claimability question, asked against the database clock.
//
// The shipped claim asked four: a deny-list of one status, a null deliveredAt, a
// lease, and nothing at all about expiry or attempt count. Each case below is a
// row that at least one of those four waved through.
// ---------------------------------------------------------------------------

type SeededClaimFixture = Awaited<
	ReturnType<typeof seedReadyCycleWithRecipient>
>;

/**
 * A delivery row created BY THE REAL CLAIM.
 *
 * Seeding through `claimPublishingEmailDelivery` rather than through
 * `db.publishingNotificationDelivery.create` is deliberate: the row then carries exactly the
 * columns production writes, defaults included, so a case cannot pass because a hand-built fixture
 * happened to leave a column null.
 */
async function seedClaimedEmailRow(): Promise<SeededClaimFixture> {
	const seeded = await seedReadyCycleWithRecipient();
	const first = await claimPublishingEmailDelivery({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
	});
	expect(first.outcome).toBe("CLAIMED");
	return seeded;
}

/**
 * Move that row into the state under test with ONE raw UPDATE, and prove the move landed.
 *
 * Raw because several of these columns have no writer yet — `expiresAt` and `attemptCount` are the
 * terms 1C-2d-2b and 1C-2d-3 start producing — so there is no production path that can seed them
 * here. Every timestamp is written from the DATABASE clock, which is the clock the claim's expiry
 * term reads; a JS `Date` would compare two clocks and make a boundary case flaky for a reason that
 * has nothing to do with the predicate.
 *
 * The affected-row assertion is the fixture's own positive control: a reshape that matched nothing
 * would leave the case asserting against the freshly-claimed row, which is claimable, and several
 * of these cases would then pass for exactly the wrong reason.
 */
async function reshapeEmailRow(
	seeded: SeededClaimFixture,
	setClause: string,
): Promise<void> {
	const affected = await db.$executeRawUnsafe(
		`UPDATE "publishing_notification_delivery"
		    SET ${setClause}
		  WHERE "cycleId" = $1 AND "recipientUserId" = $2 AND "channel" = 'EMAIL'`,
		seeded.cycleId,
		seeded.recipientUserId,
	);
	expect(affected).toBe(1);
}

function readEmailRow(seeded: SeededClaimFixture) {
	return db.publishingNotificationDelivery.findUniqueOrThrow({
		where: {
			cycleId_recipientUserId_channel: {
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				channel: "EMAIL",
			},
		},
	});
}

function claimAgain(seeded: SeededClaimFixture, now?: Date) {
	return claimPublishingEmailDelivery({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
		now,
	});
}

it.skipIf(!RUN_DB)(
	"refuses to claim a row the reconciler already terminalized",
	async () => {
		// EXPIRED with a NULL deliveredAt — the shape 1C-2d-2b's discharge leaves behind. The
		// shipped deny-list of one admitted it and `deliveredAt: null` did not keep it out, so a
		// later attempt re-sent a message the system had already given up on. Both the allow-list
		// and the expiry term refuse this row, deliberately: neither delete-a-guard run turns it
		// red, and that is the point of seeding the realistic shape rather than a minimal one.
		const seeded = await seedClaimedEmailRow();
		await reshapeEmailRow(
			seeded,
			`"status" = 'EXPIRED', "claimedAt" = NULL, "claimToken" = NULL,
			 "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour'`,
		);

		expect((await claimAgain(seeded)).outcome).toBe("ALREADY_TERMINAL");
		const row = await readEmailRow(seeded);
		// The verdict alone would also come back from an implementation that answered terminal
		// and still moved the row.
		expect(row.status).toBe("EXPIRED");
		expect(row.claimToken).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"refuses to claim a DEFERRED row whose expiry has already passed",
	async () => {
		// The transient Decision 10 documents: the sweep can commit a row as DEFERRED with an
		// expiry that is ALREADY PAST, because it defers on the lease and dates on the original
		// obligation. DEFERRED is IN the allow-list, so only the expiry term can refuse this.
		const seeded = await seedClaimedEmailRow();
		await reshapeEmailRow(
			seeded,
			`"status" = 'DEFERRED', "claimedAt" = NULL, "claimToken" = NULL,
			 "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute'`,
		);

		expect((await claimAgain(seeded)).outcome).toBe("ALREADY_TERMINAL");
		const row = await readEmailRow(seeded);
		expect(row.status).toBe("DEFERRED");
		expect(row.claimToken).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"refuses to claim a dead-leased SENDING row whose expiry has already passed",
	async () => {
		// The lease is DEAD here, so the lease term positively admits this row and nothing but
		// the expiry can refuse it. A crashed attempt leaves exactly this shape and it sits past
		// its deadline until the next sweep tick.
		const seeded = await seedClaimedEmailRow();
		await reshapeEmailRow(
			seeded,
			`"status" = 'SENDING',
			 "claimedAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
			 "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute'`,
		);
		const before = await readEmailRow(seeded);

		expect((await claimAgain(seeded)).outcome).toBe("ALREADY_TERMINAL");
		const row = await readEmailRow(seeded);
		expect(row.status).toBe("SENDING");
		// The dead lease is untouched — the refusal did not re-stamp the row on its way out.
		expect(row.claimToken).toBe(before.claimToken);
		expect(row.claimedAt).toEqual(before.claimedAt);
	},
);

it.skipIf(!RUN_DB)(
	"refuses to claim a FAILED row whose expiry has already passed",
	async () => {
		// recordPublishingEmailFailure PRESERVES expiresAt and releases the claim, so FAILED on
		// its own says nothing about whether the obligation is still owed.
		const seeded = await seedClaimedEmailRow();
		await reshapeEmailRow(
			seeded,
			`"status" = 'FAILED', "reason" = 'PROVIDER_REJECTED',
			 "claimedAt" = NULL, "claimToken" = NULL,
			 "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute'`,
		);

		expect((await claimAgain(seeded)).outcome).toBe("ALREADY_TERMINAL");
		const row = await readEmailRow(seeded);
		expect(row.status).toBe("FAILED");
		expect(row.claimToken).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"refuses to claim a FAILED row at the attempt bound, even inside its expiry",
	async () => {
		// A fourteen-day expiry, an unclaimed row, a status the allow-list admits — the attempt
		// bound is the ONLY term that can refuse this, which is what makes it the isolated case
		// for that guard. A retryable status at the bound is terminal in fact while its status
		// still says FAILED.
		const seeded = await seedClaimedEmailRow();
		await reshapeEmailRow(
			seeded,
			`"status" = 'FAILED', "reason" = 'PROVIDER_REJECTED',
			 "claimedAt" = NULL, "claimToken" = NULL,
			 "attemptCount" = ${PUBLISHING_DELIVERY_ATTEMPT_BOUND},
			 "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '14 days'`,
		);

		expect((await claimAgain(seeded)).outcome).toBe("ALREADY_TERMINAL");
		const row = await readEmailRow(seeded);
		expect(row.status).toBe("FAILED");
		expect(row.attemptCount).toBe(PUBLISHING_DELIVERY_ATTEMPT_BOUND);
		expect(row.claimToken).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"the rolling-version skew window is one claim wide, and it closes on its own",
	async () => {
		// A rolling deploy runs the old build and the new one at once, so for one deploy window a
		// worker that predates this hardening can still take a row the new predicate refuses. A
		// window nobody can demonstrate is a window nobody can bound, so the old predicate is
		// RETYPED here and run for real — and asserted to take the row — before the new one is
		// asked what happens next.
		const seeded = await seedClaimedEmailRow();
		await reshapeEmailRow(
			seeded,
			`"status" = 'EXPIRED', "claimedAt" = NULL, "claimToken" = NULL,
			 "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour'`,
		);
		const terminal = await readEmailRow(seeded);

		// The SHIPPED pre-hardening predicate, retyped: deliveredAt null, a deny-list of one, and
		// the lease. Nothing about expiry, nothing about attempts.
		const oldBuildClaimAt = new Date();
		const oldBuildToken = "old-build-claim-token";
		const takenByOldBuild = await db.$executeRawUnsafe(
			`UPDATE "publishing_notification_delivery"
			    SET "status" = 'SENDING', "claimedAt" = $2, "claimToken" = $3,
			        "lastAttemptAt" = $2, "reason" = NULL, "errorMessage" = NULL
			  WHERE "id" = $1
			    AND "deliveredAt" IS NULL
			    AND "status" <> 'SKIPPED'
			    AND ("claimedAt" IS NULL OR "claimedAt" < $4::timestamp)`,
			terminal.id,
			oldBuildClaimAt,
			oldBuildToken,
			new Date(oldBuildClaimAt.getTime() - PUBLISHING_EMAIL_LEASE_MS),
		);
		// The window is REAL, and this is the assertion that says so. Without it the case below
		// could pass against a fixture the old predicate would also have refused.
		expect(takenByOldBuild).toBe(1);

		// A FULL LEASE later, so the lease term positively admits the row and cannot be what
		// refuses the next claim. Only the expiry is left.
		const afterLease = new Date(
			oldBuildClaimAt.getTime() + PUBLISHING_EMAIL_LEASE_MS + 1_000,
		);
		expect((await claimAgain(seeded, afterLease)).outcome).toBe(
			"ALREADY_TERMINAL",
		);

		const row = await readEmailRow(seeded);
		// The window closes on its own: the old build's claim is the LAST one this row ever gets,
		// and its token is still in place because the new build refused to replace it.
		expect(row.claimToken).toBe(oldBuildToken);
		expect(row.status).toBe("SENDING");
	},
);

it.skipIf(!RUN_DB)(
	"refuses to claim a SKIPPED row still inside its expiry",
	async () => {
		// The allow-list's own case. A cancellation carries a null deliveredAt and, from 1C-2d-2b
		// onwards, a FUTURE expiry — Decision 14's kill switch — so neither the expiry term nor
		// the attempt bound refuses it. Without this case the allow-list has no test that can go
		// red, which is how a guard becomes decoration.
		const seeded = await seedClaimedEmailRow();
		await reshapeEmailRow(
			seeded,
			`"status" = 'SKIPPED', "reason" = 'RECIPIENT_UNAUTHORIZED',
			 "claimedAt" = NULL, "claimToken" = NULL,
			 "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '14 days'`,
		);

		expect((await claimAgain(seeded)).outcome).toBe("ALREADY_TERMINAL");
		const row = await readEmailRow(seeded);
		expect(row.status).toBe("SKIPPED");
		expect(row.reason).toBe("RECIPIENT_UNAUTHORIZED");
		expect(row.claimToken).toBeNull();
		expect(row.deliveredAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: confirming with the matching token marks SENT and stamps deliveredAt",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}

		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
			}),
		).resolves.toBe("CONFIRMED");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a stale token cannot confirm a row the succeeding attempt owns",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const first = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		const second = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			now: new Date(Date.now() + PUBLISHING_EMAIL_LEASE_MS + 1_000),
		});
		if (first.outcome !== "CLAIMED" || second.outcome !== "CLAIMED") {
			throw new Error("expected both claims");
		}

		// The first attempt's lease expired mid-flight and the second took the row. If the first
		// could still stamp deliveredAt, the ledger would assert a delivery on the strength of a
		// send whose outcome nobody knows, and the second attempt's real send would look like a
		// duplicate of it.
		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: first.claimToken,
			}),
		).resolves.toBe("LOST");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SENDING");
		expect(row.deliveredAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a cancelled row never records deliveredAt, even with a live token",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}
		await recordPublishingDeliverySkip({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			channel: "EMAIL",
			reason: "RECIPIENT_UNAUTHORIZED",
		});

		// Cancellation sets the row terminal REGARDLESS of any live claimToken, and what this case
		// pins is that OUTCOME rather than the mechanism that produces it. The mechanism is now the
		// TOKEN predicate: terminalizing RELEASES claimToken, so the caller's token matches nothing
		// and `status: "SENDING"` could be deleted with this test still green. That predicate is
		// pinned separately by "a confirmed row is not confirmed again", where the token still
		// matches by construction.
		//
		// The message may already be gone; what the ledger must never do is assert a delivery this
		// design does not stand behind.
		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
			}),
		).resolves.toBe("LOST");
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SKIPPED");
		expect(row.deliveredAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: recording a known failure RELEASES the claim so the next attempt recovers",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}
		await expect(
			recordPublishingEmailFailure({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
				reason: "PROVIDER_REJECTED",
			}),
		).resolves.toBe("RECORDED");

		// The distinction that makes this design recoverable: a KNOWN failure released the lease,
		// so the retry re-takes the row immediately instead of waiting one lease. Only an
		// AMBIGUOUS outcome — a crash between the send and this write — needs the lease held, and
		// only that case falls through to 1C-2d.
		const retry = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		expect(retry.outcome).toBe("CLAIMED");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: terminalizing a SENDING row releases its lease",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		await terminalizeExistingDeliveriesAsSkipped({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			channel: "EMAIL",
			reason: "CYCLE_CLOSED",
		});

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SKIPPED");
		// Terminal AND unclaimed. Asserting only the status would let a stale token survive into
		// 1C-2d, where a reader that checks the lease before the status would treat this
		// discharged obligation as re-claimable.
		expect(row.claimedAt).toBeNull();
		expect(row.claimToken).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a confirmed row is not confirmed again by the token that confirmed it",
	async () => {
		// This is what pins the `status: "SENDING"` half of the confirming write, and it has to
		// exist separately because the cancelled-row case above no longer pins it. Terminalizing
		// now releases `claimToken` as well, so on that row the TOKEN predicate alone refuses the
		// confirmation and the status predicate can be deleted with the whole suite still green.
		// Here the token matches by construction — confirming does not clear it — so the status
		// predicate is the only thing that can refuse the second call.
		//
		// The record it protects is the delivery instant: a duplicate confirmation from a retried
		// activity would re-stamp deliveredAt at the later time, and every age question asked of
		// this ledger afterwards — the re-drive script's, 1C-2d's — reads the wrong one.
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}
		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
			}),
		).resolves.toBe("CONFIRMED");

		// Backdated to a fixed instant so the assertion below cannot pass by two `new Date()`
		// calls landing in the same millisecond. The row keeps its status and its token.
		const deliveredAt = new Date("2026-08-01T00:00:00.000Z");
		await db.publishingNotificationDelivery.update({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
			data: { deliveredAt },
		});

		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
			}),
		).resolves.toBe("LOST");
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).toEqual(deliveredAt);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a stale token cannot record a failure over a newer attempt's live claim",
	async () => {
		// The failing write is fenced on the token for a harsher reason than the confirming one.
		// Confirming without the fence writes a wrong record; FAILING without it RELEASES a lease
		// this attempt does not hold — so a third attempt claims the row at once and sends while
		// the second is still inside the provider call. That is a duplicate the idempotency key
		// only covers by luck of timing, and the fence is what stops it being reached at all.
		const seeded = await seedReadyCycleWithRecipient();
		const first = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		const second = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			now: new Date(Date.now() + PUBLISHING_EMAIL_LEASE_MS + 1_000),
		});
		if (first.outcome !== "CLAIMED" || second.outcome !== "CLAIMED") {
			throw new Error("expected both claims");
		}

		await expect(
			recordPublishingEmailFailure({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: first.claimToken,
				reason: "PROVIDER_REJECTED",
			}),
		).resolves.toBe("LOST");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		// The second attempt still owns the row, and still owns it under ITS token.
		expect(row.status).toBe("SENDING");
		expect(row.claimToken).toBe(second.claimToken);
		expect(row.claimedAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a late failure cannot overwrite a delivery its own token confirmed",
	async () => {
		// The `status: "SENDING"` predicate on the FAILING write, pinned on its own. The token
		// cannot do it here: confirming leaves the token in place, so the same attempt that
		// confirmed can come back — a retried activity re-running its recipient loop after the
		// confirmation committed — and would flip a delivered row to FAILED while deliveredAt
		// stays set. That row asserts both that the mail arrived and that it never did, and the
		// activity's outcome computation reads the status.
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}
		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
			}),
		).resolves.toBe("CONFIRMED");

		await expect(
			recordPublishingEmailFailure({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
				reason: "PROVIDER_REJECTED",
			}),
		).resolves.toBe("LOST");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: releasing the lease on a failure leaves lastAttemptAt standing",
	async () => {
		// `lastAttemptAt` has exactly one writer and no clearer, and this is the test that says so.
		// Adding `lastAttemptAt: null` beside the two fields this function DOES clear is the
		// tidying edit the comment there warns about, and without this case the whole suite stays
		// green through it.
		//
		// The reason it matters is that `sendEmail` returning false is AMBIGUOUS: it covers a
		// template render error and a provider error that can arrive after the provider already
		// accepted the message. So a FAILED row with a released lease can still represent a
		// message that went out, and nothing else on the row records when. Clear the timestamp and
		// a delayed recovery reads the row as never-attempted, re-sends it past the provider's
		// 24-hour idempotency window, and emits no warning while doing it.
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}
		const claimed =
			await db.publishingNotificationDelivery.findUniqueOrThrow({
				where: {
					cycleId_recipientUserId_channel: {
						cycleId: seeded.cycleId,
						recipientUserId: seeded.recipientUserId,
						channel: "EMAIL",
					},
				},
			});
		expect(claimed.lastAttemptAt).not.toBeNull();

		await expect(
			recordPublishingEmailFailure({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: claim.claimToken,
				reason: "PROVIDER_REJECTED",
			}),
		).resolves.toBe("RECORDED");

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("FAILED");
		// Both halves of the lease go, and BOTH are asserted: dropping only `claimedAt` leaves the
		// row re-claimable while still carrying a token a late attempt could present.
		expect(row.claimedAt).toBeNull();
		expect(row.claimToken).toBeNull();
		// Unmoved and un-nulled. The lease was released; the historical fact was not.
		expect(row.lastAttemptAt).toEqual(claimed.lastAttemptAt);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: terminalizing releases the lease without erasing lastAttemptAt",
	async () => {
		// The same rule as the failure path, in the two writers Step 4 taught to release the lease.
		// Terminalizing an obligation does not unsend a message, so the row must go terminal and
		// unclaimed while still recording that a message may already have reached the provider.
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}
		const claimed =
			await db.publishingNotificationDelivery.findUniqueOrThrow({
				where: {
					cycleId_recipientUserId_channel: {
						cycleId: seeded.cycleId,
						recipientUserId: seeded.recipientUserId,
						channel: "EMAIL",
					},
				},
			});

		await terminalizeExistingDeliveriesAsSkipped({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			channel: "EMAIL",
			reason: "CYCLE_CLOSED",
		});

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SKIPPED");
		expect(row.lastAttemptAt).toEqual(claimed.lastAttemptAt);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: cancelling one recipient releases that row's lease the same way",
	async () => {
		// recordPublishingDeliverySkip's second statement got the identical Step 4 change, and
		// nothing else in this file exercises it — the case above covers only
		// terminalizeExistingDeliveriesAsSkipped, so all three fields could be dropped from this
		// writer with the suite green. The two are separate code paths reached by separate callers
		// (a per-recipient revocation versus a cycle-wide close), and 1C-2d's sweep will read rows
		// produced by both.
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}
		const claimed =
			await db.publishingNotificationDelivery.findUniqueOrThrow({
				where: {
					cycleId_recipientUserId_channel: {
						cycleId: seeded.cycleId,
						recipientUserId: seeded.recipientUserId,
						channel: "EMAIL",
					},
				},
			});

		await recordPublishingDeliverySkip({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			channel: "EMAIL",
			reason: "RECIPIENT_UNAUTHORIZED",
		});

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SKIPPED");
		expect(row.claimedAt).toBeNull();
		expect(row.claimToken).toBeNull();
		expect(row.lastAttemptAt).toEqual(claimed.lastAttemptAt);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: confirming with an absent token throws instead of widening the fence",
	async () => {
		// Prisma DROPS an `undefined` where-predicate rather than treating it as unmatchable, so
		// without the guard `claimToken: undefined` does not MISS — it removes the token condition
		// and leaves `cycleId + recipientUserId + channel + status: "SENDING"`, which matches
		// whichever attempt currently owns the row. A caller holding no claim at all would confirm
		// the row below, and the symptom is not an error: a LOST quietly becomes a CONFIRMED.
		//
		// Unreachable through the typed surface today — `EmailClaimResult` exposes `claimToken`
		// only on its CLAIMED branch and TS narrows it. Task 7 is a Temporal ACTIVITY, where inputs
		// arrive as deserialized JSON and the compiler is not in the loop.
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}

		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: undefined as unknown as string,
			}),
		).rejects.toThrow(/claimToken/);

		// The empty string is the other falsy arrival and is refused the same way. It does not
		// widen the fence — it matches nothing — but answering LOST would tell the caller "a newer
		// attempt owns this row" about what is really a malformed call, and the caller stops.
		await expect(
			confirmPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: "",
			}),
		).rejects.toThrow(/claimToken/);

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		// Untouched, and this is the half that matters. The throw is the mechanism; not writing
		// over a live claim is the property, and only these assertions would notice a guard that
		// threw after the query rather than before it.
		expect(row.status).toBe("SENDING");
		expect(row.deliveredAt).toBeNull();
		expect(row.claimToken).toBe(claim.claimToken);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: failing with an absent token throws instead of releasing another attempt's lease",
	async () => {
		// The same dropped predicate, with the worse consequence. A widened fence here does not
		// merely write a wrong record: it records a failure over whichever attempt owns the row AND
		// clears that attempt's `claimedAt`/`claimToken`. The next claim then passes its
		// `OR: [{ claimedAt: null }, …]` immediately and sends while the previous attempt is still
		// inside the provider call — a duplicate reported as a success.
		const seeded = await seedReadyCycleWithRecipient();
		const claim = await claimPublishingEmailDelivery({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
		});
		if (claim.outcome !== "CLAIMED") {
			throw new Error("expected a claim");
		}

		await expect(
			recordPublishingEmailFailure({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: undefined as unknown as string,
				reason: "PROVIDER_REJECTED",
			}),
		).rejects.toThrow(/claimToken/);
		await expect(
			recordPublishingEmailFailure({
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				claimToken: "",
				reason: "PROVIDER_REJECTED",
			}),
		).rejects.toThrow(/claimToken/);

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SENDING");
		// The lease is the assertion. A thrown error retries and eventually surfaces; a released
		// lease is invisible until two copies of the same mail arrive.
		expect(row.claimToken).toBe(claim.claimToken);
		expect(row.claimedAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"carries the deferral columns with the documented defaults",
	async () => {
		// column_name is cast to text: Postgres types it "name" (via the sql_identifier
		// domain), which Prisma's raw-query deserializer cannot decode on its own —
		// unrelated to whether the two columns below exist.
		const columns = (await db.$queryRawUnsafe(`
		SELECT column_name::text AS column_name, data_type, datetime_precision, is_nullable, column_default
		  FROM information_schema.columns
		 WHERE table_name = 'publishing_notification_delivery'
		   AND column_name IN ('expiresAt', 'attemptCount')
		 ORDER BY column_name
	`)) as Array<{
			column_name: string;
			data_type: string;
			datetime_precision: number | null;
			is_nullable: string;
			column_default: string | null;
		}>;

		expect(columns).toHaveLength(2);

		const attemptCount = columns.find(
			(c) => c.column_name === "attemptCount",
		);
		expect(attemptCount?.data_type).toBe("integer");
		expect(attemptCount?.is_nullable).toBe("NO");
		expect(attemptCount?.column_default).toBe("0");

		const expiresAt = columns.find((c) => c.column_name === "expiresAt");
		expect(expiresAt?.is_nullable).toBe("YES");
		// No default: an expiry is set by the writer that creates the obligation,
		// never inherited. A default would manufacture an expiry for every row.
		expect(expiresAt?.column_default).toBeNull();
		// Pin the exact wire type: TIMESTAMP(3) reports data_type "timestamp without
		// time zone" with datetime_precision 3 — data_type alone would not catch a
		// silent widen to timestamp(6), and datetime_precision alone would not catch
		// a silent switch to timestamptz.
		expect(expiresAt?.data_type).toBe("timestamp without time zone");
		expect(expiresAt?.datetime_precision).toBe(3);
	},
);

it.skipIf(!RUN_DB)(
	"defaults attemptCount to 0 on a row that never names it",
	async () => {
		const { cycleId, projectId, tenant } =
			await seedReadyCycleWithRecipients(0);
		const recipientId = (await seedUser("Deferral recipient")).id;

		await db.$executeRawUnsafe(
			`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId",
		    "recipientUserId","channel","status")
		 VALUES ($1,$2,$3,$4,$5,$6,'EMAIL','SENT')`,
			`del_${Date.now()}`,
			cycleId,
			projectId,
			tenant.organizationId,
			tenant.userId,
			recipientId,
		);

		const [row] = (await db.$queryRawUnsafe(
			`SELECT "attemptCount", "expiresAt" FROM "publishing_notification_delivery"
		  WHERE "cycleId" = $1`,
			cycleId,
		)) as Array<{ attemptCount: number; expiresAt: Date | null }>;

		expect(row.attemptCount).toBe(0);
		expect(row.expiresAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"admits the two deferral states the sweep needs",
	async () => {
		const { cycleId, projectId, tenant } =
			await seedReadyCycleWithRecipients(0);

		for (const status of ["DEFERRED", "EXPIRED"] as const) {
			const recipientId = (await seedUser(`Deferral recipient ${status}`))
				.id;
			await expect(
				db.$executeRawUnsafe(
					`INSERT INTO "publishing_notification_delivery"
				   ("id","cycleId","projectId","organizationId","userId",
				    "recipientUserId","channel","status","expiresAt")
				 VALUES ($1,$2,$3,$4,$5,$6,'EMAIL',$7, now() + interval '14 days')`,
					`del_${status}_${Date.now()}`,
					cycleId,
					projectId,
					tenant.organizationId,
					tenant.userId,
					recipientId,
					status,
				),
			).resolves.toBe(1);
		}
	},
);

// NOT VALID skipped the scan of EXISTING rows only. The predicate was enforced
// on every insert and update from the moment the constraint existed, which is
// why 1C-2d-1a could ship the shape guarantee before this slice validated it.
// The constraint is VALID as of 1C-2d-2a, so this case now proves the older
// property rather than the current one — kept because a reader who deletes it
// loses the record that NOT VALID was never inert.
it.skipIf(!RUN_DB)(
	"rejects a DEFERRED row with no expiry, as it did before the constraint was validated",
	async () => {
		const { cycleId, projectId, tenant } =
			await seedReadyCycleWithRecipients(0);
		const recipientId = (await seedUser("Deferral recipient")).id;

		await expect(
			db.$executeRawUnsafe(
				`INSERT INTO "publishing_notification_delivery"
			   ("id","cycleId","projectId","organizationId","userId",
			    "recipientUserId","channel","status")
			 VALUES ($1,$2,$3,$4,$5,$6,'EMAIL','DEFERRED')`,
				`del_noexp_${Date.now()}`,
				cycleId,
				projectId,
				tenant.organizationId,
				tenant.userId,
				recipientId,
			),
		).rejects.toThrow(/publishing_notification_delivery_deferred_shape/);
	},
);

it.skipIf(!RUN_DB)(
	"permits a null expiry on every status that is not DEFERRED",
	async () => {
		const { cycleId, projectId, tenant } =
			await seedReadyCycleWithRecipients(0);

		// EXPIRED is the interesting one: it is a deferral-lifecycle terminal, so a
		// shape rule written as "the lifecycle states carry an expiry" rather than
		// "DEFERRED carries an expiry" would wrongly reject it.
		for (const status of [
			"SENT",
			"FAILED",
			"SKIPPED",
			"SENDING",
			"EXPIRED",
		] as const) {
			const recipientId = (await seedUser(`Deferral recipient ${status}`))
				.id;
			await expect(
				db.$executeRawUnsafe(
					`INSERT INTO "publishing_notification_delivery"
				   ("id","cycleId","projectId","organizationId","userId",
				    "recipientUserId","channel","status")
				 VALUES ($1,$2,$3,$4,$5,$6,'EMAIL',$7)`,
					`del_nx_${status}_${Date.now()}`,
					cycleId,
					projectId,
					tenant.organizationId,
					tenant.userId,
					recipientId,
					status,
				),
			).resolves.toBe(1);
		}
	},
);

// The cases above only prove the shape on INSERT. The reconciliation sweep never inserts a
// DEFERRED row — it returns a crashed SENDING row to DEFERRED by UPDATE once its lease
// expires — so UPDATE is the transition that matters in practice, and nothing above pins the
// constraint there. This closes that gap directly: the same UPDATE is rejected with expiresAt
// left null, then proven to succeed once expiresAt is supplied in the same statement, so a
// shape rule written as "DEFERRED can never be reached by UPDATE at all" would also fail here.
it.skipIf(!RUN_DB)(
	"the deferred-shape CHECK also holds when DEFERRED is reached by UPDATE, not just INSERT",
	async () => {
		const { cycleId, projectId, tenant } =
			await seedReadyCycleWithRecipients(0);
		const recipientId = (await seedUser("Deferral recipient")).id;
		const deliveryId = `del_upd_${Date.now()}`;

		await db.$executeRawUnsafe(
			`INSERT INTO "publishing_notification_delivery"
			   ("id","cycleId","projectId","organizationId","userId",
			    "recipientUserId","channel","status")
			 VALUES ($1,$2,$3,$4,$5,$6,'EMAIL','SENDING')`,
			deliveryId,
			cycleId,
			projectId,
			tenant.organizationId,
			tenant.userId,
			recipientId,
		);

		await expect(
			db.$executeRaw`UPDATE "publishing_notification_delivery" SET "status" = 'DEFERRED' WHERE "id" = ${deliveryId}`,
		).rejects.toThrow(/publishing_notification_delivery_deferred_shape/);

		await expect(
			db.$executeRaw`UPDATE "publishing_notification_delivery" SET "status" = 'DEFERRED', "expiresAt" = now() + interval '14 days' WHERE "id" = ${deliveryId}`,
		).resolves.toBe(1);
	},
);

// The only way to tell a discharged obligation from a deleted JSON line.
it.skipIf(!RUN_DB)(
	"validates both deferral constraints, discharging the obligation 1C-2d-1a recorded",
	async () => {
		const rows = (await db.$queryRawUnsafe(`
		SELECT conname::text AS conname, convalidated
		  FROM pg_constraint
		 WHERE conrelid = 'publishing_notification_delivery'::regclass
		   AND conname IN ('publishing_notification_delivery_status_check',
		                   'publishing_notification_delivery_deferred_shape')
		 ORDER BY conname
	`)) as Array<{ conname: string; convalidated: boolean }>;

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.convalidated).toBe(true);
		}
	},
);

// =============================================================================
// 1C-2d-3a — the producer's deferral writer, and the close that must not eat it
// =============================================================================

it.skipIf(!RUN_DB)(
	"defers email-only recipients with no lease, a zero attempt count and a 14-day expiry (1C-2d-3a)",
	async () => {
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(2);
		const now = new Date("2026-08-18T10:00:00.000Z");

		const result = await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds,
			now,
		});

		expect(result).toEqual({ outcome: "DEFERRED", created: 2 });
		const rows = await db.publishingNotificationDelivery.findMany({
			where: { cycleId, channel: "EMAIL" },
		});
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.status).toBe("DEFERRED");
			// A DEFERRAL IS NOT A CLAIM (§9.9). This pair staying null is what leaves the
			// lease fence untouched and lets reconciliation claim the row normally when
			// the time comes.
			expect(row.claimedAt).toBeNull();
			expect(row.claimToken).toBeNull();
			expect(row.attemptCount).toBe(0);
			expect(row.deliveredAt).toBeNull();
			expect(row.expiresAt?.toISOString()).toBe(
				new Date(
					now.getTime() + PUBLISHING_DEFERRAL_WINDOW_MS,
				).toISOString(),
			);
		}
	},
);

it.skipIf(!RUN_DB)(
	"WAITS on the project row, so a concurrent close cannot land rows under a terminal cycle (1C-2d-3a)",
	async () => {
		// WHAT THIS PINS is that the deferral writer is mutually exclusive with anything
		// holding the project row — so it cannot write rows beside a closing transaction
		// that is terminalizing the same cycle.
		//
		// WHAT IT DOES NOT PIN, said here because three earlier versions of this case each
		// claimed to and none did. The writer used to call lockPublishingProjectRow
		// explicitly, and every attempt to pin THAT call stayed green under a
		// delete-a-guard run: an ordering assertion, because currentTenantMatches is raw
		// too and also precedes the fence read; a blocked/not-blocked assertion, because
		// createMany's FK to the project takes FOR KEY SHARE on the parent and conflicts
		// with the holder anyway; and a "did the fence read happen yet" assertion, because
		// the fence's OWN first statement is SELECT ... FOR UPDATE on that row.
		//
		// The third of those is the answer rather than another failure: the fence takes the
		// lock, the explicit call was a second acquisition of a lock already held, and it
		// has been removed. This case is therefore about the FENCE's lock, and there is
		// nothing left in this function to perturb — which is the honest state to leave it
		// in, rather than a case that appears to guard something it cannot.
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(1);

		// NO FIXED SLEEPS ANYWHERE IN THE COORDINATION, and that is the point rather than
		// tidiness. A fixed delay before the writer starts is the flaky half: if the
		// holder has not acquired the row within it, the writer takes the lock first and
		// finishes, and the case fails on a slow runner for a reason that has nothing to
		// do with what it tests. Both waits below are barriers on events this test can
		// observe.
		let releaseHolder: () => void = () => {};
		let announceAcquired: () => void = () => {};
		const holderMayCommit = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holderHasLock = new Promise<void>((resolve) => {
			announceAcquired = resolve;
		});
		const holder = db.$transaction(
			async (tx) => {
				await lockPublishingProjectRow(tx, tenant.projectId);
				// BARRIER 1, anchored to the statement that DECIDES: the lock is held only
				// once this call has RETURNED, so the signal goes here and not before the
				// transaction or after the body.
				announceAcquired();
				await holderMayCommit;
			},
			{ timeout: 30_000 },
		);
		await holderHasLock;

		let settled = false;
		const writer = deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds,
		}).then((result) => {
			settled = true;
			return result;
		});

		// BARRIER 2 IS NOT "the writer has issued a statement", and the difference is the
		// whole refuting power of this case. The tape observer pushes BEFORE awaiting the
		// query, so an entry appears the instant the statement is sent — including when
		// nothing is blocking it. Asserting `settled === false` at that moment would pass
		// against a writer that never waited at all: it simply has not finished yet.
		// Tightening the wait would have made the case faster and hollow.
		//
		// So the barrier is the BLOCK ITSELF, observed from a third connection the way the
		// reconciliation contention suite observes it. `wait_event = 'transactionid'`
		// rather than merely `wait_event_type = 'Lock'`: a backend queued behind a DDL
		// statement is also a Lock wait, and counting it would let this go green on
		// contention that has nothing to do with this row.
		//
		// This also gives the case a real failure mode. If the writer never blocks, the
		// poll runs out and the test fails naming that — where a duration-based wait would
		// have failed on a timing accident instead.
		const blockDeadline = Date.now() + 15_000;
		let observedBlock = 0;
		while (observedBlock === 0) {
			if (Date.now() > blockDeadline) {
				throw new Error(
					"no backend waiting on a row lock within 15s — the deferral writer did not block on the held project row",
				);
			}
			const [{ n }] = (await db.$queryRawUnsafe(
				`SELECT count(*)::int AS n
				   FROM pg_stat_activity
				  WHERE "datname" = current_database()
				    AND "state" = 'active'
				    AND "wait_event_type" = 'Lock'
				    AND "wait_event" = 'transactionid'
				    AND "pid" <> pg_backend_pid()`,
			)) as Array<{ n: number }>;
			observedBlock = n;
			if (observedBlock === 0) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}

		// DURING: the block is OBSERVED, not inferred, and the writer has not resolved.
		expect(observedBlock).toBeGreaterThan(0);
		expect(settled).toBe(false);

		releaseHolder();
		await holder;
		// AFTER: it proceeds, so the wait was a wait and not a deadlock.
		await expect(writer).resolves.toEqual({
			outcome: "DEFERRED",
			created: 1,
		});
	},
);

it.skipIf(!RUN_DB)(
	"is create-once: a second call writes nothing and preserves a row a drain has since claimed (1C-2d-3a)",
	async () => {
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(1);
		const first = new Date("2026-08-18T10:00:00.000Z");
		await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds,
			now: first,
		});
		// A drain attempt has taken the row since. Every field below is one an upsert
		// would trample.
		await db.publishingNotificationDelivery.updateMany({
			where: { cycleId, channel: "EMAIL" },
			data: {
				status: "SENDING",
				claimedAt: first,
				claimToken: "held-by-the-drain",
				attemptCount: 3,
			},
		});

		const second = await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds,
			now: new Date("2026-08-18T10:05:00.000Z"),
		});

		expect(second).toEqual({ outcome: "DEFERRED", created: 0 });
		const row = await db.publishingNotificationDelivery.findFirstOrThrow({
			where: { cycleId, channel: "EMAIL" },
		});
		expect(row.status).toBe("SENDING");
		expect(row.claimToken).toBe("held-by-the-drain");
		expect(row.attemptCount).toBe(3);
		// The one an upsert would move, silently extending a 14-day obligation for as
		// long as the outage lasts.
		expect(row.expiresAt?.toISOString()).toBe(
			new Date(
				first.getTime() + PUBLISHING_DEFERRAL_WINDOW_MS,
			).toISOString(),
		);
	},
);

it.skipIf(!RUN_DB)(
	"writes only the recipients that have no row yet, and reports that count (1C-2d-3a)",
	async () => {
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(3);
		const [firstRecipient] = recipientUserIds;
		if (!firstRecipient) {
			throw new Error("seeded no recipients");
		}
		await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds: [firstRecipient],
			now: new Date("2026-08-18T10:00:00.000Z"),
		});

		const result = await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds,
			now: new Date("2026-08-18T10:01:00.000Z"),
		});

		// The returned count is what the database inserted, never the input length — the
		// caller logs it, and the two differ on every retry.
		expect(result).toEqual({ outcome: "DEFERRED", created: 2 });
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId, channel: "EMAIL" },
			}),
		).toBe(3);
	},
);

it.skipIf(!RUN_DB)(
	"does not collide with the same recipient's IN_APP row for the same cycle (1C-2d-3a)",
	async () => {
		// The unique key includes the CHANNEL, so a bell and a deferral coexist. Worth a
		// case because the create-once guard is skipDuplicates over that key, and a key
		// mis-stated as a pair would make this the failing shape.
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(1);
		const [recipientUserId] = recipientUserIds;
		if (!recipientUserId) {
			throw new Error("seeded no recipient");
		}
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId,
				projectId: tenant.projectId,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId,
				channel: "IN_APP",
				status: "SENT",
				deliveredAt: new Date(),
			},
		});

		const result = await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds,
		});

		expect(result).toEqual({ outcome: "DEFERRED", created: 1 });
	},
);

it.skipIf(!RUN_DB)(
	"refuses, writing nothing, under a tuple that no longer owns the cycle (1C-2d-3a)",
	async () => {
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(1);

		const result = await deferPublishingEmailDeliveries({
			cycleId,
			tenant: { ...tenant, organizationId: null, userId: randomUUID() },
			recipientUserIds,
		});

		expect(result).toEqual({ outcome: "TENANT_CHANGED" });
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"refuses, writing nothing, on a cycle another attempt already terminalized (1C-2d-3a)",
	async () => {
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(1);
		await db.publishingSuggestionCycle.update({
			where: { id: cycleId },
			data: { notificationOutcome: "CANCELLED" },
		});

		const result = await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds,
		});

		expect(result).toEqual({ outcome: "CYCLE_TERMINAL" });
		expect(
			await db.publishingNotificationDelivery.count({
				where: { cycleId },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"is a no-op on an empty recipient set, and issues no query to be one (1C-2d-3a)",
	async () => {
		// The COMMON case: every email recipient also gets a bell. It must not queue
		// behind the project row lock, which every claim contends for.
		const { cycleId, tenant } = await seedReadyCycleWithRecipients(1);

		queryTape.length = 0;
		const result = await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds: [],
		});

		expect(result).toEqual({ outcome: "DEFERRED", created: 0 });
		expect(queryTape).toHaveLength(0);
	},
);

it.skipIf(!RUN_DB)(
	"the close spares a DEFERRED row while still terminalizing its FAILED neighbour (1C-2d-3a)",
	async () => {
		// THE DEFECT THIS SLICE WAS WRITTEN AROUND. Without the notIn term the completing
		// exit terminalizes the obligation the same attempt just created: deliveredAt is
		// null and DEFERRED is not SKIPPED, so the row matches BOTH terms of the old
		// predicate. Nothing else notices — the row exists, its status is terminal, every
		// count agrees.
		const { cycleId, tenant, recipientUserIds } =
			await seedReadyCycleWithRecipients(2);
		const [deferredRecipient, failedRecipient] = recipientUserIds;
		if (!deferredRecipient || !failedRecipient) {
			throw new Error("seeded too few recipients");
		}
		await deferPublishingEmailDeliveries({
			cycleId,
			tenant,
			recipientUserIds: [deferredRecipient],
			now: new Date("2026-08-18T10:00:00.000Z"),
		});
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId,
				projectId: tenant.projectId,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				recipientUserId: failedRecipient,
				channel: "EMAIL",
				status: "FAILED",
			},
		});

		await terminalizeExistingDeliveriesAsSkipped({
			cycleId,
			tenant,
			channel: "EMAIL",
			reason: "CYCLE_CLOSED",
		});

		const rows = new Map(
			(
				await db.publishingNotificationDelivery.findMany({
					where: { cycleId, channel: "EMAIL" },
				})
			).map((row) => [row.recipientUserId, row]),
		);
		// Spared, and still carrying everything the drain needs to find and claim it.
		expect(rows.get(deferredRecipient)?.status).toBe("DEFERRED");
		expect(rows.get(deferredRecipient)?.expiresAt).not.toBeNull();
		expect(rows.get(deferredRecipient)?.reason).toBeNull();
		// And the close still does its job on everything else, which is what stops the
		// fix from being "terminalize nothing".
		expect(rows.get(failedRecipient)?.status).toBe("SKIPPED");
		expect(rows.get(failedRecipient)?.reason).toBe("CYCLE_CLOSED");
	},
);
