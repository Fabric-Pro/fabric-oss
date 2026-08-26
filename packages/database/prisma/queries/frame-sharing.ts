import { randomUUID } from "node:crypto";
import { db } from "../client";
import type { FrameShareScope } from "../generated/client";

// Re-export the enum type for use in other packages
export type { FrameShareScope };

export interface CreateSharingGrantInput {
	frameId: string;
	email: string;
	invitedBy: string;
}

export interface SharingGrant {
	id: string;
	frameId: string;
	email: string | null;
	invitedBy: string;
	invitedAt: Date;
	lastAccessedAt: Date | null;
	accessCount: number;
}

export async function createSharingGrant(
	input: CreateSharingGrantInput,
): Promise<SharingGrant> {
	const grant = await db.frameSharingGrant.create({
		data: {
			frameId: input.frameId,
			email: input.email.toLowerCase().trim(),
			invitedBy: input.invitedBy,
		},
	});

	return {
		id: grant.id,
		frameId: grant.frameId,
		email: grant.email,
		invitedBy: grant.invitedBy,
		invitedAt: grant.invitedAt,
		lastAccessedAt: grant.lastAccessedAt,
		accessCount: grant.accessCount,
	};
}

export async function createMultipleSharingGrants(
	frameId: string,
	emails: string[],
	invitedBy: string,
): Promise<SharingGrant[]> {
	const grants = await db.$transaction(
		emails.map((email) =>
			db.frameSharingGrant.create({
				data: {
					frameId,
					email: email.toLowerCase().trim(),
					invitedBy,
				},
			}),
		),
	);

	return grants.map((grant) => ({
		id: grant.id,
		frameId: grant.frameId,
		email: grant.email,
		invitedBy: grant.invitedBy,
		invitedAt: grant.invitedAt,
		lastAccessedAt: grant.lastAccessedAt,
		accessCount: grant.accessCount,
	}));
}

export async function revokeSharingGrant(
	frameId: string,
	email: string,
): Promise<boolean> {
	const result = await db.frameSharingGrant.deleteMany({
		where: {
			frameId,
			email: email.toLowerCase().trim(),
		},
	});

	return result.count > 0;
}

export async function listSharingGrants(
	frameId: string,
): Promise<SharingGrant[]> {
	const grants = await db.frameSharingGrant.findMany({
		where: { frameId },
		orderBy: { invitedAt: "desc" },
	});

	return grants.map((grant) => ({
		id: grant.id,
		frameId: grant.frameId,
		email: grant.email,
		invitedBy: grant.invitedBy,
		invitedAt: grant.invitedAt,
		lastAccessedAt: grant.lastAccessedAt,
		accessCount: grant.accessCount,
	}));
}

export async function hasSharingGrant(
	frameId: string,
	email: string,
): Promise<boolean> {
	const grant = await db.frameSharingGrant.findUnique({
		where: {
			frameId_email: {
				frameId,
				email: email.toLowerCase().trim(),
			},
		},
	});

	return !!grant;
}

export async function updateGrantAccessStats(grantId: string): Promise<void> {
	await db.frameSharingGrant.update({
		where: { id: grantId },
		data: {
			lastAccessedAt: new Date(),
			accessCount: { increment: 1 },
		},
	});
}

export interface UpdateFrameShareScopeInput {
	frameId: string;
	userId: string;
	organizationId?: string;
	shareScope: FrameShareScope;
}

export async function updateFrameShareScope(
	input: UpdateFrameShareScopeInput,
): Promise<{ success: boolean; shareToken?: string; error?: string }> {
	// Verify ownership
	const frame = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.frameId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});

	if (!frame) {
		return { success: false, error: "Frame not found" };
	}

	// Generate or clear share token based on scope
	let shareToken: string | null = frame.shareToken;

	if (input.shareScope === "PUBLIC") {
		// Generate token if not exists
		shareToken = frame.shareToken ?? randomUUID();
	} else if (input.shareScope === "PRIVATE") {
		// Clear token for private frames
		shareToken = null;
	}
	// For EMAILS_ONLY and WORKSPACE_AND_EMAILS, keep existing token if any

	await db.agentWorkspaceFile.update({
		where: { id: input.frameId },
		data: {
			shareScope: input.shareScope,
			shareToken,
			isPublic: input.shareScope === "PUBLIC",
		},
	});

	return { success: true, shareToken: shareToken ?? undefined };
}

export interface CheckFrameAccessInput {
	frameId: string;
	userId?: string;
	userEmail?: string;
	organizationId?: string;
	isOrgMember?: boolean;
}

export async function checkFrameAccess(input: CheckFrameAccessInput): Promise<{
	hasAccess: boolean;
	scope?: FrameShareScope;
	grant?: SharingGrant;
}> {
	const frame = await db.agentWorkspaceFile.findUnique({
		where: { id: input.frameId },
		include: { sharingGrants: true },
	});

	if (!frame || !["FRAME", "SLIDESHOW"].includes(frame.fileType)) {
		return { hasAccess: false };
	}

	// Owner always has access
	if (input.userId && frame.userId === input.userId) {
		return { hasAccess: true, scope: frame.shareScope };
	}

	// Check based on share scope
	switch (frame.shareScope) {
		case "PUBLIC":
			return { hasAccess: true, scope: "PUBLIC" };

		case "WORKSPACE_AND_EMAILS": {
			// Organization members have access
			if (
				input.isOrgMember &&
				frame.organizationId === input.organizationId
			) {
				return { hasAccess: true, scope: "WORKSPACE_AND_EMAILS" };
			}
			// Not an org member — check email grants (same logic as EMAILS_ONLY)
			return checkEmailGrant(input, frame);
		}

		case "EMAILS_ONLY": {
			return checkEmailGrant(input, frame);
		}
		default:
			return { hasAccess: false, scope: "PRIVATE" };
	}
}

/**
 * Check email-based sharing grant access.
 */
async function checkEmailGrant(
	input: { userEmail?: string },
	frame: {
		shareScope: FrameShareScope;
		sharingGrants: Array<{
			id: string;
			frameId: string;
			email: string | null;
			invitedBy: string;
			invitedAt: Date;
			lastAccessedAt: Date | null;
			accessCount: number;
		}>;
	},
): Promise<{
	hasAccess: boolean;
	scope?: FrameShareScope;
	grant?: SharingGrant;
}> {
	if (!input.userEmail) {
		return { hasAccess: false, scope: frame.shareScope };
	}

	const grant = frame.sharingGrants.find(
		(g) => g.email?.toLowerCase() === input.userEmail?.toLowerCase(),
	);

	if (grant) {
		await updateGrantAccessStats(grant.id);
		return {
			hasAccess: true,
			scope: frame.shareScope,
			grant: {
				id: grant.id,
				frameId: grant.frameId,
				email: grant.email,
				invitedBy: grant.invitedBy,
				invitedAt: grant.invitedAt,
				lastAccessedAt: grant.lastAccessedAt,
				accessCount: grant.accessCount,
			},
		};
	}

	return { hasAccess: false, scope: frame.shareScope };
}

export async function getFrameShareScope(
	frameId: string,
): Promise<FrameShareScope | null> {
	const frame = await db.agentWorkspaceFile.findUnique({
		where: { id: frameId },
		select: { shareScope: true },
	});

	return frame?.shareScope ?? null;
}
