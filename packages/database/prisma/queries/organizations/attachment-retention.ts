/**
 * Org-level attachment retention override (#1749).
 *
 * The organization tier of the cascade `project -> organization -> server
 * default`. Every project without its own override inherits this window, so a
 * write here can change how long soft-deleted attachments survive across an
 * entire tenant. The read/write pair lives in one module so the "stamp only on
 * a real change" rule cannot drift away from the column it guards.
 */

import { db } from "../../client";

export async function getOrganizationAttachmentRetention(
	organizationId: string,
): Promise<{
	attachmentRetentionDays: number | null;
	attachmentRetentionDaysUpdatedAt: Date | null;
}> {
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: {
			attachmentRetentionDays: true,
			attachmentRetentionDaysUpdatedAt: true,
		},
	});
	// Normalised to nulls rather than passed through: `findUnique` yields
	// `undefined` for a missing row, and the caller feeds this straight into an
	// oRPC output contract of `number | null`.
	return {
		attachmentRetentionDays: org?.attachmentRetentionDays ?? null,
		attachmentRetentionDaysUpdatedAt:
			org?.attachmentRetentionDaysUpdatedAt ?? null,
	};
}

/**
 * Set (or clear) the org override.
 *
 * Stamps the change timestamp only when the value actually changes, so a no-op
 * save cannot repeatedly re-arm the grace floor and postpone every purge. The
 * `?? null` on the current value is load-bearing beyond null-safety: without
 * it a missing row reads as `undefined`, and `null !== undefined` would stamp
 * on a write that changed nothing.
 */
export async function updateOrganizationAttachmentRetention(input: {
	organizationId: string;
	attachmentRetentionDays: number | null;
}): Promise<{ attachmentRetentionDays: number | null }> {
	const current = await db.organization.findUnique({
		where: { id: input.organizationId },
		select: { attachmentRetentionDays: true },
	});
	const changed =
		(current?.attachmentRetentionDays ?? null) !==
		input.attachmentRetentionDays;
	const updated = await db.organization.update({
		where: { id: input.organizationId },
		data: {
			attachmentRetentionDays: input.attachmentRetentionDays,
			...(changed
				? { attachmentRetentionDaysUpdatedAt: new Date() }
				: {}),
		},
		select: { attachmentRetentionDays: true },
	});
	return updated;
}
