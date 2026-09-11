/**
 * Organization soft delete, restore and purge (Fizzy #2462).
 *
 * Mirrors `projects/projects.ts`, which has run this exact shape in production
 * since January. Deliberately a copy of a proven pattern rather than a new one:
 * the purge workflow, the reminder sweep and the restore path are all written
 * against these four column names, so an organization purge can copy the
 * project workflow almost line for line.
 *
 * The one thing this module does that the project code does not is own the
 * window as a NAMED CONSTANT. `7 * 24 * 60 * 60 * 1000` is currently spelled
 * out in four separate places on the project side — two query files, an OpenAPI
 * description and several UI strings — and they can drift apart silently. The
 * organization window is written down once, here, and everything that states it
 * — mail, dialogs, settings copy — is handed the number rather than repeating
 * it. That is what made moving it from seven days to thirty a one-line change.
 */
import { db } from "../../client";

/**
 * How long a deleted organization stays recoverable.
 *
 * Deliberately LONGER than the seven days a deleted project gets, and the
 * difference is the blast radius: a project is one team's work and its owner
 * notices within the day, whereas an organization takes everyone in it offline
 * at once — including the people best placed to notice, who lose the surface
 * they would have noticed on. Thirty days covers someone away for a few weeks
 * and the deletion nobody sees until the quiet fortnight ends (Fizzy #2462,
 * decided at the 2026-09-10 DSU).
 */
export const ORGANIZATION_RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The retention window in milliseconds. */
export const ORGANIZATION_RETENTION_MS =
	ORGANIZATION_RETENTION_DAYS * MS_PER_DAY;

/**
 * How far ahead of the purge the warning goes out.
 *
 * Two days rather than one so a person who reads mail on weekdays still gets a
 * weekend's notice, and so a single failed sweep is not the difference between
 * warned and not.
 */
export const REMINDER_LEAD_MS = 2 * MS_PER_DAY;

/**
 * Deactivate an organization and stamp its purge date.
 *
 * The stamp is computed HERE, at deletion time, and never recomputed. Shortening
 * the retention window later must not retroactively destroy something already in
 * the corridor — that is what lets the UI promise "recoverable until <date>" and
 * mean it.
 *
 * Guarded on `deletedAt: null` so a double submit cannot restart the clock on an
 * organization that is already deleted, which would silently extend its life.
 */
export async function softDeleteOrganization(params: {
	organizationId: string;
	deletedByUserId: string;
	now?: Date;
}) {
	const now = params.now ?? new Date();

	return await db.organization.update({
		where: {
			id: params.organizationId,
			deletedAt: null,
		},
		data: {
			deletedAt: now,
			deletedBy: params.deletedByUserId,
			scheduledPermanentDeleteAt: new Date(
				now.getTime() + ORGANIZATION_RETENTION_MS,
			),
			deletionReminderSentAt: null,
		},
	});
}

/**
 * Bring a deactivated organization back, exactly as it was.
 *
 * Cheap precisely because nothing was destroyed: every row the organization owns
 * survived the corridor untouched, so this clears four columns rather than
 * re-importing across the ~168 relations that cascade off the model.
 *
 * `deletedAt: { not: null }` means restoring a live organization is a no-op that
 * throws rather than a silent success, so a caller cannot report "restored" for
 * something that was never gone.
 */
export async function restoreOrganization(params: { organizationId: string }) {
	return await db.organization.update({
		where: {
			id: params.organizationId,
			deletedAt: { not: null },
		},
		data: {
			deletedAt: null,
			deletedBy: null,
			scheduledPermanentDeleteAt: null,
			deletionReminderSentAt: null,
		},
	});
}

/**
 * Every organization this user could restore right now.
 *
 * Filtered by the caller's own membership, so this can be called from a context
 * where no organization resolves — which is the normal case, because a person
 * looking at this list has just deleted the organization they were in.
 *
 * `role` comes back so the caller can apply the same permission rule the delete
 * path used, rather than inventing a second one.
 */
export async function listRestorableOrganizationsForUser(params: {
	userId: string;
}) {
	const rows = await db.member.findMany({
		where: {
			userId: params.userId,
			organization: { deletedAt: { not: null } },
		},
		select: {
			role: true,
			organization: {
				select: {
					id: true,
					name: true,
					slug: true,
					logo: true,
					deletedAt: true,
					deletedBy: true,
					scheduledPermanentDeleteAt: true,
				},
			},
		},
	});

	return rows.map((row) => ({ role: row.role, ...row.organization }));
}

/**
 * Is this organization live?
 *
 * Deliberately selects nothing but the one column. This runs on the tenant
 * resolution path for every request, so it must stay a primary-key lookup that
 * returns a single nullable timestamp.
 *
 * A row that does not exist reads as NOT live: an organization deleted out from
 * under a session should refuse the same way a deactivated one does, rather than
 * falling through to a different error.
 */
export async function isOrganizationLive(organizationId: string) {
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: { deletedAt: true },
	});

	return org !== null && org.deletedAt === null;
}

/**
 * Organizations whose window has elapsed and which are ready to be destroyed.
 *
 * Ordered oldest-first so a backlog drains in the order it accumulated, and
 * bounded by `batchSize` so one sweep cannot run unbounded.
 */
export async function getOrganizationsReadyForPurge(params: {
	batchSize?: number;
	now?: Date;
}) {
	const now = params.now ?? new Date();

	return await db.organization.findMany({
		where: {
			deletedAt: { not: null },
			scheduledPermanentDeleteAt: { lte: now },
		},
		select: { id: true, name: true, slug: true, deletedBy: true },
		orderBy: { scheduledPermanentDeleteAt: "asc" },
		take: params.batchSize ?? 100,
	});
}

/**
 * Organizations close enough to purge to warrant a warning, which have not had
 * one yet — together with every owner who should receive it.
 *
 * NO LOWER BOUND, deliberately, and this is a correctness property rather than
 * a widening. The first cut of this asked for a 24-48h band, which works only
 * while the sweep runs exactly daily: an organization that fails its send falls
 * out of the band before the next run and is then NEVER warned, going dark with
 * no notice. Without the lower bound a failed send is simply retried the next
 * day, every day, until the purge — and `deletionReminderSentAt: null` is what
 * stops a successful one being sent twice. At-least-once beats exactly-once for
 * a message whose absence is the expensive failure.
 *
 * Owners, plural: whoever pressed the button is not necessarily the only person
 * who would want to know their organization is about to be destroyed, and a
 * co-owner learning about it afterwards has no recourse at all.
 */
export async function getOrganizationsNeedingPurgeReminder(params: {
	batchSize?: number;
	now?: Date;
}) {
	const now = params.now ?? new Date();

	const organizations = await db.organization.findMany({
		where: {
			deletedAt: { not: null },
			deletionReminderSentAt: null,
			scheduledPermanentDeleteAt: {
				lte: new Date(now.getTime() + REMINDER_LEAD_MS),
			},
		},
		select: {
			id: true,
			name: true,
			slug: true,
			deletedBy: true,
			scheduledPermanentDeleteAt: true,
			members: {
				// Owners are the people who can act on the warning: restoring is
				// gated by the same permission as deleting, so warning anyone
				// else offers them a button they cannot press.
				where: { role: "owner" },
				select: {
					user: { select: { id: true, email: true, name: true } },
				},
			},
		},
		orderBy: { scheduledPermanentDeleteAt: "asc" },
		take: params.batchSize ?? 100,
	});

	return organizations.map((organization) => ({
		id: organization.id,
		name: organization.name,
		slug: organization.slug,
		deletedBy: organization.deletedBy,
		scheduledPermanentDeleteAt: organization.scheduledPermanentDeleteAt,
		owners: organization.members
			.map((member) => member.user)
			.filter((user): user is NonNullable<typeof user> => user !== null),
	}));
}

/** Records that the pre-purge warning went out, so it cannot go out twice. */
export async function markOrganizationPurgeReminderSent(
	organizationId: string,
) {
	return await db.organization.update({
		where: { id: organizationId },
		data: { deletionReminderSentAt: new Date() },
	});
}

/**
 * Destroy an organization for real.
 *
 * The `deletedAt: { not: null }` guard is the whole safety story of the purge
 * worker. The sweep reads a batch, then deletes each row one at a time, and a
 * person can restore an organization in between those two moments. Because the
 * guard is part of the WHERE clause, that restore makes this delete match zero
 * rows and throw — which the caller treats as "skip", not as a failure. Without
 * it, a restore that lands mid-sweep would lose the tenant it just saved.
 *
 * This is a hard delete: ~168 relations cascade off `organization`, so the row
 * takes the whole tenant with it. Everything that does NOT live in Postgres —
 * vectors, blobs, the payment-provider subscription, per-tenant schedules — has
 * to be torn down by the caller, because a cascade cannot reach any of it.
 */
export async function permanentDeleteOrganization(organizationId: string) {
	return await db.organization.delete({
		where: {
			id: organizationId,
			deletedAt: { not: null },
		},
	});
}
