/**
 * The per-tenant attachment retention cascade (#1749).
 *
 * The retention purge runs one nightly sweep across every tenant, so it needs
 * two things this module provides: the effective window for the projects a page
 * actually touched, and the smallest window configured anywhere, which bounds
 * the sweep's indexed scan.
 *
 * Windows are resolved in code rather than joined into the purge's WHERE
 * clause, for the reason `qa-evidence-retention` documents: a join silently
 * skips every project still on defaults, and that is most of them.
 *
 * BOTH functions must run on a BYPASSRLS connection (the worker's `db`, never
 * `getTenantDb()`). `project` carries a row-level policy, and an RLS-filtered
 * MIN() observes fewer rows and can only return a LARGER minimum — which is the
 * direction that narrows the scan and silently skips eligible rows forever.
 */

import {
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
} from "@repo/utils/attachment";
import { db } from "../../client";

export interface AttachmentRetentionOverride {
	/** Effective override in days, or null when the tenant inherits the default. */
	days: number | null;
	/** When the tier that supplied `days` last changed. Arms the grace floor. */
	settingChangedAt: Date | null;
}

/**
 * Effective override per project, as a TOTAL map over the ids that exist.
 *
 * A key present with `days: null` means "resolved, no override". A key ABSENT
 * means "could not resolve" — an anomaly, never a normal state — and the caller
 * must skip such rows rather than fall back to a default. Falling back would
 * pick the SHORTEST window, so an unresolvable project would have its data
 * deleted rather than kept.
 *
 * Deliberately does NOT filter `Project.deletedAt`. A soft-deleted project is
 * restorable for seven days and its attachment rows survive; hiding it here
 * would revert its window to the default and purge a still-recoverable backlog.
 */
export async function resolveAttachmentRetentionOverrides(
	projectIds: string[],
): Promise<Map<string, AttachmentRetentionOverride>> {
	if (projectIds.length === 0) {
		return new Map();
	}
	const rows = await db.project.findMany({
		where: { id: { in: projectIds } },
		select: {
			id: true,
			attachmentRetentionDays: true,
			attachmentRetentionDaysUpdatedAt: true,
			organization: {
				select: {
					attachmentRetentionDays: true,
					attachmentRetentionDaysUpdatedAt: true,
				},
			},
		},
	});
	return new Map(
		// The return annotation is load-bearing: without it TypeScript infers the
		// tuple type from the first `return` alone and then rejects the
		// `days: null` branch as an incompatible union member.
		rows.map((row): readonly [string, AttachmentRetentionOverride] => {
			if (row.attachmentRetentionDays !== null) {
				return [
					row.id,
					{
						days: row.attachmentRetentionDays,
						settingChangedAt: row.attachmentRetentionDaysUpdatedAt,
					},
				] as const;
			}
			const org = row.organization;
			if (org?.attachmentRetentionDays != null) {
				return [
					row.id,
					{
						days: org.attachmentRetentionDays,
						settingChangedAt: org.attachmentRetentionDaysUpdatedAt,
					},
				] as const;
			}
			return [row.id, { days: null, settingChangedAt: null }] as const;
		}),
	);
}

/**
 * Smallest USABLE override across all projects and organizations, or null.
 *
 * Both aggregates are restricted to the usable range on purpose. An
 * out-of-range stored value resolves to the SERVER DEFAULT when the purge
 * filters, so letting it into this minimum would make the scan bound describe a
 * window nobody actually has — and a single such row anywhere in the deployment
 * would then distort eligibility for every tenant.
 */
export async function getMinimumAttachmentRetentionOverride(): Promise<
	number | null
> {
	const usable = {
		attachmentRetentionDays: {
			gte: MIN_ATTACHMENT_RETENTION_DAYS,
			lte: MAX_ATTACHMENT_RETENTION_DAYS,
		},
	};
	const [projects, organizations] = await Promise.all([
		db.project.aggregate({
			where: usable,
			_min: { attachmentRetentionDays: true },
		}),
		db.organization.aggregate({
			where: usable,
			_min: { attachmentRetentionDays: true },
		}),
	]);
	const candidates = [
		projects._min.attachmentRetentionDays,
		organizations._min.attachmentRetentionDays,
	].filter((value): value is number => value != null);
	return candidates.length === 0 ? null : Math.min(...candidates);
}
