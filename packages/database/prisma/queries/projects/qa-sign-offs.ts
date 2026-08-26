/**
 * QA sign-offs — one person's approval of one feature, and the threshold gate
 * that reads them.
 *
 * The gate is deliberately a single function (`assertQaSignOffGate`) rather than
 * a count the caller compares itself. A threshold check spread across call sites
 * is one `>=` away from being wrong in only one of them, and the failing side of
 * this check is "the feature ships without the approvals somebody configured".
 */

import { db } from "../../client";
import { projectTenant } from "./qa-settings";

/** A sign-off as the feature QA tab renders it. */
export interface QaSignOffSummary {
	id: string;
	signedById: string;
	signedByLabel: string;
	note: string | null;
	createdAt: Date;
}

/**
 * Record one person's approval.
 *
 * Idempotent by constraint: the unique `(userStoryId, signedById)` means a
 * second press by the same person updates their note rather than adding a
 * second row towards the threshold. That is the control — see the model's doc
 * comment — so this upsert must never become a create.
 */
export async function recordQaSignOff(input: {
	projectId: string;
	userStoryId: string;
	signedById: string;
	signedByLabel: string;
	note?: string | null;
}): Promise<QaSignOffSummary> {
	// Tenant columns come from the PARENT PROJECT, never from the caller or its
	// session. `requireProjectPermission` authorizes the project without looking
	// at the organization, and a caller's active organization can legitimately
	// differ from the project's — a guest project-member has no active org at
	// all, and a multi-org user can act on Org B's project while their session
	// still points at Org A. Deriving from the session tags the row with the
	// wrong tenant in both cases (SOC 2 CC6.1/CC6.3).
	//
	// Derived HERE rather than in the procedure so no future caller can get it
	// wrong: the function does not accept the columns at all.
	const tenant = await projectTenant(input.projectId);

	const row = await db.qaSignOff.upsert({
		where: {
			userStoryId_signedById: {
				userStoryId: input.userStoryId,
				signedById: input.signedById,
			},
		},
		update: {
			note: input.note ?? null,
			// Refresh the label: a person who changed their display name should
			// not appear under the old one on a record they just touched.
			signedByLabel: input.signedByLabel,
		},
		create: {
			projectId: input.projectId,
			userStoryId: input.userStoryId,
			signedById: input.signedById,
			signedByLabel: input.signedByLabel,
			note: input.note ?? null,
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		},
		select: {
			id: true,
			signedById: true,
			signedByLabel: true,
			note: true,
			createdAt: true,
		},
	});
	return row;
}

/**
 * Withdraw a person's own approval. Returns false when there was nothing to
 * withdraw, so the caller can answer NOT_FOUND rather than pretend it worked.
 */
export async function revokeQaSignOff(input: {
	userStoryId: string;
	signedById: string;
}): Promise<boolean> {
	const { count } = await db.qaSignOff.deleteMany({
		where: {
			userStoryId: input.userStoryId,
			signedById: input.signedById,
		},
	});
	return count > 0;
}

/** Every approval on a feature, oldest first. */
export async function listQaSignOffs(
	userStoryId: string,
): Promise<QaSignOffSummary[]> {
	return db.qaSignOff.findMany({
		where: { userStoryId },
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			signedById: true,
			signedByLabel: true,
			note: true,
			createdAt: true,
		},
	});
}

/** What the feature QA tab shows, and what the gate decides on. */
export interface QaSignOffStatus {
	/** Distinct people who have signed off. */
	recorded: number;
	/** How many the project requires. Zero means the gate is off. */
	required: number;
	/** False only when the gate is on AND not yet satisfied. */
	satisfied: boolean;
}

/**
 * Read the threshold and the count together.
 *
 * `ProjectQaSettings` is lazy — a project that has never saved the page has no
 * row — so an absent row means the default, which is zero, which means no gate.
 * Reading it as "no row = no requirement" is what keeps this behaviour-neutral
 * for every project that never configures it.
 */
export async function getQaSignOffStatus(input: {
	projectId: string;
	userStoryId: string;
}): Promise<QaSignOffStatus> {
	const [settings, recorded] = await Promise.all([
		db.projectQaSettings.findUnique({
			where: { projectId: input.projectId },
			select: { requiredQaSignOffs: true },
		}),
		db.qaSignOff.count({ where: { userStoryId: input.userStoryId } }),
	]);

	const required = settings?.requiredQaSignOffs ?? 0;
	return { recorded, required, satisfied: recorded >= required };
}
