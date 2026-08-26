/**
 * `StatusUpdate` query helpers — the customer-facing announcement surface.
 *
 * Read side is used by both the in-product dashboard and the external REST
 * surface; write side is admin-only and lives behind `adminProcedure`.
 *
 * The customer-facing projection deliberately omits `componentIncidentId` and
 * `integrationIncidentId`. Those are operator navigation aids into internal
 * detection records, and letting them reach a customer response would leak the
 * existence and identifiers of internal incident rows.
 */

import { db } from "../client";
import type { StatusUpdateImpact, StatusUpdateLifecycle } from "../zod";

/**
 * Both aliases resolve to the generated Prisma enum types, deliberately rather
 * than re-declaring the literal unions by hand.
 *
 * These values live in exactly one place — the `StatusUpdateLifecycle` /
 * `StatusUpdateImpact` enums in the Prisma schema — and adding a variant there
 * must break every consumer that has not handled it. Four independent hand-written
 * copies of the same union produced the opposite: a migration plus `generate` would
 * update the canonical type and leave the copies silently short, with no build error
 * pointing at the label maps and option lists that had gone stale.
 */
export type StatusUpdateLifecycleValue = StatusUpdateLifecycle;
export type StatusUpdateImpactValue = StatusUpdateImpact;

/**
 * Lifecycles that mean "this is over". Used to split active from historical
 * without every caller re-deriving the set — and so adding a terminal
 * lifecycle later is one edit here rather than a hunt through call sites.
 */
export const TERMINAL_STATUS_LIFECYCLES = [
	"RESOLVED",
	"COMPLETED",
] as const satisfies readonly StatusUpdateLifecycleValue[];

/**
 * Ceiling on active announcements returned per dashboard load, and on the
 * revisions eager-loaded with each.
 *
 * Both bounds matter: without the second, one long-running incident with a
 * hundred progress notes would dominate every poll for every customer.
 */
const ACTIVE_ANNOUNCEMENT_CAP = 25;
const REVISIONS_PER_ANNOUNCEMENT_CAP = 50;

/** Shape returned to customers. No internal incident back-pointers. */
export interface CustomerStatusUpdate {
	id: string;
	title: string;
	body: string;
	lifecycle: StatusUpdateLifecycleValue;
	impact: StatusUpdateImpactValue;
	affectedComponentKeys: string[];
	affectedProviderKeys: string[];
	startedAt: Date;
	resolvedAt: Date | null;
	scheduledFor: Date | null;
	revisions: {
		id: string;
		lifecycle: StatusUpdateLifecycleValue;
		body: string;
		createdAt: Date;
	}[];
}

/**
 * Field selection shared by every customer-facing read. Defined once so a
 * later column addition cannot leak to customers by being picked up
 * implicitly — adding a field to the customer surface has to happen here,
 * deliberately.
 */
const CUSTOMER_SELECT = {
	id: true,
	title: true,
	body: true,
	lifecycle: true,
	impact: true,
	affectedComponentKeys: true,
	affectedProviderKeys: true,
	startedAt: true,
	resolvedAt: true,
	scheduledFor: true,
	revisions: {
		select: { id: true, lifecycle: true, body: true, createdAt: true },
		orderBy: { createdAt: "asc" },
		take: REVISIONS_PER_ANNOUNCEMENT_CAP,
	},
} as const;

/**
 * Announcements a customer should currently see: anything not in a terminal
 * lifecycle, plus upcoming scheduled maintenance.
 */
export async function listActiveStatusUpdates(): Promise<
	CustomerStatusUpdate[]
> {
	const rows = await db.statusUpdate.findMany({
		where: { lifecycle: { notIn: [...TERMINAL_STATUS_LIFECYCLES] } },
		select: CUSTOMER_SELECT,
		orderBy: { startedAt: "desc" },
		// Capped for the same reason `listStatusUpdateHistory` below clamps its
		// page size — an unbounded read on a global table is a cheap way to load
		// the database — and more sharply, because this one fires on EVERY
		// dashboard poll rather than on demand. Newest-first, so the cap drops
		// the stalest announcements rather than the current one.
		take: ACTIVE_ANNOUNCEMENT_CAP,
	});
	return rows as CustomerStatusUpdate[];
}

/**
 * Historical announcements within a window, newest first.
 *
 * `limit` is clamped rather than trusted: this is reachable by API key, and an
 * unbounded page size on a global table is a cheap way to load the database.
 */
export async function listStatusUpdateHistory(args: {
	sinceDays?: number;
	limit?: number;
}): Promise<CustomerStatusUpdate[]> {
	const sinceDays = Math.min(Math.max(args.sinceDays ?? 90, 1), 365);
	const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
	const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

	const rows = await db.statusUpdate.findMany({
		where: { startedAt: { gte: since } },
		select: CUSTOMER_SELECT,
		orderBy: { startedAt: "desc" },
		take: limit,
	});
	return rows as CustomerStatusUpdate[];
}

/**
 * Publish a new announcement, seeding the revision timeline with its opening
 * state in the same transaction. Without that seed the timeline would start
 * empty and the first state would be invisible in the history.
 */
export async function createStatusUpdate(input: {
	title: string;
	body: string;
	lifecycle: StatusUpdateLifecycleValue;
	impact: StatusUpdateImpactValue;
	affectedComponentKeys: string[];
	affectedProviderKeys: string[];
	startedAt?: Date;
	scheduledFor?: Date | null;
	componentIncidentId?: string | null;
	integrationIncidentId?: string | null;
	authorUserId: string;
}): Promise<{ id: string }> {
	return db.$transaction(async (tx) => {
		const created = await tx.statusUpdate.create({
			data: {
				title: input.title,
				body: input.body,
				lifecycle: input.lifecycle,
				impact: input.impact,
				affectedComponentKeys: input.affectedComponentKeys,
				affectedProviderKeys: input.affectedProviderKeys,
				startedAt: input.startedAt ?? new Date(),
				scheduledFor: input.scheduledFor ?? null,
				componentIncidentId: input.componentIncidentId ?? null,
				integrationIncidentId: input.integrationIncidentId ?? null,
				publishedByUserId: input.authorUserId,
			},
			select: { id: true },
		});
		await tx.statusUpdateRevision.create({
			data: {
				statusUpdateId: created.id,
				lifecycle: input.lifecycle,
				body: input.body,
				authorUserId: input.authorUserId,
			},
		});
		return created;
	});
}

/**
 * Append a revision and move the parent's lifecycle in one transaction.
 *
 * The parent's `lifecycle` is a denormalized "current state" over the
 * append-only revision list; letting the two diverge would make the badge
 * disagree with the timeline directly beneath it.
 *
 * `resolvedAt` tracks the CURRENT terminal state, not the first one:
 *
 *   - appending another terminal revision keeps the existing timestamp, so a
 *     second "Resolved" note does not restamp it;
 *   - appending a NON-terminal revision (reopening) clears it back to null,
 *     because the announcement is no longer resolved.
 *
 * The reopen path therefore discards the earlier resolution timestamp. That is
 * deliberate and safe: `resolvedAt` is a denormalized convenience, and the real
 * history — every state and when it was entered — is preserved in the
 * append-only revision rows, which are never updated or deleted.
 */
export async function appendStatusUpdateRevision(input: {
	statusUpdateId: string;
	lifecycle: StatusUpdateLifecycleValue;
	body: string;
	authorUserId: string;
}): Promise<void> {
	const terminal = ([...TERMINAL_STATUS_LIFECYCLES] as string[]).includes(
		input.lifecycle,
	);

	await db.$transaction(async (tx) => {
		const existing = await tx.statusUpdate.findUnique({
			where: { id: input.statusUpdateId },
			select: { resolvedAt: true },
		});
		if (!existing) {
			throw new Error(`StatusUpdate not found: ${input.statusUpdateId}`);
		}

		await tx.statusUpdateRevision.create({
			data: {
				statusUpdateId: input.statusUpdateId,
				lifecycle: input.lifecycle,
				body: input.body,
				authorUserId: input.authorUserId,
			},
		});
		await tx.statusUpdate.update({
			where: { id: input.statusUpdateId },
			data: {
				lifecycle: input.lifecycle,
				resolvedAt: terminal
					? (existing.resolvedAt ?? new Date())
					: null,
			},
		});
	});
}

/**
 * Admin-side listing, including the internal incident back-pointers the
 * customer projection withholds.
 */
export async function listStatusUpdatesForAdmin(args: {
	limit?: number;
}): Promise<
	(CustomerStatusUpdate & {
		componentIncidentId: string | null;
		integrationIncidentId: string | null;
		publishedByUserId: string | null;
	})[]
> {
	const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
	const rows = await db.statusUpdate.findMany({
		select: {
			...CUSTOMER_SELECT,
			componentIncidentId: true,
			integrationIncidentId: true,
			publishedByUserId: true,
		},
		orderBy: { startedAt: "desc" },
		take: limit,
	});
	return rows as (CustomerStatusUpdate & {
		componentIncidentId: string | null;
		integrationIncidentId: string | null;
		publishedByUserId: string | null;
	})[];
}
