/**
 * Read-access grants on a project's coding-instructions repository (spec
 * 2026-11-04 §4.4, §4.5). Every row is a grant Fabric made; access a member
 * already had is never written here, so a revoke never removes it.
 *
 * Every function takes the project's `organizationId`, resolved server-side by
 * the caller, and never widens past it.
 */

import { db, type Prisma } from "../client";
import type {
	ProjectInstructionsAccessMode,
	ProjectInstructionsAccessStatus,
} from "../zod";

const GRANT_SELECT = {
	id: true,
	organizationId: true,
	projectId: true,
	userId: true,
	githubLogin: true,
	repository: true,
	teamSlug: true,
	mode: true,
	status: true,
	lastError: true,
	createdByUserId: true,
	createdAt: true,
	updatedAt: true,
} as const satisfies Prisma.ProjectInstructionsAccessGrantSelect;

export type InstructionsAccessGrant =
	Prisma.ProjectInstructionsAccessGrantGetPayload<{
		select: typeof GRANT_SELECT;
	}>;

/** The longest `lastError` kept: a short, fixed reason, never a payload. */
const LAST_ERROR_MAX = 500;

export async function listInstructionsAccessGrants(input: {
	projectId: string;
	organizationId: string;
}): Promise<InstructionsAccessGrant[]> {
	return db.projectInstructionsAccessGrant.findMany({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		select: GRANT_SELECT,
	});
}

export async function getInstructionsAccessGrant(input: {
	projectId: string;
	organizationId: string;
	userId: string;
}): Promise<InstructionsAccessGrant | null> {
	return db.projectInstructionsAccessGrant.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
		},
		select: GRANT_SELECT,
	});
}

/**
 * Records the outcome of a grant Fabric attempted: one row per member and
 * project, replaced by the latest attempt.
 */
export async function upsertInstructionsAccessGrant(input: {
	organizationId: string;
	projectId: string;
	userId: string;
	githubLogin: string;
	repository: string;
	teamSlug: string | null;
	mode: ProjectInstructionsAccessMode;
	status: ProjectInstructionsAccessStatus;
	lastError: string | null;
	createdByUserId: string;
}): Promise<InstructionsAccessGrant> {
	const values = {
		githubLogin: input.githubLogin,
		repository: input.repository,
		teamSlug: input.teamSlug,
		mode: input.mode,
		status: input.status,
		lastError: input.lastError?.slice(0, LAST_ERROR_MAX) ?? null,
		createdByUserId: input.createdByUserId,
	};
	const existing = await db.projectInstructionsAccessGrant.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
		},
		select: { id: true },
	});
	if (existing) {
		return db.projectInstructionsAccessGrant.update({
			where: { id: existing.id },
			data: values,
			select: GRANT_SELECT,
		});
	}
	return db.projectInstructionsAccessGrant.create({
		data: {
			...values,
			organizationId: input.organizationId,
			projectId: input.projectId,
			userId: input.userId,
		},
		select: GRANT_SELECT,
	});
}

/** Moves one grant to a new status; null when the row is not this tenant's. */
export async function setInstructionsAccessGrantStatus(input: {
	id: string;
	organizationId: string;
	status: ProjectInstructionsAccessStatus;
	lastError: string | null;
}): Promise<InstructionsAccessGrant | null> {
	const updated = await db.projectInstructionsAccessGrant.updateMany({
		where: { id: input.id, organizationId: input.organizationId },
		data: {
			status: input.status,
			lastError: input.lastError?.slice(0, LAST_ERROR_MAX) ?? null,
		},
	});
	if (updated.count === 0) {
		return null;
	}
	return db.projectInstructionsAccessGrant.findFirst({
		where: { id: input.id, organizationId: input.organizationId },
		select: GRANT_SELECT,
	});
}
